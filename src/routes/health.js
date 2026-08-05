/**
 * Healthcheck. Confirma que el proceso responde y que SQLite contesta.
 * No toca datos: un `SELECT 1` sobre better-sqlite3 es sincrónico y sub-milisegundo.
 */
import { config } from '../config.js';

export default async function healthRoutes(fastify, opts) {
  const { store } = opts;

  fastify.get('/health', async (request, reply) => {
    let dbOk = false;
    try {
      dbOk = store.ping();
    } catch (err) {
      request.log.error({ err }, 'healthcheck: la base no responde');
    }

    if (!dbOk) {
      reply.code(503);
      return { status: 'error', db: 'error', uptime: process.uptime(), version: config.appVersion };
    }

    return {
      status: 'ok',
      db: 'ok',
      uptime: Math.round(process.uptime()),
      version: config.appVersion,
    };
  });
}
