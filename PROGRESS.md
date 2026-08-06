# PROGRESS

Bitácora del proyecto. Lo más reciente arriba.

---

## 2026-08-06 (6) — SQLite → Postgres, build Nixpacks y backup diario a R2

Se cambió el motor de persistencia de SQLite a Postgres y se dejó el repo
listo para deployar en Railway. **El front no se tocó** (`git diff public/`
vacío): la migración es toda de la puerta del server para adentro.

### Por qué

La entrada anterior había decidido quedarse en SQLite razonando que Railway no
da backups de Postgres, así que Postgres no compraba ventaja. Ese razonamiento
se cae solo cuando el backup lo hace igual la app: si hay que escribir el
backup a mano en los dos casos, lo que queda es comparar el resto, y ahí
SQLite en un volume pierde — el volume se monta como `root` con el contenedor
corriendo como `node` (el "readonly database" que quedó anotado sin resolver),
no se puede leer la base desde afuera, y ata la app a un solo contenedor.

### Backend

- **`src/db.js`** — reescrito de `better-sqlite3` a `pg`. Tabla `docs` con
  `json JSONB`, `version INTEGER`, timestamps `TIMESTAMPTZ`, creada con
  `CREATE TABLE IF NOT EXISTS` al arrancar. Pool de `pg` (`max: 5`). El SSL se
  decide por host: sin TLS contra `*.railway.internal` y localhost (la red
  privada de Railway no lo ofrece), con TLS sin verificar la cadena contra
  cualquier otro. La primera conexión reintenta 6 × 2 s, porque en un deploy
  Railway levanta la app y la base en paralelo.
- **Contrato de API idéntico.** Mismos endpoints, mismos códigos, mismos
  cuerpos. Las rutas solo pasaron a `await`. El versionado optimista es el
  mismo (`UPDATE ... WHERE key = $1 AND version = $2`, 0 filas → `409`), y el
  batch sigue siendo todo-o-nada (`BEGIN`/`COMMIT`/`ROLLBACK`).
- **`src/backup.js`** (nuevo) — `pg_dump -Fc` diario a Cloudflare R2 vía el SDK
  de S3, retención 30 días. Aislado: todo en try/catch, si falla loguea y la
  app sigue. Con plan B: si `pg_dump` no está o falla, sube la tabla `docs`
  serializada a JSON (que es el 100% de los datos, porque el esquema es esa
  única tabla). Un backup que se apaga solo en silencio no sirve de nada.
- **Se sacó todo lo de SQLite:** dependencia, `SGO_DB_PATH`, volume, permisos
  del punto de montaje, backup por copia de archivo.
- **Build: Nixpacks, sin Dockerfile.** Ya no hay módulo nativo que compilar, así
  que Nixpacks detecta Node solo. `nixpacks.toml` solo agrega el cliente de
  Postgres para que exista `pg_dump`. `railway.json` fija el healthcheck en
  `/health`, el start command y la política de reinicio.

### Dependencias

`better-sqlite3` afuera; entran `pg` y `@aws-sdk/client-s3` (este último solo
para subir el backup). Ambas pedidas explícitamente en el prompt de esta
tarea, según CLAUDE.md §6.

### Verificado (contra Postgres real, no mocks)

**API — 30/30.** Whitelist de claves (`400`/`404`), alta con `version: 0`,
carrera de creación (`409` con los datos actuales en el cuerpo), versionado
optimista (`409` sin pisar el dato), batch de altas, batch con una clave en
conflicto → `409` **y `ROLLBACK` verificado** (la clave que sí iba tampoco se
escribió), clave repetida y batch vacío → `400`, bootstrap `GET /api/docs`,
borrado con versión correcta/vieja/inexistente, y bodies inválidos.

**Plata — verde.** 10 montos feos (`0.1`, `0.30000000000000004`, `1e-7`,
`9007199254740991`, `1.7976931348623157e308`, negativos, cero) escritos y
releídos: **todos vuelven `Object.is`-idénticos**, también después de un
`pg_dump` + `pg_restore`. `jsonb` guarda los números como `numeric`, de
precisión decimal exacta. Lo único que cambia es el **orden de las claves**,
que `jsonb` normaliza; ningún valor se altera y nada de la app depende del
orden (la comparación de `sgoStore.setItem` es cache local contra stringify
local, no contra el string del server).

