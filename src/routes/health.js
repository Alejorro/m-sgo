/**
 * Healthcheck. Confirma que el proceso responde y que Postgres contesta.
 * No toca datos: un `SELECT 1` no lee ni escribe ninguna tabla.
 *
 * Es lo que mira Railway antes de mandarle tráfico a un deploy nuevo: si acá
 * sale 503, la versión nueva no se promociona y sigue sirviendo la anterior.
 */
import { config } from '../config.js';

export default async function healthRoutes(fastify, opts) {
  const { store } = opts;

  fastify.get('/health', async (request, reply) => {
    let dbOk = false;
    try {
      dbOk = await store.ping();
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
