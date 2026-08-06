# CLAUDE.md — reglas para trabajar en este repo

SGO: mini-app de control de gastos de obra. Front vanilla JS sin build, servido
por Fastify, con persistencia documental en Postgres. Leer
[ARQUITECTURA.md](ARQUITECTURA.md) antes de tocar la capa de datos.

---

## PROTOCOLO DE USUARIO — leer SIEMPRE al iniciar sesión

Al arrancar CUALQUIER sesión, ANTES de tocar nada, preguntar: **"¿Con quién
hablo: Alejo o Mariano?"** y esperar la respuesta. No asumir ni avanzar sin
eso. Es una convención de trabajo, no verificación de identidad: actuás
según lo que la persona responda.

El deploy es automático para los dos: push a `main` → Railway buildea +
healthcheck; si falla, no promociona la versión nueva y sigue sirviendo la
anterior (ver §8 Deploy). Lo que cambia entre un usuario y otro **no es el
deploy**, es **cuándo hay luz verde para pushear**.

### Si es ALEJO (owner técnico)

- Sus cambios vienen como prompts ya trabajados: de **ANÁLISIS** (no
  implementás, devolvés plan y parás) o de **EJECUCIÓN** (implementás lo
  aprobado). Respetá cuál es.
- En ejecución: implementás lo aprobado, commiteás y pusheás a `main`. No
  metas scope extra.
- Frenás y pedís OK ante migraciones destructivas (`DROP`/`DELETE`/`ALTER`
  que borra o transforma datos), siempre (ver §7 Datos destructivos).

### Si es MARIANO (jefe / owner de producto, no dev)

Hace cambios chicos directo, sin prompts de dos fases. Tu trabajo: que
salgan sanos y que él no tenga que saber de código.

1. Implementás el cambio.
2. Te asegurás de que **funciona**: `npm run dev` levanta, `curl
   localhost:3000/health` devuelve `200`, y probás lo que tocaste (no
   alcanza con que compile o arranque).
3. Le explicás en criollo qué cambiaste y qué impacto tiene.
4. Commiteás siempre.
5. **NO pusheás solo.** Preguntás "¿Lo pusheo a producción?" y solo pusheás
   a `main` si dice que sí.

Mariano puede pushear cambios chicos sin drama: la red es Railway
(healthcheck; si el deploy falla sigue sirviendo la versión anterior) y Alejo
se entera si algo se rompe y lo arregla.

**LÍMITE DURO:** si el cambio toca plata, datos, migraciones, config de
deploy, o es más que un ajuste chico → NO ofrezcas push. Decile a Mariano que
eso lo revisa Alejo primero, dejalo commiteado en una rama aparte (no
`main`), y avisá que queda para Alejo.

---

## 1. La plata nunca va en float

Regla dura del proyecto.

**Estado actual: el front NO la cumple.** `round2()` es
`Math.round(n * 100) / 100` sobre `Number`; todos los montos son floats y las
comparaciones usan un epsilon `0.01` escrito a mano. Es **deuda registrada**, no
un descuido que haya que arreglar de paso.

Qué implica en la práctica:

- **El server no calcula plata.** Persiste el JSON que arma el front en una
  columna `JSONB`, opaco: no suma, no redondea, no compara montos. Mantenerlo
  así. (`jsonb` guarda los números como `numeric`, de precisión decimal
  exacta, así que la ida y vuelta por la base no cambia ningún monto —
  verificado, ver PROGRESS.md.)
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

Las actuales son `fastify`, `@fastify/static`, `pg` y `@aws-sdk/client-s3`
(este último solo para subir el backup a R2). `pino` viene con Fastify.

**No agregar dependencias sin avisar y justificar.** El valor de este stack es
que es chico y se entiende entero. Antes de sumar un paquete: ver si Node lo
trae de fábrica (por ejemplo, `--env-file` reemplaza a `dotenv`).

## 7. Datos destructivos

No hay migraciones: la tabla se crea sola con `CREATE TABLE IF NOT EXISTS` al
arrancar. Si alguna tarea implicara un `DROP`, `DELETE`, `TRUNCATE` o `ALTER`
destructivo sobre datos existentes: **frenar y pedir OK explícito**.

Mismo cuidado a nivel de shell con `dropdb`, `psql -c "TRUNCATE ..."` o
`pg_restore --clean`: antes de correrlos, confirmar contra **qué** base
apuntan. La `DATABASE_URL` de producción y la de desarrollo se parecen lo
suficiente como para equivocarse. Para pruebas, crear una base nueva
(`createdb sgo_test`) en vez de limpiar una existente. Ya pasó una vez que una
limpieza de datos de prueba se llevó puesta la base real del usuario (ver
PROGRESS.md, 2026-08-06).

Hay backup automático a R2 (§8), pero es diario: entre backup y backup se
pierde hasta un día de trabajo. No es red para un borrado a mano.

## 8. Deploy: Railway + Postgres

El molde de deploy para SGO y las demás mini-apps es Railway (PaaS en la
nube). Push a `main` → Railway buildea la imagen → corre el healthcheck
contra `/health` → recién ahí corta el tráfico a la versión nueva. Railway
mantiene la versión anterior sirviendo mientras tanto; si el build o el
healthcheck fallan, la versión nueva no sale y la anterior sigue en pie.

Dos servicios en el mismo proyecto de Railway: **la app** y **Postgres**. La
app recibe la conexión por `DATABASE_URL`, que se apunta al servicio de base
con una referencia (`${{Postgres.DATABASE_URL}}`), no con la URL copiada a
mano: así sigue andando si Railway rota las credenciales. Adentro de Railway
el tráfico va por la red privada (`*.railway.internal`), que **no** lleva TLS;
`src/db.js` decide el SSL según el host y no hay que tocar nada.

No hay Dockerfile ni volume: el build es Nixpacks (`nixpacks.toml` solo agrega
el cliente de Postgres para que exista `pg_dump`) y la config de deploy vive en
`railway.json`.

El dominio es **`sgo.dot4sa.com.ar`**. Cuidado: `dot4sa.com` (sin `.ar`) es
otro dominio, con otra zona DNS y el mail de la empresa colgando de ahí. No
tocarlo. Ver README §Dominio.

El backup **no** lo da Railway: lo hace la app, un `pg_dump` diario a
Cloudflare R2 con retención de 30 días (`src/backup.js`). Es una tarea de
fondo aislada — si falla, loguea y la app sigue sirviendo igual. Nunca
convertirla en algo que pueda tumbar el server o hacer fallar el healthcheck.

## 9. Antes de dar algo por terminado

- `npm run dev` levanta contra un Postgres real y `curl localhost:3000/health`
  devuelve `200` con `"db":"ok"` (necesita `DATABASE_URL` en `.env`; sin base
  el server muere al arrancar, a propósito).
- Ningún monto ni fórmula cambió de valor.
- Los criterios de aceptación relevantes en [PROGRESS.md](PROGRESS.md) siguen en
  verde.
- Nada de secretos en el código ni en git. Solo `.env.example` se versiona.