**Backup — 20/20**, contra un S3 falso local que habla el protocolo real
(firma SigV4, `PutObject`, `ListObjectsV2`, `DeleteObjects`): sube un dump con
firma `PGDMP` válida, poda exactamente los de más de 30 días, no toca nada
fuera del prefijo, cae al volcado JSON cuando `pg_dump` no está en el `PATH`,
y **nunca lanza** — con R2 caído devuelve `ok:false` y loguea, sin propagar.

**Restauración — verde.** `pg_dump` → `createdb` → `pg_restore` en una base
nueva: la tabla `docs` restaurada sale byte-idéntica a la de origen (`diff`
vacío), claves, versiones y montos incluidos. Un backup que no se probó
restaurar no es un backup.

**Front real (Chromium/Playwright) — 17/17.** Contra base Postgres vacía: la
app arranca sin errores de JS, crea el registro de obras y el catálogo, pinta
la UI; un alta de proveedor llega a Postgres y sobrevive a un F5 (hydrate);
dos pestañas agregando proveedores distintos a la vez generan un `409`
genuino que **se resuelve solo y conserva los dos** proveedores, sin banner
(§4 de CLAUDE.md sigue en pie); el indicador de guardado queda en "guardado",
no en "sin conexión".

**CA-9 (equivalencia del motor de cálculo): sin riesgo.** No se tocó una línea
de `public/`. `git diff public/` vacío.

### Railway: conectado y andando

Proyecto `innovative-renewal`, servicio `m-sgo` (ya existía, del intento de
deploy con SQLite que nunca llegó a levantar). Se le agregó el servicio
**Postgres** y se apuntó `DATABASE_URL` con la referencia
`${{Postgres.DATABASE_URL}}`, que resuelve a `postgres.railway.internal` — o
sea red privada, sin TLS, que es justo lo que contempla `sslPara()`. Se borró
la variable `SGO_DB_PATH`.

Deploy **SUCCESS**, verificado contra producción: `/health` devuelve `200`
con `"db":"ok"` (o sea el `SELECT 1` viaja bien por la red privada), el front
sirve `200` y `GET /api/docs` devuelve `{"docs":{}}` — base nueva y vacía,
como corresponde.

**`pg_dump`: la versión se desincronizó y se arregló.** Railway provisionó
`postgres-ssl:18` y `nixpacks.toml` instalaba `postgresql_17`. Verificado
dentro del contenedor (`railway ssh`): `pg_dump` 17.6 contra server 18.4
aborta con *"aborting because of server version mismatch"*. Se subió a
`postgresql_18`. Nótese que el plan B funcionó como estaba pensado: el backup
no se hubiera apagado, hubiera caído al volcado JSON avisando en el log.

**Dominio `sgo.dot4sa.com`** creado en Railway. Falta el CNAME del lado del
DNS.

**Bug del CLI, por si reaparece:** `railway domain <dominio>` devuelve
`Unauthorized` aunque `railway whoami` y `railway variables` funcionen —
manda el token viejo (`user.token`) en vez del `user.accessToken`. Se creó el
dominio con la mutación `customDomainCreate` de la API GraphQL directamente,
con el `accessToken`. No es un problema de permisos ni de plan.

### Pendiente (necesita la mano del usuario, no del código)

- Las cuatro credenciales `R2_*`: sin ellas el backup arranca **apagado** (lo
  dice en el log). Es lo único que falta para cerrar el punto de backup.
- El CNAME `sgo` → `pselz0e9.up.railway.app` en el DNS de `dot4sa.com`.

**Quedó un Volume (`m-sgo-volume`, montado en `/data`) de la etapa SQLite**,
ya sin uso: nada lo lee ni lo escribe. No se borró para no tocar
almacenamiento sin OK explícito (CLAUDE.md §7). Conviene sacarlo.

**La base local vieja de SQLite (`data/sgo.sqlite*`) quedó en disco, sin
tocar.** Ya no la lee nadie. No se migró a Postgres porque era data de
desarrollo y producción nunca llegó a tener datos; si hiciera falta, es un
script de una sola pasada.

