#!/usr/bin/env bash
# LineWise — one-shot setup + launch.
# Idempotent: re-run any time.
#
# What it does, in order:
#   1. Verify Node + npm + Python
#   2. Seed web/.env from web/.env.example if missing (warns if keys still blank)
#   3. Install npm deps (only if node_modules missing)
#   4. Build a .venv and install requirements.txt (only if missing)
#   5. Sync the 3D viewer assets into web/public/interactive-3d/
#   6. Apply Prisma migrations → web/prisma/dev.db  (SavedChart + planning models)
#   7. Build the DuckDB analytics DB (db/linewise.duckdb · fact_runs) if missing
#   8. Launch Prisma Studio (5555) + LineWise model sidecar (8001) + Next (3000)
#
# All dashboard metrics (KPIs, chart-builder, saved charts) read from DuckDB
# `fact_runs`. The SQLite DB only stores editable objects: SavedChart configs,
# SKU master, plans, etc. — visible in Prisma Studio.
# The model sidecar (scripts/local_model_server.py) powers /validar and
# /urgencias; without it those pages silently fall back to a heuristic.

set -euo pipefail

# ── colors ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RESET=""
fi

step()  { printf "\n${C_BOLD}${C_BLUE}▸ %s${C_RESET}\n" "$1"; }
ok()    { printf "${C_GREEN}✓${C_RESET} %s\n" "$1"; }
warn()  { printf "${C_YELLOW}⚠ %s${C_RESET}\n" "$1"; }
fail()  { printf "${C_RED}✗ %s${C_RESET}\n" "$1" >&2; exit 1; }

# ── locate repo root ─────────────────────────────────────────────────────────
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$ROOT/web"
DATA="$ROOT/Repte operacions"
DUCKDB="$ROOT/db/linewise.duckdb"

cd "$ROOT"

# ── arg parsing ──────────────────────────────────────────────────────────────
SETUP_ONLY=0
NO_STUDIO=0
REBUILD_DUCK=0
for arg in "$@"; do
  case "$arg" in
    --setup-only)   SETUP_ONLY=1 ;;
    --no-studio)    NO_STUDIO=1 ;;
    --rebuild-duck) REBUILD_DUCK=1 ;;
    -h|--help)
      cat <<EOF
LineWise launcher

Usage:
  ./start.sh                  Setup (idempotent) + Studio + dev server
  ./start.sh --setup-only     Setup only, do not launch any server
  ./start.sh --no-studio      Skip Prisma Studio (just dev server)
  ./start.sh --rebuild-duck   Force rebuild of db/linewise.duckdb from Excels

Servers (when launched):
  · Next dev server   http://localhost:3000
  · Prisma Studio     http://localhost:5555  (SavedChart, Sku, Plan, …)

Data sources:
  · DuckDB  (db/linewise.duckdb · fact_runs)   ← all dashboard metrics
  · SQLite  (web/prisma/dev.db)                ← saved charts, SKU, plans
EOF
      exit 0
      ;;
    *) fail "Unknown argument: $arg (try --help)" ;;
  esac
done

# ── 1. prerequisites ─────────────────────────────────────────────────────────
step "1/8  Checking prerequisites"
command -v node    >/dev/null 2>&1 || fail "node not found — install Node 18+ (https://nodejs.org)"
command -v npm     >/dev/null 2>&1 || fail "npm not found"
command -v python3 >/dev/null 2>&1 || fail "python3 not found — install Python 3.10+"
ok "node $(node -v) · npm $(npm -v) · python $(python3 --version | awk '{print $2}')"

[ -d "$WEB" ] || fail "web/ directory missing at $WEB"
[ -d "$DATA" ] || fail "Data directory '$DATA' missing. Drop the Damm Excels there."

REQUIRED_XLSX=(
  "OEE 14_17_19_ 2025.xlsx"
  "Volumen 14_17_19_ 2025.xlsx"
  "Tiempo 14_17_19_ 2025.xlsx"
  "Cambios 14_17_19_ 2025.xlsx"
  "Mantenimiento 14_17_19_ 2025.xlsx"
)
for f in "${REQUIRED_XLSX[@]}"; do
  [ -f "$DATA/$f" ] || fail "Missing Excel: $DATA/$f"
done
ok "all 5 required Excels present in 'Repte operacions/'"

# ── 2. seed web/.env from the example template if missing ────────────────────
step "2/8  Checking web/.env (API keys + URLs)"
if [ ! -f "$WEB/.env" ]; then
  if [ -f "$WEB/.env.example" ]; then
    cp "$WEB/.env.example" "$WEB/.env"
    warn "created web/.env from web/.env.example — edit it now and add your OPENAI_API_KEY"
    warn "the Ask bar in /observabilidad will 500 until OPENAI_API_KEY is set"
  else
    fail "web/.env missing and no web/.env.example to seed from"
  fi
