# EXECUTE — Cómo arrancar LineWise

> Si solo tienes 30 segundos: `./start.sh` desde la raíz del repo. Listo.

---

## TL;DR

```bash
# 1. Clona el repo y entra en él
cd damm-hack

# 2. Asegúrate de tener los 5 Excels en `Repte operacions/`
ls "Repte operacions/"
# → OEE 14_17_19_ 2025.xlsx
# → Volumen 14_17_19_ 2025.xlsx
# → Tiempo 14_17_19_ 2025.xlsx
# → Cambios 14_17_19_ 2025.xlsx
# → Mantenimiento 14_17_19_ 2025.xlsx

# 3. Arranca todo
./start.sh

# Abre http://localhost:3000 → te redirige a /observabilidad
```

`start.sh` es **idempotente**: ejecútalo cuantas veces quieras. Detecta lo ya hecho y lo salta.

---

## Requisitos

| | Versión mínima | Comprobar |
|---|---|---|
| Node.js | 18+ | `node -v` |
| npm | viene con Node | `npm -v` |
| Sistema operativo | macOS / Linux / WSL | — |

> Para Windows nativo, ejecuta los comandos de `start.sh` a mano (ver "Modo manual" abajo). El `.sh` necesita bash.

---

## Qué hace `./start.sh`

Cinco pasos, todos idempotentes:

1. **Verifica prerequisites** — node, npm y los 5 Excels esperados en `Repte operacions/`. Si falta algo, aborta con mensaje claro.
2. **Instala dependencias JS** (`npm install` en `web/`) — solo la primera vez, o si has borrado `node_modules`.
3. **Aplica migraciones Prisma** (`prisma migrate deploy`) — crea/actualiza `web/prisma/dev.db` (SQLite).
4. **Ingesta los Excels reales** (`npm run ingest`) — lee los 5 ficheros, limpia/une los datos y puebla la tabla `OfHecho`. Borra y repuebla en cada ejecución.
5. **Arranca el servidor de desarrollo** (`npm run dev`) — Next.js en `http://localhost:3000`.

### Variantes

```bash
./start.sh                # todo + arranca dev server
./start.sh --setup-only   # todo menos el `npm run dev` (útil en CI o si vas a arrancar tú mismo)
./start.sh --help         # ayuda
```

---

## Estructura del repo

```
damm-hack/
├── Repte operacions/      ← los 5 .xlsx reales (única fuente de verdad)
├── web/                   ← app Next.js + ingest + API + UI
│   ├── prisma/            ← schema + migraciones + dev.db (SQLite)
│   └── src/
│       ├── server/
│       │   ├── ingest.ts          ← ETL TypeScript (SheetJS → OfHecho)
│       │   └── observabilidad.ts  ← agregaciones para la API
│       └── app/
│           ├── observabilidad/    ← landing: dashboard de observabilidad
│           ├── post-mortem/       ← análisis histórico (datos seed)
│           ├── validar/           ← validador de planes (datos seed)
│           ├── urgencias/         ← reactivo (datos seed)
│           └── api/observabilidad/  ← endpoints REST
├── start.sh               ← este script
└── EXECUTE.md             ← este documento
```

---

## Qué verás en la web

Al abrir `http://localhost:3000` te redirige a `/observabilidad`:

- **Filtros** — año, línea, marca, formato, canal. Cada cambio recalcula todo vía API.
- **5 KPIs** — OEE, Disponibilidad, Rendimiento, Volumen HL, % OFs con cambio. Cuando haya datos del año anterior, muestra delta.
- **OEE en el tiempo** — toggle semanal/mensual y "Comparar líneas" para overlay de L14/L17/L19.
- **OEE por línea** — barras.
- **¿Dónde se va el tiempo?** — desglose horizontal de pérdidas (PNP, Baja velocidad, Saturación salida, Limpieza, IDLE, Falta producto, Esterilización, CIP) sin doble conteo del cubo "Paro máquina".
- **OEE por formato** — 1/3, 1/2, 2/5.
- **Top marcas** — barras por nº OFs, OEE en tooltip.

Los datos vienen 100% del histórico real de Damm 2025 (líneas 14/17/19 de El Prat). Cero literales hardcodeados.

Las otras tres pestañas (Post mortem, Validar, Urgencias) siguen usando datos sembrados del schema antiguo — migrarlas a datos reales es trabajo futuro.

---

## Comandos útiles (desde `web/`)

