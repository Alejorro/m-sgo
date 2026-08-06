/* SGO — Sistema de Gestión de Control de Gastos de Obra. Ver decisiones de diseño en el comentario inicial de index.html. */

/* ===================== HELPERS ===================== */
const fmtMonto = (n) => (Number(n) || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtARS = (n) => '$ ' + fmtMonto(n);
const fmtUSD = (n) => 'US$ ' + fmtMonto(n);
const fmtPct = (n) => (Number.isFinite(n) ? n : 0).toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%';
const fmtFecha = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const todayISO = () => new Date().toISOString().slice(0, 10);
const nowISO = () => new Date().toISOString();
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

let _idSeq = 0;
function newId(prefix) {
  _idSeq++;
  return `${prefix}_${Date.now().toString(36)}${_idSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function notify(msg, type) {
  type = type || 'success';
  const area = document.getElementById('toast-area');
  const div = document.createElement('div');
  div.className = `alert alert-${type} shadow-sm`;
  div.style.opacity = '0';
  div.style.transition = 'opacity .25s';
  div.textContent = msg;
  area.appendChild(div);
  requestAnimationFrame(() => { div.style.opacity = '1'; });
  setTimeout(() => { div.style.opacity = '0'; setTimeout(() => div.remove(), 300); }, 3500);
}

function mesesEntre(mesInicio, mesFin) {
  const out = [];
  let [y, m] = mesInicio.split('-').map(Number);
  const [yf, mf] = mesFin.split('-').map(Number);
  while (y < yf || (y === yf && m <= mf)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/* ===================== REGISTRO DE OBRAS (multi-obra, hasta 5 en simultáneo) ===================== */
const OBRAS_REGISTRY_KEY = 'sgo_obras_v1';
const OBRA_DATA_PREFIX = 'obra_db_v1__';
const LEGACY_DB_KEY = 'obra_db_v1';
const MAX_OBRAS = 5;

const obrasRegistry = (function () {
  let reg = null;
  function migrarDesdeMonoObra() {
    const legacyRaw = sgoStore.getItem(LEGACY_DB_KEY);
    const id = newId('obra');
    let nombre = 'Obra 1';
    if (legacyRaw) {
      try {
        const legacy = JSON.parse(legacyRaw);
        nombre = (legacy.parametros && legacy.parametros.nombreObra) || nombre;
      } catch (e) { /* backup previo corrupto: arranca la obra migrada en blanco */ }
      sgoStore.setItem(OBRA_DATA_PREFIX + id, legacyRaw);
      sgoStore.removeItem(LEGACY_DB_KEY);
    }
    return { obras: [{ id, nombre, createdAt: nowISO() }], activaId: id };
  }
  function load() {
    try {
      const raw = sgoStore.getItem(OBRAS_REGISTRY_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { console.error('Error cargando registro de obras', e); }
    const migrado = migrarDesdeMonoObra();
    sgoStore.setItem(OBRAS_REGISTRY_KEY, JSON.stringify(migrado));
    return migrado;
  }
  function save() { sgoStore.setItem(OBRAS_REGISTRY_KEY, JSON.stringify(reg)); }
  return {
    get() { if (!reg) reg = load(); return reg; },
    listar() { return this.get().obras; },
    activaId() { return this.get().activaId; },
    obraActiva() { const r = this.get(); return r.obras.find(o => o.id === r.activaId) || r.obras[0]; },
    setActiva(id) { this.get().activaId = id; save(); },
    crear(nombre) {
      const r = this.get();
      if (r.obras.length >= MAX_OBRAS) return null;
      const o = { id: newId('obra'), nombre: (nombre || '').trim() || `Obra ${r.obras.length + 1}`, createdAt: nowISO() };
      r.obras.push(o);
      save();
      return o;
    },
    renombrar(id, nombre) {
      const r = this.get();
      const o = r.obras.find(x => x.id === id);
      if (!o || !(nombre || '').trim()) return;
      o.nombre = nombre.trim();
      save();
    },
    eliminar(id) {
      const r = this.get();
      if (r.obras.length <= 1) return false;
      r.obras = r.obras.filter(x => x.id !== id);
      sgoStore.removeItem(OBRA_DATA_PREFIX + id);
      if (r.activaId === id) r.activaId = r.obras[0].id;
      save();
      return true;
    },
  };
})();

/* ===================== DATA LAYER (db) — datos de la obra activa ===================== */
const RUBRO_TIPOS = ['MATERIAL', 'MANO_OBRA', 'HONORARIOS', 'IMPUESTOS', 'CONTRATO'];
const RUBRO_TIPO_INFO = {
  MATERIAL:   { label: 'Materiales',   abrev: 'MAT',  badge: 'primary',           color: '#0d6efd' },
  MANO_OBRA:  { label: 'Mano de Obra', abrev: 'MO',   badge: 'warning text-dark', color: '#fd7e14' },
  HONORARIOS: { label: 'Honorarios',   abrev: 'HON',  badge: 'info text-dark',    color: '#6f42c1' },
  IMPUESTOS:  { label: 'Impuestos',    abrev: 'IMP',  badge: 'secondary',         color: '#6c757d' },
  CONTRATO:   { label: 'Contrato',     abrev: 'CONT', badge: 'dark',              color: '#343a40' },
};

function seedRubros() {
  const mk = (id, nombre, tipo) => ({ id, nombre, tipo, activo: true, createdAt: nowISO(), updatedAt: nowISO() });
  return [
    mk('mat-obra-gruesa', 'MAT OBRA GRUESA', 'MATERIAL'),
    mk('mat-electricidad', 'MAT ELECTRICIDAD', 'MATERIAL'),
    mk('mat-plomeria', 'MAT PLOMERIA', 'MATERIAL'),
    mk('mat-pintura', 'MAT PINTURA', 'MATERIAL'),
    mk('mo-albanileria', 'MO ALBAÑILERIA', 'MANO_OBRA'),
    mk('mo-electricidad', 'MO ELECTRICIDAD', 'MANO_OBRA'),
    mk('mo-plomeria', 'MO PLOMERIA', 'MANO_OBRA'),
    mk('mo-pintura', 'MO PINTURA', 'MANO_OBRA'),
  ];
}

/* ===================== CATÁLOGO GLOBAL (proveedores y rubros, compartidos entre obras) ===================== */
const GLOBAL_CATALOG_KEY = 'sgo_global_v1';

function mergeProveedoresYRubros(catalogo, proveedoresNuevos, rubrosNuevos) {
  const proveedorIdMap = {};
  const rubroIdMap = {};
  const provPorNombre = new Map(catalogo.proveedores.map(p => [p.nombre.trim().toUpperCase(), p]));
  const rubroPorClave = new Map(catalogo.rubros.map(r => [r.nombre.trim().toUpperCase() + '|' + r.tipo, r]));
  for (const p of (proveedoresNuevos || [])) {
    const key = (p.nombre || '').trim().toUpperCase();
    if (!key) continue;
    let canon = provPorNombre.get(key);
    if (!canon) { canon = Object.assign({}, p); catalogo.proveedores.push(canon); provPorNombre.set(key, canon); }
    proveedorIdMap[p.id] = canon.id;
  }
  for (const r of (rubrosNuevos || [])) {
    const key = (r.nombre || '').trim().toUpperCase() + '|' + r.tipo;
    let canon = rubroPorClave.get(key);
    if (!canon) { canon = Object.assign({}, r); catalogo.rubros.push(canon); rubroPorClave.set(key, canon); }
    rubroIdMap[r.id] = canon.id;
  }
  return { proveedorIdMap, rubroIdMap };
}

function remapReferenciasObra(obraData, proveedorIdMap, rubroIdMap) {
  for (const c of (obraData.comprobantes || [])) {
    if (proveedorIdMap[c.proveedorId]) c.proveedorId = proveedorIdMap[c.proveedorId];
    if (rubroIdMap[c.rubroDefaultId]) c.rubroDefaultId = rubroIdMap[c.rubroDefaultId];
    for (const it of (c.items || [])) { if (rubroIdMap[it.rubroId]) it.rubroId = rubroIdMap[it.rubroId]; }
  }
  for (const p of (obraData.pagos || [])) { if (proveedorIdMap[p.proveedorId]) p.proveedorId = proveedorIdMap[p.proveedorId]; }
  for (const pr of (obraData.presupuestos || [])) { if (rubroIdMap[pr.rubroId]) pr.rubroId = rubroIdMap[pr.rubroId]; }
}

const globalCatalog = (function () {
  let cat = null;
  function migrarDesdeObras() {
    const catalogo = { proveedores: [], rubros: [] };
    const reg = obrasRegistry.get();
    for (const obra of reg.obras) {
      const raw = sgoStore.getItem(OBRA_DATA_PREFIX + obra.id);
      if (!raw) continue;
      let obraData;
      try { obraData = JSON.parse(raw); } catch (e) { continue; }
      const { proveedorIdMap, rubroIdMap } = mergeProveedoresYRubros(catalogo, obraData.proveedores, obraData.rubros);
      remapReferenciasObra(obraData, proveedorIdMap, rubroIdMap);
      delete obraData.proveedores;
      delete obraData.rubros;
      sgoStore.setItem(OBRA_DATA_PREFIX + obra.id, JSON.stringify(obraData));
    }
    if (catalogo.rubros.length === 0) catalogo.rubros = seedRubros();
    return catalogo;
  }
  function load() {
    try {
      const raw = sgoStore.getItem(GLOBAL_CATALOG_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { console.error('Error cargando catálogo global', e); }
    const migrado = migrarDesdeObras();
    sgoStore.setItem(GLOBAL_CATALOG_KEY, JSON.stringify(migrado));
    return migrado;
  }
  return {
    get() { if (!cat) cat = load(); return cat; },
    save() { sgoStore.setItem(GLOBAL_CATALOG_KEY, JSON.stringify(cat)); },
    mergeDesde(proveedoresNuevos, rubrosNuevos) {
      const catalogo = this.get();
      const maps = mergeProveedoresYRubros(catalogo, proveedoresNuevos, rubrosNuevos);
      this.save();
      return maps;
    },
  };
})();

/* ===================== RESOLUCIÓN DE CONFLICTOS (silenciosa) ===================== */
/* Pensado para un usuario único con más de una pestaña/dispositivo: si un
   guardado choca contra una versión más nueva, no se interrumpe a nadie —se
   combina el cambio local arriba de lo último del server y se reintenta. */

function unionPorClave(remotoArr, localArr, clave) {
  remotoArr = remotoArr || []; localArr = localArr || [];
  const clavesRemoto = new Set(remotoArr.map((x) => x[clave]));
  return remotoArr.concat(localArr.filter((x) => !clavesRemoto.has(x[clave])));
}

// Registro de obras: unión de obras por id (así una obra nueva creada en una
// pestaña no desaparece si la otra guarda encima); la obra activa se
// mantiene si sigue existiendo, si no se cae a la del server.
sgoStore.registrarResolutor(OBRAS_REGISTRY_KEY, (local, remoto) => {
  const idsRemoto = new Set(remoto.obras.map((o) => o.id));
  const obras = remoto.obras.concat(local.obras.filter((o) => !idsRemoto.has(o.id)));
  const activaId = obras.some((o) => o.id === local.activaId) ? local.activaId : remoto.activaId;
  return { obras, activaId };
});

// Catálogo global: mismo merge idempotente por nombre/tipo que ya usa la
// migración vieja (mergeProveedoresYRubros) — un proveedor o rubro nuevo se
// agrega, uno que ya existía por nombre no se duplica.
sgoStore.registrarResolutor(GLOBAL_CATALOG_KEY, (local, remoto) => {
  const catalogo = { proveedores: remoto.proveedores.slice(), rubros: remoto.rubros.slice() };
  mergeProveedoresYRubros(catalogo, local.proveedores, local.rubros);
  return catalogo;
});

// Documento de obra: unión por id de comprobantes/pagos (y por rubroId de
// presupuestos, que no tienen id propio). Si el mismo registro se editó
// distinto en los dos lados, gana el del server; lo nuevo de cada lado se
// conserva. Evita que una pestaña vieja borre de un plumazo lo cargado en
// otra desde el último hydrate.
sgoStore.registrarResolutor((key) => key.startsWith(OBRA_DATA_PREFIX), (local, remoto) => {
  return Object.assign({}, remoto, {
    comprobantes: unionPorClave(remoto.comprobantes, local.comprobantes, 'id'),
    pagos: unionPorClave(remoto.pagos, local.pagos, 'id'),
    presupuestos: unionPorClave(remoto.presupuestos, local.presupuestos, 'rubroId'),
  });
});

function leerDatosDeObra(obraId) {
  if (obraId === obrasRegistry.activaId()) return db.get();
  try { return JSON.parse(sgoStore.getItem(OBRA_DATA_PREFIX + obraId) || 'null'); } catch (e) { return null; }
}

function escanearUsoGlobal() {
  const proveedoresUsados = new Set();
  const rubrosUsados = new Set();
  for (const obra of obrasRegistry.listar()) {
    const obraData = leerDatosDeObra(obra.id);
    if (!obraData) continue;
    for (const c of (obraData.comprobantes || [])) {
      proveedoresUsados.add(c.proveedorId);
      for (const it of (c.items || [])) rubrosUsados.add(it.rubroId);
    }
    for (const p of (obraData.pagos || [])) proveedoresUsados.add(p.proveedorId);
  }
  return { proveedoresUsados, rubrosUsados };
}

function defaultData() {
  return {
    version: 1,
    parametros: { monedaBase: 'ARS', tcActual: 1000 },
    comprobantes: [],
    pagos: [],
    presupuestos: [],
    meta: { createdAt: nowISO(), updatedAt: nowISO() },
  };
}

const db = (function () {
  let data = null;
  let cargadaParaObraId = null;
  function attachCatalogoGlobal(d) {
    const cat = globalCatalog.get();
    d.proveedores = cat.proveedores;
    d.rubros = cat.rubros;
    return d;
  }
  function load() {
    let parsed = null;
    try {
      const raw = sgoStore.getItem(OBRA_DATA_PREFIX + obrasRegistry.activaId());
      if (raw) parsed = JSON.parse(raw);
    } catch (e) {
      console.error('Error cargando datos de la obra', e);
    }
    const base = defaultData();
    const merged = parsed ? Object.assign(base, parsed, {
      parametros: Object.assign({}, base.parametros, parsed.parametros || {}),
      meta: Object.assign({}, base.meta, parsed.meta || {}),
    }) : base;
    delete merged.proveedores;
    delete merged.rubros;
    return attachCatalogoGlobal(merged);
  }
  return {
    get() {
      const activaId = obrasRegistry.activaId();
      if (!data || cargadaParaObraId !== activaId) { data = load(); cargadaParaObraId = activaId; }
      return data;
    },
    set(newData) {
      if (newData.proveedores || newData.rubros) {
        const { proveedorIdMap, rubroIdMap } = globalCatalog.mergeDesde(newData.proveedores, newData.rubros);
        remapReferenciasObra(newData, proveedorIdMap, rubroIdMap);
      }
      delete newData.proveedores;
      delete newData.rubros;
      data = attachCatalogoGlobal(newData);
      cargadaParaObraId = obrasRegistry.activaId();
      this.save();
    },
    save() {
      data.meta.updatedAt = nowISO();
      const obraEspecifico = Object.assign({}, data);
      delete obraEspecifico.proveedores;
      delete obraEspecifico.rubros;
      sgoStore.setItem(OBRA_DATA_PREFIX + obrasRegistry.activaId(), JSON.stringify(obraEspecifico));
      // globalCatalog.save() es un no-op si el catálogo no cambió: sgoStore
      // compara el string y no encola escrituras idénticas.
      globalCatalog.save();
      // El indicador de #hdr-last-action ahora lo maneja sgoStore, que sabe si
      // la escritura llegó al server (ver renderEstadoSync).
    },
    reset() {
      data = attachCatalogoGlobal(defaultData());
      cargadaParaObraId = obrasRegistry.activaId();
      this.save();
    },
  };
})();

/* ===================== MOTOR DE CÁLCULO ===================== */
function montoPagableComprobante(c) {
  const ret = (c.retencionPct > 0 && !c.retencionLiberada) ? c.retencionARS : 0;
  return round2(c.totalARS - ret);
}

function tasaUsdEfectiva(c) {
  if (c.totalARS > 0) return c.totalUSD / c.totalARS;
  return c.tc > 0 ? 1 / c.tc : 0;
}

function totalImputadoComprobante(c, data) {
  data = data || db.get();
  let total = 0;
  for (const p of data.pagos) {
    if (p.anulado) continue;
    for (const im of (p.imputaciones || [])) if (im.comprobanteId === c.id) total += im.montoImputado;
  }
  return round2(total);
}

function recalcComprobante(c, data) {
  data = data || db.get();
  c.totalARS = round2((c.items || []).reduce((s, it) => s + (Number(it.total) || 0), 0));
  const totalUSDCalculado = c.tc > 0 ? round2(c.totalARS / c.tc) : 0;
  c.totalUSD = (c.totalUSDManual != null && c.totalUSDManual > 0) ? c.totalUSDManual : totalUSDCalculado;
  c.retencionARS = round2(c.totalARS * ((Number(c.retencionPct) || 0) / 100));
  const pagable = montoPagableComprobante(c);
  const imputado = totalImputadoComprobante(c, data);
  c.saldoARS = round2(pagable - imputado);
  if (c.saldoARS <= 0.01) c.estado = 'PAGADO';
  else if (c.saldoARS < pagable - 0.01) c.estado = 'PARCIAL';
  else c.estado = 'PENDIENTE';
}

/* `opts.persist === false` recalcula solo en memoria, sin guardar. Se usa en el
   arranque y al cambiar de obra: ahí no hay nada que el usuario haya cambiado,
   y contra un server persistir sin motivo sería escribir sola al abrirse. */
function recalcTodo(opts) {
  const data = db.get();
  for (const c of data.comprobantes) recalcComprobante(c, data);
  if (!opts || opts.persist !== false) db.save();
}

function totalFacturadoProveedor(proveedorId, data) {
  return round2(data.comprobantes.filter(c => c.proveedorId === proveedorId).reduce((s, c) => s + c.totalARS, 0));
}
function totalPagadoProveedor(proveedorId, data) {
  let total = 0;
  for (const p of data.pagos) {
    if (p.anulado || p.proveedorId !== proveedorId) continue;
    for (const im of (p.imputaciones || [])) total += im.montoImputado;
  }
  return round2(total);
}
function saldoDeudorProveedor(proveedorId, data) {
  return round2(data.comprobantes.filter(c => c.proveedorId === proveedorId).reduce((s, c) => s + Math.max(0, c.saldoARS), 0));
}
function saldoAFavorProveedor(proveedorId, data) {
  let favor = 0, aplicado = 0;
  for (const p of data.pagos) {
    if (p.anulado || p.proveedorId !== proveedorId) continue;
    favor += (p.saldoAFavorGenerado || 0);
    if (p.tipo === 'APLICACION_SALDO_FAVOR') aplicado += p.montoARS;
  }
  return round2(Math.max(0, favor - aplicado));
}
function retencionPendienteProveedor(proveedorId, data) {
  return round2(data.comprobantes
    .filter(c => c.proveedorId === proveedorId && c.retencionPct > 0 && !c.retencionLiberada)
    .reduce((s, c) => s + c.retencionARS, 0));
}

/* ===================== IMPUTACIÓN DE PAGOS ===================== */
function calcularFIFO(proveedorId, monto, data) {
  const pendientes = data.comprobantes
    .filter(c => c.proveedorId === proveedorId && c.saldoARS > 0.01)
    .sort((a, b) => a.fecha === b.fecha ? a.id.localeCompare(b.id) : (a.fecha < b.fecha ? -1 : 1));
  let restante = round2(monto);
  const imputaciones = [];
  for (const c of pendientes) {
    if (restante <= 0.005) break;
    const aplicar = round2(Math.min(restante, c.saldoARS));
    if (aplicar > 0) { imputaciones.push({ comprobanteId: c.id, montoImputado: aplicar }); restante = round2(restante - aplicar); }
  }
  return { imputaciones, sobra: Math.max(0, restante) };
}

function registrarPago({ proveedorId, fecha, tc, montoARS, esAnticipo, imputaciones }) {
  const data = db.get();
  montoARS = round2(montoARS);
  const montoUSD = tc > 0 ? round2(montoARS / tc) : 0;
  let saldoAFavorGenerado = 0;
  let imputacionesFinal = [];
  if (esAnticipo) {
    saldoAFavorGenerado = montoARS;
  } else {
    imputacionesFinal = (imputaciones || []).filter(im => im.montoImputado > 0);
    const sumaImp = round2(imputacionesFinal.reduce((s, i) => s + i.montoImputado, 0));
    saldoAFavorGenerado = round2(montoARS - sumaImp);
  }
  const pago = {
    id: newId('pago'), fecha, proveedorId, tc: Number(tc), montoARS, montoUSD,
    tipo: esAnticipo ? 'ANTICIPO' : 'PAGO', imputaciones: imputacionesFinal, saldoAFavorGenerado,
    anulado: false, createdAt: nowISO(), updatedAt: nowISO(),
  };
  data.pagos.push(pago);
  for (const im of imputacionesFinal) {
    const c = data.comprobantes.find(x => x.id === im.comprobanteId);
    if (c) recalcComprobante(c, data);
  }
  db.save();
  return pago;
}

function anularPago(pagoId) {
  const data = db.get();
  const p = data.pagos.find(x => x.id === pagoId);
  if (!p || p.anulado) return false;
  if (p.saldoAFavorGenerado > 0) {
    let favorOtros = 0, aplicadoOtros = 0;
    for (const otro of data.pagos) {
      if (otro.anulado || otro.proveedorId !== p.proveedorId || otro.id === p.id) continue;
      favorOtros += (otro.saldoAFavorGenerado || 0);
      if (otro.tipo === 'APLICACION_SALDO_FAVOR') aplicadoOtros += otro.montoARS;
    }
    if (aplicadoOtros > favorOtros + 0.01) {
      notify('No se puede anular: el saldo a favor generado por este pago ya fue aplicado a otra factura. Anule primero esa aplicación de saldo a favor.', 'danger');
      return false;
    }
  }
  p.anulado = true; p.anuladoFecha = nowISO();
  for (const im of (p.imputaciones || [])) {
    const c = data.comprobantes.find(x => x.id === im.comprobanteId);
    if (c) recalcComprobante(c, data);
  }
  db.save();
  return true;
}

function autoAplicarSaldoFavor(comprobante, data) {
  const favor = saldoAFavorProveedor(comprobante.proveedorId, data);
  if (favor <= 0.005) return;
  const pagable = montoPagableComprobante(comprobante);
  const aplicar = round2(Math.min(favor, pagable));
  if (aplicar <= 0) return;
  const pago = {
    id: newId('pago'), fecha: todayISO(), proveedorId: comprobante.proveedorId, tc: comprobante.tc,
    montoARS: aplicar, montoUSD: round2(aplicar * tasaUsdEfectiva(comprobante)),
    tipo: 'APLICACION_SALDO_FAVOR', imputaciones: [{ comprobanteId: comprobante.id, montoImputado: aplicar }],
    saldoAFavorGenerado: 0, anulado: false, createdAt: nowISO(), updatedAt: nowISO(),
  };
  data.pagos.push(pago);
  recalcComprobante(comprobante, data);
}

function liberarRetencion(comprobanteId) {
  const data = db.get();
  const c = data.comprobantes.find(x => x.id === comprobanteId);
  if (!c || c.retencionLiberada || !(c.retencionPct > 0)) return;
  c.retencionLiberada = true;
  c.retencionLiberadaFecha = todayISO();
  recalcComprobante(c, data);
  db.save();
}

/* ===================== CRUD: PROVEEDORES ===================== */
function buscarOCrearProveedorPorNombre(nombre, data) {
  const limpio = nombre.trim();
  let p = data.proveedores.find(x => x.nombre.trim().toUpperCase() === limpio.toUpperCase());
  if (!p) {
    p = { id: newId('prov'), nombre: limpio, cuit: '', contacto: '', email: '', tel: '', notas: '', activo: true, createdAt: nowISO(), updatedAt: nowISO() };
    data.proveedores.push(p);
  }
  return p;
}

function guardarProveedor(form) {
  const data = db.get();
  if (form.id) {
    const p = data.proveedores.find(x => x.id === form.id);
    if (!p) return null;
    p.nombre = form.nombre.trim(); p.cuit = form.cuit || ''; p.contacto = form.contacto || '';
    p.email = form.email || ''; p.tel = form.tel || ''; p.notas = form.notas || ''; p.updatedAt = nowISO();
    db.save();
    return p;
  }
  const p = { id: newId('prov'), nombre: form.nombre.trim(), cuit: form.cuit || '', contacto: form.contacto || '', email: form.email || '', tel: form.tel || '', notas: form.notas || '', activo: true, createdAt: nowISO(), updatedAt: nowISO() };
  data.proveedores.push(p);
  db.save();
  return p;
}

function proveedorTieneMovimientos(proveedorId) {
  return escanearUsoGlobal().proveedoresUsados.has(proveedorId);
}

function borrarOInactivarProveedor(id) {
  const data = db.get();
  const p = data.proveedores.find(x => x.id === id);
  if (!p) return;
  if (proveedorTieneMovimientos(id)) {
    p.activo = false; p.updatedAt = nowISO();
    db.save();
    notify('El proveedor tiene movimientos asociados: se marcó como inactivo.', 'warning');
  } else {
    data.proveedores = data.proveedores.filter(x => x.id !== id);
    db.save();
    notify('Proveedor eliminado.');
  }
}

function reactivarProveedor(id) {
  const data = db.get();
  const p = data.proveedores.find(x => x.id === id);
  if (!p) return;
  p.activo = true; p.updatedAt = nowISO();
  db.save();
}

/* ===================== CRUD: RUBROS ===================== */
function guardarRubro(form) {
  const data = db.get();
  if (form.id) {
    const r = data.rubros.find(x => x.id === form.id);
    if (!r) return null;
    r.nombre = form.nombre.trim(); r.tipo = form.tipo; r.updatedAt = nowISO();
    db.save();
    return r;
  }
  const r = { id: newId('rubro'), nombre: form.nombre.trim(), tipo: form.tipo, activo: true, createdAt: nowISO(), updatedAt: nowISO() };
  data.rubros.push(r);
  db.save();
  return r;
}

function rubroEnUso(rubroId) {
  return escanearUsoGlobal().rubrosUsados.has(rubroId);
}

function borrarOInactivarRubro(id) {
  const data = db.get();
  const r = data.rubros.find(x => x.id === id);
  if (!r) return;
  if (rubroEnUso(id)) {
    r.activo = false; r.updatedAt = nowISO();
    db.save();
    notify('El rubro tiene comprobantes asociados: se marcó como inactivo.', 'warning');
  } else {
    data.rubros = data.rubros.filter(x => x.id !== id);
    data.presupuestos = data.presupuestos.filter(x => x.rubroId !== id);
    db.save();
    notify('Rubro eliminado.');
  }
}

function reactivarRubro(id) {
  const data = db.get();
  const r = data.rubros.find(x => x.id === id);
  if (!r) return;
  r.activo = true; r.updatedAt = nowISO();
  db.save();
}

function inactivarRubro(id) {
  const data = db.get();
  const r = data.rubros.find(x => x.id === id);
  if (!r) return;
  r.activo = false; r.updatedAt = nowISO();
  db.save();
  renderRubros();
  refreshAllSelects();
}

function inactivarProveedor(id) {
  const data = db.get();
  const p = data.proveedores.find(x => x.id === id);
  if (!p) return;
  p.activo = false; p.updatedAt = nowISO();
  db.save();
  renderProveedores();
  refreshAllSelects();
}

/* ===================== CRUD: COMPROBANTES ===================== */
function guardarComprobante(form) {
  const data = db.get();
  const proveedor = buscarOCrearProveedorPorNombre(form.proveedorNombre, data);
  const items = form.items.map(it => ({
    descripcion: it.descripcion || '',
    rubroId: it.rubroId,
    montoUnit: round2(it.montoUnit),
    cantidad: Number(it.cantidad) || 1,
    total: round2(it.total != null && it.total !== '' ? it.total : (Number(it.montoUnit) || 0) * (Number(it.cantidad) || 1)),
  }));

  const totalUSDManual = (form.totalUSDManual != null && form.totalUSDManual > 0) ? round2(form.totalUSDManual) : null;

  let c;
  if (form.id) {
    c = data.comprobantes.find(x => x.id === form.id);
    if (!c) return null;
    c.fecha = form.fecha; c.proveedorId = proveedor.id; c.tipoComp = form.tipoComp || ''; c.numero = form.numero || '';
    c.tc = Number(form.tc); c.vencimiento = form.vencimiento || ''; c.items = items; c.rubroDefaultId = form.rubroDefaultId;
    c.retencionPct = Number(form.retencionPct) || 0; c.totalUSDManual = totalUSDManual; c.updatedAt = nowISO();
    recalcComprobante(c, data);
  } else {
    c = {
      id: newId('comp'), fecha: form.fecha, proveedorId: proveedor.id, tipoComp: form.tipoComp || '', numero: form.numero || '',
      tc: Number(form.tc), vencimiento: form.vencimiento || '', items, rubroDefaultId: form.rubroDefaultId,
      retencionPct: Number(form.retencionPct) || 0, retencionLiberada: false, retencionLiberadaFecha: '', totalUSDManual,
      createdAt: nowISO(), updatedAt: nowISO(),
    };
    recalcComprobante(c, data);
    data.comprobantes.push(c);
    autoAplicarSaldoFavor(c, data);
  }
  db.save();
  return c;
}

function comprobanteTieneImputaciones(comprobanteId, data) {
  return data.pagos.some(p => !p.anulado && (p.imputaciones || []).some(im => im.comprobanteId === comprobanteId));
}

function borrarComprobante(id) {
  const data = db.get();
  if (comprobanteTieneImputaciones(id, data)) {
    notify('No se puede borrar: tiene pagos imputados. Anule los pagos primero desde Cuenta Corriente.', 'danger');
    return false;
  }
  data.comprobantes = data.comprobantes.filter(x => x.id !== id);
  db.save();
  notify('Comprobante eliminado.');
  return true;
}

/* ===================== PRESUPUESTOS ===================== */
function getPresupuesto(rubroId, data) {
  data = data || db.get();
  return data.presupuestos.find(p => p.rubroId === rubroId) || { rubroId, montoPresupuestadoARS: 0 };
}
function setPresupuesto(rubroId, monto) {
  const data = db.get();
  let p = data.presupuestos.find(x => x.rubroId === rubroId);
  if (!p) { p = { rubroId, montoPresupuestadoARS: 0 }; data.presupuestos.push(p); }
  p.montoPresupuestadoARS = round2(monto);
  db.save();
}

/* ===================== FILTROS / AGREGACIONES (TABLERO) ===================== */
function filterItems(data, filtros) {
  filtros = filtros || {};
  const { desde, hasta, rubroId, proveedorId } = filtros;
  const out = [];
  for (const c of data.comprobantes) {
    if (desde && c.fecha < desde) continue;
    if (hasta && c.fecha > hasta) continue;
    if (proveedorId && c.proveedorId !== proveedorId) continue;
    for (const it of c.items) {
      if (rubroId && it.rubroId !== rubroId) continue;
      out.push({ item: it, comprobante: c });
    }
  }
  return out;
}

function gastoPorRubro(rubroId, data, filtros) {
  const f = Object.assign({}, filtros || {}, { rubroId });
  return round2(filterItems(data, f).reduce((s, x) => s + x.item.total, 0));
}

function gastoPorRubroUSD(rubroId, data, filtros) {
  const f = Object.assign({}, filtros || {}, { rubroId });
  return round2(filterItems(data, f).reduce((s, x) => s + x.item.total * tasaUsdEfectiva(x.comprobante), 0));
}

function avanceGastoTotal(data) {
  const totalPresupuesto = data.presupuestos.reduce((s, p) => s + p.montoPresupuestadoARS, 0);
  const totalReal = data.comprobantes.reduce((s, c) => s + c.totalARS, 0);
  return totalPresupuesto > 0 ? round2(totalReal / totalPresupuesto * 100) : 0;
}

function tcPromedioPonderado(data) {
  const totalARS = data.comprobantes.reduce((s, c) => s + c.totalARS, 0);
  const totalUSD = data.comprobantes.reduce((s, c) => s + c.totalUSD, 0);
  return totalUSD > 0 ? round2(totalARS / totalUSD) : 0;
}

function exposicionCambiaria(data) {
  const pendientes = data.comprobantes.filter(c => c.saldoARS > 0.01);
  let saldoARS = 0, saldoUSDHistorico = 0;
  for (const c of pendientes) { saldoARS += c.saldoARS; saldoUSDHistorico += c.saldoARS * tasaUsdEfectiva(c); }
  const tcActual = data.parametros.tcActual || 0;
  const valuadoActual = round2(saldoUSDHistorico * tcActual);
  return { saldoARS: round2(saldoARS), saldoUSDHistorico: round2(saldoUSDHistorico), valuadoActual, diferencia: round2(valuadoActual - saldoARS) };
}

function alertasVencimiento(data) {
  const hoy = todayISO();
  const en7 = new Date(); en7.setDate(en7.getDate() + 7);
  const en7ISO = en7.toISOString().slice(0, 10);
  const vencidas = data.comprobantes.filter(c => c.saldoARS > 0.01 && c.vencimiento && c.vencimiento < hoy);
  const proximas = data.comprobantes.filter(c => c.saldoARS > 0.01 && c.vencimiento && c.vencimiento >= hoy && c.vencimiento <= en7ISO);
  return { vencidas, proximas };
}

function rubrosExcedidos(data) {
  return data.rubros.filter(r => r.activo).map(r => {
    const presu = getPresupuesto(r.id, data).montoPresupuestadoARS;
    const real = gastoPorRubro(r.id, data, {});
    return { rubro: r, presupuestado: presu, real, desvio: round2(real - presu) };
  }).filter(x => x.presupuestado > 0 && x.real > x.presupuestado);
}

function flujoCajaProyectado(data) {
  const pendientes = data.comprobantes.filter(c => c.saldoARS > 0.01);
  const porMes = {};
  for (const c of pendientes) {
    const base = c.vencimiento || c.fecha;
    const m = base.slice(0, 7);
    porMes[m] = (porMes[m] || 0) + c.saldoARS;
  }
  return Object.keys(porMes).sort().map(m => ({ mes: m, monto: round2(porMes[m]) }));
}

function buildCurvaS(data, filtros) {
  const totalPresupuesto = data.presupuestos.reduce((s, p) => s + p.montoPresupuestadoARS, 0);
  const items = filterItems(data, filtros);
  if (items.length === 0) return { meses: [], real: [], plan: [] };
  const fechas = items.map(x => x.comprobante.fecha).sort();
  const mesInicio = fechas[0].slice(0, 7);
  const mesFinReal = fechas[fechas.length - 1].slice(0, 7);
  const mesHoy = todayISO().slice(0, 7);
  const mesFin = mesFinReal > mesHoy ? mesFinReal : mesHoy;
  const meses = mesesEntre(mesInicio, mesFin);
  const realPorMes = {};
  for (const x of items) { const m = x.comprobante.fecha.slice(0, 7); realPorMes[m] = (realPorMes[m] || 0) + x.item.total; }
  let acumReal = 0;
  const real = meses.map(m => { acumReal += round2(realPorMes[m] || 0); return round2(acumReal); });
  const planPorMes = meses.length ? totalPresupuesto / meses.length : 0;
  let acumPlan = 0;
  const plan = meses.map(() => { acumPlan += planPorMes; return round2(acumPlan); });
  return { meses, real, plan };
}

/* ===================== ESTADO DE UI ===================== */
const state = {
  editingComprobanteId: null,
  formItems: [],
  editingRubroId: null,
  editingProveedorId: null,
  ctaCteProveedorId: null,
  modoImputacion: 'auto',
  monedaVista: 'ARS',
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function estadoBadgeHtml(estado) {
  return `<span class="badge badge-estado-${estado}">${estado}</span>`;
}

/* ===================== SELECTS COMPARTIDOS ===================== */
function rubrosActivos(data) { return data.rubros.filter(r => r.activo).sort((a, b) => a.nombre.localeCompare(b.nombre)); }
function proveedoresActivos(data) { return data.proveedores.filter(p => p.activo).sort((a, b) => a.nombre.localeCompare(b.nombre)); }

function rubroOptionsHtml(selectedId, data) {
  data = data || db.get();
  let opts = '';
  for (const r of rubrosActivos(data)) opts += `<option value="${r.id}" ${r.id === selectedId ? 'selected' : ''}>${escapeHtml(r.nombre)} (${RUBRO_TIPO_INFO[r.tipo] ? RUBRO_TIPO_INFO[r.tipo].abrev : r.tipo})</option>`;
  return opts;
}

function refreshAllSelects() {
  const data = db.get();
  const dl = document.getElementById('dl-proveedores');
  dl.innerHTML = proveedoresActivos(data).map(p => `<option value="${escapeHtml(p.nombre)}">`).join('');

  const provSelects = ['flt-comp-proveedor', 'tb-proveedor', 'pago-proveedor'];
  for (const selId of provSelects) {
    const sel = document.getElementById(selId);
    if (!sel) continue;
    const cur = sel.value;
    const placeholder = selId === 'pago-proveedor' ? '<option value="">Seleccionar...</option>' : `<option value="">${selId === 'tb-proveedor' ? 'Todos los proveedores' : 'Todos los proveedores'}</option>`;
    sel.innerHTML = placeholder + proveedoresActivos(data).map(p => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join('');
    if (cur) sel.value = cur;
  }

  const rubroSelects = ['comp-rubro-default', 'tb-rubro'];
  for (const selId of rubroSelects) {
    const sel = document.getElementById(selId);
    if (!sel) continue;
    const cur = sel.value;
    const placeholder = selId === 'tb-rubro' ? '<option value="">Todos los rubros</option>' : '';
    sel.innerHTML = placeholder + rubroOptionsHtml(null, data);
    if (cur) sel.value = cur;
  }
}

/* ===================== COMPROBANTES: FORM ===================== */
function rowHtml(it, idx) {
  return `<tr class="item-row" data-idx="${idx}">
    <td><input type="text" class="form-control form-control-sm" value="${escapeHtml(it.descripcion)}" oninput="onItemFieldInput(${idx},'descripcion',this.value)" placeholder="Descripción"></td>
    <td><select class="form-select form-select-sm" onchange="onItemFieldInput(${idx},'rubroId',this.value)">${rubroOptionsHtml(it.rubroId)}</select></td>
    <td><input type="number" step="0.01" min="0" class="form-control form-control-sm" id="item-montounit-${idx}" value="${it.montoUnit}" oninput="onItemMontoCantChange(${idx})"></td>
    <td><input type="number" step="1" min="0" class="form-control form-control-sm" id="item-cant-${idx}" value="${it.cantidad}" oninput="onItemMontoCantChange(${idx})"></td>
    <td><input type="number" step="0.01" class="form-control form-control-sm" id="item-total-${idx}" value="${it.total}" oninput="onItemTotalInput(${idx},this.value)"></td>
    <td><button class="btn btn-sm btn-outline-danger" onclick="quitarItemRow(${idx})"><i class="bi bi-trash"></i></button></td>
  </tr>`;
}

function renderItemsRows() {
  document.getElementById('comp-items-body').innerHTML = state.formItems.map((it, idx) => rowHtml(it, idx)).join('');
}

function actualizarSubtotalForm() {
  const subtotal = round2(state.formItems.reduce((s, it) => s + (Number(it.total) || 0), 0));
  const tc = Number(document.getElementById('comp-tc').value) || 0;
  const usdManualRaw = document.getElementById('comp-usd-manual').value;
  const usdManual = usdManualRaw !== '' ? Number(usdManualRaw) : null;
  document.getElementById('comp-subtotal-ars').textContent = fmtARS(subtotal);
  const usdMostrado = (usdManual != null && usdManual > 0) ? usdManual : (tc > 0 ? subtotal / tc : null);
  document.getElementById('comp-subtotal-usd').textContent = usdMostrado != null ? fmtUSD(usdMostrado) : 'US$ —';
}

function agregarItemRow() {
  const rubroDefault = document.getElementById('comp-rubro-default').value;
  state.formItems.push({ descripcion: '', rubroId: rubroDefault, montoUnit: 0, cantidad: 1, total: 0 });
  renderItemsRows();
  actualizarSubtotalForm();
}

function quitarItemRow(idx) {
  state.formItems.splice(idx, 1);
  renderItemsRows();
  actualizarSubtotalForm();
}

function onItemFieldInput(idx, field, value) {
  if (!state.formItems[idx]) return;
  state.formItems[idx][field] = value;
}

function onItemMontoCantChange(idx) {
  const mu = Number(document.getElementById(`item-montounit-${idx}`).value) || 0;
  const cant = Number(document.getElementById(`item-cant-${idx}`).value) || 0;
  const total = round2(mu * cant);
  state.formItems[idx].montoUnit = mu;
  state.formItems[idx].cantidad = cant;
  state.formItems[idx].total = total;
  document.getElementById(`item-total-${idx}`).value = total;
  actualizarSubtotalForm();
}

function onItemTotalInput(idx, value) {
  state.formItems[idx].total = Number(value) || 0;
  actualizarSubtotalForm();
}

function onRubroDefaultChange() { /* solo afecta a nuevas líneas agregadas en adelante */ }

function limpiarFormComprobante() {
  state.editingComprobanteId = null;
  state.formItems = [];
  const data = db.get();
  document.getElementById('comp-fecha').value = todayISO();
  document.getElementById('comp-proveedor').value = '';
  document.getElementById('comp-tipo').value = '';
  document.getElementById('comp-numero').value = '';
  document.getElementById('comp-tc').value = data.parametros.tcActual || '';
  document.getElementById('comp-vencimiento').value = '';
  document.getElementById('comp-retencion-pct').value = 0;
  document.getElementById('comp-usd-manual').value = '';
  refreshAllSelects();
  renderItemsRows();
  actualizarSubtotalForm();
  document.getElementById('comp-form-title').textContent = 'Nuevo Comprobante';
  document.getElementById('btn-comp-cancelar').style.display = 'none';
}

function cancelarEdicionComprobante() { limpiarFormComprobante(); }

function editarComprobante(id) {
  const data = db.get();
  const c = data.comprobantes.find(x => x.id === id);
  if (!c) return;
  if (comprobanteTieneImputaciones(id, data)) {
    notify('Esta factura tiene pagos imputados. Si edita el monto, el saldo se recalculará; revise la cuenta corriente luego.', 'warning');
  }
  state.editingComprobanteId = id;
  state.formItems = c.items.map(it => Object.assign({}, it));
  const prov = data.proveedores.find(p => p.id === c.proveedorId);
  document.getElementById('comp-fecha').value = c.fecha;
  document.getElementById('comp-proveedor').value = prov ? prov.nombre : '';
  document.getElementById('comp-tipo').value = c.tipoComp || '';
  document.getElementById('comp-numero').value = c.numero || '';
  document.getElementById('comp-tc').value = c.tc;
  document.getElementById('comp-vencimiento').value = c.vencimiento || '';
  document.getElementById('comp-retencion-pct').value = c.retencionPct || 0;
  document.getElementById('comp-usd-manual').value = c.totalUSDManual != null ? c.totalUSDManual : '';
  refreshAllSelects();
  document.getElementById('comp-rubro-default').value = c.rubroDefaultId || '';
  renderItemsRows();
  actualizarSubtotalForm();
  document.getElementById('comp-form-title').textContent = 'Editar Comprobante';
  document.getElementById('btn-comp-cancelar').style.display = '';
  document.getElementById('pane-comprobantes').scrollIntoView({ behavior: 'smooth' });
}

function onGuardarComprobante() {
  const fecha = document.getElementById('comp-fecha').value;
  const proveedorNombre = document.getElementById('comp-proveedor').value.trim();
  const tc = Number(document.getElementById('comp-tc').value);
  const rubroDefaultId = document.getElementById('comp-rubro-default').value;

  if (!fecha) return notify('Ingrese la fecha.', 'danger');
  if (!proveedorNombre) return notify('Ingrese el proveedor.', 'danger');
  if (!(tc > 0)) return notify('El tipo de cambio debe ser mayor a 0.', 'danger');
  if (state.formItems.length === 0) return notify('Agregue al menos un ítem.', 'danger');
  for (const it of state.formItems) {
    if (!it.rubroId) return notify('Todos los ítems deben tener un rubro asignado.', 'danger');
    if (!(Number(it.total) > 0)) return notify('Todos los ítems deben tener un total mayor a 0.', 'danger');
  }

  const usdManualRaw = document.getElementById('comp-usd-manual').value;
  const form = {
    id: state.editingComprobanteId,
    fecha, proveedorNombre, tipoComp: document.getElementById('comp-tipo').value,
    numero: document.getElementById('comp-numero').value.trim(), tc,
    vencimiento: document.getElementById('comp-vencimiento').value,
    rubroDefaultId, retencionPct: Number(document.getElementById('comp-retencion-pct').value) || 0,
    totalUSDManual: usdManualRaw !== '' ? Number(usdManualRaw) : null,
    items: state.formItems,
  };
  guardarComprobante(form);
  notify(state.editingComprobanteId ? 'Comprobante actualizado.' : 'Comprobante guardado.');
  limpiarFormComprobante();
  renderComprobantesListado();
}

/* ===================== COMPROBANTES: LISTADO ===================== */
function renderComprobantesListado() {
  const data = db.get();
  const texto = (document.getElementById('flt-comp-texto').value || '').trim().toUpperCase();
  const provFiltro = document.getElementById('flt-comp-proveedor').value;
  const estadoFiltro = document.getElementById('flt-comp-estado').value;
  const desde = document.getElementById('flt-comp-desde').value;
  const hasta = document.getElementById('flt-comp-hasta').value;

  let lista = data.comprobantes.slice().sort((a, b) => a.fecha < b.fecha ? 1 : (a.fecha > b.fecha ? -1 : 0));
  if (provFiltro) lista = lista.filter(c => c.proveedorId === provFiltro);
  if (estadoFiltro) lista = lista.filter(c => c.estado === estadoFiltro);
  if (desde) lista = lista.filter(c => c.fecha >= desde);
  if (hasta) lista = lista.filter(c => c.fecha <= hasta);
  if (texto) lista = lista.filter(c => {
    const prov = data.proveedores.find(p => p.id === c.proveedorId);
    return (prov && prov.nombre.toUpperCase().includes(texto)) || (c.numero || '').toUpperCase().includes(texto) || (c.tipoComp || '').toUpperCase().includes(texto);
  });

  const body = document.getElementById('comp-listado-body');
  if (lista.length === 0) { body.innerHTML = '<tr><td colspan="9" class="text-center text-muted py-3">Sin comprobantes</td></tr>'; return; }

  body.innerHTML = lista.map(c => {
    const prov = data.proveedores.find(p => p.id === c.proveedorId);
    const tieneImp = comprobanteTieneImputaciones(c.id, data);
    let retHtml = '—';
    if (c.retencionPct > 0) {
      retHtml = c.retencionLiberada
        ? `<span class="badge bg-secondary">${c.retencionPct}% liberada</span>`
        : `<span class="badge bg-info text-dark">${c.retencionPct}% (${fmtARS(c.retencionARS)})</span> <button class="btn btn-sm btn-outline-secondary py-0 px-1" onclick="liberarRetencion('${c.id}');renderComprobantesListado();renderCtaCte();" title="Liberar retención"><i class="bi bi-unlock"></i></button>`;
    }
    return `<tr>
      <td>${fmtFecha(c.fecha)}</td>
      <td>${escapeHtml(prov ? prov.nombre : '—')}</td>
      <td>${escapeHtml(c.tipoComp || '')} ${escapeHtml(c.numero || '')}</td>
      <td class="text-end">${fmtARS(c.totalARS)}</td>
      <td class="text-end">${fmtUSD(c.totalUSD)}</td>
      <td class="text-end">${fmtARS(c.saldoARS)}</td>
      <td>${estadoBadgeHtml(c.estado)}</td>
      <td>${retHtml}</td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-primary" onclick="editarComprobante('${c.id}')" title="Editar"><i class="bi bi-pencil"></i></button>
        <button class="btn btn-sm btn-outline-danger" ${tieneImp ? 'disabled title="Tiene pagos imputados"' : ''} onclick="if(confirm('¿Borrar este comprobante?')) { borrarComprobante('${c.id}'); renderComprobantesListado(); }"><i class="bi bi-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}

/* ===================== CUENTA CORRIENTE ===================== */
function renderCtaCte() {
  const data = db.get();
  const provs = data.proveedores.slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
  const body = document.getElementById('ctacte-resumen-body');
  const foot = document.getElementById('ctacte-resumen-foot');
  const totales = { facturado: 0, pagado: 0, deudor: 0, favor: 0, retenido: 0 };
  if (provs.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">Sin proveedores</td></tr>';
    foot.innerHTML = '';
  } else {
    body.innerHTML = provs.map(p => {
      const facturado = totalFacturadoProveedor(p.id, data);
      const pagado = totalPagadoProveedor(p.id, data);
      const deudor = saldoDeudorProveedor(p.id, data);
      const favor = saldoAFavorProveedor(p.id, data);
      const retenido = retencionPendienteProveedor(p.id, data);
      totales.facturado += facturado; totales.pagado += pagado; totales.deudor += deudor;
      totales.favor += favor; totales.retenido += retenido;
      return `<tr class="${state.ctaCteProveedorId === p.id ? 'table-primary' : ''}">
        <td>${escapeHtml(p.nombre)}${!p.activo ? ' <span class="badge bg-secondary">inactivo</span>' : ''}</td>
        <td class="text-end">${fmtARS(facturado)}</td>
        <td class="text-end">${fmtARS(pagado)}</td>
        <td class="text-end ${deudor > 0 ? 'text-danger fw-semibold' : ''}">${fmtARS(deudor)}</td>
        <td class="text-end ${favor > 0 ? 'text-success fw-semibold' : ''}">${fmtARS(favor)}</td>
        <td class="text-end">${fmtARS(retenido)}</td>
        <td><button class="btn btn-sm btn-outline-primary" onclick="seleccionarProveedorCtaCte('${p.id}')"><i class="bi bi-journal-text"></i> Ver extracto</button></td>
      </tr>`;
    }).join('');
    foot.innerHTML = `<tr class="fw-semibold">
      <td>TOTAL</td>
      <td class="text-end">${fmtARS(round2(totales.facturado))}</td>
      <td class="text-end">${fmtARS(round2(totales.pagado))}</td>
      <td class="text-end">${fmtARS(round2(totales.deudor))}</td>
      <td class="text-end">${fmtARS(round2(totales.favor))}</td>
      <td class="text-end">${fmtARS(round2(totales.retenido))}</td>
      <td></td>
    </tr>`;
  }
  if (state.ctaCteProveedorId) renderExtracto();
}

function seleccionarProveedorCtaCte(proveedorId) {
  state.ctaCteProveedorId = proveedorId;
  document.getElementById('ctacte-extracto-card').style.display = '';
  renderCtaCte();
  document.getElementById('ctacte-extracto-card').scrollIntoView({ behavior: 'smooth' });
}

function buildLedgerProveedor(proveedorId, data) {
  data = data || db.get();
  const entries = [];
  for (const c of data.comprobantes.filter(x => x.proveedorId === proveedorId)) {
    const debeFactura = round2(c.totalARS - c.retencionARS);
    entries.push({ fecha: c.fecha, tipo: 'Factura', detalle: `${c.tipoComp || 'Comprobante'} ${c.numero || ''}`.trim(), debe: debeFactura, haber: 0, refTipo: 'comprobante', ref: c });
    if (c.retencionPct > 0 && c.retencionLiberada) {
      entries.push({ fecha: c.retencionLiberadaFecha || c.fecha, tipo: 'Liberación Retención', detalle: `Retención liberada (${c.numero || c.tipoComp || 'factura'})`, debe: c.retencionARS, haber: 0, refTipo: 'comprobante', ref: c });
    }
  }
  for (const p of data.pagos.filter(x => x.proveedorId === proveedorId && !x.anulado)) {
    let tipoLbl, detalle, haber;
    if (p.tipo === 'ANTICIPO') { tipoLbl = 'Anticipo'; detalle = 'Anticipo (a saldo a favor)'; haber = p.montoARS; }
    else if (p.tipo === 'APLICACION_SALDO_FAVOR') { tipoLbl = 'Aplic. Saldo Favor'; detalle = 'Reasignación de saldo a favor a factura (sin movimiento de caja)'; haber = 0; }
    else { tipoLbl = 'Pago'; detalle = 'Pago a proveedor'; haber = p.montoARS; }
    entries.push({ fecha: p.fecha, tipo: tipoLbl, detalle, debe: 0, haber, refTipo: 'pago', ref: p });
  }
  entries.sort((a, b) => a.fecha === b.fecha ? 0 : (a.fecha < b.fecha ? -1 : 1));
  let saldo = 0;
  for (const e of entries) { saldo = round2(saldo + e.debe - e.haber); e.saldoAcumulado = saldo; }
  return entries;
}

function renderExtracto() {
  const data = db.get();
  const proveedorId = state.ctaCteProveedorId;
  const prov = data.proveedores.find(p => p.id === proveedorId);
  if (!prov) return;
  document.getElementById('ctacte-prov-nombre').textContent = prov.nombre;

  const pendRetencion = data.comprobantes.filter(c => c.proveedorId === proveedorId && c.retencionPct > 0 && !c.retencionLiberada);
  const panel = document.getElementById('ctacte-retenciones-panel');
  if (pendRetencion.length === 0) panel.innerHTML = '';
  else {
    panel.innerHTML = `<div class="alert alert-info mb-2"><strong>Retenciones pendientes de liberación:</strong><ul class="mb-0">` +
      pendRetencion.map(c => `<li>${fmtFecha(c.fecha)} — ${escapeHtml(c.tipoComp || 'Comprobante')} ${escapeHtml(c.numero || '')}: ${fmtARS(c.retencionARS)}
        <button class="btn btn-sm btn-outline-primary py-0 px-2 ms-2" onclick="liberarRetencion('${c.id}'); renderCtaCte(); renderComprobantesListado();"><i class="bi bi-unlock"></i> Liberar</button></li>`).join('') +
      `</ul></div>`;
  }

  const entries = buildLedgerProveedor(proveedorId, data);
  const body = document.getElementById('ctacte-extracto-body');
  if (entries.length === 0) { body.innerHTML = '<tr><td colspan="7" class="text-center text-muted py-3">Sin movimientos</td></tr>'; return; }
  body.innerHTML = entries.map(e => {
    let accion = '';
    if (e.refTipo === 'pago' && !e.ref.anulado) {
      accion = `<button class="btn btn-sm btn-outline-danger py-0 px-2" onclick="if(confirm('¿Anular este movimiento?')){ anularPago('${e.ref.id}'); renderCtaCte(); }"><i class="bi bi-x-circle"></i> Anular</button>`;
    }
    return `<tr>
      <td>${fmtFecha(e.fecha)}</td>
      <td>${e.tipo}</td>
      <td>${escapeHtml(e.detalle)}</td>
      <td class="text-end">${e.debe ? fmtARS(e.debe) : ''}</td>
      <td class="text-end">${e.haber ? fmtARS(e.haber) : ''}</td>
      <td class="text-end fw-semibold ${e.saldoAcumulado > 0 ? 'text-danger' : (e.saldoAcumulado < 0 ? 'text-success' : '')}">${fmtARS(e.saldoAcumulado)}</td>
      <td>${accion}</td>
    </tr>`;
  }).join('');
}

/* ===================== MODAL: REGISTRAR PAGO ===================== */
function abrirModalPago() {
  refreshAllSelects();
  const data = db.get();
  document.getElementById('pago-proveedor').value = state.ctaCteProveedorId || '';
  document.getElementById('pago-fecha').value = todayISO();
  document.getElementById('pago-tc').value = data.parametros.tcActual || '';
  document.getElementById('pago-monto').value = '';
  document.getElementById('pago-monto-usd').value = '';
  document.getElementById('pago-es-anticipo').checked = false;
  document.getElementById('pago-imputacion-section').style.display = '';
  state.modoImputacion = 'auto';
  document.getElementById('pago-modo-auto').classList.add('active');
  document.getElementById('pago-modo-manual').classList.remove('active');
  onPagoProveedorChange();
  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-pago'));
  modal.show();
}

function pagosPendientesProveedor(proveedorId, data) {
  return data.comprobantes.filter(c => c.proveedorId === proveedorId && c.saldoARS > 0.01)
    .sort((a, b) => a.fecha === b.fecha ? a.id.localeCompare(b.id) : (a.fecha < b.fecha ? -1 : 1));
}

function pagoFacturaRowHtml(c, montoImputado, checked, disabled) {
  return `<tr>
    <td><input type="checkbox" id="pago-imp-chk-${c.id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="onPagoManualToggle('${c.id}')"></td>
    <td>${fmtFecha(c.fecha)}</td>
    <td>${escapeHtml((c.tipoComp || 'Comprobante') + ' ' + (c.numero || ''))}</td>
    <td class="text-end">${fmtARS(c.saldoARS)}</td>
    <td><input type="number" step="0.01" min="0" max="${c.saldoARS}" class="form-control form-control-sm" id="pago-imp-monto-${c.id}" value="${montoImputado}" ${disabled ? 'disabled' : ''} oninput="renderPagoResumen()"></td>
  </tr>`;
}

function onPagoProveedorChange() {
  const proveedorId = document.getElementById('pago-proveedor').value;
  const data = db.get();
  const body = document.getElementById('pago-facturas-body');
  if (!proveedorId) { body.innerHTML = ''; renderPagoResumen(); return; }
  const pendientes = pagosPendientesProveedor(proveedorId, data);
  if (pendientes.length === 0) { body.innerHTML = '<tr><td colspan="5" class="text-center text-muted py-2">Sin facturas pendientes</td></tr>'; renderPagoResumen(); return; }
  if (state.modoImputacion === 'auto') {
    const monto = Number(document.getElementById('pago-monto').value) || 0;
    const { imputaciones } = calcularFIFO(proveedorId, monto, data);
    const map = {}; for (const im of imputaciones) map[im.comprobanteId] = im.montoImputado;
    body.innerHTML = pendientes.map(c => pagoFacturaRowHtml(c, map[c.id] || 0, !!map[c.id], true)).join('');
  } else {
    body.innerHTML = pendientes.map(c => pagoFacturaRowHtml(c, 0, false, false)).join('');
  }
  renderPagoResumen();
}

function setModoImputacion(modo) {
  state.modoImputacion = modo;
  document.getElementById('pago-modo-auto').classList.toggle('active', modo === 'auto');
  document.getElementById('pago-modo-manual').classList.toggle('active', modo === 'manual');
  onPagoProveedorChange();
}

function onPagoMontoChange() {
  const tc = Number(document.getElementById('pago-tc').value) || 0;
  const monto = Number(document.getElementById('pago-monto').value) || 0;
  document.getElementById('pago-monto-usd').value = tc > 0 ? fmtUSD(monto / tc) : '';
  if (state.modoImputacion === 'auto') onPagoProveedorChange();
  else renderPagoResumen();
}

function onPagoManualToggle(comprobanteId) {
  const chk = document.getElementById(`pago-imp-chk-${comprobanteId}`);
  const input = document.getElementById(`pago-imp-monto-${comprobanteId}`);
  if (!chk || !input) return;
  if (chk.checked) { input.disabled = false; if (!(Number(input.value) > 0)) input.value = input.max; }
  else { input.disabled = true; input.value = 0; }
  renderPagoResumen();
}

function onPagoEsAnticipoChange() {
  const esAnticipo = document.getElementById('pago-es-anticipo').checked;
  document.getElementById('pago-imputacion-section').style.display = esAnticipo ? 'none' : '';
}

function leerImputacionesDesdeUI(proveedorId, data) {
  const pendientes = pagosPendientesProveedor(proveedorId, data);
  const imputaciones = [];
  for (const c of pendientes) {
    const chk = document.getElementById(`pago-imp-chk-${c.id}`);
    const input = document.getElementById(`pago-imp-monto-${c.id}`);
    if (!chk || !input) continue;
    if (chk.checked) {
      const v = round2(Number(input.value) || 0);
      if (v > 0.005) imputaciones.push({ comprobanteId: c.id, montoImputado: Math.min(v, c.saldoARS) });
    }
  }
  return imputaciones;
}

function renderPagoResumen() {
  const proveedorId = document.getElementById('pago-proveedor').value;
  const monto = round2(Number(document.getElementById('pago-monto').value) || 0);
  const data = db.get();
  const div = document.getElementById('pago-resumen-imputacion');
  if (!proveedorId) { div.innerHTML = ''; return; }
  const imputaciones = leerImputacionesDesdeUI(proveedorId, data);
  const sumaImp = round2(imputaciones.reduce((s, i) => s + i.montoImputado, 0));
  const diff = round2(monto - sumaImp);
  let msg;
  if (diff > 0.005) msg = `<span class="text-success">Sobra ${fmtARS(diff)} → pasará a saldo a favor del proveedor.</span>`;
  else if (diff < -0.005) msg = `<span class="text-danger">La suma imputada (${fmtARS(sumaImp)}) supera el monto del pago (${fmtARS(monto)}).</span>`;
  else msg = `<span class="text-muted">Total imputado: ${fmtARS(sumaImp)}</span>`;
  div.innerHTML = msg;
}

function onGuardarPago() {
  const proveedorId = document.getElementById('pago-proveedor').value;
  const fecha = document.getElementById('pago-fecha').value;
  const tc = Number(document.getElementById('pago-tc').value);
  const monto = round2(Number(document.getElementById('pago-monto').value) || 0);
  const esAnticipo = document.getElementById('pago-es-anticipo').checked;

  if (!proveedorId) return notify('Seleccione un proveedor.', 'danger');
  if (!fecha) return notify('Ingrese la fecha.', 'danger');
  if (!(tc > 0)) return notify('El tipo de cambio debe ser mayor a 0.', 'danger');
  if (!(monto > 0)) return notify('El monto debe ser mayor a 0.', 'danger');

  const data = db.get();
  let imputaciones = [];
  if (!esAnticipo) {
    imputaciones = leerImputacionesDesdeUI(proveedorId, data);
    const sumaImp = round2(imputaciones.reduce((s, i) => s + i.montoImputado, 0));
    if (sumaImp > monto + 0.01) return notify('La suma imputada no puede superar el monto del pago.', 'danger');
    for (const im of imputaciones) {
      const c = data.comprobantes.find(x => x.id === im.comprobanteId);
      if (c && im.montoImputado > c.saldoARS + 0.01) return notify('No se puede imputar más que el saldo de una factura.', 'danger');
    }
  }
  registrarPago({ proveedorId, fecha, tc, montoARS: monto, esAnticipo, imputaciones });
  bootstrap.Modal.getOrCreateInstance(document.getElementById('modal-pago')).hide();
  notify('Pago registrado.');
  renderCtaCte();
  renderComprobantesListado();
}

function exportarExtractoCSV() {
  if (!state.ctaCteProveedorId) return;
  const data = db.get();
  const entries = buildLedgerProveedor(state.ctaCteProveedorId, data);
  const prov = data.proveedores.find(p => p.id === state.ctaCteProveedorId);
  const rows = [['Fecha', 'Tipo', 'Detalle', 'Debe ARS', 'Haber ARS', 'Saldo ARS']];
  for (const e of entries) rows.push([fmtFecha(e.fecha), e.tipo, e.detalle, e.debe || 0, e.haber || 0, e.saldoAcumulado]);
  descargarCSV(rows, `extracto_${(prov ? prov.nombre : 'proveedor').replace(/\s+/g, '_')}.csv`);
}

function exportarExtractoExcel() {
  if (!state.ctaCteProveedorId) return;
  const data = db.get();
  const entries = buildLedgerProveedor(state.ctaCteProveedorId, data);
  const prov = data.proveedores.find(p => p.id === state.ctaCteProveedorId);
  const rows = entries.map(e => ({ Fecha: fmtFecha(e.fecha), Tipo: e.tipo, Detalle: e.detalle, 'Debe ARS': e.debe || 0, 'Haber ARS': e.haber || 0, 'Saldo ARS': e.saldoAcumulado }));
  descargarExcel(rows, `extracto_${(prov ? prov.nombre : 'proveedor').replace(/\s+/g, '_')}.xlsx`, 'Extracto');
}

/* ===================== TABLERO ===================== */
const charts = {};
function upsertChart(key, ctxId, config) {
  if (charts[key]) charts[key].destroy();
  const el = document.getElementById(ctxId);
  if (!el) return;
  charts[key] = new Chart(el, config);
}

function filterComprobantes(data, filtros) {
  filtros = filtros || {};
  return data.comprobantes.filter(c => {
    if (filtros.desde && c.fecha < filtros.desde) return false;
    if (filtros.hasta && c.fecha > filtros.hasta) return false;
    if (filtros.proveedorId && c.proveedorId !== filtros.proveedorId) return false;
    return true;
  });
}

function tcPromedioPonderadoFiltrado(items) {
  const ars = items.reduce((s, x) => s + x.item.total, 0);
  const usd = items.reduce((s, x) => s + x.item.total * tasaUsdEfectiva(x.comprobante), 0);
  return usd > 0 ? ars / usd : tcPromedioPonderado(db.get());
}

function setMonedaVista(moneda) {
  state.monedaVista = moneda;
  for (const prefix of ['tb', 'presu']) {
    const btnArs = document.getElementById(`${prefix}-moneda-ars`);
    const btnUsd = document.getElementById(`${prefix}-moneda-usd`);
    if (btnArs) btnArs.classList.toggle('active', moneda === 'ARS');
    if (btnUsd) btnUsd.classList.toggle('active', moneda === 'USD');
  }
  renderTablero();
  renderPresupuesto();
}

function getTableroFiltros() {
  return {
    desde: document.getElementById('tb-desde').value,
    hasta: document.getElementById('tb-hasta').value,
    rubroId: document.getElementById('tb-rubro').value,
    proveedorId: document.getElementById('tb-proveedor').value,
  };
}

function kpiCardMoneda(label, ars, usd, extraClass) {
  const val = state.monedaVista === 'ARS' ? fmtARS(ars) : fmtUSD(usd);
  return `<div class="col-6 col-md-4 col-lg-3"><div class="card kpi-card h-100 ${extraClass || ''}"><div class="card-body">
    <div class="kpi-label">${label}</div><div class="kpi-value">${val}</div>
  </div></div></div>`;
}
function kpiCardTexto(label, valor, sub) {
  return `<div class="col-6 col-md-4 col-lg-3"><div class="card kpi-card h-100"><div class="card-body">
    <div class="kpi-label">${label}</div><div class="kpi-value">${valor}</div>${sub ? `<div class="kpi-sub">${sub}</div>` : ''}
  </div></div></div>`;
}

function renderTablero() {
  refreshAllSelects();
  const data = db.get();
  const filtros = getTableroFiltros();
  const items = filterItems(data, filtros);
  const comprobantesF = filterComprobantes(data, filtros);
  const rubroMap = {}; for (const r of data.rubros) rubroMap[r.id] = r;

  const gastoARS = round2(items.reduce((s, x) => s + x.item.total, 0));
  const gastoUSD = round2(items.reduce((s, x) => s + x.item.total * tasaUsdEfectiva(x.comprobante), 0));
  const porTipo = {};
  for (const t of RUBRO_TIPOS) porTipo[t] = { ars: 0, usd: 0 };
  for (const x of items) {
    const r = rubroMap[x.item.rubroId];
    const t = (r && porTipo[r.tipo]) ? r.tipo : 'MATERIAL';
    porTipo[t].ars += x.item.total;
    porTipo[t].usd += x.item.total * tasaUsdEfectiva(x.comprobante);
  }

  const tcDiv = tcPromedioPonderadoFiltrado(items);
  const pagadoARS = round2(comprobantesF.reduce((s, c) => s + totalImputadoComprobante(c, data), 0));
  const adeudadoARS = round2(comprobantesF.reduce((s, c) => s + Math.max(0, c.saldoARS), 0));
  const provIdsFiltro = filtros.proveedorId ? [filtros.proveedorId] : data.proveedores.map(p => p.id);
  const favorARS = round2(provIdsFiltro.reduce((s, id) => s + saldoAFavorProveedor(id, data), 0));
  const retenidoARS = round2(provIdsFiltro.reduce((s, id) => s + retencionPendienteProveedor(id, data), 0));

  const exp = exposicionCambiaria(data);
  const tcProm = tcPromedioPonderado(data);

  document.getElementById('tb-kpis').innerHTML =
    kpiCardMoneda('Gasto Total Obra', gastoARS, gastoUSD) +
    RUBRO_TIPOS.map(t => kpiCardMoneda(RUBRO_TIPO_INFO[t].label, round2(porTipo[t].ars), round2(porTipo[t].usd))).join('') +
    kpiCardMoneda('Total Pagado', pagadoARS, tcDiv > 0 ? pagadoARS / tcDiv : 0) +
    kpiCardMoneda('Total Adeudado', adeudadoARS, tcDiv > 0 ? adeudadoARS / tcDiv : 0, adeudadoARS > 0 ? 'border-danger' : '') +
    kpiCardMoneda('Saldo a Favor', favorARS, tcDiv > 0 ? favorARS / tcDiv : 0, favorARS > 0 ? 'border-success' : '') +
    kpiCardMoneda('Retenido Pendiente', retenidoARS, tcDiv > 0 ? retenidoARS / tcDiv : 0) +
    kpiCardTexto('% Avance s/ Presupuesto', fmtPct(avanceGastoTotal(data)), 'Sobre presupuesto total (global)') +
    kpiCardTexto('TC Prom. Ponderado / Actual', `${fmtMonto(tcProm)} / ${fmtMonto(data.parametros.tcActual || 0)}`, `Exposición cambiaria s/saldo pend.: ${fmtARS(exp.diferencia)}`);

  renderTableroAlertas(data);
  renderTableroCharts(data, filtros, items, rubroMap);
}

function renderTableroAlertas(data) {
  const { vencidas, proximas } = alertasVencimiento(data);
  const excedidos = rubrosExcedidos(data);
  const provMap = {}; for (const p of data.proveedores) provMap[p.id] = p;
  let html = '';
  if (vencidas.length || proximas.length) {
    html += `<div class="col-md-6"><div class="alert ${vencidas.length ? 'alert-danger' : 'alert-warning'} mb-0">
      ${vencidas.length ? `<strong><i class="bi bi-exclamation-octagon"></i> Facturas vencidas (${vencidas.length}):</strong><ul class="mb-1">${vencidas.map(c => `<li>${fmtFecha(c.vencimiento)} — ${escapeHtml(provMap[c.proveedorId] ? provMap[c.proveedorId].nombre : '')} (${fmtARS(c.saldoARS)})</li>`).join('')}</ul>` : ''}
      ${proximas.length ? `<strong><i class="bi bi-clock-history"></i> Próximas a vencer (7 días) (${proximas.length}):</strong><ul class="mb-0">${proximas.map(c => `<li>${fmtFecha(c.vencimiento)} — ${escapeHtml(provMap[c.proveedorId] ? provMap[c.proveedorId].nombre : '')} (${fmtARS(c.saldoARS)})</li>`).join('')}</ul>` : ''}
    </div></div>`;
  }
  if (excedidos.length) {
    html += `<div class="col-md-6"><div class="alert alert-warning mb-0"><strong><i class="bi bi-graph-up-arrow"></i> Rubros que excedieron presupuesto:</strong><ul class="mb-0">${excedidos.map(x => `<li>${escapeHtml(x.rubro.nombre)}: ${fmtARS(x.real)} de ${fmtARS(x.presupuestado)} (+${fmtARS(x.desvio)})</li>`).join('')}</ul></div></div>`;
  }
  document.getElementById('tb-alertas').innerHTML = html;
}

function renderTableroCharts(data, filtros, items, rubroMap) {
  const usd = state.monedaVista === 'USD';
  const valorItem = (x) => usd ? x.item.total * tasaUsdEfectiva(x.comprobante) : x.item.total;

  const porRubro = {};
  for (const x of items) {
    const r = rubroMap[x.item.rubroId];
    const nombre = r ? r.nombre : '(sin rubro)';
    porRubro[nombre] = porRubro[nombre] || { total: 0, tipo: r ? r.tipo : 'MATERIAL' };
    porRubro[nombre].total += valorItem(x);
  }
  const rubroNombres = Object.keys(porRubro).sort((a, b) => porRubro[b].total - porRubro[a].total);
  upsertChart('pie', 'chart-pie-rubro', {
    type: 'pie',
    data: { labels: rubroNombres, datasets: [{ data: rubroNombres.map(n => round2(porRubro[n].total)) }] },
    options: { responsive: true, plugins: { legend: { position: 'right' } } },
  });
  upsertChart('barRubro', 'chart-bar-rubro', {
    type: 'bar',
    data: { labels: rubroNombres, datasets: [{ label: usd ? 'USD' : 'ARS', data: rubroNombres.map(n => round2(porRubro[n].total)), backgroundColor: rubroNombres.map(n => (RUBRO_TIPO_INFO[porRubro[n].tipo] || RUBRO_TIPO_INFO.MATERIAL).color) }] },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });

  const porMes = {}; const porMesTipo = {};
  for (const x of items) {
    const m = x.comprobante.fecha.slice(0, 7);
    porMes[m] = (porMes[m] || 0) + valorItem(x);
    const r = rubroMap[x.item.rubroId];
    const tipo = (r && RUBRO_TIPO_INFO[r.tipo]) ? r.tipo : 'MATERIAL';
    porMesTipo[m] = porMesTipo[m] || RUBRO_TIPOS.reduce((acc, t) => { acc[t] = 0; return acc; }, {});
    porMesTipo[m][tipo] += valorItem(x);
  }
  const meses = Object.keys(porMes).sort();
  upsertChart('mensual', 'chart-mensual', {
    type: 'bar',
    data: { labels: meses, datasets: [{ label: usd ? 'Gasto USD' : 'Gasto ARS', data: meses.map(m => round2(porMes[m])), backgroundColor: '#0d6efd' }] },
    options: { responsive: true },
  });
  upsertChart('stackedMes', 'chart-stacked-mes', {
    type: 'bar',
    data: {
      labels: meses,
      datasets: RUBRO_TIPOS.map(t => ({ label: RUBRO_TIPO_INFO[t].label, data: meses.map(m => round2(porMesTipo[m][t])), backgroundColor: RUBRO_TIPO_INFO[t].color })),
    },
    options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true } } },
  });

  const porProveedor = {};
  for (const x of items) {
    const prov = data.proveedores.find(p => p.id === x.comprobante.proveedorId);
    const nombre = prov ? prov.nombre : '(sin proveedor)';
    porProveedor[nombre] = (porProveedor[nombre] || 0) + valorItem(x);
  }
  const topProv = Object.keys(porProveedor).sort((a, b) => porProveedor[b] - porProveedor[a]).slice(0, 8);
  upsertChart('topProv', 'chart-top-proveedores', {
    type: 'bar',
    data: { labels: topProv, datasets: [{ label: usd ? 'USD' : 'ARS', data: topProv.map(n => round2(porProveedor[n])), backgroundColor: '#198754' }] },
    options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false } } },
  });

  const curva = buildCurvaS(data, filtros);
  upsertChart('curvaS', 'chart-curva-s', {
    type: 'line',
    data: { labels: curva.meses, datasets: [
      { label: 'Real Acumulado (ARS)', data: curva.real, borderColor: '#0d6efd', backgroundColor: '#0d6efd', tension: .2 },
      { label: 'Plan Acumulado (ARS, aprox.)', data: curva.plan, borderColor: '#6c757d', backgroundColor: '#6c757d', borderDash: [6, 4], tension: .2 },
    ] },
    options: { responsive: true },
  });

  const flujo = flujoCajaProyectado(data);
  upsertChart('flujoCaja', 'chart-flujo-caja', {
    type: 'bar',
    data: { labels: flujo.map(f => f.mes), datasets: [{ label: 'Saldo pendiente ARS', data: flujo.map(f => f.monto), backgroundColor: '#dc3545' }] },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
}

/* ===================== PRESUPUESTO ===================== */
function semaforoPresupuesto(pct, presupuestado) {
  if (!(presupuestado > 0)) return { dot: '', label: '<span class="text-muted">Sin presupuesto</span>' };
  if (pct < 80) return { dot: 'semaforo-verde', label: 'OK' };
  if (pct <= 100) return { dot: 'semaforo-ambar', label: 'Atención' };
  return { dot: 'semaforo-rojo', label: 'Excedido' };
}

function renderPresupuesto() {
  const data = db.get();
  const rubros = rubrosActivos(data);
  const usd = state.monedaVista === 'USD';
  const fmtMoneda = usd ? fmtUSD : fmtARS;
  const tcActual = data.parametros.tcActual || 0;
  let totalPresuARS = 0, totalRealARS = 0, totalRealUSD = 0;
  const filas = rubros.map(r => {
    const presuARS = getPresupuesto(r.id, data).montoPresupuestadoARS;
    const realARS = gastoPorRubro(r.id, data, {});
    const realUSD = gastoPorRubroUSD(r.id, data, {});
    totalPresuARS += presuARS; totalRealARS += realARS; totalRealUSD += realUSD;
    const presuUSD = tcActual > 0 ? round2(presuARS / tcActual) : 0;
    const presuMostrado = usd ? presuUSD : presuARS;
    const realMostrado = usd ? realUSD : realARS;
    const pct = presuMostrado > 0 ? round2(realMostrado / presuMostrado * 100) : 0;
    const desvioMostrado = round2(realMostrado - presuMostrado);
    const sem = semaforoPresupuesto(pct, presuMostrado);
    return `<tr>
      <td>${escapeHtml(r.nombre)}</td>
      <td><span class="badge bg-${RUBRO_TIPO_INFO[r.tipo] ? RUBRO_TIPO_INFO[r.tipo].badge : 'secondary'}">${r.tipo}</span></td>
      <td><input type="number" min="0" step="0.01" class="form-control form-control-sm" value="${presuARS}" onchange="onCambiarPresupuesto('${r.id}', this.value)"></td>
      <td class="text-end">${fmtMoneda(realMostrado)}</td>
      <td class="text-end ${desvioMostrado > 0 ? 'text-danger' : 'text-success'}">${fmtMoneda(desvioMostrado)}</td>
      <td class="text-end">${presuMostrado > 0 ? fmtPct(pct) : '—'}</td>
      <td><span class="semaforo-dot ${sem.dot}"></span>${sem.label}</td>
    </tr>`;
  });
  document.getElementById('presu-body').innerHTML = filas.join('') || '<tr><td colspan="7" class="text-center text-muted py-3">Sin rubros activos</td></tr>';

  const totalPresuUSD = tcActual > 0 ? round2(totalPresuARS / tcActual) : 0;
  const totalPresuMostrado = usd ? totalPresuUSD : totalPresuARS;
  const totalRealMostrado = usd ? totalRealUSD : totalRealARS;
  const totalPct = totalPresuMostrado > 0 ? round2(totalRealMostrado / totalPresuMostrado * 100) : 0;
  document.getElementById('presu-foot').innerHTML = `<tr class="fw-semibold"><td colspan="2">TOTAL</td><td>${fmtMoneda(totalPresuMostrado)}</td><td class="text-end">${fmtMoneda(totalRealMostrado)}</td><td class="text-end">${fmtMoneda(round2(totalRealMostrado - totalPresuMostrado))}</td><td class="text-end">${totalPresuMostrado > 0 ? fmtPct(totalPct) : '—'}</td><td></td></tr>`;

  document.getElementById('presu-kpis').innerHTML =
    kpiCardMoneda('Presupuesto Total', totalPresuARS, totalPresuUSD) +
    kpiCardMoneda('Real Total', totalRealARS, totalRealUSD) +
    kpiCardMoneda('Desvío Total', round2(totalRealARS - totalPresuARS), round2(totalRealUSD - totalPresuUSD)) +
    kpiCardTexto('% Avance', totalPresuMostrado > 0 ? fmtPct(totalPct) : '—');
}

function onCambiarPresupuesto(rubroId, valor) {
  setPresupuesto(rubroId, Number(valor) || 0);
  renderPresupuesto();
}

/* ===================== RUBROS (ABM) ===================== */
function renderRubros() {
  const data = db.get();
  const rubros = data.rubros.slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
  const { rubrosUsados } = escanearUsoGlobal();
  document.getElementById('rubros-body').innerHTML = rubros.map(r => {
    const enUso = rubrosUsados.has(r.id);
    return `<tr>
      <td>${escapeHtml(r.nombre)}</td>
      <td><span class="badge bg-${RUBRO_TIPO_INFO[r.tipo] ? RUBRO_TIPO_INFO[r.tipo].badge : 'secondary'}">${r.tipo}</span></td>
      <td>${r.activo ? '<span class="badge bg-success">Activo</span>' : '<span class="badge bg-secondary">Inactivo</span>'}</td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-primary" onclick="editarRubro('${r.id}')"><i class="bi bi-pencil"></i></button>
        ${r.activo
          ? `<button class="btn btn-sm btn-outline-warning" onclick="if(confirm('¿Inactivar este rubro?')){ inactivarRubro('${r.id}'); }"><i class="bi bi-eye-slash"></i></button>`
          : `<button class="btn btn-sm btn-outline-success" onclick="reactivarRubro('${r.id}');renderRubros();refreshAllSelects();"><i class="bi bi-eye"></i></button>`}
        <button class="btn btn-sm btn-outline-danger" ${enUso ? 'disabled title="Tiene comprobantes asociados"' : ''} onclick="if(confirm('¿Borrar este rubro?')){ borrarOInactivarRubro('${r.id}'); renderRubros(); refreshAllSelects(); }"><i class="bi bi-trash"></i></button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="text-center text-muted py-3">Sin rubros</td></tr>';
}

function onGuardarRubro() {
  const nombre = document.getElementById('rubro-nombre').value.trim();
  const tipo = document.getElementById('rubro-tipo').value;
  if (!nombre) return notify('Ingrese el nombre del rubro.', 'danger');
  guardarRubro({ id: state.editingRubroId, nombre, tipo });
  notify(state.editingRubroId ? 'Rubro actualizado.' : 'Rubro creado.');
  cancelarEdicionRubro();
  renderRubros();
  refreshAllSelects();
  renderPresupuesto();
}

function editarRubro(id) {
  const r = db.get().rubros.find(x => x.id === id);
  if (!r) return;
  state.editingRubroId = id;
  document.getElementById('rubro-nombre').value = r.nombre;
  document.getElementById('rubro-tipo').value = r.tipo;
  document.getElementById('rubro-form-title').textContent = 'Editar Rubro';
  document.getElementById('btn-rubro-cancelar').style.display = '';
}

function cancelarEdicionRubro() {
  state.editingRubroId = null;
  document.getElementById('rubro-nombre').value = '';
  document.getElementById('rubro-tipo').value = 'MATERIAL';
  document.getElementById('rubro-form-title').textContent = 'Nuevo Rubro';
  document.getElementById('btn-rubro-cancelar').style.display = 'none';
}

/* ===================== PROVEEDORES (ABM) ===================== */
function renderProveedores() {
  const data = db.get();
  const provs = data.proveedores.slice().sort((a, b) => a.nombre.localeCompare(b.nombre));
  const { proveedoresUsados } = escanearUsoGlobal();
  document.getElementById('provs-body').innerHTML = provs.map(p => {
    const tieneMov = proveedoresUsados.has(p.id);
    return `<tr>
      <td>${escapeHtml(p.nombre)}</td>
      <td>${escapeHtml(p.cuit || '')}</td>
      <td>${escapeHtml(p.contacto || '')}</td>
      <td>${escapeHtml(p.email || '')}</td>
      <td>${escapeHtml(p.tel || '')}</td>
      <td>${escapeHtml(p.notas || '')}</td>
      <td>${p.activo ? '<span class="badge bg-success">Activo</span>' : '<span class="badge bg-secondary">Inactivo</span>'}</td>
      <td class="text-nowrap">
        <button class="btn btn-sm btn-outline-primary" onclick="editarProveedor('${p.id}')"><i class="bi bi-pencil"></i></button>
        ${p.activo
          ? `<button class="btn btn-sm btn-outline-warning" onclick="if(confirm('¿Inactivar este proveedor?')){ inactivarProveedor('${p.id}'); }"><i class="bi bi-eye-slash"></i></button>`
          : `<button class="btn btn-sm btn-outline-success" onclick="reactivarProveedor('${p.id}');renderProveedores();refreshAllSelects();"><i class="bi bi-eye"></i></button>`}
        <button class="btn btn-sm btn-outline-danger" ${tieneMov ? 'disabled title="Tiene movimientos asociados"' : ''} onclick="if(confirm('¿Borrar este proveedor?')){ borrarOInactivarProveedor('${p.id}'); renderProveedores(); refreshAllSelects(); }"><i class="bi bi-trash"></i></button>
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" class="text-center text-muted py-3">Sin proveedores</td></tr>';
}

function onGuardarProveedor() {
  const nombre = document.getElementById('prov-nombre').value.trim();
  if (!nombre) return notify('Ingrese el nombre del proveedor.', 'danger');
  guardarProveedor({
    id: state.editingProveedorId, nombre,
    cuit: document.getElementById('prov-cuit').value.trim(),
    contacto: document.getElementById('prov-contacto').value.trim(),
    email: document.getElementById('prov-email').value.trim(),
    tel: document.getElementById('prov-tel').value.trim(),
    notas: document.getElementById('prov-notas').value.trim(),
  });
  notify(state.editingProveedorId ? 'Proveedor actualizado.' : 'Proveedor creado.');
  cancelarEdicionProveedor();
  renderProveedores();
  refreshAllSelects();
}

function editarProveedor(id) {
  const p = db.get().proveedores.find(x => x.id === id);
  if (!p) return;
  state.editingProveedorId = id;
  document.getElementById('prov-nombre').value = p.nombre;
  document.getElementById('prov-cuit').value = p.cuit || '';
  document.getElementById('prov-contacto').value = p.contacto || '';
  document.getElementById('prov-email').value = p.email || '';
  document.getElementById('prov-tel').value = p.tel || '';
  document.getElementById('prov-notas').value = p.notas || '';
  document.getElementById('prov-form-title').textContent = 'Editar Proveedor';
  document.getElementById('btn-prov-cancelar').style.display = '';
}

function cancelarEdicionProveedor() {
  state.editingProveedorId = null;
  document.getElementById('prov-nombre').value = '';
  document.getElementById('prov-cuit').value = '';
  document.getElementById('prov-contacto').value = '';
  document.getElementById('prov-email').value = '';
  document.getElementById('prov-tel').value = '';
  document.getElementById('prov-notas').value = '';
  document.getElementById('prov-form-title').textContent = 'Nuevo Proveedor';
  document.getElementById('btn-prov-cancelar').style.display = 'none';
}

/* ===================== EXPORTACIONES (CSV / EXCEL / BACKUP) ===================== */
function descargarArchivoBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function descargarCSV(rows, filename) {
  const content = rows.map(r => r.map(csvEscape).join(';')).join('\r\n');
  descargarArchivoBlob('﻿' + content, filename, 'text/csv;charset=utf-8;');
}

function descargarExcel(rowsObjArray, filename, sheetName) {
  const ws = XLSX.utils.json_to_sheet(rowsObjArray);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Hoja1');
  XLSX.writeFile(wb, filename);
}

function exportarComprobantesExcel() {
  const data = db.get();
  const rows = data.comprobantes.map(c => {
    const prov = data.proveedores.find(p => p.id === c.proveedorId);
    return {
      Fecha: fmtFecha(c.fecha), Proveedor: prov ? prov.nombre : '', Tipo: c.tipoComp || '', Numero: c.numero || '',
      TC: c.tc, 'Total ARS': c.totalARS, 'Total USD': c.totalUSD, 'Retención %': c.retencionPct || 0,
      'Retención ARS': c.retencionARS || 0, 'Retención Liberada': c.retencionLiberada ? 'Sí' : 'No',
      'Saldo ARS': c.saldoARS, Estado: c.estado, Vencimiento: c.vencimiento ? fmtFecha(c.vencimiento) : '',
    };
  });
  descargarExcel(rows, `comprobantes_${todayISO()}.xlsx`, 'Comprobantes');
}

function ctaCteGeneralRows(data) {
  return data.proveedores.map(p => ({
    Proveedor: p.nombre,
    'Facturado ARS': totalFacturadoProveedor(p.id, data),
    'Pagado ARS': totalPagadoProveedor(p.id, data),
    'Saldo Deudor ARS': saldoDeudorProveedor(p.id, data),
    'Saldo a Favor ARS': saldoAFavorProveedor(p.id, data),
    'Retenido Pendiente ARS': retencionPendienteProveedor(p.id, data),
  }));
}
function exportarCtaCteGeneralExcel() { descargarExcel(ctaCteGeneralRows(db.get()), `cuenta_corriente_${todayISO()}.xlsx`, 'CtaCte'); }
function exportarCtaCteGeneralCSV() {
  const data = db.get();
  const rows = [['Proveedor', 'Facturado ARS', 'Pagado ARS', 'Saldo Deudor ARS', 'Saldo a Favor ARS', 'Retenido Pendiente ARS']];
  for (const r of ctaCteGeneralRows(data)) rows.push(Object.values(r));
  descargarCSV(rows, `cuenta_corriente_${todayISO()}.csv`);
}

function exportarBackup() {
  descargarArchivoBlob(JSON.stringify(db.get(), null, 2), `backup_obra_${todayISO()}.json`, 'application/json');
  notify('Backup exportado.');
}

function onImportarBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  if (!confirm('Importar este backup reemplazará TODOS los datos actuales. ¿Continuar?')) { event.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const base = defaultData();
      const merged = Object.assign(base, parsed, {
        parametros: Object.assign({}, base.parametros, parsed.parametros || {}),
        meta: Object.assign({}, base.meta, parsed.meta || {}),
      });
      db.set(merged);
      recalcTodo();
      state.ctaCteProveedorId = null;
      document.getElementById('ctacte-extracto-card').style.display = 'none';
      renderAll();
      notify('Backup importado correctamente.');
    } catch (e) {
      console.error(e);
      notify('El archivo no es un backup válido.', 'danger');
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

/* ===================== OBRAS (multi-obra) ===================== */
function renderObraHeader() {
  const obras = obrasRegistry.listar();
  const activaId = obrasRegistry.activaId();
  const activa = obrasRegistry.obraActiva();
  document.getElementById('hdr-nombre-obra').textContent = activa ? activa.nombre : 'SGO';
  const sel = document.getElementById('obra-selector');
  sel.innerHTML = obras.map(o => `<option value="${o.id}" ${o.id === activaId ? 'selected' : ''}>${escapeHtml(o.nombre)}</option>`).join('');
  document.getElementById('btn-nueva-obra').disabled = obras.length >= MAX_OBRAS;
}

function renderObrasManagement() {
  const obras = obrasRegistry.listar();
  const activaId = obrasRegistry.activaId();
  document.getElementById('obras-management-body').innerHTML = obras.map(o => `<tr class="${o.id === activaId ? 'table-primary' : ''}">
    <td>${escapeHtml(o.nombre)}${o.id === activaId ? ' <span class="badge bg-primary">Activa</span>' : ''}</td>
    <td>${fmtFecha((o.createdAt || '').slice(0, 10))}</td>
    <td class="text-nowrap">
      ${o.id === activaId ? '' : `<button class="btn btn-sm btn-outline-primary" onclick="cambiarObraActiva('${o.id}')"><i class="bi bi-check2-circle"></i> Activar</button>`}
      <button class="btn btn-sm btn-outline-secondary" onclick="onRenombrarObra('${o.id}')"><i class="bi bi-pencil"></i></button>
      <button class="btn btn-sm btn-outline-danger" ${obras.length <= 1 ? 'disabled title="Debe existir al menos una obra"' : ''} onclick="onEliminarObra('${o.id}')"><i class="bi bi-trash"></i></button>
    </td>
  </tr>`).join('');
  document.getElementById('btn-nueva-obra-datos').disabled = obras.length >= MAX_OBRAS;
  document.getElementById('obras-limite-hint').textContent = `${obras.length} / ${MAX_OBRAS}`;
}

function cambiarObraActiva(id) {
  if (id === obrasRegistry.activaId()) return;
  obrasRegistry.setActiva(id);
  state.ctaCteProveedorId = null;
  document.getElementById('ctacte-extracto-card').style.display = 'none';
  recalcTodo({ persist: false });
  limpiarFormComprobante();
  cancelarEdicionRubro();
  cancelarEdicionProveedor();
  renderAll();
}

function onCambiarObraSelector() {
  cambiarObraActiva(document.getElementById('obra-selector').value);
}

function onCrearObra() {
  if (obrasRegistry.listar().length >= MAX_OBRAS) return notify(`Ya hay ${MAX_OBRAS} obras, el máximo permitido.`, 'danger');
  const nombre = prompt('Nombre de la nueva obra:');
  if (nombre === null) return;
  const o = obrasRegistry.crear(nombre);
  if (!o) return notify(`Ya hay ${MAX_OBRAS} obras, el máximo permitido.`, 'danger');
  cambiarObraActiva(o.id);
  notify(`Obra "${o.nombre}" creada.`);
}

function onRenombrarObra(id) {
  const o = obrasRegistry.listar().find(x => x.id === id);
  if (!o) return;
  const nombre = prompt('Nuevo nombre de la obra:', o.nombre);
  if (nombre === null) return;
  obrasRegistry.renombrar(id, nombre);
  renderObraHeader();
  renderObrasManagement();
}

function onEliminarObra(id) {
  const o = obrasRegistry.listar().find(x => x.id === id);
  if (!o) return;
  if (obrasRegistry.listar().length <= 1) return notify('Debe existir al menos una obra.', 'danger');
  if (!confirm(`¿Eliminar la obra "${o.nombre}" y TODOS sus datos (comprobantes, pagos, proveedores, presupuestos)? Esta acción no se puede deshacer.`)) return;
  const eraActiva = id === obrasRegistry.activaId();
  obrasRegistry.eliminar(id);
  if (eraActiva) {
    state.ctaCteProveedorId = null;
    document.getElementById('ctacte-extracto-card').style.display = 'none';
    recalcTodo({ persist: false });
    renderAll();
  } else {
    renderObraHeader();
    renderObrasManagement();
  }
  notify('Obra eliminada.');
}

/* ===================== PARÁMETROS ===================== */
function actualizarHeaderTC() {
  const data = db.get();
  document.getElementById('hdr-tc-actual').textContent = data.parametros.tcActual ? `TC actual: ${fmtMonto(data.parametros.tcActual)}` : '';
}

function onGuardarParametros() {
  const data = db.get();
  data.parametros.tcActual = Number(document.getElementById('param-tc-actual').value) || 0;
  db.save();
  actualizarHeaderTC();
  notify('Parámetros guardados.');
}

/* ===================== DATOS DE EJEMPLO ===================== */
function cargarDatosDemo() {
  if (!confirm('Esto agregará datos de ejemplo a la base actual (no borra lo existente). ¿Continuar?')) return;
  const base = new Date(); base.setMonth(base.getMonth() - 3);
  const mkFecha = (offsetDias) => { const d = new Date(base); d.setDate(d.getDate() + offsetDias); return d.toISOString().slice(0, 10); };

  const rubros = db.get().rubros;
  const idDe = (slug) => rubros.find(r => r.id === slug).id;
  const rMatObra = idDe('mat-obra-gruesa'), rMatElec = idDe('mat-electricidad'), rMoAlb = idDe('mo-albanileria'), rMoPlom = idDe('mo-plomeria');

  guardarComprobante({ fecha: mkFecha(0), proveedorNombre: 'CASA PEPE', tipoComp: 'Factura B', numero: '0001-00001234', tc: 1000, rubroDefaultId: rMatObra, retencionPct: 0, items: [{ descripcion: 'Cemento y áridos', rubroId: rMatObra, montoUnit: 100, cantidad: 1, total: 100 }] });
  guardarComprobante({ fecha: mkFecha(5), proveedorNombre: 'CASA PEPE', tipoComp: 'Factura B', numero: '0001-00001255', tc: 1000, rubroDefaultId: rMatObra, retencionPct: 0, items: [{ descripcion: 'Ladrillos', rubroId: rMatObra, montoUnit: 100, cantidad: 1, total: 100 }] });
  guardarComprobante({ fecha: mkFecha(10), proveedorNombre: 'CASA PEPE', tipoComp: 'Factura B', numero: '0001-00001299', tc: 1000, rubroDefaultId: rMatObra, retencionPct: 0, items: [{ descripcion: 'Hierro', rubroId: rMatObra, montoUnit: 200, cantidad: 1, total: 200 }] });
  guardarComprobante({ fecha: mkFecha(15), proveedorNombre: 'CASA PEPE', tipoComp: 'Factura B', numero: '0001-00001310', tc: 1000, rubroDefaultId: rMatObra, retencionPct: 0, items: [{ descripcion: 'Cal y arena', rubroId: rMatObra, montoUnit: 200, cantidad: 1, total: 200 }] });
  const casaPepe = db.get().proveedores.find(p => p.nombre === 'CASA PEPE');
  registrarPago({ proveedorId: casaPepe.id, fecha: mkFecha(20), tc: 1000, montoARS: 350, esAnticipo: false, imputaciones: calcularFIFO(casaPepe.id, 350, db.get()).imputaciones });

  guardarComprobante({ fecha: mkFecha(8), proveedorNombre: 'ELECTRICISTA SRL', tipoComp: 'Factura A', numero: '0002-00000511', tc: 1020, rubroDefaultId: rMoAlb, retencionPct: 10, items: [{ descripcion: 'Instalación eléctrica planta baja', rubroId: rMoAlb, montoUnit: 50000, cantidad: 1, total: 50000 }] });

  const venc = new Date(); venc.setDate(venc.getDate() + 3);
  guardarComprobante({ fecha: mkFecha(25), proveedorNombre: 'PLOMERIA HNOS', tipoComp: 'Factura A', numero: '0003-00000099', tc: 1050, vencimiento: venc.toISOString().slice(0, 10), rubroDefaultId: rMoPlom, retencionPct: 0, items: [{ descripcion: 'Mano de obra plomería', rubroId: rMoPlom, montoUnit: 30000, cantidad: 1, total: 30000 }] });

  guardarComprobante({ fecha: mkFecha(40), proveedorNombre: 'CORRALON NORTE', tipoComp: 'Factura B', numero: '0004-00002001', tc: 1080, rubroDefaultId: rMatElec, retencionPct: 0, items: [{ descripcion: 'Cableado y tableros', rubroId: rMatElec, montoUnit: 80000, cantidad: 1, total: 80000 }] });

  setPresupuesto(rMatObra, 1000);
  setPresupuesto(rMatElec, 100000);
  setPresupuesto(rMoAlb, 60000);
  setPresupuesto(rMoPlom, 40000);

  notify('Datos de ejemplo cargados.');
  renderAll();
}

function borrarTodosLosDatos() {
  if (!confirm('Esto borrará los comprobantes, pagos y presupuesto de ESTA obra. Los proveedores y rubros son compartidos con las demás obras y no se modifican. ¿Continuar?')) return;
  db.reset();
  state.ctaCteProveedorId = null;
  document.getElementById('ctacte-extracto-card').style.display = 'none';
  renderAll();
  notify('Todos los datos fueron borrados.');
}

/* ===================== INIT ===================== */
function renderAll() {
  renderObraHeader();
  renderObrasManagement();
  refreshAllSelects();
  renderComprobantesListado();
  renderCtaCte();
  renderTablero();
  renderPresupuesto();
  renderRubros();
  renderProveedores();
  const data = db.get();
  document.getElementById('param-tc-actual').value = data.parametros.tcActual;
  actualizarHeaderTC();
}

/* ===================== SINCRONIZACIÓN (UI) ===================== */
/* El estado de guardado lo publica sgoStore; acá solo se pinta. */

function renderEstadoSync(s) {
  const hdr = document.getElementById('hdr-last-action');
  if (hdr) {
    if (s.estado === 'saving') hdr.textContent = 'Guardando…';
    else if (s.estado === 'offline') hdr.textContent = 'Sin conexión — reintentando';
    else if (s.ultimoGuardado) hdr.textContent = 'Guardado ' + s.ultimoGuardado.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    else hdr.textContent = 'Sistema de Gestión de Control de Gastos de Obra';
  }
}

function mostrarErrorFatal(mensaje) {
  const banner = document.getElementById('sync-fatal-banner');
  if (banner) {
    document.getElementById('sync-fatal-msg').textContent = mensaje;
    banner.style.display = '';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Único punto asincrónico: traer la base del server antes de arrancar. Si
  // falla, NO se sigue: una app con datos vacíos parecería haberlos perdido y
  // el usuario empezaría a cargar encima.
  try {
    await sgoStore.hydrate();
  } catch (err) {
    console.error('No se pudo cargar la base', err);
    mostrarErrorFatal('No se pudo conectar con el servidor. Recargá la página; si sigue, avisá.');
    return;
  }

  sgoStore.onEstado(renderEstadoSync);

  recalcTodo({ persist: false });
  limpiarFormComprobante();
  cancelarEdicionRubro();
  cancelarEdicionProveedor();
  renderAll();

  document.querySelectorAll('#nav-tabs-main button[data-bs-toggle="tab"]').forEach(btn => {
    btn.addEventListener('shown.bs.tab', (e) => {
      const target = e.target.getAttribute('data-bs-target');
      if (target === '#pane-tablero') renderTablero();
      else if (target === '#pane-ctacte') renderCtaCte();
      else if (target === '#pane-presupuesto') renderPresupuesto();
      else if (target === '#pane-rubros') renderRubros();
      else if (target === '#pane-proveedores') renderProveedores();
      else if (target === '#pane-comprobantes') renderComprobantesListado();
    });
  });

  // Ya no se guarda acá: un fetch disparado en beforeunload no llega. sgoStore
  // pide confirmación si quedan escrituras sin confirmar.
  window.addEventListener('beforeunload', (e) => sgoStore.beforeUnload(e));

  // Si el browser restaura esta página desde bfcache (volver atrás, gestos,
  // pestaña suspendida y reanudada), NO vuelve a correr este script: el JS
  // queda congelado tal cual estaba, banner de conflicto incluido, sin
  // importar qué haya cambiado en el server desde entonces. Forzar una
  // recarga real en ese caso es la única forma de que el estado no quede
  // pegado indefinidamente.
  window.addEventListener('pageshow', (e) => { if (e.persisted) location.reload(); });
});
