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

/* El backup se activa solo si están las cuatro credenciales de R2. Sin ellas
   la app funciona igual, con un aviso en el log: es una tarea de fondo, no un
   requisito para servir (ver src/backup.js). */
const r2 = {
  accountId: env('R2_ACCOUNT_ID'),
  accessKeyId: env('R2_ACCESS_KEY_ID'),
  secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  bucket: env('R2_BUCKET'),
  prefix: env('R2_PREFIX') || 'sgo/',
  /** Se deriva del account id; se puede pisar para apuntar a otro S3. */
  endpoint: env('R2_ENDPOINT') || `https://${env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com`,
};

export const config = {
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  appVersion: pkg.version,

  port: parseInteger(env('PORT'), 3000),
  host: env('HOST') || '0.0.0.0',
  databaseUrl: env('DATABASE_URL'),
  logLevel: env('LOG_LEVEL') || 'info',
  nodeEnv: env('NODE_ENV') || 'development',

  /** Un documento de obra con miles de comprobantes entra holgado en 5 MB. */
  bodyLimit: 5 * 1024 * 1024,

  backup: {
    r2,
    habilitado:
      env('BACKUP_ENABLED') !== 'false' &&
      Boolean(r2.accountId && r2.accessKeyId && r2.secretAccessKey && r2.bucket),
    intervaloHoras: parseInteger(env('BACKUP_INTERVAL_HOURS'), 24),
    retencionDias: parseInteger(env('BACKUP_RETENTION_DAYS'), 30),
    /** Margen para que la app termine de levantar antes del primer dump. */
    demoraInicialMs: parseInteger(env('BACKUP_INITIAL_DELAY_MS'), 2 * 60 * 1000),
  },
};

export function validateConfig(cfg = config) {
  const errores = [];
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    errores.push(`PORT inválido: ${process.env.PORT}`);
  }
  if (!cfg.host) errores.push('HOST vacío');
  if (!cfg.databaseUrl) {
    errores.push(
      'DATABASE_URL vacía. En Railway la provee el servicio de Postgres; en local, ver .env.example'
    );
  } else if (!/^postgres(ql)?:\/\//.test(cfg.databaseUrl)) {
    errores.push('DATABASE_URL debe empezar con postgres:// o postgresql://');
  }
  if (!Number.isInteger(cfg.backup.intervaloHoras) || cfg.backup.intervaloHoras < 1) {
    errores.push(`BACKUP_INTERVAL_HOURS inválido: ${process.env.BACKUP_INTERVAL_HOURS}`);
  }
  if (!Number.isInteger(cfg.backup.retencionDias) || cfg.backup.retencionDias < 1) {
    errores.push(`BACKUP_RETENTION_DAYS inválido: ${process.env.BACKUP_RETENTION_DAYS}`);
  }
  if (errores.length) {
    throw new Error(`Configuración inválida:\n  - ${errores.join('\n  - ')}`);
  }
  return cfg;
}