---

## 2026-08-06 (5) — Target de deploy cambiado de Dokploy/MacBook a Railway (solo docs)

Target de deploy cambiado de Dokploy/MacBook a Railway. DB sigue en SQLite
(Railway no da backups automáticos de Postgres, así que Postgres no compra
ventaja; el modelo KV es portable si alguna app futura lo pide). Pendiente
para fase de deploy: Volume persistente, permisos del volume, backup a
bucket externo, Dockerfile/config Railway.

Esta entrada es solo documentación (`README.md`, `ARQUITECTURA.md`,
`CLAUDE.md`, este archivo): no se tocó código ni el Dockerfile. El repo
todavía no está conectado a Railway.

---

## 2026-08-06 (4) — Se sacó el banner de conflicto: usuario único, autorresolución silenciosa

Decisión: la app la va a usar una sola persona (posiblemente desde más de un
dispositivo/pestaña), así que ya no tiene sentido interrumpir con un banner
pidiendo recargar. Se mantiene el versionado en el server (por las dudas, y
porque no cuesta nada tenerlo), pero el cliente ya no bloquea ni avisa: ante
un `409`, `sgoStore` trae la versión fresca, la combina con el cambio local y
reintenta, todo en silencio.

**`public/storage.js`:**
- Se sacó `bloqueado`/`ConflictoError`/el estado `'conflict'` enteros.
- `enviarLote()` y `enviarBorrado()` ahora resuelven el `409` ellos mismos: si
  hay un resolutor registrado para esa clave lo usan, si no, el cambio local
  gana tal cual y se reintenta con la versión fresca. Tope de 3 reintentos de
  conflicto por guardado; si se agotan, esa clave queda para el próximo
  guardado real (no hay banner que insista).
- Nuevo método público `registrarResolutor(match, combinar)` — `match` es una
  clave exacta o un predicado `(key) => boolean` (para prefijos).

**`public/app.js`:** se registran tres resolutores, todos reusando
mecanismos que ya existían o son triviales (nada de lógica de negocio nueva,
`recalcTodo()` sigue recalculando todo después):
- Registro de obras (`sgo_obras_v1`): unión de `obras` por `id`; la obra
  activa se mantiene si sigue existiendo.
- Catálogo global (`sgo_global_v1`): el merge idempotente por nombre/tipo que
  ya usaba la migración vieja (`mergeProveedoresYRubros`).
- Documento de obra (`obra_db_v1__*`): unión por `id` de `comprobantes` y
  `pagos`, unión por `rubroId` de `presupuestos`. Si el mismo registro se
  editó distinto en ambos lados, gana el del server; lo nuevo de cada lado se
  conserva.

**`public/index.html`:** se borró el `<div id="sync-conflict-banner">`
entero (el otro cartel, `sync-fatal-banner` para "no se pudo conectar", se
deja: es un problema distinto — servidor caído, no conflicto de versión).

**Verificado con Chromium real (Playwright), con conflictos genuinos (409
real de la red, no simulados):**
- El elemento `sync-conflict-banner` ya no existe en el DOM.
- Dos pestañas, misma obra, comprobantes distintos: la que pierde la carrera
  recibe el 409, se resuelve sola, y **ambos comprobantes sobreviven** (mejor
  que el bloqueo de antes: acá no se pierde nada).
- Dos pestañas agregan proveedores distintos casi al mismo tiempo: ambos
  terminan en el catálogo.
- Dos pestañas crean obras distintas casi al mismo tiempo: ambas terminan en
  el registro.
- CA-9 (equivalencia del motor de cálculo contra el `app.js` original)
  sigue en verde: nada de esto tocó `recalcComprobante`, FIFO, retenciones,
  ni ningún cálculo de plata.

**Límite conocido, a propósito:** si el mismo registro (mismo comprobante,
mismo proveedor) se edita distinto en dos pestañas casi al mismo tiempo, gana
el del server — el cambio de la otra pestaña se pierde en silencio. Es el
trade-off aceptado al elegir "silencioso" sobre "avisar": para que nunca se
pierda nada hay que volver a interrumpir al usuario, que es justo lo que se
pidió sacar.

