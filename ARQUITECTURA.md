# Arquitectura

## En una frase

SGO era una app 100% client-side con todo el estado en `localStorage`. Se le
puso un backend que sirve el mismo front y persiste **los mismos blobs JSON** en
Postgres. Se reemplazó únicamente la capa de storage: la lógica de negocio del
front no cambió.

---

## 1. Persistencia documental, no relacional

El server **no entiende** lo que guarda. Recibe un JSON, lo guarda como texto y
lo devuelve igual. No hay tablas de comprobantes, pagos ni proveedores.

Esto es deliberado: el objetivo era dejar de depender del browser sin reescribir
la app. Un modelo relacional hubiera obligado a rehacer los ~50 puntos donde el
front lee y escribe datos, más todo el motor de cálculo.

### Las tres claves

Son exactamente las que usaba `localStorage`, sin traducir:

| Clave | Contenido |
|---|---|
| `sgo_obras_v1` | Registro de obras: `{ obras: [{id, nombre, createdAt}], activaId }` |
| `sgo_global_v1` | Catálogo **compartido** por todas las obras: `{ proveedores, rubros }` |
| `obra_db_v1__<obraId>` | Datos de una obra: comprobantes, pagos, presupuestos, parámetros |

### Esquema

Una sola tabla, creada con `CREATE TABLE IF NOT EXISTS` al arrancar. No hay
migraciones ni herramienta de migraciones: si el esquema alguna vez cambia, se
discute aparte.

```sql
CREATE TABLE IF NOT EXISTS docs (
  key        TEXT PRIMARY KEY,
  json       JSONB NOT NULL,
  version    INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`JSONB` y no `TEXT`: `jsonb` valida que lo guardado sea JSON de verdad, y el
driver lo devuelve ya parseado (una vuelta menos de `JSON.parse`). Sigue siendo
opaco para el server, que no mira adentro.

**Sobre la plata:** `jsonb` guarda los números como `numeric`, de precisión
decimal arbitraria, así que un monto va y vuelve **exacto**. Verificado con
los casos feos (`0.1`, `0.30000000000000004`, `1e-7`, `9007199254740991`, el
doble máximo): todos vuelven `Object.is`-idénticos, también después de un
`pg_dump` + `pg_restore`.

**Lo único que sí cambia es el orden de las claves:** `jsonb` lo normaliza
(no guarda el orden de inserción). Ningún valor se altera y nada de la app
depende del orden — la comparación de `sgoStore.setItem` que evita reencolar
el catálogo compara el cache local contra un `JSON.stringify` local, ambos con
el mismo orden, no contra el string del server.

### Conexión

Pool de `pg` (`max: 5`), `DATABASE_URL` por entorno. El SSL se decide mirando
el host: dentro de Railway se habla por la red privada (`*.railway.internal`),
que no ofrece TLS y donde pedirlo hace fallar la conexión; contra cualquier
host externo va TLS sin verificar la cadena (certificado autofirmado, sin CA
con qué validarlo).

La primera conexión reintenta 6 veces cada 2 s: en un deploy, Railway levanta
la app y la base en paralelo y es normal que los primeros intentos den
`ECONNREFUSED`. Si aun así no conecta, el proceso muere y el healthcheck
falla — que es exactamente lo que tiene que pasar para que Railway no
promocione ese deploy.

### Whitelist de claves

`:key` es input del usuario y va directo a la PK. Se aceptan solo las tres
formas de arriba, con el `obraId` matcheando `^[a-z0-9_]{1,64}$`. Cualquier otra
cosa devuelve `400` antes de tocar la base. Sin esto, cualquiera con la URL
podría llenar la base de documentos basura (la app todavía no tiene login).

Está en `src/routes/docs.js`, función `isAllowedKey`.

---

## 2. La capa de storage del front (`public/storage.js`)

El problema: `db.get()` se usa de forma **sincrónica** en unas 50 partes de
`app.js`, y `escanearUsoGlobal()` recorre **todas** las obras en cada render.
Volver eso asincrónico significaba reescribir la app entera.

La solución: `sgoStore` mantiene el contrato de `localStorage`
—`getItem`/`setItem`/`removeItem` sincrónicos, manejando strings— y mueve el
asincronismo a los bordes.

```
  arranque          GET /api/docs  ──►  cache en memoria (todos los documentos)
  lectura           getItem()      ──►  cache. Nunca toca la red.
  escritura         setItem()      ──►  cache + cola  ──(400 ms)──►  POST /api/docs/batch
