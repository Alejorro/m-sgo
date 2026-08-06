/**
 * SGO — capa de storage del front.
 *
 * Reemplaza a localStorage sin cambiar su contrato: getItem/setItem/removeItem
 * siguen siendo SINCRÓNICOS y siguen manejando strings. Eso es lo que permite
 * que la lógica de negocio de app.js quede intacta (db.get() se usa en ~50
 * lugares de forma sincrónica, y escanearUsoGlobal() lee todas las obras en
 * cada render).
 *
 * Cómo funciona:
 *   - hydrate()  → único punto async. Un GET /api/docs trae TODOS los
 *                  documentos y llena el cache en memoria. Se llama una vez,
 *                  antes de que arranque la app.
 *   - getItem()  → lee del cache. Nunca toca la red.
 *   - setItem()  → escribe el cache y encola la escritura. Un debounce de
 *                  400 ms agrupa la ráfaga típica (comprobante → recalc →
 *                  save escribe obra + catálogo) en un solo POST batch.
 *   - removeItem() → cache + DELETE encolado.
 *
 * Concurrencia optimista, resuelta en silencio: se recuerda la versión de
 * cada documento. Si el server responde 409 (alguien más — otra pestaña,
 * otro dispositivo del mismo usuario — escribió antes), NO se bloquea nada
 * ni se interrumpe al usuario: se trae la versión fresca, se combina con el
 * cambio local (registrarResolutor) y se reintenta. Pensado para un usuario
 * único que puede tener más de una pestaña/dispositivo abiertos; no hay
 * banner ni pantalla de "recargá".
 */
/* global window, document, fetch */

