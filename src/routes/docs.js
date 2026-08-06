/**
 * API de documentos. Un endpoint genérico clave → blob JSON, con versionado
 * optimista. El server no interpreta el contenido; solo lo guarda y arbitra
 * quién escribió último.
 *
 * Endpoints:
 *   GET    /api/docs                  bootstrap: todos los documentos de una
 *   GET    /api/docs/:key
 *   PUT    /api/docs/:key             { data, version }
 *   DELETE /api/docs/:key?version=N
 *   POST   /api/docs/batch            { docs: [{ key, data, version }] }  (transaccional)
 */
import { ConflictError } from '../db.js';

/* ===================== WHITELIST DE CLAVES ===================== */
/* `:key` es input del usuario y va directo a la PK de la tabla. Sin esta
   validación cualquiera con la URL llena la base de documentos basura. */

const KEY_OBRAS_REGISTRY = 'sgo_obras_v1';
const KEY_GLOBAL_CATALOG = 'sgo_global_v1';
const OBRA_DATA_PREFIX = 'obra_db_v1__';
const OBRA_ID_RE = /^[a-z0-9_]{1,64}$/;

export function isAllowedKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (key === KEY_OBRAS_REGISTRY || key === KEY_GLOBAL_CATALOG) return true;
  if (!key.startsWith(OBRA_DATA_PREFIX)) return false;
  return OBRA_ID_RE.test(key.slice(OBRA_DATA_PREFIX.length));
}

function isValidVersion(v) {
  return Number.isInteger(v) && v >= 0;
}

/** `data` puede ser cualquier JSON serializable menos undefined. */
function isValidData(data) {
  return data !== undefined;
}

export default async function docsRoutes(fastify, opts) {
  const { store } = opts;

  const badKey = (reply, key) =>
    reply.code(400).send({ error: 'invalid_key', message: `Clave no permitida: ${key}` });

  /* ---------- bootstrap: todos los documentos ---------- */
  /* El front necesita TODOS los docs, no solo el de la obra activa:
     escanearUsoGlobal() recorre todas las obras en cada render. Son ≤7
     documentos (registro + catálogo + hasta 5 obras), del orden de KB. */
  fastify.get('/docs', async () => {
    return { docs: await store.getAll() };
  });

  /* ---------- lectura suelta ---------- */
  fastify.get('/docs/:key', async (request, reply) => {
    const { key } = request.params;
    if (!isAllowedKey(key)) return badKey(reply, key);

    const doc = await store.get(key);
    if (!doc) return reply.code(404).send({ error: 'not_found', key });
    return doc;
  });

  /* ---------- escritura suelta ---------- */
  fastify.put('/docs/:key', async (request, reply) => {
    const { key } = request.params;
    if (!isAllowedKey(key)) return badKey(reply, key);

    const body = request.body;
    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'invalid_body', message: 'Se esperaba { data, version }' });
    }
    if (!isValidData(body.data)) {
      return reply.code(400).send({ error: 'invalid_body', message: 'Falta `data`' });
    }
    if (!isValidVersion(body.version)) {
      return reply.code(400).send({ error: 'invalid_body', message: '`version` debe ser un entero >= 0' });
    }

    const res = await store.put(key, body.data, body.version);
    if (!res.ok) {
      request.log.warn(
        { key, expected: res.expected, actual: res.current.version },
        'version_conflict'
      );
      return reply.code(409).send({ error: 'version_conflict', key, current: res.current });
    }
    return { key, version: res.version };
  });

  /* ---------- borrado ---------- */
  fastify.delete('/docs/:key', async (request, reply) => {
    const { key } = request.params;
    if (!isAllowedKey(key)) return badKey(reply, key);

    const version = Number.parseInt(request.query.version, 10);
    if (!isValidVersion(version)) {
      return reply
        .code(400)
        .send({ error: 'invalid_version', message: 'Falta el query param `version` (entero >= 0)' });
    }

    const res = await store.remove(key, version);
    if (res.notFound) return reply.code(404).send({ error: 'not_found', key });
    if (!res.ok) {
      request.log.warn({ key, expected: version, actual: res.current.version }, 'version_conflict');
      return reply.code(409).send({ error: 'version_conflict', key, current: res.current });
    }
    return reply.code(204).send();
  });

  /* ---------- escritura múltiple, todo o nada ---------- */
  /* db.save() en el front escribe el doc de la obra y el catálogo global
     juntos: deben quedar consistentes o no quedar. */
  fastify.post('/docs/batch', async (request, reply) => {
    const docs = request.body && request.body.docs;
    if (!Array.isArray(docs) || docs.length === 0) {
      return reply.code(400).send({ error: 'invalid_body', message: 'Se esperaba { docs: [...] } no vacío' });
    }

    const seen = new Set();
    for (const doc of docs) {
      if (!doc || typeof doc !== 'object') {
        return reply.code(400).send({ error: 'invalid_body', message: 'Documento inválido en `docs`' });
      }
      if (!isAllowedKey(doc.key)) return badKey(reply, doc.key);
      if (!isValidData(doc.data)) {
        return reply.code(400).send({ error: 'invalid_body', message: `Falta \`data\` en ${doc.key}` });
      }
      if (!isValidVersion(doc.version)) {
        return reply
          .code(400)
          .send({ error: 'invalid_body', message: `\`version\` inválida en ${doc.key}` });
      }
      if (seen.has(doc.key)) {
        return reply.code(400).send({ error: 'invalid_body', message: `Clave repetida: ${doc.key}` });
      }
      seen.add(doc.key);
    }

    try {
      const results = await store.putMany(docs);
      return { results };
    } catch (err) {
      if (err instanceof ConflictError) {
        request.log.warn({ conflicts: err.conflicts.map((c) => c.key) }, 'version_conflict');
        return reply.code(409).send({ error: 'version_conflict', conflicts: err.conflicts });
      }
      throw err;
    }
  });
}