```

### Por qué se traen todos los documentos de una

`escanearUsoGlobal()` necesita los datos de todas las obras para saber si un
proveedor o un rubro se puede borrar. Con un máximo de 5 obras son ≤7
documentos, del orden de kilobytes: un solo request al arrancar.

**Límite conocido:** si algún día suben mucho las obras o el tamaño de los
documentos, ese arranque se vuelve pesado.

### Debounce de 400 ms

`db.save()` escribe el documento de la obra **y** el catálogo global. Una acción
del usuario (guardar un comprobante → recalcular → guardar) dispara varias
escrituras seguidas. El debounce las agrupa en un solo `POST /api/docs/batch`.

### Reintentos

Ante falla de red o `5xx`: 3 intentos con backoff (500 / 1500 / 4500 ms). Si se
agotan, las escrituras vuelven a la cola, el indicador dice "Sin conexión —
reintentando" y se reintenta cada 10 s. Un `409` **no** se reintenta: no es
transitorio.

### Cerrar la pestaña

No se guarda en `beforeunload`: un `fetch` disparado ahí no llega a completarse,
y `sendBeacon` tiene un límite de 64 KB que un documento de obra supera, además
de no poder leer la respuesta para detectar un conflicto.

En cambio, si quedan escrituras sin confirmar se llama a `preventDefault()` y el
browser pregunta "¿salir del sitio?". Es la única garantía confiable.

**Ventana de pérdida:** ~400 ms (el debounce), y solo si el usuario elige salir
igual ante la pregunta del browser.

---

## 3. Concurrencia optimista, resuelta en silencio

SGO lo usa una sola persona, que puede tener más de un dispositivo o pestaña
abiertos a la vez. No hay banner ni pantalla de "recargá": un choque se
resuelve solo, sin interrumpir a nadie.

Cada documento tiene una `version` que arranca en 1 y sube de a uno. Quien
escribe declara qué versión creía estar editando:

```sql
UPDATE docs SET json = ?, version = version + 1, updated_at = ?
WHERE key = ? AND version = ?
```

Si no afecta ninguna fila, alguien escribió primero → `409` con el documento
actual en el cuerpo. `version: 0` en un `PUT` significa "crear si no existe".

### Qué pasa en el front

`sgoStore` (`public/storage.js`) nunca bloquea. Ante un `409`:

1. Busca si hay un **resolutor** registrado para esa clave
   (`sgoStore.registrarResolutor`, ver `public/app.js`).
2. Si lo hay, combina el cambio local con la versión fresca del server. Si no,
   el cambio local gana tal cual (se reintenta con la versión correcta).
3. Reintenta el guardado. Hasta 3 vueltas; si se agotan, esa clave queda para
   el próximo guardado real (nada insiste ni avisa).

Tres resolutores registrados, todos reusando mecanismos existentes o triviales
—nada de lógica de negocio nueva, `recalcTodo()` sigue recalculando todo
después de cualquier merge:

| Clave | Resolutor |
|---|---|
| `sgo_obras_v1` (registro de obras) | Unión de `obras` por `id`; la obra activa se mantiene si sigue existiendo |
| `sgo_global_v1` (catálogo global) | El merge idempotente por nombre/tipo que ya usaba la migración vieja (`mergeProveedoresYRubros`) |
| `obra_db_v1__*` (documento de obra) | Unión por `id` de `comprobantes`/`pagos`, por `rubroId` de `presupuestos` |

**Límite conocido, a propósito:** el merge es por unión de registros nuevos, no
por campo. Si el mismo comprobante (mismo `id`) se edita distinto en dos
pestañas casi al mismo tiempo, gana la versión del server — el cambio de la
otra pestaña se pierde en silencio. Es el trade-off aceptado al priorizar
"silencioso" sobre "avisar": para que nunca se pierda nada hay que volver a
interrumpir al usuario, que es exactamente lo que se sacó.

### El batch es transaccional

`db.save()` escribe dos documentos que tienen que quedar consistentes entre sí.
`POST /api/docs/batch` los aplica en una transacción de Postgres
(`BEGIN` … `COMMIT`, con `ROLLBACK` si alguno choca): si alguno choca,
**ninguno** se escribe y se devuelve `409` con la lista de conflictos —el front
resuelve cada uno y reintenta el lote entero.

### El catálogo global: el punto caliente

`db.save()` reescribe `sgo_global_v1` en **cada** acción, aunque el catálogo no
haya cambiado. Sin mitigación, dos pestañas trabajando en obras distintas
chocarían todo el tiempo sin haber tocado un proveedor.

La mitigación está en `sgoStore.setItem`: si el string nuevo es idéntico al
último persistido, **no se encola nada**. Barato y suficiente, y además el
resolutor del catálogo cubre el caso en que sí choca de verdad.

---

## 4. Plata: deuda técnica registrada

**Regla del proyecto: la plata nunca va en float.** Hoy el front **no la
cumple**: `round2()` es `Math.round(n * 100) / 100` sobre `Number`, y todos los
montos (`totalARS`, `saldoARS`, `retencionARS`, `montoImputado`,
`montoPresupuestadoARS`) son floats, con comparaciones contra un epsilon `0.01`
escrito a mano.

**Esto no se tocó en esta etapa y no es scope del backend.** Queda asentado:

- El server **no hace aritmética de plata**. Guarda el JSON que arma el front en
  una columna `TEXT`, opaco. No suma, no redondea, no compara montos. Por lo
  tanto **no empeora** la situación.
- Si alguna vez el server tiene que calcular totales, lo primero es pasar a
  enteros en centavos. No se agrega lógica de plata al backend sobre la
  representación actual.

---

## 5. Observabilidad

`GET /health` devuelve `{ status, db, uptime, version }`. Ejecuta un `SELECT 1`
contra Postgres —no lee ni escribe ninguna tabla— y responde `503` si la base no
contesta. Es lo que mira Railway antes de mandarle tráfico a un deploy nuevo.

Los logs son los de `pino`, que viene con Fastify: una línea JSON por request con
`method`, `url`, `statusCode` y `responseTime`. Los conflictos de versión se
loguean en `warn` con la clave y las dos versiones: es la señal para saber si el
diseño de concurrencia molesta en la práctica.

---

## 6. Decisiones y lo que se descartó

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| Cache en memoria hidratado al arrancar | Volver `db.get()` asincrónico | Correcto de libro, pero reescribe ~50 llamadas y todo el motor de cálculo |
| Endpoint genérico `/api/docs/:key` | Endpoints por entidad (`/api/obras`, …) | El front ya piensa en "clave → blob". Los endpoints por entidad recién sirven cuando haya login y permisos por entidad; se agregan encima sin romper nada |
| `POST /api/docs/batch` transaccional | Dos `PUT` sueltos | Pueden dejar el catálogo guardado y la obra no |
| Guardado explícito + debounce | `sendBeacon` en `beforeunload` | Límite de 64 KB y no puede leer el `409` → pisadas silenciosas |
| Fastify | Express | Estático oficial, `pino` de fábrica y validación de schema incluidos |
| Postgres documental (`jsonb`) | Postgres relacional | Lo relacional obligaba a rehacer el front entero (~50 puntos de lectura/escritura + el motor de cálculo). El modelo clave→blob se mantuvo tal cual |
| Postgres | SQLite en un volume | El volume de Railway es un punto de falla propio (se monta como `root`, el contenedor corre como `node` → "readonly database"), no se puede leer desde afuera y obliga a un solo contenedor. Postgres es un servicio aparte, con `pg_dump` para backup y sin gimnasia de permisos |
| `pg_dump` diario a R2 | Backups de Railway | Railway no da backups automáticos de Postgres. R2 además deja las copias **fuera** del proveedor: si se pierde la cuenta de Railway, el backup sigue estando |
| Sin polling ni websockets | Push de cambios | Usuario único, cambios ajenos se ven al recargar; agrega estado sin ganancia clara |
| Merge por unión de registros | Bloquear y avisar (banner) | Un solo usuario: mejor resolver solo que interrumpir. El costo es perder ediciones al mismo registro hechas en paralelo (raro), no altas nuevas |

---

## 7. Deploy: Railway + Postgres

El runtime de producción es Railway (PaaS): push a `main` dispara build y
deploy. Railway corre el healthcheck (`GET /health`) antes de cortar tráfico
a la versión nueva; si el build o el healthcheck fallan, la versión anterior
sigue sirviendo sin interrupción.

Son **dos servicios** en un proyecto: la app y Postgres. La app recibe
`DATABASE_URL` como **referencia** al servicio de base
(`${{Postgres.DATABASE_URL}}`), no como URL copiada a mano: si Railway rota
las credenciales, sigue andando.

El build es **Nixpacks**, sin Dockerfile: ya no hay módulos nativos que
compilar. Nixpacks detecta Node por `package.json` solo; `nixpacks.toml`
únicamente agrega el cliente de Postgres, para que exista el binario
`pg_dump` que usa el backup. La config de deploy (healthcheck, start command,
política de reinicio) vive en `railway.json`, versionada.

### Backup a Cloudflare R2

Railway **no** hace backups de Postgres. Los hace la app (`src/backup.js`):

```
  cada 24 h ──► pg_dump -Fc ──► PUT a R2 (SDK S3)  ──► poda lo que pasó 30 días
