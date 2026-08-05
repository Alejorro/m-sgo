/**
 * Capa de persistencia: SQLite (better-sqlite3) usado como store documental.
 *
 * El server NO entiende el contenido de los documentos: guarda el mismo blob
 * JSON que el front arma hoy en localStorage, opaco, en una columna TEXT.
 * En particular NO hace aritmética de plata (ver CLAUDE.md).
 *
 * Concurrencia optimista: cada documento tiene una `version` que arranca en 1
 * y sube de a uno. Una escritura declara qué versión creyó estar editando; si
 * no coincide con la de la fila, se rechaza en vez de pisar.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS docs (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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

export function openStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const stmts = {
    selectAll: db.prepare('SELECT key, json, version, updated_at FROM docs'),
    selectOne: db.prepare('SELECT key, json, version, updated_at FROM docs WHERE key = ?'),
    insert: db.prepare(
      'INSERT OR IGNORE INTO docs (key, json, version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)'
    ),
    update: db.prepare(
      'UPDATE docs SET json = ?, version = version + 1, updated_at = ? WHERE key = ? AND version = ?'
    ),
    delete: db.prepare('DELETE FROM docs WHERE key = ? AND version = ?'),
    ping: db.prepare('SELECT 1 AS ok'),
  };

  const toDoc = (row) =>
    row ? { key: row.key, data: JSON.parse(row.json), version: row.version, updatedAt: row.updated_at } : null;

  /** Estado actual de una clave, para devolver en el cuerpo de un 409. */
  function current(key) {
    const doc = toDoc(stmts.selectOne.get(key));
    return doc ? { data: doc.data, version: doc.version } : { data: null, version: 0 };
  }

  /**
   * Aplica una escritura. `expectedVersion === 0` significa "crear si no existe".
   * Devuelve `{ ok:true, version }` o `{ ok:false, key, expected, current }`.
   * No abre transacción por sí sola: es reutilizable desde putMany.
   */
  function applyPut({ key, data, version }, now) {
    const json = JSON.stringify(data);
    if (version === 0) {
      const info = stmts.insert.run(key, json, now, now);
      if (info.changes === 0) return { ok: false, key, expected: version, current: current(key) };
      return { ok: true, key, version: 1 };
    }
    const info = stmts.update.run(json, now, key, version);
    if (info.changes === 0) return { ok: false, key, expected: version, current: current(key) };
    return { ok: true, key, version: version + 1 };
  }

  const putManyTxn = db.transaction((docs, now) => {
    const results = [];
    const conflicts = [];
    for (const doc of docs) {
      const res = applyPut(doc, now);
      if (res.ok) results.push({ key: res.key, version: res.version });
      else conflicts.push({ key: res.key, expected: res.expected, current: res.current });
    }
    // Todo o nada: el throw revierte las escrituras que sí habían entrado.
    if (conflicts.length) throw new ConflictError(conflicts);
    return results;
  });

  return {
    db,

    ping() {
      return stmts.ping.get().ok === 1;
    },

    getAll() {
      const out = {};
      for (const row of stmts.selectAll.all()) {
        out[row.key] = { data: JSON.parse(row.json), version: row.version };
      }
      return out;
    },

    get(key) {
      return toDoc(stmts.selectOne.get(key));
    },

    /** Escritura suelta. Devuelve `{ ok, version }` o `{ ok:false, current }`. */
    put(key, data, version) {
      const now = new Date().toISOString();
      const res = db.transaction(() => applyPut({ key, data, version }, now))();
      return res;
    },

    /** Escritura múltiple atómica. Lanza ConflictError si alguna choca. */
    putMany(docs) {
      return putManyTxn(docs, new Date().toISOString());
    },

    /** Devuelve `{ ok:true }`, o `{ ok:false, current }` / `{ ok:false, notFound:true }`. */
    remove(key, version) {
      const existing = stmts.selectOne.get(key);
      if (!existing) return { ok: false, notFound: true };
      const info = stmts.delete.run(key, version);
      if (info.changes === 0) return { ok: false, expected: version, current: current(key) };
      return { ok: true };
    },

    close() {
      db.close();
    },
  };
}
