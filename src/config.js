/**
 * Configuración del server. Todo sale de variables de entorno con defaults
 * razonables para desarrollo; ver .env.example.
 *
 * Se valida al arrancar: preferimos que el proceso muera con un mensaje claro
 * antes que levantar con una config inservible.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseInteger(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Lee una variable de entorno recortando espacios de los bordes, y trata el
 * string vacío como "no seteada" (para que caiga el default).
 *
 * No es paranoia: pegar un valor en el panel de un PaaS arrastra espacios
 * invisibles con facilidad. Un `HOST=" 0.0.0.0"` hace que Node deje de verlo
 * como IP literal e intente resolverlo por DNS: `app.listen()` muere con
 * ENOTFOUND y el server no levanta. Pasó en el primer deploy a Railway
 * (ver PROGRESS.md, 2026-08-06).
 */
function env(name) {
  const raw = process.env[name];
  if (raw == null) return undefined;
  const limpio = raw.trim();
  return limpio === '' ? undefined : limpio;
}

const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  appVersion: pkg.version,

  port: parseInteger(env('PORT'), 3000),
  host: env('HOST') || '0.0.0.0',
  dbPath: path.resolve(rootDir, env('SGO_DB_PATH') || './data/sgo.sqlite'),
  logLevel: env('LOG_LEVEL') || 'info',
  nodeEnv: env('NODE_ENV') || 'development',

  /** Un documento de obra con miles de comprobantes entra holgado en 5 MB. */
  bodyLimit: 5 * 1024 * 1024,
};

export function validateConfig(cfg = config) {
  const errores = [];
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    errores.push(`PORT inválido: ${process.env.PORT}`);
  }
  if (!cfg.host) errores.push('HOST vacío');
  if (!cfg.dbPath) errores.push('SGO_DB_PATH vacío');
  if (errores.length) {
    throw new Error(`Configuración inválida:\n  - ${errores.join('\n  - ')}`);
  }
  return cfg;
}