const sgoStore = (function () {
  const API = '/api';
  const DEBOUNCE_MS = 400;
  const MAX_INTENTOS = 3;
  const BACKOFF_MS = [500, 1500, 4500];
  const REINTENTO_OFFLINE_MS = 10000;
  /** Reintentos de resolución de conflicto antes de resignarse por ahora
   *  (el próximo guardado real lo vuelve a intentar solo). */
  const MAX_REINTENTOS_CONFLICTO = 3;

  /** Clave → string JSON, exactamente lo que guardaba localStorage. */
  const cache = new Map();
  /** Clave → versión conocida en el server. 0 = todavía no existe allá. */
  const versiones = new Map();
  /** Claves con escritura pendiente de enviar. */
  const pendientes = new Set();
  /** Claves pendientes de borrado. */
  const borrados = new Set();
  /** Resolutores de conflicto: [{ coincide(key), combinar(local, remoto) }]. */
  const resolutores = [];

  let timerFlush = null;
  let enviando = false;
  let hidratado = false;
  let ultimoGuardado = null;
  let estado = 'idle'; // idle | saving | saved | offline
  const suscriptores = [];

  function resolutorPara(key) {
    const entrada = resolutores.find((r) => r.coincide(key));
    return entrada && entrada.combinar;
  }

  /* ===================== ESTADO / OBSERVADORES ===================== */

  function setEstado(nuevo) {
    estado = nuevo;
    const snapshot = { estado, ultimoGuardado, pendientes: pendientes.size + borrados.size };
    for (const cb of suscriptores) {
      try { cb(snapshot); } catch (e) { console.error('Error en observador de estado', e); }
    }
  }

  /* ===================== RED ===================== */

  const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * fetch con reintentos ante fallas transitorias (red caída, 5xx).
   * Un 409 o un 4xx NO se reintentan acá: un 409 se resuelve aparte
   * (ver enviarLote/enviarBorrado), el resto de los 4xx son bugs, no fallas
   * transitorias.
   */
  async function fetchConReintento(url, opts) {
    let ultimoError = null;
    for (let intento = 0; intento < MAX_INTENTOS; intento++) {
      if (intento > 0) await esperar(BACKOFF_MS[intento - 1]);
      try {
        const res = await fetch(url, opts);
        if (res.status >= 500) { ultimoError = new Error('HTTP ' + res.status); continue; }
        return res;
      } catch (err) {
        ultimoError = err; // falla de red: reintentable
      }
    }
    throw ultimoError || new Error('No se pudo contactar al server');
  }

  /**
   * Borra `key`. Ante un 409 (alguien cambió el documento desde que
   * conocíamos su versión), la intención sigue siendo la misma —borrarlo—
   * así que simplemente adoptamos la versión fresca y reintentamos.
   */
  async function enviarBorrado(key, intento) {
    intento = intento || 0;
    const version = versiones.get(key) || 0;
    const res = await fetchConReintento(`${API}/docs/${encodeURIComponent(key)}?version=${version}`, {
      method: 'DELETE',
    });
    if (res.status === 409) {
      if (intento >= MAX_REINTENTOS_CONFLICTO) {
        console.warn(`No se pudo borrar "${key}" tras varios intentos; se reintentará en el próximo guardado.`);
        return;
      }
      const body = await res.json().catch(() => ({}));
      versiones.set(key, body.current ? body.current.version : 0);
      return enviarBorrado(key, intento + 1);
    }
    // 404 = ya no está: el objetivo se cumplió igual.
    if (!res.ok && res.status !== 404 && res.status !== 204) {
      throw new Error(`DELETE ${key} falló: HTTP ${res.status}`);
    }
    versiones.delete(key);
  }

  /**
   * Envía el lote. Ante un 409 (batch transaccional: si choca una clave,
   * ninguna del lote se escribió), resuelve cada clave en conflicto —con el
   * resolutor registrado si hay uno, si no, el cambio local pisa encima de
   * la versión fresca— y reintenta el lote entero con las versiones y datos
   * ya corregidos. Todo en silencio: sin banner, sin interrumpir al usuario.
   */
  async function enviarLote(keys, intento) {
    intento = intento || 0;
    const docs = [];
    for (const key of keys) {
      if (!cache.has(key)) continue; // se borró entre el encolado y el envío
      docs.push({ key, data: JSON.parse(cache.get(key)), version: versiones.get(key) || 0 });
    }
    if (!docs.length) return;

    const res = await fetchConReintento(`${API}/docs/batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docs }),
    });

    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      const conflicts = body.conflicts || [];
      if (intento >= MAX_REINTENTOS_CONFLICTO) {
        console.warn('No se pudo resolver un conflicto de guardado tras varios intentos; se reintentará en el próximo guardado.', conflicts);
        return;
      }
      for (const c of conflicts) {
        if (!cache.has(c.key)) { versiones.set(c.key, c.current.version); continue; }
        const combinar = resolutorPara(c.key);
        const local = JSON.parse(cache.get(c.key));
        const combinado = combinar ? combinar(local, c.current.data) : local;
        cache.set(c.key, JSON.stringify(combinado));
        versiones.set(c.key, c.current.version);
      }
      return enviarLote(keys, intento + 1);
    }
    if (!res.ok) {
      const detalle = await res.text().catch(() => '');
      throw new Error(`Batch falló: HTTP ${res.status} ${detalle}`);
    }

    const body = await res.json();
    for (const r of body.results || []) versiones.set(r.key, r.version);
  }

  /* ===================== COLA DE ESCRITURA ===================== */

  function programarFlush(delay) {
    setEstado('saving');
    if (timerFlush) clearTimeout(timerFlush);
    timerFlush = setTimeout(() => { timerFlush = null; flush(); }, delay == null ? DEBOUNCE_MS : delay);
  }

  async function flush() {
    if (enviando) return;
    if (!pendientes.size && !borrados.size) return;

    enviando = true;
    const aBorrar = Array.from(borrados);
    const aEscribir = Array.from(pendientes);
    borrados.clear();
    pendientes.clear();

    try {
      // Los borrados van primero: eliminar el documento de una obra y después
      // actualizar el registro deja un estado coherente si algo falla en el medio.
      for (const key of aBorrar) await enviarBorrado(key);
      if (aEscribir.length) await enviarLote(aEscribir);

      ultimoGuardado = new Date();
      setEstado(pendientes.size || borrados.size ? 'saving' : 'saved');
    } catch (err) {
      // A esta altura enviarLote/enviarBorrado ya resolvieron solos cualquier
      // 409; lo que llega acá es una falla de red genuina. Se reencola y se
      // reintenta más tarde.
      console.error('No se pudo guardar, se reintenta.', err);
      aBorrar.forEach((k) => borrados.add(k));
      aEscribir.forEach((k) => pendientes.add(k));
      setEstado('offline');
      setTimeout(() => flush(), REINTENTO_OFFLINE_MS);
    } finally {
      enviando = false;
      // Si entraron escrituras nuevas mientras enviábamos, salen en la próxima vuelta.
      if ((pendientes.size || borrados.size) && !timerFlush) programarFlush();
    }
  }

  /* ===================== API PÚBLICA ===================== */

  /** Trae todos los documentos del server. Único punto asincrónico de la app. */
  async function hydrate() {
    const res = await fetch(`${API}/docs`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`No se pudo cargar la base: HTTP ${res.status}`);
    const body = await res.json();

    cache.clear();
    versiones.clear();
    for (const [key, doc] of Object.entries(body.docs || {})) {
      cache.set(key, JSON.stringify(doc.data));
      versiones.set(key, doc.version);
    }
    hidratado = true;
    setEstado('idle');
    return { documentos: cache.size };
  }

  function getItem(key) {
    if (!hidratado) console.warn(`sgoStore.getItem("${key}") antes de hydrate(): se devuelve null.`);
    return cache.has(key) ? cache.get(key) : null;
  }

  function setItem(key, value) {
    const str = String(value);

    // Mitigación clave del catálogo global: db.save() reescribe sgo_global_v1
    // en CADA acción, aunque no haya cambiado. Si el contenido es idéntico al
    // último persistido, no se encola nada. Sin esto, dos pestañas/obras
    // chocarían todo el tiempo sin haber tocado el catálogo.
    if (cache.get(key) === str) return;

    cache.set(key, str);
    borrados.delete(key);
    pendientes.add(key);
    programarFlush();
  }

  function removeItem(key) {
    const existia = cache.has(key);
    cache.delete(key);
    pendientes.delete(key);
    if (existia && (versiones.get(key) || 0) > 0) {
      borrados.add(key);
      programarFlush();
    }
  }

  /**
   * Registra cómo combinar un cambio local con la versión fresca del server
   * cuando chocan (409) al guardar la clave `match`. `match` es una clave
   * exacta o una función `(key) => boolean` (para prefijos, ej. las claves
   * de obra). `combinar(local, remoto)` devuelve el objeto final a guardar.
   * Sin resolutor registrado para una clave, gana el cambio local tal cual
   * (se reintenta con la versión fresca, sin combinar nada).
   */
  function registrarResolutor(match, combinar) {
    const coincide = typeof match === 'function' ? match : (key) => key === match;
    resolutores.push({ coincide, combinar });
  }

  /**
   * Red de seguridad al cerrar la pestaña. Si quedan escrituras sin confirmar,
   * se pide confirmación al usuario: es la única garantía confiable: un fetch
   * disparado en beforeunload no llega a completarse.
   */
  function beforeUnload(event) {
    if (!pendientes.size && !borrados.size && !enviando) return undefined;
    event.preventDefault();
    event.returnValue = ''; // requerido por navegadores viejos
    return '';
  }

  return {
    hydrate,
    getItem,
    setItem,
    removeItem,
    registrarResolutor,
    beforeUnload,
    /** Fuerza el envío inmediato, sin esperar el debounce. */
    flushNow() { if (timerFlush) { clearTimeout(timerFlush); timerFlush = null; } return flush(); },
    onEstado(cb) { suscriptores.push(cb); cb({ estado, ultimoGuardado, pendientes: pendientes.size + borrados.size }); },
    hayPendientes() { return pendientes.size + borrados.size > 0; },
  };
})();

if (typeof window !== 'undefined') window.sgoStore = sgoStore;
