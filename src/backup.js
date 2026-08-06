/**
 * Backup diario de la base a Cloudflare R2.
 *
 * Railway NO hace backups de Postgres automáticamente: si la base se pierde,
 * se perdió. Esto lo cubre: un `pg_dump` por día, subido a un bucket de R2 que
 * vive fuera de Railway, con retención de 30 días.
 *
 * REGLA DE ORO: esto es una tarea de fondo, no parte de servir la app. Todo
 * está envuelto en try/catch — si el dump falla, si faltan credenciales, si R2
 * no responde, se loguea el error y la app sigue funcionando igual. Un backup
 * roto nunca tumba el server ni hace fallar el healthcheck.
 *
 * Dos formatos posibles, en orden:
 *   1. `pg_dump -Fc` — el backup completo y canónico. Se restaura con
 *      `pg_restore`. Requiere que el binario `pg_dump` esté en la imagen (lo
 *      instala nixpacks.toml) y que su versión sea >= la del server.
 *   2. Volcado JSON de la tabla `docs` — el plan B. El esquema es una sola
 *      tabla que la app recrea sola al arrancar (CREATE TABLE IF NOT EXISTS),
 *      así que el JSON de `docs` es, en la práctica, el 100% de los datos.
 *      Existe porque un desajuste de versión de `pg_dump` es el modo de falla
 *      más probable acá, y un backup que se apaga solo en silencio no sirve
 *      de nada.
 */
import { spawn } from 'node:child_process';
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

/** Sello de tiempo apto para nombre de archivo: 2026-08-06T14-32-05Z */
function sello(fecha) {
  return fecha.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

/**
 * Corre pg_dump y devuelve el volcado en memoria.
 *
 * Los dumps de SGO son del orden de kilobytes (≤7 documentos JSON), así que
 * juntarlo en un Buffer es más simple que encadenar streams y no pesa nada.
 * Si algún día esto crece a cientos de MB, hay que pasarlo a archivo temporal.
 */
function correrPgDump(databaseUrl) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-privileges', '--dbname', databaseUrl],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const salida = [];
    const errores = [];
    proc.stdout.on('data', (c) => salida.push(c));
    proc.stderr.on('data', (c) => errores.push(c));

    proc.on('error', (err) => reject(err)); // típicamente ENOENT: no está instalado
    proc.on('close', (code) => {
      if (code !== 0) {
        const detalle = Buffer.concat(errores).toString('utf8').trim();
        reject(new Error(`pg_dump salió con código ${code}: ${detalle || 'sin detalle'}`));
        return;
      }
      resolve(Buffer.concat(salida));
    });
  });
}

/** Plan B: la tabla `docs` entera como JSON. Ver el comentario de arriba. */
async function volcadoJson(store) {
  const docs = await store.getAll();
  const cuerpo = {
    formato: 'sgo-docs-json-v1',
    generadoEn: new Date().toISOString(),
    docs,
  };
  return Buffer.from(JSON.stringify(cuerpo), 'utf8');
}

export function crearBackup({ config, store, log }) {
  const { r2, retencionDias, intervaloHoras, demoraInicialMs, habilitado } = config.backup;
  let timer = null;

  const cliente = habilitado
    ? new S3Client({
        region: 'auto',
        endpoint: r2.endpoint,
        // R2 direcciona por ruta (endpoint/bucket/key), no por subdominio.
        forcePathStyle: true,
        credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
      })
    : null;

  /** Borra del bucket lo que pasó la ventana de retención. */
  async function podar() {
    const corte = Date.now() - retencionDias * 24 * 60 * 60 * 1000;
    let token;
    let borrados = 0;

    do {
      const pagina = await cliente.send(
        new ListObjectsV2Command({
          Bucket: r2.bucket,
          Prefix: r2.prefix,
          ContinuationToken: token,
        })
      );
      const viejos = (pagina.Contents || [])
        .filter((o) => o.LastModified && o.LastModified.getTime() < corte)
        .map((o) => ({ Key: o.Key }));

      if (viejos.length) {
        await cliente.send(
          new DeleteObjectsCommand({ Bucket: r2.bucket, Delete: { Objects: viejos } })
        );
        borrados += viejos.length;
      }
      token = pagina.IsTruncated ? pagina.NextContinuationToken : undefined;
    } while (token);

    return borrados;
  }

  /** Una corrida completa: dump → subida → poda. Nunca lanza. */
  async function correr() {
    if (!habilitado) return { ok: false, motivo: 'deshabilitado' };

    const arranque = Date.now();
    try {
      let cuerpo;
      let extension;
      let tipo;

      try {
        cuerpo = await correrPgDump(config.databaseUrl);
        extension = 'dump';
        tipo = 'application/octet-stream';
      } catch (err) {
        log.warn({ err }, 'pg_dump no disponible o falló; se cae al volcado JSON de `docs`');
        cuerpo = await volcadoJson(store);
        extension = 'json';
        tipo = 'application/json';
      }

      const key = `${r2.prefix}sgo-${sello(new Date())}.${extension}`;
      await cliente.send(
        new PutObjectCommand({ Bucket: r2.bucket, Key: key, Body: cuerpo, ContentType: tipo })
      );

      let podados = 0;
      try {
        podados = await podar();
      } catch (err) {
        // La poda es higiene, no el backup: si falla, el dump ya está a salvo.
        log.error({ err }, 'backup: no se pudo podar los backups viejos');
      }

      log.info(
        { key, bytes: cuerpo.length, podados, ms: Date.now() - arranque },
        'backup subido a R2'
      );
      return { ok: true, key, bytes: cuerpo.length, podados };
    } catch (err) {
      log.error({ err }, 'backup: falló la corrida (la app sigue funcionando igual)');
      return { ok: false, motivo: String(err && err.message) };
    }
  }

  return {
    correr,

    iniciar() {
      if (!habilitado) {
        log.warn(
          'backup a R2 deshabilitado: faltan R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET'
        );
        return;
      }
      log.info(
        { bucket: r2.bucket, prefix: r2.prefix, intervaloHoras, retencionDias },
        'backup a R2 activo'
      );
      // La primera corrida va demorada para no competir con el arranque ni con
      // el healthcheck del deploy; después, cada `intervaloHoras`.
      timer = setTimeout(() => {
        correr();
        timer = setInterval(correr, intervaloHoras * 60 * 60 * 1000);
      }, demoraInicialMs);
    },

    detener() {
      if (timer) {
        clearTimeout(timer);
        clearInterval(timer);
        timer = null;
      }
      if (cliente) cliente.destroy();
    },
  };
}
