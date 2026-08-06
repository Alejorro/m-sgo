# CLAUDE.md — reglas para trabajar en este repo

SGO: mini-app de control de gastos de obra. Front vanilla JS sin build, servido
por Fastify, con persistencia documental en SQLite. Leer
[ARQUITECTURA.md](ARQUITECTURA.md) antes de tocar la capa de datos.

---

## 1. La plata nunca va en float

Regla dura del proyecto.

**Estado actual: el front NO la cumple.** `round2()` es
`Math.round(n * 100) / 100` sobre `Number`; todos los montos son floats y las
comparaciones usan un epsilon `0.01` escrito a mano. Es **deuda registrada**, no
un descuido que haya que arreglar de paso.

Qué implica en la práctica:

- **El server no calcula plata.** Persiste el JSON que arma el front en una
  columna `TEXT`, opaco: no suma, no redondea, no compara montos. Mantenerlo
  así.
- **No agregar lógica de plata al backend** sobre la representación actual. Si
  alguna vez hace falta, lo primero es pasar a enteros en centavos, y eso es un
  cambio con su propia discusión.
- **No "arreglar" el float del front por iniciativa propia** dentro de otra
  tarea. Toca el motor de cálculo entero y necesita su propia validación.

## 2. No tocar la lógica de negocio del front

`public/app.js` contiene el motor de cálculo (FIFO de imputaciones, retenciones,
saldo a favor, exposición cambiaria, curva S, semáforos de presupuesto) y todos
los renders. **No se modifica** salvo que la tarea sea explícitamente sobre eso.

Si un cambio de infraestructura parece exigir tocar una función de negocio,
frenar y preguntar. Ya pasó una vez: `recalcTodo()` recibió un flag
`{ persist: false }` porque persistía al arrancar la app, y se pidió OK antes.

Regla práctica: ninguna fórmula ni ningún monto puede cambiar de valor. Si un
cambio no puede demostrarse neutral, no va.

## 3. Toda escritura pasa por `sgoStore`

`public/storage.js` es la única puerta a la persistencia del front.

- **Nunca** usar `localStorage`, `sessionStorage` ni `fetch` directo para datos
  de negocio desde `app.js`.
- `getItem` / `setItem` / `removeItem` son **sincrónicos** a propósito: es lo que
  permite que el resto de la app no haya cambiado. No convertirlos en `async`.
- El único punto asincrónico es `hydrate()`, al arrancar.
- `setItem` no encola si el contenido es idéntico al último persistido. Esa
  comparación es lo que evita conflictos espurios del catálogo global: **no
  quitarla**.

## 4. Concurrencia: se resuelve sola, sin avisar

Cada documento tiene una versión. Si el server devuelve `409`, `sgoStore` NO
bloquea ni muestra nada: combina el cambio local con la versión fresca del
server (via los resolutores registrados en `app.js`, ver ARQUITECTURA.md §3) y
reintenta. Es intencional —la app la usa una sola persona, no tiene sentido
interrumpirla— y no se vuelve a un banner/bloqueo sin discutirlo antes.

Si se agrega un nuevo tipo de documento con arrays propios, registrar su
resolutor (`sgoStore.registrarResolutor`) en vez de dejarlo caer al
last-write-wins genérico, salvo que el last-write-wins sea realmente lo que
corresponde para ese documento.

## 5. Usuario único, multi-dispositivo

La usa una sola persona, que puede tener más de un dispositivo o pestaña
abiertos a la vez. No hay login todavía.

- Los cambios de otra pestaña/dispositivo **no aparecen solos**: hay que
  recargar para verlos.
- No hay banner de conflicto: un choque de guardado se resuelve solo (ver §4).
  El único costo real es si el mismo registro se edita distinto en dos
  pestañas casi al mismo tiempo — ahí gana el del server, sin avisar. Es un
  trade-off aceptado, no un bug.
- Si en algún momento pasa a usarla más de una persona, este protocolo entero
  se revisa (probablemente haya que volver a algún tipo de aviso).

## 6. Dependencias

Las actuales son `fastify`, `@fastify/static` y `better-sqlite3`. `pino` viene
con Fastify.

**No agregar dependencias sin avisar y justificar.** El valor de este stack es
que es chico y se entiende entero. Antes de sumar un paquete: ver si Node lo
trae de fábrica (por ejemplo, `--env-file` reemplaza a `dotenv`).

## 7. Datos destructivos

No hay migraciones: la base arranca limpia y la tabla se crea sola. Si alguna
tarea implicara un `DROP`, `DELETE` o `ALTER` destructivo sobre datos
existentes: **frenar y pedir OK explícito**.

Mismo cuidado con `data/` a nivel de shell: antes de borrar o limpiar esa
carpeta en la raíz del repo, confirmar que no hay un `npm run dev` real
corriendo contra esa ruta (`lsof -iTCP -sTCP:LISTEN | grep node`). Ya pasó una
vez que una limpieza de datos de prueba se llevó puesta la base real del
usuario (ver PROGRESS.md, 2026-08-06). No hay backup automático todavía.

## 8. Deploy: Railway

El molde de deploy para SGO y las demás mini-apps es Railway (PaaS en la
nube). Push a `main` → Railway buildea la imagen → corre el healthcheck
contra `/health` → recién ahí corta el tráfico a la versión nueva. Railway
mantiene la versión anterior sirviendo mientras tanto; si el build o el
healthcheck fallan, la versión nueva no sale y la anterior sigue en pie.

La base SQLite vive en un **Volume persistente de Railway montado en
`/data`** (`SGO_DB_PATH=/data/sgo.sqlite`). **Sin el volume, la data se borra
en cada deploy.** El backup **no** es automático en Railway: se configura
aparte (ver §7, todavía pendiente).

Esto es solo el contrato de deploy; la configuración real de Railway
(Dockerfile, volume, variables de entorno) es una fase aparte — ver
PROGRESS.md.

## 9. Antes de dar algo por terminado

- `npm run dev` levanta y `curl localhost:3000/health` devuelve `200`.
- Ningún monto ni fórmula cambió de valor.
- Los criterios de aceptación relevantes en [PROGRESS.md](PROGRESS.md) siguen en
  verde.
- Nada de secretos en el código ni en git. Solo `.env.example` se versiona.
