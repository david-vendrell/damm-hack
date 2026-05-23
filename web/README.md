# LineWise

Ayuda a la decisión para la planificación de las líneas 14, 17 y 19 de El Prat.

Secciones:

- **Observabilidad** *(landing)* — dashboard sobre el histórico **real** de producción 2025 (KPIs, OEE temporal, desglose de pérdidas, top marcas). Alimentado por la ingesta TS de los Excel reales.
- **Análisis Post Mortem** — evidencia del histórico (pérdida evitable, peores cambios, explorador SKU+línea).
- **Validar planificación** — sube `Diario_Hl_Planif.xlsx`, obtén veredictos por OF (Procede / Revisar / Evitar) y recomendaciones concretas (reordenar, mover de línea, reprogramar) con comparador antes/después.
- **Urgencias** — replanificación reactiva (avería, pedido urgente, calidad).

## Stack

Next.js 14 (App Router, TS) · Tailwind · Prisma + SQLite · TanStack Query · Recharts · SheetJS.

## Arrancar

```bash
npm install
npx prisma migrate dev          # crea dev.db
npm run ingest                  # lee Repte operacions/*.xlsx → OfHecho (datos reales)
npx prisma db seed              # opcional: datos del histórico para las otras pestañas
npm run dev                     # http://localhost:3000
```

Para volver a sembrar/ingerir desde cero: `npm run db:reset && npm run ingest`.

## Ingesta de datos reales

`npm run ingest` ejecuta `src/server/ingest.ts`:

- Lee 5 Excel de `Repte operacions/`: `OEE …`, `Volumen …`, `Tiempo …`, `Cambios …`, `Mantenimiento …`.
- Une por OF (en el fichero Tiempo la clave es `WOID`; solo se conservan filas con `MAQUINA=LLENAD`).
- **Limpieza**:
  - Excluye `SKU == 'LIMPIEZA'` (no es producción).
  - Descarta filas con `OEE ≤ 0` o `OEE > 1` (incluye nulos e imposibles físicamente).
  - Marca como sin-cambio los registros con un `Nº de Cambios` atípico (>50).
  - Redondea floats con ruido a 4 decimales.
  - Normaliza `TREN` a `{14, 17, 19}` y parsea fechas Excel.
- **Derivaciones**:
  - `formato` = primera coincidencia `\d+/\d+` en `Tipo Envase` (ej. `LATA 1/3 SR.` → `1/3`).
  - `canal` = parte detrás de `Canal distrib.` (`MARCA` o `MDD`).
  - `mes` y `semanaIso` desde `Fecha Fin`.
- Idempotente: borra y repuebla `OfHecho` en cada ejecución.

Para añadir otro año: deja los `OEE/Volumen/Tiempo/Cambios/Mantenimiento <AÑO>.xlsx` en `Repte operacions/` y vuelve a ingerir (`DATA_DIR` env permite apuntar a otra carpeta).

Si una columna obligatoria falta o un Excel está vacío la ingesta falla con un mensaje claro — no se inventan datos.

Test del parser contra el Excel real:

```bash
npm run test:parser
```

## Estructura

```
prisma/
  schema.prisma     modelos: Sku, SkuLineaBaseline, ChangeoverTime,
                    CambioIneficiente, OeeObservacion, Mantenimiento, Plan, PlanItem
  seed.ts           datos del histórico + caso L19 octubre 2025
src/
  types.ts          contrato API compartido cliente/servidor
  server/
    db.ts           cliente Prisma
    parser.ts       parser del Diario_Hl_Planif.xlsx (formato pivote)
    analysis.ts     ★ aquí vive TODA la inteligencia (placeholder + DB)
  app/
    post-mortem/    pantalla de análisis histórico
    validar/        pantalla de validación de plan
    api/            rutas REST tipadas
  components/       UI compartida (Card, KPI, VeredictoBadge, ...)
sample/
  Diario_Hl_Planif.xlsx   Excel de ejemplo
tests/
  parser.test.ts    test del parser contra sample/
```

## Dónde enchufar el modelo

Todo el conocimiento está aislado en `src/server/analysis.ts`. Cada función
PLACEHOLDER está marcada con `// TODO: reemplazar por el modelo`:

| Función                | Hoy (heurística)                                              | Mañana (modelo)                                          |
| ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| `predecirOEE`          | `baseline.oeeAlcanzable - penalizaciones`                     | inferencia: features = SKU, línea, cambio, contexto      |
| `veredictoDe`          | umbrales fijos sobre tipo de cambio y OEE                     | regla derivada de la incertidumbre del modelo            |
| `clasificarTipoCambio` | diff de formato / marca con fallback de regex sobre el código | igual (es solo categorización)                           |
| `recomendarPlan`       | reglas de formato/manto                                       | optimización: buscar permutaciones que maximicen OEE plan |

El modelo solo necesita cumplir los tipos de `src/types.ts`. La UI no cambia.

## Contrato API

| Ruta                                          | Tipo respuesta      |
| --------------------------------------------- | ------------------- |
| `GET  /api/observabilidad?anio=&linea=&marca=&formato=&canal=` | `ObservabilidadData` |
| `GET  /api/observabilidad/dimensiones`        | `ObservabilidadDimensiones` |
| `GET  /api/postmortem/resumen`                | `PostMortemResumen` |
| `GET  /api/postmortem/cambios?linea=`         | `CambioIneficienteDTO[]` |
| `GET  /api/postmortem/distribucion?sku=&linea=` | `DistribucionSku` |
| `GET  /api/postmortem/skus`                   | `SkuLineaInfo[]`    |
| `POST /api/planes` (multipart .xlsx)          | `AnalisisPlan`      |
| `GET  /api/planes/:id/recomendaciones`        | `PlanRecomendado`   |

## Formato del Excel

`Diario_Hl_Planif.xlsx`, hoja `Diario Hl`. Estructura pivote:

- **Cabecera**: bloques de 12 columnas por día, encabezados por `Programa Prod.\n<dd/mm/aaaa>`. Un bloque final `…\nTOTAL` que ignoramos.
- **Columna A**: jerarquía por indentación — `Centro` / `Tren 14` / código SKU / `Total Tren 14`. La fila de SKU lleva el código a secas; mantenemos la línea actual.
- Por cada fila de SKU leemos el `Programa Prod.` (Hl) de cada bloque-día. Solo registros con `Hl > 0`.
- Hl redondeado a entero (los floats vienen con ruido). Formato de SKU derivado de la tabla `Sku` o, en su defecto, regex sobre el código (`xx13...` → 1/3, `xx12...` → 1/2).

## Diseño Damm

Tokens en `tailwind.config.ts`:

- Fondo crema `#F5F1EA`, superficie blanca, hairlines `#E6E0D6`
- Acento Damm rojo `#A4161A` (hover `#7E1116`)
- Veredictos: procede verde `#2E7D32`, revisar ámbar `#B7791F`, evitar rojo Damm
- Tipografía Inter / system-ui; números con `font-variant-numeric: tabular-nums`
- Radios suaves 10px, bordes 1px, sin sombras, sin gradientes
