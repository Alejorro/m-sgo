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
 * Concurrencia optimista: se recuerda la versión de cada documento. Si el
 * server responde 409, alguien más escribió: se bloquean las escrituras y se
 * avisa al usuario que recargue. Nunca se pisa nada en silencio.
 */
/* global window, document, fetch */

const sgoStore = (function () {
  const API = '/api';
  const DEBOUNCE_MS = 400;
  const MAX_INTENTOS = 3;
  const BACKOFF_MS = [500, 1500, 4500];
  const REINTENTO_OFFLINE_MS = 10000;

  /** Clave → string JSON, exactamente lo que guardaba localStorage. */
  const cache = new Map();
  /** Clave → versión conocida en el server. 0 = todavía no existe allá. */
  const versiones = new Map();
  /** Claves con escritura pendiente de enviar. */
  const pendientes = new Set();
  /** Claves pendientes de borrado. */
  const borrados = new Set();

  let timerFlush = null;
  let enviando = false;
  /** Tras un 409 la app queda en solo-lectura hasta que el usuario recargue. */
  let bloqueado = false;
  let hidratado = false;
  let ultimoGuardado = null;
  let estado = 'idle'; // idle | saving | saved | offline | conflict
  const suscriptores = [];

  class ConflictoError extends Error {
    constructor(conflicts) {
      super('version_conflict');
      this.name = 'ConflictoError';
      this.conflicts = conflicts || [];
    }
  }

  /* ===================== ESTADO / OBSERVADORES ===================== */

  function setEstado(nuevo) {
    estado = nuevo;
    const snapshot = { estado, ultimoGuardado, pendientes: pendientes.size + borrados.size, bloqueado };
    for (const cb of suscriptores) {
      try { cb(snapshot); } catch (e) { console.error('Error en observador de estado', e); }
    }
  }

  /* ===================== RED ===================== */

  const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * fetch con reintentos ante fallas transitorias (red caída, 5xx).
   * Un 409 o un 4xx NO se reintentan: no son transitorios, se propagan.
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

  async function enviarBorrado(key) {
    const version = versiones.get(key) || 0;
    const res = await fetchConReintento(`${API}/docs/${encodeURIComponent(key)}?version=${version}`, {
      method: 'DELETE',
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({}));
      throw new ConflictoError([{ key, current: body.current }]);
    }
    // 404 = ya no está: el objetivo se cumplió igual.
    if (!res.ok && res.status !== 404 && res.status !== 204) {
      throw new Error(`DELETE ${key} falló: HTTP ${res.status}`);
    }
    versiones.delete(key);
  }

  async function enviarLote(keys) {
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
      throw new ConflictoError(body.conflicts);
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
    if (bloqueado) return;
    setEstado('saving');
    if (timerFlush) clearTimeout(timerFlush);
    timerFlush = setTimeout(() => { timerFlush = null; flush(); }, delay == null ? DEBOUNCE_MS : delay);
  }

  async function flush() {
    if (enviando || bloqueado) return;
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
      if (err instanceof ConflictoError) {
        bloqueado = true;
        console.warn('Conflicto de versión: otro dispositivo escribió primero.', err.conflicts);
        setEstado('conflict');
      } else {
        // Falla de red tras agotar los reintentos: se reencola y se prueba de nuevo.
        console.error('No se pudo guardar, se reintenta.', err);
        aBorrar.forEach((k) => borrados.add(k));
        aEscribir.forEach((k) => pendientes.add(k));
        setEstado('offline');
        setTimeout(() => { if (!bloqueado) flush(); }, REINTENTO_OFFLINE_MS);
      }
    } finally {
      enviando = false;
      // Si entraron escrituras nuevas mientras enviábamos, salen en la próxima vuelta.
      if (!bloqueado && (pendientes.size || borrados.size) && !timerFlush) programarFlush();
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
    // último persistido, no se encola nada. Sin esto, dos usuarios en obras
    // distintas chocarían todo el tiempo sin haber tocado el catálogo.
    if (cache.get(key) === str) return;

    cache.set(key, str);
    if (bloqueado) return; // en conflicto no se encola: la app está en solo-lectura

    borrados.delete(key);
    pendientes.add(key);
    programarFlush();
  }

  function removeItem(key) {
    const existia = cache.has(key);
    cache.delete(key);
    if (bloqueado) return;

    pendientes.delete(key);
    if (existia && (versiones.get(key) || 0) > 0) {
      borrados.add(key);
      programarFlush();
    }
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
    beforeUnload,
    /** Fuerza el envío inmediato, sin esperar el debounce. */
    flushNow() { if (timerFlush) { clearTimeout(timerFlush); timerFlush = null; } return flush(); },
    onEstado(cb) { suscriptores.push(cb); cb({ estado, ultimoGuardado, pendientes: pendientes.size + borrados.size, bloqueado }); },
    estaBloqueado() { return bloqueado; },
    hayPendientes() { return pendientes.size + borrados.size > 0; },
  };
})();

if (typeof window !== 'undefined') window.sgoStore = sgoStore;