### Nota operativa: cuidado con `data/` en desarrollo

Durante esta sesión se perdió por error la base de datos de desarrollo del
usuario (`data/sgo.sqlite`) — un `rm -rf data` de limpieza, en una sesión de
trabajo anterior, corrido sin volver a chequear si en ese momento `data/`
apuntaba al `npm run dev` real del usuario o a un servidor de prueba propio.
Por suerte lo perdido era la data de ejemplo (`cargarDatosDemo()`), no
trabajo real, pero el error es real: **antes de cualquier limpieza que toque
`data/` en la raíz del repo, primero confirmar que no hay un servidor real
del usuario corriendo contra esa ruta** (`lsof -iTCP -sTCP:LISTEN`). No hay
backup automático configurado todavía (queda para la fase de infra); mientras
tanto, cualquier `data/sgo.sqlite` de desarrollo es prescindible por diseño,
pero no debe borrarse sin confirmar primero.

---

## 2026-08-06 (3) — Banner "permanente": investigado en la máquina real, cero bugs de código encontrados, se blindó contra bfcache

Reporte: el banner de conflicto seguía apareciendo de forma permanente, con
evidencia de captura de pantalla. Se investigó directamente contra el
`npm run dev` real del usuario (puerto 3000) con **Chromium visible
(headless:false)**, no headless:

1. **Servidor y archivo servido:** se confirmó por MD5 que `/storage.js` en
   `http://127.0.0.1:3000` es byte-a-byte el mismo `public/storage.js` en
   disco (el revert `ca5d1d4` ya estaba corriendo). La base real
   (`data/sgo.sqlite`) tiene una sola obra, sin duplicados ni estados raros.
2. **Carga limpia:** una pestaña nueva contra el server y la base reales,
   navegando por las 7 pestañas de la UI, esperando 20s, y haciendo F5 real:
   cero banner, cero escritura, en todo momento.
3. **Pestaña "vieja" atascada:** se forzó a mano el estado `bloqueado=true`
   (para replicar visualmente una pestaña que quedó pegada desde antes del
   fix anterior) y se hizo un F5 real contra el server actual → el banner se
   limpia. Screenshot antes/después tomado.
4. **Conflicto real de punta a punta:** dos pestañas reales, un 409 genuino
   (no simulado), y un **click físico** (`page.click`, no manipulación de
   estado) sobre el botón "Recargar" del banner → se limpia correctamente y
   la pestaña que perdió ve los datos de la que ganó.
5. **bfcache:** se probó si el navegador podía estar restaurando la página
   desde back-forward-cache (lo que congelaría el JS, banner incluido, sin
   volver a pasar por el server) vía `goBack()`; en el Chromium de Playwright
   no se disparó (`persisted: false`), pero es un mecanismo real del
   navegador que **si** puede ocurrir en Chrome/Safari de verdad (gestos,
   volver atrás, pestaña suspendida y reanudada) y dejaría el banner pegado
   para siempre sin que el código tenga ningún bug.

**No se encontró ningún bug de código en `ca5d1d4`.** La explicación más
probable es que la pestaña de la captura quedó abierta durante o antes de la
ventana del bug anterior (el loop de `3ff0fef`) y nunca se recargó — el
`bloqueado=true` es un flag en memoria de esa pestaña puntual, no algo que el
server pueda "arreglar" del otro lado sin que esa pestaña vuelva a cargar.

**Hardening agregado igual, por las dudas (bajo riesgo, cero cambio de
comportamiento en uso normal):** `public/app.js`, en el listener
`DOMContentLoaded`, ahora también escucha `pageshow` y fuerza
`location.reload()` si `event.persisted` es `true` (la señal estándar de que
la página se restauró desde bfcache en vez de cargar de cero). Verificado que
no dispara en carga normal ni al cambiar de pestaña interna, y que CA-4
(conflicto real + click físico en "Recargar") sigue en verde.

---

## 2026-08-06 (2) — Revertido: auto-reload en carrera de creación

