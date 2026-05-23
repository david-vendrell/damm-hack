# ROL
Actúa como un experto en analítica industrial / OEE y en el query builder
del módulo de Observabilidad de este repositorio (`web/src/app/observabilidad/`).
Tu tarea es explicar de forma técnica, precisa y estructurada cómo funciona
el creador de charts, qué primitivas expone y cómo se traducen al backend
de consulta.

# OBJETIVO
Describir el funcionamiento interno y el flujo de construcción de un chart
en `/observabilidad`, desde la definición de la consulta hasta su
visualización y guardado, de modo que un lector con perfil técnico (PM
industrial, ingeniero de procesos, analista o data engineer) entienda cada
componente, cómo se combinan y qué efecto tiene cada uno sobre el resultado.

Las afirmaciones deben estar respaldadas por el código real:
- UI: `web/src/app/observabilidad/chart-builder.tsx`, `chart-preview.tsx`,
  `view.tsx`, `saved-charts-grid.tsx`.
- Tipos: `web/src/types.ts` (`ChartConfig`, `QueryResult`, `Filter`,
  `DateRange`, `Granularity`, `VizType`, `MeasureKey`, `DimensionKey`,
  `Aggregation`).
- Backend de consulta: `web/src/server/query.ts` (`MEASURES`, `DIMENSIONS`,
  `runQuery`, `buildWhere`, `aggExpr`, `resolveRange`).
- Endpoints: `web/src/app/api/observabilidad/{query,metricas,dimension-values,charts}/…`.
- Persistencia: modelo `SavedChart` en `web/prisma/schema.prisma`.

Si un nombre no aparece en el código, descríbelo funcionalmente; no lo
inventes.

# CONTEXTO CONCEPTUAL QUE DEBES CUBRIR

1. UNIDAD DE ANÁLISIS
   - Un **chart** es la unidad básica. Se define con un objeto
     `ChartConfig` (`web/src/types.ts`) y se renderiza en el panel
     "Constructor de gráficos" dentro de `/observabilidad`.
   - Cada chart tiene: una **medida** + una **agregación** + opcionalmente
     una **dimensión (eje X)**, un **desglose (breakdown)**, **filtros**,
     **rango de fechas + granularidad**, **Top N** y un **tipo de
     visualización**.
   - Los charts pueden guardarse como `SavedChart` (nombre + JSON de
     config) y reaparecen en la rejilla bajo el constructor. No existe el
     concepto de "board"/"dashboard" — todos los charts guardados se
     listan en orden descendente por `creadoEn`.

2. TIPOS DE CHART / VISUALIZACIÓN
   El campo `viz: VizType` admite:
   - `auto` — el sistema escoge según la forma del dato
     (lógica en `chart-preview.tsx`).
   - `line` — línea temporal (single o multi-serie cuando hay breakdown).
   - `bar` — barras simples para dimensiones categóricas.
   - `stackedBar` — barras apiladas (típico con breakdown).
   - `donut` — composición sobre una sola dimensión categórica.
   - `bigNumber` — KPI único (cuando no hay dimensión).
   - `table` — vista tabular.
   No existen Funnels / Flows / Retention al estilo Mixpanel: el builder
   es un análogo de Insights pensado para series temporales y composición
   en dominio industrial.

