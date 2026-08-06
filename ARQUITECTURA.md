# Arquitectura

## En una frase

SGO era una app 100% client-side con todo el estado en `localStorage`. Se le
puso un backend que sirve el mismo front y persiste **los mismos blobs JSON** en
SQLite. Se reemplazó únicamente la capa de storage: la lógica de negocio del
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

```sql
CREATE TABLE docs (
  key        TEXT PRIMARY KEY,
  json       TEXT NOT NULL,
  version    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

PRAGMAs: `journal_mode = WAL` (una lectura no bloquea una escritura),
`synchronous = NORMAL`, `foreign_keys = ON`.

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
`POST /api/docs/batch` los aplica en una transacción de SQLite: si alguno choca,
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
contra SQLite —sincrónico, sub-milisegundo, no toca datos— y responde `503` si la
base no contesta.

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
| SQLite documental | Postgres relacional | Usuario único, un archivo, backup = copiar. Lo relacional obligaba a rehacer el front |
| Sin polling ni websockets | Push de cambios | Usuario único, cambios ajenos se ven al recargar; agrega estado sin ganancia clara |
| Merge por unión de registros | Bloquear y avisar (banner) | Un solo usuario: mejor resolver solo que interrumpir. El costo es perder ediciones al mismo registro hechas en paralelo (raro), no altas nuevas |

---

## 7. Deploy: Railway + Volume persistente

El runtime de producción es Railway (PaaS): push a `main` dispara build y
deploy. Railway corre el healthcheck (`GET /health`) antes de cortar tráfico
a la versión nueva; si el build o el healthcheck fallan, la versión anterior
sigue sirviendo sin interrupción.

La base SQLite necesita vivir en un **Volume persistente de Railway**
montado en `/data` (`SGO_DB_PATH=/data/sgo.sqlite`). Sin el volume, cada
deploy levanta un filesystem nuevo y la data se pierde.

**Gotcha conocido, sin resolver todavía (fase de deploy):** el Volume de
Railway se monta como `root`, pero el contenedor corre como usuario `node` →
sin ajustar los permisos de escritura sobre el punto de montaje, SQLite falla
con "readonly database" en el primer intento de escritura. Queda pendiente
para la fase de configuración de Railway; no se resuelve en esta etapa (esta
sección es solo documentación).

---

## 8. Límites actuales

- **Sin autenticación.** La URL no está listada y nada más. Es lo próximo.
- **Los cambios de otro dispositivo no llegan solos:** se ven al recargar.
- **Los assets (Bootstrap, Chart.js, XLSX) vienen de un CDN.** La app no
  funciona offline ni si jsdelivr no responde.
- **Sin migración de datos.** Se arrancó con base limpia; lo que hubiera en el
  `localStorage` de un browser se ignora.
