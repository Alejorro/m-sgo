# SGO — Sistema de Gestión de Control de Gastos de Obra

Mini-app para llevar el control de gastos de una obra: comprobantes, pagos,
cuenta corriente por proveedor, presupuesto por rubro y tablero de indicadores.

El front es el mismo de siempre (vanilla JS + Bootstrap, sin build). Lo nuevo es
que los datos ya no viven en el `localStorage` del browser sino en un servidor
Node + SQLite, así que se puede abrir desde varios dispositivos y ver lo mismo.

Ver [ARQUITECTURA.md](ARQUITECTURA.md) para el cómo, y [PROGRESS.md](PROGRESS.md)
para el estado y lo que falta.

---

## Correr en local

Requiere Node 20.12 o superior (probado en 24.18).

```bash
npm install
cp .env.example .env      # opcional: los defaults ya sirven
npm run dev
```

Abrir <http://localhost:3000>.

`npm run dev` levanta con `--watch`, así que el server se reinicia solo al
editar `src/`. Para producción: `npm start`.

La base se crea sola en `./data/sgo.sqlite` la primera vez. Arranca vacía: al
entrar por primera vez, la app crea una "Obra 1" y el catálogo inicial de rubros.

## Variables de entorno

Ver [.env.example](.env.example). Todas tienen default razonable.

| Variable | Default | Para qué |
|---|---|---|
| `PORT` | `3000` | Puerto HTTP |
| `HOST` | `0.0.0.0` | Interfaz de escucha |
| `SGO_DB_PATH` | `./data/sgo.sqlite` | Archivo SQLite. En producción apunta al volumen montado |
| `LOG_LEVEL` | `info` | `fatal`…`trace` |
| `NODE_ENV` | `development` | |

El `.env` real **no se versiona**; solo `.env.example`.

## Estructura

```
src/              server (Fastify)
  server.js       arranque: estático + rutas
  config.js       env con defaults, validada al arrancar
  db.js           SQLite: esquema, versionado optimista
  routes/
    health.js     GET /health
    docs.js       API de documentos
public/           front, servido tal cual
  index.html
  app.js          lógica de negocio (el server no la toca)
  storage.js      capa de storage: reemplaza localStorage
data/             base local (fuera de git)
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
datos; el front muestra un cartel pidiendo recargar. Detalle en
[ARQUITECTURA.md](ARQUITECTURA.md).

## Backup

La base es **un solo archivo**, así que el backup es copiarlo. Pero con WAL
activo hay tres archivos (`.sqlite`, `-wal`, `-shm`) y copiar solo el primero
puede dar una copia inconsistente. Las dos formas correctas:

```bash
# Con el server corriendo (recomendado)
sqlite3 data/sgo.sqlite ".backup 'backup-$(date +%F).sqlite'"

# O con el proceso detenido, copiando los tres archivos
cp data/sgo.sqlite* /destino/
```

## Restaurar / empezar de cero

Borrar `data/sgo.sqlite*` y levantar de nuevo: la app arranca con base limpia.

## Deploy

Todavía no configurado. Va en la fase siguiente (Docker → Dokploy, destino
`sgo.alejorro.dev`). Ver [PROGRESS.md](PROGRESS.md).
