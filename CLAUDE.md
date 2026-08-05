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

## 4. Concurrencia: nunca pisar datos en silencio

Cada documento tiene una versión. Si el server devuelve `409`, la app queda en
solo-lectura y le pide al usuario que recargue. Ese comportamiento es
intencional y no se cambia por uno que "resuelva solo" sin discutirlo antes.

## 5. Protocolo de dos usuarios (Alejo / Mariano)

La app la usan dos personas, a veces al mismo tiempo, desde dispositivos
distintos. No hay login todavía: **no hay forma de saber quién escribió qué**.

- Los cambios de la otra persona **no aparecen solos**: hay que recargar.
- Antes de una sesión de carga larga, recargar para arrancar de la versión más
  nueva.
- Si aparece el cartel *"Otro dispositivo modificó estos datos"*, la otra persona
  guardó primero. Lo que se estaba cargando en esa pestaña **se perdió**:
  recargar y volver a cargarlo. No hay merge.
- La convención operativa es **no trabajar los dos sobre la misma obra al mismo
  tiempo**. Obras distintas no chocan (está probado: ver CA-5).
- Cuando se agregue login, este protocolo se revisa entero.

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

## 8. Antes de dar algo por terminado

- `npm run dev` levanta y `curl localhost:3000/health` devuelve `200`.
- Ningún monto ni fórmula cambió de valor.
- Los criterios de aceptación relevantes en [PROGRESS.md](PROGRESS.md) siguen en
  verde.
- Nada de secretos en el código ni en git. Solo `.env.example` se versiona.