else
  if grep -qE '^OPENAI_API_KEY="?sk-\.\.\.' "$WEB/.env" 2>/dev/null || \
     ! grep -qE '^OPENAI_API_KEY=' "$WEB/.env" 2>/dev/null; then
    warn "web/.env exists but OPENAI_API_KEY looks unset — the Ask bar will not work"
  else
    ok "web/.env present"
  fi
fi

# ── 3. npm install ───────────────────────────────────────────────────────────
cd "$WEB"
step "3/8  Installing JS dependencies"
if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
  ok "node_modules already installed (delete it to force re-install)"
else
  npm install --no-audit --no-fund
  ok "deps installed"
fi

# ── 4. python venv + requirements ────────────────────────────────────────────
cd "$ROOT"
step "4/8  Setting up Python venv (.venv) for the model sidecar"
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  ok "created .venv"
fi
# shellcheck disable=SC1091
source .venv/bin/activate

# Activate the venv for the rest of the script so `python`, `pip`, and the
# `npm run model` subprocess all see the sidecar's dependencies.
if ! python -c "import duckdb, pandas, openpyxl, fastapi, uvicorn" 2>/dev/null; then
  pip install --quiet --upgrade pip
  pip install --quiet -r requirements.txt
  ok "Python deps installed into .venv (fastapi, uvicorn, duckdb, lightgbm, …)"
else
  ok "Python deps already satisfied in .venv"
fi

# ── 5. sync 3D viewer assets ─────────────────────────────────────────────────
step "5/8  Syncing 3D viewer assets into web/public/interactive-3d/"
mkdir -p "$WEB/public"
(cd "$WEB" && npm run --silent sync:3d) && ok "3D assets synced"

# ── 6. prisma migrate ────────────────────────────────────────────────────────
cd "$WEB"
step "6/8  Applying Prisma migrations (web/prisma/dev.db)"
npx --yes prisma migrate deploy
ok "schema in sync (includes SavedChart for the chart-builder)"

# ── 7. DuckDB build (analytics fact_runs) ────────────────────────────────────
cd "$ROOT"
step "7/8  Building DuckDB analytics DB (db/linewise.duckdb · fact_runs)"
if [ -f "$DUCKDB" ] && [ "$REBUILD_DUCK" -eq 0 ]; then
  ok "$DUCKDB already exists (use --rebuild-duck to rebuild from Excels)"
else
  mkdir -p "$ROOT/db" "$ROOT/parquet"
  python "$ROOT/scripts/01_ingest.py"
  python "$ROOT/scripts/03_derived_tables.py"
  ok "DuckDB rebuilt — chart-builder will see fresh data"
fi

# ── 8. servers ───────────────────────────────────────────────────────────────
if [ "$SETUP_ONLY" -eq 1 ]; then
  printf "\n${C_BOLD}${C_GREEN}✓ Setup complete.${C_RESET} Launch manually with: ${C_BOLD}cd web && npm run dev:full${C_RESET}\n"
  exit 0
fi

cd "$WEB"

# Free ports if a previous run is still bound. 3000 = Next, 8001 = sidecar.
for port in 3000 8001; do
  if lsof -i :$port -t >/dev/null 2>&1; then
    warn "port $port already in use — killing the old process"
    lsof -i :$port -t | xargs -r kill -9 || true
  fi
done

STUDIO_PID=""
cleanup() {
  [ -n "$STUDIO_PID" ] && kill "$STUDIO_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$NO_STUDIO" -eq 0 ]; then
  if lsof -i :5555 -t >/dev/null 2>&1; then
    warn "port 5555 already in use — skipping Prisma Studio launch"
  else
    step "8/8  Launching Prisma Studio on http://localhost:5555 (background)"
    BROWSER=none npx --yes prisma studio --browser none >/tmp/prisma-studio.log 2>&1 &
    STUDIO_PID=$!
    ok "Prisma Studio pid=$STUDIO_PID — visualises SavedChart, Sku, OfHecho, Plan, …"
    printf "${C_DIM}  log: /tmp/prisma-studio.log${C_RESET}\n"
  fi
fi

step "Launching Next dev server + LineWise model sidecar (concurrently)"
printf "${C_DIM}  Dashboard       http://localhost:3000/observabilidad${C_RESET}\n"
printf "${C_DIM}  Model sidecar   http://localhost:8001 (FastAPI)${C_RESET}\n"
[ "$NO_STUDIO" -eq 0 ] && printf "${C_DIM}  Prisma Studio   http://localhost:5555${C_RESET}\n"
printf "${C_DIM}  Ctrl+C to stop everything${C_RESET}\n\n"

# `npm run dev:full` runs `npm run dev` and `npm run model` concurrently.
# The venv is activated above so the model subprocess finds fastapi/uvicorn.
npm run dev:full