3. BLOQUES DE CONSTRUCCIÓN DE LA CONSULTA (query builder)

   a) MEDIDA + AGREGACIÓN (`measure`, `aggregation`)
      - 25 medidas definidas en `web/src/server/query.ts` (`MEASURES`),
        agrupadas por `kind`: `pct` (OEE, Disponibilidad, Rendimiento,
        Ineficiencia, % cambios, Utilización), `hl` (Hl producidos),
        `units` (unidades), `hours` (horas marcha, paro, PNP, limpieza,
        CIP, esterilización, cambio, IDLE, baja velocidad, saturación,
        falta producto, mantenimiento intervención/espera) y `count`
        (Nº OFs, llamadas mantenimiento, dimensiones cambiadas, frecuencia
        de cambio).
      - Cada medida declara `allowedAggs`. La UI restringe el selector de
        agregación a esa lista.
      - Para medidas de tipo `pct` (OEE y derivadas), la "media" es
        **ponderada por Hl**:
        `SUM(col * r.hl) / NULLIF(SUM(r.hl), 0)`.
        Explica esto porque NO es una media aritmética.
      - El resto usa SUM/AVG/MEDIAN/MIN/MAX/QUANTILE_CONT(0.9)/COUNT
        directos.

   b) DIMENSIÓN (eje X, `dimension`)
      - 16 dimensiones (`DIMENSIONS` en `query.ts`):
        temporales (`dia`, `semana`, `mesIso`, `mes`, `semanaIso`,
        `fechaFin`) y categóricas (`linea`, `formato`, `marca`, `familia`,
        `tipoEnvase`, `canal`, `sku`, `cambioPrincipal`, `turno`,
        `causaParo`).
      - La UI separa "Tiempo" (optgroup) de "Categórica".
      - Si `dimension` es temporal, aparece el selector de **granularidad**
        (`day` / `week` / `month`) que mapea a la dimensión subyacente
        (`dia` / `semana` / `mesIso`).
      - `causaParo` es especial: el backend hace UNION ALL para expandir
        cada OF en hasta 7 filas (una por tipo de paro). Explícalo.

   c) DESGLOSE / BREAKDOWN (`breakdown`)
      - Segunda dimensión opcional, distinta del eje X.
      - Backend limita a los **top 12 valores** por valor agregado
        (constante en `runQuery`).
      - En la visualización produce líneas adicionales, barras apiladas o
        leyenda según `viz`.

   d) FILTROS (`filters: Filter[]`)
      - `Filter = { dim: DimensionKey, values: string[] }`.
      - Lógica: AND entre filtros distintos, OR dentro de los valores de
        un mismo filtro.
      - Solo dimensiones **categóricas** son filtrables (lista
        `SUPPORTED` en `api/observabilidad/dimension-values/route.ts`).
      - Los valores disponibles se cargan dinámicamente desde
        `GET /api/observabilidad/dimension-values?key=…`.
      - La UI impide tener dos filtros sobre la misma dimensión.

   e) RANGO TEMPORAL Y RENDIMIENTO
      - `dateRange` admite preset (`7d|30d|90d|ytd|y2025|y2024|all`) o
        `from`/`to` explícitos (`YYYY-MM-DD`). `resolveRange()` los
        normaliza.
      - Granularidad (`day`/`week`/`month`) se aplica al bucketizar el
        eje temporal.
      - **No** hay "query-time sampling" tipo Mixpanel; toda la consulta
        va contra `fact_runs` (∼2.184 OFs) en DuckDB/Postgres.
      - Siempre se aplica `NOT r.outlier AND (r.oee IS NULL OR r.oee<=1)`.
        El conteo de filas excluidas vuelve en `dataQuality` y se muestra
        como banner bajo el preview.

   f) TOP N (`topN`)
      - 5 / 10 / 20 / 50. Solo aplica a dimensiones categóricas
        (en temporales sería absurdo).
      - Ranking por valor agregado descendente.

   g) FÓRMULAS
      - **No existen fórmulas configurables por el usuario.** Las
        fórmulas relevantes están precomputadas en backend:
        `OEE = Disponibilidad × Rendimiento × Ineficiencia`,
        `Utilización = horas_marcha / horas_totales`,
        `horas_cambio = PAR_TOT − (PNP + LIMPIEZA + IDLE)`.
      - Para "ratios" entre dos medidas el camino es elegir la medida ya
        compuesta (p.ej. `pctCambios`, `utilizacion`) o crear una nueva
        medida en `MEASURES`.

   h) "GROUP ANALYTICS" (equivalente)
      - No hay un modo separado: el cambio de unidad de análisis se hace
        eligiendo `linea` / `marca` / `sku` / `turno` como `dimension` o
        `breakdown`. La granularidad subyacente sigue siendo la OF
        (`fact_runs`).

   i) "PROFILE METRICS" (equivalente)
      - Sin equivalente. No hay perfiles de usuario. La unidad última es
        la OF (orden de fabricación).

