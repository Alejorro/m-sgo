# SGO — Sistema de Gestión de Control de Gastos de Obra

Mini-app para llevar el control de gastos de una obra: comprobantes, pagos,
cuenta corriente por proveedor, presupuesto por rubro y tablero de indicadores.

El front es el mismo de siempre (vanilla JS + Bootstrap, sin build). Lo nuevo es
que los datos ya no viven en el `localStorage` del browser sino en un servidor
Node + Postgres, así que se puede abrir desde varios dispositivos y ver lo mismo.

Ver [ARQUITECTURA.md](ARQUITECTURA.md) para el cómo, y [PROGRESS.md](PROGRESS.md)
para el estado y lo que falta.

---

## Correr en local

Requiere Node 20.12 o superior (probado en 24.18) y un Postgres al que apuntar.

```bash
npm install
createdb sgo                        # o el Postgres que ya tengas
cp .env.example .env                # y poner ahí la DATABASE_URL
npm run dev
```

Abrir <http://localhost:3000>.

`npm run dev` levanta con `--watch`, así que el server se reinicia solo al
editar `src/`. Para producción: `npm start`.

La tabla se crea sola la primera vez (`CREATE TABLE IF NOT EXISTS`). La base
arranca vacía: al entrar por primera vez, la app crea una "Obra 1" y el
catálogo inicial de rubros.

Si no hay `DATABASE_URL`, el server **no levanta** y lo dice: es a propósito,
mejor morir con un mensaje claro que servir contra una base que no existe.

## Variables de entorno

Ver [.env.example](.env.example).

| Variable | Default | Para qué |
|---|---|---|
| `DATABASE_URL` | — (**obligatoria**) | Conexión a Postgres. En Railway: `${{Postgres.DATABASE_URL}}` |
| `PORT` | `3000` | Puerto HTTP. Railway lo inyecta |
| `HOST` | `0.0.0.0` | Interfaz de escucha |
| `LOG_LEVEL` | `info` | `fatal`…`trace` |
| `NODE_ENV` | `development` | |
| `R2_ACCOUNT_ID` | — | Backup: cuenta de Cloudflare R2 |
| `R2_ACCESS_KEY_ID` | — | Backup: access key del token de R2 |
| `R2_SECRET_ACCESS_KEY` | — | Backup: secret del token de R2 |
| `R2_BUCKET` | — | Backup: nombre del bucket |
| `R2_PREFIX` | `sgo/` | Backup: carpeta dentro del bucket |
| `BACKUP_ENABLED` | `true` | `false` para apagarlo aun con credenciales |
| `BACKUP_INTERVAL_HOURS` | `24` | Cada cuánto corre |
| `BACKUP_RETENTION_DAYS` | `30` | Cuánto se guarda antes de podar |

Sin las cuatro `R2_*`, el backup queda apagado y la app funciona igual (lo
avisa en el log al arrancar).

El `.env` real **no se versiona**; solo `.env.example`.

## Estructura

```
src/              server (Fastify)
  server.js       arranque: estático + rutas + backup
  config.js       env con defaults, validada al arrancar
  db.js           Postgres: esquema, pool, versionado optimista
  backup.js       pg_dump diario a Cloudflare R2
  routes/
    health.js     GET /health
    docs.js       API de documentos
public/           front, servido tal cual
  index.html
  app.js          lógica de negocio (el server no la toca)
  storage.js      capa de storage: reemplaza localStorage
railway.json      config de deploy (healthcheck, start, reintentos)
nixpacks.toml     build: agrega el cliente de Postgres para pg_dump
```

## API

| Verbo | Ruta | Para qué |
|---|---|---|
| `GET` | `/health` | Estado del proceso y de la base |
| `GET` | `/api/docs` | Todos los documentos (lo que el front pide al arrancar) |
| `GET` | `/api/docs/:key` | Un documento |
| `PUT` | `/api/docs/:key` | Guardar. Body `{ data, version }` |
| `DELETE` | `/api/docs/:key?version=N` | Borrar |
| `POST` | `/api/docs/batch` | Guardar varios en una transacción |

Las claves válidas son solo `sgo_obras_v1`, `sgo_global_v1` y
`obra_db_v1__<obraId>`. Cualquier otra devuelve `400`.

Un guardado con una versión desactualizada devuelve `409` en vez de pisar los
datos. El front no interrumpe a nadie: combina el cambio local con la versión
fresca del server y reintenta, en silencio. Detalle en
[ARQUITECTURA.md](ARQUITECTURA.md) §3.

## Backup

Automático: la app corre `pg_dump` cada 24 h y lo sube a un bucket de
Cloudflare R2, borrando lo que pasó los 30 días. Railway no hace backups de
Postgres, y tenerlos en R2 los deja **fuera** del proveedor.

Es una tarea de fondo aislada: si falla, lo loguea y la app sigue funcionando.
Sin las credenciales `R2_*` queda apagado. Se ve en los logs:

```
backup a R2 activo          ← al arrancar
backup subido a R2          ← cada corrida, con key, bytes y cuántos podó
```

Si `pg_dump` no está disponible o su versión es más vieja que la del server,
el backup **no se apaga**: sube en cambio la tabla `docs` entera como JSON
(que es el 100% de los datos, porque el esquema es esa única tabla) y lo avisa
con un `warn`.

Uno a mano, cuando sea:

```bash
pg_dump --format=custom --no-owner --no-privileges --dbname "$DATABASE_URL" -f backup-$(date +%F).dump
```

## Restaurar

```bash
# En una base NUEVA, siempre — nunca encima de la de producción
createdb sgo_restaurada
pg_restore --dbname "postgres://.../sgo_restaurada" backup-2026-08-06.dump
```

**Hace falta `pg_restore` 18 o superior.** Los dumps los escribe el `pg_dump`
18 del contenedor, y un `pg_restore` más viejo los rechaza con *"versión no
soportada (1.16) en el encabezado del archivo"*. En una Mac con un Postgres
más viejo instalado: `brew install postgresql@18` y usar el binario de ahí
(no hace falta levantar el server, alcanza con el cliente).

Si el backup es del plan B (`.json` en vez de `.dump`), se reinserta con un
`INSERT` por cada entrada de `docs`: `{ key, data, version }` van tal cual a
las columnas `key`, `json` y `version`.

Para empezar de cero: base vacía y levantar; la tabla se crea sola.

## Deploy

Railway. Cada push a `main` deploya: buildea con Nixpacks, corre el
healthcheck (`GET /health`) y recién ahí corta el tráfico a la versión nueva.
Si el build o el healthcheck fallan, la versión anterior sigue sirviendo.

Son dos servicios en el mismo proyecto: **la app** y **Postgres**. La app
recibe `DATABASE_URL=${{Postgres.DATABASE_URL}}` como referencia al servicio
de base, no como URL pegada a mano.

No hay Dockerfile ni volumen: la config vive en `railway.json` y
`nixpacks.toml`, versionadas. Detalle en [ARQUITECTURA.md](ARQUITECTURA.md) §7.
