# PROGRESS

Bitácora del proyecto. Lo más reciente arriba.

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

**Fase de infra: deploy.** Dockerfile multi-stage (`better-sqlite3` es módulo
nativo: necesita toolchain al instalar, no en runtime; usar `node:24-slim`, no
Alpine), volumen persistente en `/data` con `SGO_DB_PATH=/data/sgo.sqlite`,
healthcheck contra `/health`, y conectar el repo en Dokploy.

Nota para esa fase: `npm install` avisa que el script de build de
`better-sqlite3` queda bloqueado por la política de scripts de npm. En local
funciona igual, pero en el build de Docker hay que confirmar que el binario
nativo se compila o se baja bien.

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
