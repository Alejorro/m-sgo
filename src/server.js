/**
 * Punto de entrada. Fastify sirve el front estático desde public/ y expone la
 * API de documentos bajo /api.
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { config, validateConfig } from './config.js';
import { openStore } from './db.js';
import { crearBackup } from './backup.js';
import healthRoutes from './routes/health.js';
import docsRoutes from './routes/docs.js';

validateConfig();

// El logger de fábrica (pino) ya emite una línea JSON por request con
// statusCode y responseTime, que es exactamente lo que Railway muestra en el
// panel de logs sin configuración extra (y además deja expandir el JSON
// estructurado de cada línea, que es como se encontró el ENOTFOUND del primer
// deploy: ver PROGRESS.md, 2026-08-06).
const app = Fastify({
  logger: { level: config.logLevel },
  bodyLimit: config.bodyLimit,
});

let store;
try {
  store = await openStore(config.databaseUrl, { log: app.log });
} catch (err) {
  app.log.error({ err }, 'no se pudo conectar a Postgres');
  process.exit(1);
}

await app.register(fastifyStatic, {
  root: config.publicDir,
  index: 'index.html',
  // El front no tiene build ni hashes en los nombres: cachear agresivo
  // significa servir una versión vieja después de un deploy.
  cacheControl: true,
  maxAge: 0,
});

await app.register(healthRoutes, { store });
await app.register(docsRoutes, { store, prefix: '/api' });

const backup = crearBackup({ config, store, log: app.log });

let cerrando = false;
async function shutdown(signal) {
  if (cerrando) return;
  cerrando = true;
  app.log.info({ signal }, 'cerrando');
  try {
    backup.detener();
    await app.close();
    await store.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error al cerrar');
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ host: config.host, port: config.port }, 'base de datos conectada');
  backup.iniciar();
} catch (err) {
  app.log.error({ err }, 'no se pudo levantar el server');
  process.exit(1);
}