```

Reglas de diseño:

- **Aislado.** Todo va envuelto en try/catch. Si falta una credencial, si
  `pg_dump` no está, si R2 no responde: se loguea y la app sigue sirviendo
  igual. Un backup roto nunca tumba el server ni hace fallar el healthcheck.
- **Se apaga solo si no está configurado.** Sin las cuatro variables `R2_*`,
  queda deshabilitado con un `warn` en el log.
- **Fuera del proveedor.** R2 es de Cloudflare, no de Railway: si se pierde la
  cuenta de Railway, las copias siguen estando.
- **Plan B en JSON.** El modo de falla más probable es un desajuste de versión
  (`pg_dump` se niega a volcar una base de un server más nuevo que él). Si el
  `pg_dump` falla por lo que sea, se sube en cambio la tabla `docs` entera
  serializada a JSON. Como el esquema es una sola tabla que la app recrea al
  arrancar, ese JSON **es** el 100% de los datos. Un backup que se apaga solo
  en silencio no sirve de nada.

La primera corrida arranca 2 minutos después del boot, para no competir con el
healthcheck del deploy.

---

## 8. Límites actuales

- **Sin autenticación.** La URL no está listada y nada más. Es lo próximo.
- **Los cambios de otro dispositivo no llegan solos:** se ven al recargar.
- **Los assets (Bootstrap, Chart.js, XLSX) vienen de un CDN.** La app no
  funciona offline ni si jsdelivr no responde.
- **Sin migración de datos.** Se arrancó con base limpia; lo que hubiera en el
  `localStorage` de un browser se ignora.
