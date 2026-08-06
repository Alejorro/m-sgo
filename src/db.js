/**
 * Capa de persistencia: Postgres (pg) usado como store documental.
 *
 * El server NO entiende el contenido de los documentos: guarda el mismo blob
 * JSON que el front arma hoy en localStorage, opaco, en una columna JSONB.
 * En particular NO hace aritmética de plata (ver CLAUDE.md §1): el JSON entra
 * y sale igual, y `jsonb` guarda los números como `numeric` (precisión
 * decimal exacta), así que ningún monto cambia de valor al ir y volver.
 *
 * Concurrencia optimista: cada documento tiene una `version` que arranca en 1
 * y sube de a uno. Una escritura declara qué versión creyó estar editando; si
 * no coincide con la de la fila, se rechaza en vez de pisar.
 */
import pg from 'pg';

const { Pool } = pg;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  key        TEXT PRIMARY KEY,
  json       JSONB NOT NULL,
  version    INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

/** Se lanza dentro de una transacción para forzar el rollback del batch entero. */
export class ConflictError extends Error {
  constructor(conflicts) {
    super('version_conflict');
    this.name = 'ConflictError';
    this.conflicts = conflicts;
  }
}

/**
 * SSL según dónde vive la base.
 *
 * Dentro de Railway la app habla con Postgres por la red privada
 * (`*.railway.internal`), que no ofrece TLS: pedirlo ahí hace fallar la
 * conexión. Contra cualquier host externo (el proxy público de Railway, una
 * base gestionada) sí va TLS, pero sin verificar la cadena: el certificado es
 * autofirmado y no hay CA para validarlo.
 */
export function sslPara(connectionString) {
  let host = '';
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return false;
  }
  const esLocal =
    host.endsWith('.railway.internal') ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '';
  return esLocal ? false : { rejectUnauthorized: false };
}

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Abre el pool y crea la tabla si no existe.
 *
 * Reintenta la primera conexión: Railway levanta la app y la base en paralelo,
 * así que en un deploy es normal que los primeros intentos den ECONNREFUSED
 * durante unos segundos. Preferimos esperar a morir y hacer fallar el
 * healthcheck.
 */
export async function openStore(connectionString, opts = {}) {
  const { intentos = 6, esperaMs = 2000, log } = opts;

  const pool = new Pool({
    connectionString,
    ssl: sslPara(connectionString),
    max: 5,
    // Si la base no contesta, que el request muera con error en vez de colgarse.
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });

  // Un error en un cliente ocioso del pool (la base se reinició, por ejemplo)
  // llega como 'error' del pool. Sin listener, Node mata el proceso.
  pool.on('error', (err) => {
    if (log) log.error({ err }, 'error en un cliente ocioso del pool');
  });

  let ultimoError = null;
  for (let intento = 1; intento <= intentos; intento++) {
    try {
      await pool.query(SCHEMA);
      ultimoError = null;
      break;
    } catch (err) {
      ultimoError = err;
      if (log) log.warn({ err, intento, intentos }, 'la base todavía no responde, reintentando');
      if (intento < intentos) await esperar(esperaMs);
    }
  }
  if (ultimoError) {
    await pool.end().catch(() => {});
    throw ultimoError;
  }

  const toDoc = (row) =>
    row ? { key: row.key, data: row.json, version: row.version, updatedAt: row.updated_at } : null;

  /** Estado actual de una clave, para devolver en el cuerpo de un 409. */
  async function current(client, key) {
    const { rows } = await client.query('SELECT json, version FROM docs WHERE key = $1', [key]);
    return rows.length ? { data: rows[0].json, version: rows[0].version } : { data: null, version: 0 };
  }

  /**
   * Aplica una escritura sobre `client`. `version === 0` significa "crear si no
   * existe". Devuelve `{ ok:true, version }` o `{ ok:false, key, expected, current }`.
   * No abre transacción por sí sola: es reutilizable desde putMany.
   *
   * `$2::jsonb` con el JSON ya serializado a mano y no el objeto crudo: así un
   * `data` que sea string o número (JSON válido igual) entra entrecomillado en
   * vez de romper el cast.
   */
  async function applyPut(client, { key, data, version }) {
    const json = JSON.stringify(data);

    if (version === 0) {
      const res = await client.query(
        `INSERT INTO docs (key, json, version, created_at, updated_at)
         VALUES ($1, $2::jsonb, 1, now(), now())
         ON CONFLICT (key) DO NOTHING`,
        [key, json]
      );
      if (res.rowCount === 0) {
        return { ok: false, key, expected: version, current: await current(client, key) };
      }
      return { ok: true, key, version: 1 };
    }

    const res = await client.query(
      `UPDATE docs SET json = $1::jsonb, version = version + 1, updated_at = now()
       WHERE key = $2 AND version = $3
       RETURNING version`,
      [json, key, version]
    );
    if (res.rowCount === 0) {
      return { ok: false, key, expected: version, current: await current(client, key) };
    }
    return { ok: true, key, version: res.rows[0].version };
  }

  return {
    pool,

    async ping() {
      const { rows } = await pool.query('SELECT 1 AS ok');
      return rows[0].ok === 1;
    },

    async getAll() {
      const { rows } = await pool.query('SELECT key, json, version FROM docs');
      const out = {};
      for (const row of rows) out[row.key] = { data: row.json, version: row.version };
      return out;
    },

    async get(key) {
      const { rows } = await pool.query(
        'SELECT key, json, version, updated_at FROM docs WHERE key = $1',
        [key]
      );
      return toDoc(rows[0]);
    },

    /**
     * Escritura suelta. Devuelve `{ ok, version }` o `{ ok:false, current }`.
     * Sin BEGIN explícito: es una sola sentencia, ya es atómica; el `current`
     * del conflicto es una lectura posterior y solo alimenta el cuerpo del 409.
     */
    async put(key, data, version) {
      const client = await pool.connect();
      try {
        return await applyPut(client, { key, data, version });
      } finally {
        client.release();
      }
    },

    /** Escritura múltiple atómica. Lanza ConflictError si alguna choca. */
    async putMany(docs) {
      const client = await pool.connect();
      let enTransaccion = false;
      try {
        await client.query('BEGIN');
        enTransaccion = true;

        const results = [];
        const conflicts = [];
        for (const doc of docs) {
          const res = await applyPut(client, doc);
          if (res.ok) results.push({ key: res.key, version: res.version });
          else conflicts.push({ key: res.key, expected: res.expected, current: res.current });
        }
        // Todo o nada: el throw revierte las escrituras que sí habían entrado.
        if (conflicts.length) throw new ConflictError(conflicts);

        await client.query('COMMIT');
        enTransaccion = false;
        return results;
      } catch (err) {
        if (enTransaccion) await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    /** Devuelve `{ ok:true }`, o `{ ok:false, current }` / `{ ok:false, notFound:true }`. */
    async remove(key, version) {
      const client = await pool.connect();
      try {
        const res = await client.query('DELETE FROM docs WHERE key = $1 AND version = $2', [
          key,
          version,
        ]);
        if (res.rowCount === 0) {
          const actual = await current(client, key);
          if (actual.version === 0) return { ok: false, notFound: true };
          return { ok: false, expected: version, current: actual };
        }
        return { ok: true };
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}
