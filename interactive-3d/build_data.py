"""Build interactive-3d/data.js from db/linewise.duckdb.

Reads the historical run/changeover/lost-time tables and writes a single JS
file that the 3D HTML loads as `window.__LINEWISE_DATA__`. No server needed:
open the HTML locally and it picks up the snapshot automatically.

Run from the repo root:
    source .venv/bin/activate
    python interactive-3d/build_data.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
DUCKDB_PATH = ROOT / "db" / "linewise.duckdb"
OUT_PATH = ROOT / "interactive-3d" / "data.js"

LINES = (14, 17, 19)
LINE_KEY = {14: "L14", 17: "L17", 19: "L19"}

CATEGORY_TO_STATION = {
    "cip": "cip",
    "esterilizacion": "pas",
    "baja_velocidad": "fill",
    "saturacion_salida": "pal",
    "falta_producto": "rin",
    "paro_maquina": "fill",
    "pnp": "fill",
}

CAMBIO_TIPO_TO_STATION = {
    "Contenido": "fill",
    "Volumen Envase": "ctn",
    "Pack. Primario": "pak",
    "Pack, Primario": "pak",
    "Pack. Secundario": "pak",
    "Palet": "pal",
    "Marca": "cod",
    "Referencia": "cod",
}

FORMAT_LABEL = {"1/2": "50cl", "1/3": "33cl", "2/5": "44cl"}


def df_to_records(df):
    return json.loads(df.to_json(orient="records", date_format="iso"))


def build(con):
    snapshot = {
        "meta": {},
        "lines": {},
        "timeline": [],
        "inefficiencies": {},
        "whatIf": {
            "skus": [],
            "historicalOee": {},
            "changeoverCost": {},
            "currentLastSku": {},
        },
        "bottleneckMap": CATEGORY_TO_STATION,
        "cambioTipoMap": CAMBIO_TIPO_TO_STATION,
    }

    date_range = con.execute(
        """
        SELECT MIN(fecha_fin)::DATE AS start, MAX(fecha_fin)::DATE AS end_,
               COUNT(DISTINCT fecha_fin::DATE) AS days
        FROM fact_runs WHERE linea IN (14,17,19)
        """
    ).fetchone()
    snapshot["meta"] = {
        "generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "dataRange": {
            "start": date_range[0].isoformat(),
            "end": date_range[1].isoformat(),
            "days": date_range[2],
        },
    }

    line_rows = con.execute(
        """
        SELECT linea,
               AVG(oee) AS line_oee,
               SUM(hl) AS total_hl,
               COUNT(DISTINCT sku) AS n_skus,
               SUM(CASE WHEN hubo_cambio THEN 1 ELSE 0 END) AS n_changes,
               COUNT(*) AS n_runs
        FROM fact_runs WHERE linea IN (14,17,19)
        GROUP BY linea ORDER BY linea
        """
    ).fetchall()

    fmt_rows = con.execute(
        """
        SELECT linea, estado_volumen, SUM(hl) AS hl
        FROM fact_runs WHERE linea IN (14,17,19) AND estado_volumen IS NOT NULL
        GROUP BY 1,2 ORDER BY 1, hl DESC
        """
    ).fetchall()
    formats_by_line: dict[int, list[str]] = {}
    for linea, ev, hl in fmt_rows:
        if hl is None or hl <= 0:
            continue
        label = FORMAT_LABEL.get(ev, ev)
        formats_by_line.setdefault(linea, []).append(label)

    top_skus_rows = con.execute(
        """
        SELECT linea, sku, SUM(hl) AS hl, AVG(oee) AS oee, COUNT(*) AS n
        FROM fact_runs WHERE linea IN (14,17,19)
        GROUP BY 1,2
        QUALIFY ROW_NUMBER() OVER (PARTITION BY linea ORDER BY SUM(hl) DESC) <= 5
        ORDER BY linea, SUM(hl) DESC
        """
    ).fetchall()
    top_skus_by_line: dict[int, list[dict]] = {}
    for linea, sku, hl, oee, n in top_skus_rows:
        top_skus_by_line.setdefault(linea, []).append(
            {"sku": sku, "hl": round(hl or 0, 1), "oee": round(oee or 0, 3), "n": n}
        )

    for linea, line_oee, total_hl, n_skus, n_changes, n_runs in line_rows:
        key = LINE_KEY[linea]
        snapshot["lines"][key] = {
            "lineOee": round(line_oee or 0, 3),
            "formats": formats_by_line.get(linea, []),
            "topSkus": top_skus_by_line.get(linea, []),
            "totalHl": round(total_hl or 0, 1),
            "nChanges": int(n_changes or 0),
            "nRuns": int(n_runs or 0),
            "nSkus": int(n_skus or 0),
        }

    daily = con.execute(
        """
        SELECT linea,
               fecha_fin::DATE AS d,
               AVG(oee) AS oee,
               SUM(hl) AS hl,
               SUM(CASE WHEN hubo_cambio THEN 1 ELSE 0 END) AS n_changes,
               arg_max(sku, hl) AS top_sku
        FROM fact_runs WHERE linea IN (14,17,19)
        GROUP BY linea, d ORDER BY d, linea
        """
    ).fetchall()

    bottleneck_daily = con.execute(
        """
        SELECT linea, fecha_fin::DATE AS d, categoria, SUM(minutos) AS m
        FROM fact_lost_time
        WHERE linea IN (14,17,19) AND categoria NOT IN ('marcha','idle')
        GROUP BY 1,2,3
        QUALIFY ROW_NUMBER() OVER (PARTITION BY linea,d ORDER BY m DESC) = 1
        """
    ).fetchall()
    bn_map: dict[tuple, tuple] = {}
    for linea, d, cat, m in bottleneck_daily:
        bn_map[(linea, d.isoformat())] = (cat, round(m or 0, 1))

    timeline_by_date: dict[str, dict] = {}
    for linea, d, oee, hl, n_changes, top_sku in daily:
        date_iso = d.isoformat()
        row = timeline_by_date.setdefault(date_iso, {"date": date_iso})
        cat, minutes = bn_map.get((linea, date_iso), (None, None))
        station = CATEGORY_TO_STATION.get(cat) if cat else None
        row[LINE_KEY[linea]] = {
            "oee": round(oee or 0, 3),
            "hl": round(hl or 0, 1),
            "topSku": top_sku,
            "nChanges": int(n_changes or 0),
            "bottleneck": station,
            "bottleneckCat": cat,
            "bottleneckMinutes": minutes,
        }
    snapshot["timeline"] = [timeline_by_date[d] for d in sorted(timeline_by_date)]

    ineff_rows = con.execute(
        """
        SELECT c.linea,
               c.fecha_fin::DATE AS d,
               c.prev_sku,
               c.sku AS new_sku,
               r.horas_cambio * 60.0 AS real_min,
               c.teorico_cambio_volumen_min AS teorico_min,
               r.cambio_tipo_principal AS cambio_tipo,
               r.oee AS oee
        FROM fact_changeovers c
        JOIN fact_runs r USING (of, linea, fecha_fin)
        WHERE c.linea IN (14,17,19) AND c.hubo_cambio AND r.horas_cambio IS NOT NULL
        QUALIFY ROW_NUMBER() OVER (PARTITION BY c.linea ORDER BY r.horas_cambio DESC) <= 3
        ORDER BY c.linea, r.horas_cambio DESC
        """
    ).fetchall()
    for linea, d, prev_sku, new_sku, real_min, teorico_min, cambio_tipo, oee in ineff_rows:
        station = CAMBIO_TIPO_TO_STATION.get((cambio_tipo or "").strip(), "fill")
        delta = None
        if real_min is not None and teorico_min is not None and teorico_min > 0:
            delta = round(real_min - teorico_min, 1)
        snapshot["inefficiencies"].setdefault(LINE_KEY[linea], []).append(
            {
                "date": d.isoformat(),
                "prevSku": prev_sku,
                "newSku": new_sku,
                "realMin": round(real_min or 0, 1),
                "teoricoMin": int(teorico_min) if teorico_min else None,
                "deltaMin": delta,
                "cambioTipo": cambio_tipo,
                "station": station,
                "oee": round(oee or 0, 3),
            }
        )

    hist_rows = con.execute(
        """
        SELECT linea, sku, AVG(oee) AS avg_oee, SUM(hl) AS hl, COUNT(*) AS n,
               any_value(estado_volumen) AS ev
        FROM fact_runs WHERE linea IN (14,17,19)
        GROUP BY linea, sku
        """
    ).fetchall()
    sku_summary: dict[str, dict] = {}
    for linea, sku, avg_oee, hl, n, ev in hist_rows:
        if not sku:
            continue
        key = f"{LINE_KEY[linea]}|{sku}"
        snapshot["whatIf"]["historicalOee"][key] = {
            "avgOee": round(avg_oee or 0, 3),
            "hl": round(hl or 0, 1),
            "n": n,
            "format": FORMAT_LABEL.get(ev, ev),
        }
        s = sku_summary.setdefault(sku, {"sku": sku, "format": FORMAT_LABEL.get(ev, ev), "totalHl": 0.0, "linesProduced": []})
        s["totalHl"] += hl or 0
        if LINE_KEY[linea] not in s["linesProduced"]:
            s["linesProduced"].append(LINE_KEY[linea])
    skus_sorted = sorted(sku_summary.values(), key=lambda r: r["totalHl"], reverse=True)
    for s in skus_sorted:
        s["totalHl"] = round(s["totalHl"], 1)
    snapshot["whatIf"]["skus"] = skus_sorted[:40]

    cost_rows = con.execute(
        """
        SELECT c.linea, c.prev_sku, c.sku AS new_sku,
               AVG(r.horas_cambio) * 60.0 AS avg_lost_min,
               COUNT(*) AS n
        FROM fact_changeovers c
        JOIN fact_runs r USING (of, linea, fecha_fin)
        WHERE c.linea IN (14,17,19) AND c.hubo_cambio
        GROUP BY 1,2,3
        HAVING COUNT(*) >= 1
        """
    ).fetchall()
    for linea, prev_sku, new_sku, avg_lost, n in cost_rows:
        if not prev_sku or not new_sku:
            continue
        key = f"{LINE_KEY[linea]}|{prev_sku}|{new_sku}"
        snapshot["whatIf"]["changeoverCost"][key] = {
            "avgLostMin": round(avg_lost or 0, 1),
            "n": n,
        }

    last_rows = con.execute(
        """
        SELECT linea, arg_max(sku, fecha_fin) AS last_sku
        FROM fact_runs WHERE linea IN (14,17,19)
        GROUP BY linea
        """
    ).fetchall()
    for linea, sku in last_rows:
        snapshot["whatIf"]["currentLastSku"][LINE_KEY[linea]] = sku

    return snapshot


def main():
    if not DUCKDB_PATH.exists():
        sys.exit(f"missing {DUCKDB_PATH} — run ./start.sh --setup-only first")

    con = duckdb.connect(str(DUCKDB_PATH), read_only=True)
    snapshot = build(con)
    con.close()

    body = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    OUT_PATH.write_text(
        "/* generated by interactive-3d/build_data.py — do not edit by hand */\n"
        f"window.__LINEWISE_DATA__ = {body};\n",
        encoding="utf-8",
    )

    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size:,} bytes)")
    print(f"  lines:          {list(snapshot['lines'])}")
    print(f"  timeline days:  {len(snapshot['timeline'])}")
    print(f"  inefficiencies: { {k: len(v) for k,v in snapshot['inefficiencies'].items()} }")
    print(f"  whatIf SKUs:    {len(snapshot['whatIf']['skus'])}")
    print(f"  changeoverCost: {len(snapshot['whatIf']['changeoverCost'])}")


if __name__ == "__main__":
    main()