El fix anterior (más abajo, "Fix: banner de conflicto en el arranque") agregaba
un `location.reload()` automático cuando el 409 era por una carrera de
creación (`version: 0`), para no mostrarle el banner a la pestaña que perdía
esa carrera. En la máquina real apareció evidencia de un **loop de recargas**:
con una sola pestaña y base con datos ya cargados, el Network mostraba
`GET /api/docs` repitiéndose solo, sin ningún `PUT`/`POST`/`409` de por medio.

Repasando el código, esa secuencia es contradictoria con la lógica tal como
está escrita: el `location.reload()` solo puede dispararse dentro del
`catch` de `flush()`, y ese `catch` solo se alcanza si `enviarLote()` recibió
un `409` real de un `POST /api/docs/batch` — o sea, tendría que haber un
`POST` y un `409` en la red antes de cada recarga, y el reporte decía que no
los había. No se pudo reconciliar esa observación con una lectura línea por
línea del código, así que en vez de seguir buscando una causa que el código no
sostiene, se aplicó la salida seguridad que el pedido ya autorizaba: **se quitó
el auto-reload por completo**. Una carrera de creación ahora se trata
exactamente igual que cualquier otro conflicto: banner rojo, sin bloqueo
silencioso, sin ninguna recarga automática. `public/storage.js` quedó
byte-a-byte igual al de antes del fix de carrera, salvo un texto de log.

**Verificado con Chromium real (Playwright):**
- Una pestaña, base con datos, observada **150 segundos** mirando la red en
  vivo: 1 sola navegación (la carga inicial), 1 solo `GET /api/docs`, cero
  escrituras, cero banner. Ninguna actividad no solicitada.
- CA-4 (dos instancias, misma obra, conflicto real) intacto: la que escribe
  primero sigue libre, la de versión vieja sigue bloqueándose.
- Carrera de creación (base vacía, dos pestañas simultáneas): una de las dos
  pierde y muestra el banner, pero **ninguna de las dos navega de más** —
  exactamente 1 navegación por pestaña (la carga inicial), nada de loop.

No se llegó a identificar la causa exacta de lo observado en la máquina real,
más allá de que el código, tal como estaba, no debería producirla salvo un 409
real de por medio. Si el síntoma reaparece con este cambio (que ya no tiene
ningún camino de recarga automática salvo el botón manual del banner), no
puede venir de esta lógica.

---

## 2026-08-06 (1) — Fix: banner de conflicto en el arranque (carrera de creación)

**Síntoma reportado:** con una sola ventana abierta, al arrancar aparecía el
banner "Otro dispositivo modificó estos datos" — y volvía a aparecer
inmediatamente después de apretar "Recargar".

**Investigación.** La hipótesis inicial (Riesgo C: `recalcTodo()` persistiendo
solo al arrancar) ya estaba cerrada por el fix anterior — se confirmó
exhaustivamente que un boot normal, con una sola instancia, no dispara ningún
`PUT`/`POST`: se verificó leyendo el código completo (los 19 sitios que llaman
`db.save()` son todos acciones de usuario, ninguno corre en el arranque), con
un harness headless (Node `vm`) replicando el `DOMContentLoaded` real, y con
**Chromium real vía Playwright** — incluida una corrida contra la base de datos
real que había quedado en `data/sgo.sqlite`, con dos obras y datos de ejemplo
cargados. En los tres casos: cero escrituras en el arranque, cero banner.

**Causa raíz encontrada (con Chromium real, dos pestañas):** contra una base
**recién vacía** (primer uso), el arranque crea el registro de obras y el
catálogo con `version: 0` (crear-si-no-existe). Si dos cargas casi
simultáneas de la app pegan contra esa base vacía —dos pestañas, o el propio
Chrome precargando la URL al escribirla en la barra (prerendering del
omnibox)— ambas intentan crear los mismos documentos. Gana una; la otra recibe
un `409` **real** del server y queda bloqueada con el banner, aunque no había
ningún dato del usuario en juego: perdió una carrera de inicialización, no un
pisado de edición. Esto explica el "una sola ventana visible" del reporte: la
pestaña perdedora nunca tuvo datos propios que perder.