```bash
npm run dev          # arranca dev server (lo hace start.sh por ti)
npm run build        # build de producción
npm run start        # ejecuta el build de producción
npm run lint         # ESLint
npm run ingest       # re-ingesta los Excels (después de tocar datos)
npm run db:reset     # ⚠️ destruye dev.db y vuelve a migrar
npm run test:parser  # tests del parser de planes Excel
npx prisma studio    # abre Prisma Studio en :5555 para inspeccionar dev.db
```

---

## Workflow típico

### Primera vez en tu máquina

```bash
git clone <repo>
cd damm-hack
./start.sh
# → instala todo, ingiere, arranca. Abre el navegador.
```

### Día a día

```bash
cd damm-hack/web
npm run dev
```

### Después de actualizar el código

```bash
git pull
./start.sh
# Reinstala deps solo si node_modules está raro;
# aplica migraciones pendientes; re-ingiere; arranca.
```

### Cuando cambian los Excels

```bash
# Sustituye los .xlsx en Repte operacions/
cd damm-hack/web
npm run ingest
# El dev server detecta los datos nuevos vía la API.
```

### Para añadir otro año de datos

1. Deja `OEE/Volumen/Tiempo/Cambios/Mantenimiento <AÑO>.xlsx` en `Repte operacions/`.
2. *(Pendiente)*: hoy la ingesta sólo lee los ficheros con el sufijo `2025`. Para soportar varios años, hay que generalizar el patrón de nombres en `web/src/server/ingest.ts` (variable `FILES`).
3. Re-ingiere: `npm run ingest`.

---

## Limpieza que hace la ingesta

Auditable: cada decisión se imprime en consola con su recuento.

| Regla | Motivo |
|---|---|
| Excluir `SKU == 'LIMPIEZA'` | No son producción, sirven para tiempos de cambio |
| Descartar OEE ≤ 0 o > 1 | Valores imposibles o no productivos |
| Marcar como sin-cambio si `Nº Cambios > 50` | Outlier de datos (hay un valor ~7781 claramente erróneo) |
| Redondear floats a 4 decimales | Quita ruido tipo `475.200012` |
| Tiempo: solo filas `MAQUINA == 'LLENAD'` | Llenadora es el punto de control OEE de la línea |
| Normalizar TREN a int en `{14, 17, 19}` | Algunos ficheros lo traen como float/string |
| Fechas Excel serial → Date UTC | Vía `XLSX.SSF.parse_date_code` |
| `formato` derivado de `Tipo Envase` (`1/3`, `1/2`, `2/5`) | Para filtrar/agrupar sin parsear texto en cada consulta |
| `canal` derivado de `Canal distribución` (`MARCA`, `MDD`) | Idem |

Resultado típico con los datos actuales: **2.108 OFs útiles** (de 2.274 originales).

---

## Modo manual (sin `start.sh`)

```bash
cd web
npm install
npx prisma migrate deploy
npm run ingest
npm run dev
```

---

## Troubleshooting

**`Excel not found: …/Repte operacions/…`** — Falta uno de los 5 ficheros. Verifica los nombres exactos (con espacios) en la sección TL;DR.

**`Port 3000 is in use, trying 3001 instead`** — Next.js mismo se mueve a 3001. Aviso de la consola te dice la URL real.

**Errores de Prisma client (`@prisma/client did not initialize yet`)** — Ejecuta `npx prisma generate` desde `web/`. `start.sh` lo hace implícitamente vía `migrate deploy`.

**Quiero empezar de cero la DB** — `cd web && npm run db:reset && cd .. && ./start.sh`.

**La página `/observabilidad` muestra "No hay OFs con los filtros…"** — Estás filtrando por un año/línea/marca sin datos. Limpia los selects.

---

## Stack técnico

- Next.js 14 (App Router) · TypeScript
- Tailwind CSS (tema Damm: crema, blanco, rojo `#A4161A`, hairlines)
- Prisma + SQLite (`web/prisma/dev.db`)
- TanStack Query (cliente)
- Recharts (gráficos)
- SheetJS / `xlsx` (lectura Excel en la ingesta)

---

## Mantenimiento de este documento

Este `EXECUTE.md` y `start.sh` se mantienen **en sincronía con el código**. Si cambias:

- el orden o el contenido de los pasos del setup,
- los Excels que la ingesta espera,
- los comandos `npm run …`,
- el puerto o landing por defecto,

actualiza también **estos dos ficheros** en el mismo PR.