4. CONFIGURACIÓN TEMPORAL Y CALIDAD DEL DATO
   - Selector de presets + custom from/to + granularidad.
   - `dataQuality` en el `QueryResult`: `{ rowsConsidered,
     excludedOutliers, excludedOeeGt1 }`. Aparece como nota bajo el chart.

5. PIPELINE DE CONSULTA
   - El builder construye `ChartConfig` en estado React.
   - Hace `POST /api/observabilidad/query` con `Partial<ChartConfig> &
     { withPrevious? }`.
   - Si `withPrevious=true`, el backend calcula también `previousTotal`
     desplazando el rango (`shiftRange()`).
   - `runQuery()` valida medida/agregación/dimensión/filtros, construye
     SQL con `buildWhere()`+`aggExpr()`, ejecuta contra DuckDB y devuelve
     `QueryResult { measure, dimension?, breakdown?, aggregation, rows[],
     breakdownKeys[], dataQuality, total?, previousTotal? }`.
   - El preview (`chart-preview.tsx`) elige el tipo de chart con
     `resolveViz()` si `viz === 'auto'`.

6. PERSISTENCIA Y COMPARTICIÓN
   - `SavedChart` (Prisma): `{ id, nombre, config (JSON string),
     creadoEn, actualEn }`.
   - Endpoints: `GET/POST /api/observabilidad/charts`,
     `PUT/DELETE /api/observabilidad/charts/[id]`.
   - La rejilla `saved-charts-grid.tsx` lista todos los charts y permite
     Editar / Eliminar mediante un menú `⋯`.
   - **No hay** boards, ni permisos, ni compartición externa. Es
     personal-por-instancia.

# FORMATO DE SALIDA
- Estructura con secciones y subsecciones claras.
- Para cada componente del query builder:
  (1) qué es,
  (2) cómo se configura en la interfaz (con el label exacto en español
      tal como aparece en `chart-builder.tsx`: "Métrica", "Dimensión
      (eje X)", "Desglose (opcional)", "Rango de fechas", "Filtros",
      "Top N", "Visualización", "Nombre del gráfico"),
  (3) cómo afecta al SQL/cálculo del resultado (cita el helper o función
      relevante de `query.ts` cuando aplique),
  (4) un ejemplo práctico breve en dominio Damm (líneas 14/17/19, OEE,
      causas de paro, marcas Damm/Voll Damm/Skol, formatos 1/3 1/2 2/5,
      turnos M/T/N).
- Incluye al final un ejemplo end-to-end: construir un chart que muestre
  "**OEE mensual de 2025 por línea, filtrado a marca Damm y formato 1/3,
  visualización línea**". Explica el `ChartConfig` resultante campo a
  campo, el body que viaja al POST `/api/observabilidad/query`, el SQL
  conceptual que produce `runQuery`, y la decisión final de `viz`.
- Añade un segundo ejemplo de **composición**: "horas por causa de paro
  en la línea 17 durante 2025-Q1, desglosadas por turno, top 5, barras
  apiladas", que aproveche el caso especial de `causaParo`.
- Tono técnico, sin marketing. Define cada término la primera vez que
  aparece (OEE, OF, PNP, CIP, MDD, etc.).

# RESTRICCIONES
- No inventes nombres de funciones, componentes, endpoints, claves de
  medida/dimensión, ni campos de tipos. Si dudas, abre el archivo y cita
  la línea.
- Distingue claramente entre conceptos de **consulta** (qué se calcula:
  `ChartConfig`, SQL, agregaciones) y conceptos de **visualización**
  (cómo se muestra: `VizType`, resolución `auto`).
- No describas funcionalidades que no existen (no hay Funnels, ni Flows,
  ni Retention, ni boards, ni sampling, ni fórmulas configurables por
  usuario, ni group analytics como modo aparte, ni profile metrics).
  Si el lector espera algo así, indica explícitamente "no existe; el
  equivalente más cercano es …".
- Cuando expliques medidas porcentuales (OEE/Disp/Rend/Inef), recuerda
  que la "media" es ponderada por Hl, no aritmética.
- Las etiquetas de la UI están en castellano; respeta los strings
  exactos del componente.