**Fix** (`public/storage.js`): en `enviarLote`, si TODO lo que chocó en el
`409` se estaba intentando **crear** (`version: 0` en el intento local, no
editar), es una carrera de creación, no un conflicto de datos. En ese caso no
se bloquea la app ni se muestra el banner: se hace **un** `location.reload()`
para adoptar la versión que ya ganó la carrera (con una guarda en
`sessionStorage` para no loopear si, por lo que sea, se repitiera). Un
conflicto real de EDICIÓN (`version > 0`) sigue tratándose exactamente igual
que antes: bloquea y muestra "recargá", sin fusión automática — eso no cambió.

**Verificado con Chromium real (Playwright), todo en verde:**
- CA-FIX-1: una instancia, base ya cargada, arranque → cero PUT/batch, cero
  409, cero banner.
- CA-FIX-2: recargar 6 veces seguidas → el banner nunca aparece.
- CA-FIX-3: CA-4 original intacto — dos instancias sobre la misma obra, la
  segunda (versión vieja) sigue bloqueándose correctamente.
- Repetido CA-5 (obras distintas, cero conflictos de catálogo) → sigue en
  verde.
- La carrera de creación original (dos pestañas contra base vacía) → antes del
  fix, una quedaba bloqueada; después del fix, ninguna.

---

## 2026-08-05 — Migración de localStorage a Node + Fastify + SQLite

Se convirtió SGO de app estática con estado en `localStorage` a app
multi-dispositivo con backend propio. Base limpia: **no se migró data existente**.

### Hecho

**Backend**
- `src/config.js` — configuración por entorno con defaults, validada al arrancar.
  Sin `dotenv`: se usa `node --env-file-if-exists`.
- `src/db.js` — SQLite vía `better-sqlite3`. Tabla `docs` (clave, json, versión,
  timestamps), WAL activado. Versionado optimista y batch transaccional.
- `src/routes/health.js` — `GET /health` con `SELECT 1` contra la base.
- `src/routes/docs.js` — API de documentos + whitelist de claves.
- `src/server.js` — Fastify sirviendo `public/` y la API bajo `/api`, con cierre
  ordenado en `SIGINT`/`SIGTERM`.

**Front**
- `sgo-1/` → `public/` (con `git mv`, se preserva la historia).
- `public/storage.js` (nuevo) — `sgoStore`: cache en memoria hidratado al
  arrancar, cola de escritura con debounce de 400 ms, reintentos con backoff y
  manejo de conflictos.
- `public/app.js` — 15 reemplazos mecánicos de `localStorage.*` a `sgoStore.*` y
  4 cambios puntuales:
  1. `hydrate()` al arrancar (único `await` de la app).
  2. `recalcTodo({ persist: false })` en el arranque y al cambiar de obra, para
     que la app no escriba sola al abrirse.
  3. `beforeunload` ya no guarda: pide confirmación si hay escrituras pendientes.
  4. `db.save()` delega el indicador de guardado a `sgoStore`.
  **Ninguna fórmula ni ningún monto cambió.**
- UI de estado: indicador en `#hdr-last-action`
  (Guardando… / Guardado hh:mm / Sin conexión / Sin guardar) y dos carteles: uno
  de conflicto y otro para cuando no se puede contactar al server al arrancar.

**Infra y docs**
- `.gitignore`, `.env.example`, `package.json`.
- `README.md`, `ARQUITECTURA.md`, `CLAUDE.md`, este archivo.

### Criterios de aceptación — verificados

Se verificaron headless, cargando el `app.js` y el `storage.js` reales en
contextos VM contra el server corriendo de verdad. Dos "pestañas" son dos
instancias independientes de `sgoStore`, igual que dos browsers.

| | Criterio | Resultado |
|---|---|---|
| CA-2 | Sin ningún estado local, la app carga los datos del server | verde |
| CA-3 | Matar y relevantar el proceso: los datos y las versiones sobreviven | verde |
| CA-4 | Dos pestañas en la misma obra: la segunda queda bloqueada y **no pisa** | verde |
| CA-5 | Obras distintas: cero conflictos, cero `version_conflict` del catálogo | verde |
| CA-6 | Alta de proveedor visible desde otra obra | verde |
| CA-7 | Con escrituras pendientes, cerrar pide confirmación; ya guardado, no | verde |
| CA-8 | `/health` devuelve `200`; los logs son una línea JSON por request | verde |
| CA-9 | El motor de cálculo da resultados **byte-idénticos** al de antes | verde |
| CA-10 | La API rechaza claves inválidas (`400`), inexistentes (`404`), versión vieja (`409`) | verde |

CA-9 se verificó corriendo el mismo escenario (comprobantes, FIFO, retenciones,
anticipos, saldo a favor, liberación de retención, presupuestos) contra el
`app.js` original de git y contra el actual, con IDs y fechas deterministas, y
comparando montos, saldos, estados y agregados. Salida idéntica.

**Pendiente de verificación manual en browser:** el recorrido visual completo
(Tablero, Cuenta Corriente, Presupuesto renderizados) y la exportación a
XLSX/CSV. La lógica que los alimenta está verificada; falta confirmar que se
pintan bien.

### Fuera de scope de esta etapa

- Dockerfile y `.dockerignore` → fase de infra.
- Configuración de Dokploy, túnel, DNS, dominio `sgo.alejorro.dev` → fase de infra.
- Login.
- Migrar datos viejos del `localStorage`.
- Arreglar la representación de plata en float.

---

## Próximo paso

**Terminar de conectar Railway.** El código ya está: falta crear el servicio
de Postgres en el proyecto, cargar las variables (`DATABASE_URL` como
referencia `${{Postgres.DATABASE_URL}}`, más las cuatro `R2_*`) y apuntar el
CNAME de `sgo.dot4sa.com` al dominio que dé Railway.

Después de eso, lo primero a mirar es el log del primer backup (arranca 2
minutos después del boot): confirma de una sola vez que Postgres, `pg_dump` y
las credenciales de R2 están todos bien.

**Y después: login.** Sigue siendo el hueco más grande — la app no tiene
autenticación y con dominio propio deja de estar escondida detrás de una URL
que nadie conoce.

---

## Mejoras futuras (no urgentes)

- **Auto-fusión del catálogo global ante conflicto.** Hoy un `409` del catálogo
  se trata como cualquier otro: cartel de "recargá". Se podría resolver solo
  —refetch del catálogo, reaplicar el cambio con `mergeProveedoresYRubros()`
  (que ya existe en `app.js` y es idempotente por nombre y tipo) y reintentar—
  de modo que el usuario no se entere. Se dejó afuera a propósito para achicar
  la superficie de error de esta etapa. Con la mitigación de no reencolar el
  catálogo cuando no cambió, estos conflictos son raros.
- **Ver los cambios del otro sin recargar** (polling liviano o SSE).
- **Login**, y con él revisar el protocolo de dos usuarios de CLAUDE.md.
- **Endpoints por entidad** si alguna vez hacen falta permisos granulares.

---

## Deudas conocidas

- **Plata en float.** `round2()` es `Math.round(n * 100) / 100` sobre `Number`;
  todos los montos son floats, con epsilon `0.01` a mano. Viola la regla del
  proyecto. **El server no la empeora**: no hace aritmética de plata, solo
  persiste JSON opaco. Arreglarlo es tocar el motor de cálculo entero y necesita
  su propia tarea con su propia validación. Ver CLAUDE.md §1.
- **Assets por CDN.** Bootstrap, Bootstrap Icons, Chart.js y XLSX se bajan de
  jsdelivr. La app no funciona offline ni si el CDN no responde. Se resuelve
  vendorizándolos en `public/vendor/`.
- **Bootstrap completo en cada arranque.** `escanearUsoGlobal()` necesita todas
  las obras, así que se traen todos los documentos de una. Con el máximo de 5
  obras son kilobytes; si ese límite sube mucho, hay que repensarlo.
- **Doble escritura si se pierde una respuesta.** Si el server aplica un batch
  pero la respuesta no llega, el reintento recibe un `409` que no es un
  conflicto real: el usuario ve "recargá" y encuentra sus datos ya guardados.
  Contrapartida estándar de la concurrencia optimista sin claves de
  idempotencia. No se resolvió: el costo supera al beneficio a esta escala.
- **Rutas de migración muertas.** `migrarDesdeMonoObra()` y
  `migrarDesdeObras()` en `app.js` quedaron inertes con base limpia. No se
  borraron por estar fuera de scope.
