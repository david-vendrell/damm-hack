#!/usr/bin/env bash
# LineWise — one-shot setup + launch.
# Idempotent: re-run any time.
#
# What it does, in order:
#   1. Verify Node + npm (and Python if DuckDB needs (re)building)
#   2. Install npm deps (only if node_modules missing)
#   3. Apply Prisma migrations → web/prisma/dev.db  (SavedChart + planning models)
#   4. Build the DuckDB analytics DB (db/linewise.duckdb · fact_runs) if missing
#   5. Launch Prisma Studio (port 5555) + Next dev server (port 3000)
#
# All dashboard metrics (KPIs, chart-builder, saved charts) read from DuckDB
# `fact_runs`. The SQLite DB only stores editable objects: SavedChart configs,
# SKU master, plans, etc. — visible in Prisma Studio.

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
step "1/5  Checking prerequisites"
command -v node >/dev/null 2>&1 || fail "node not found — install Node 18+ (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || fail "npm not found"
ok "node $(node -v) · npm $(npm -v)"

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

# ── 2. npm install ───────────────────────────────────────────────────────────
cd "$WEB"
step "2/5  Installing JS dependencies"
if [ -d "node_modules" ] && [ -f "node_modules/.package-lock.json" ]; then
  ok "node_modules already installed (delete it to force re-install)"
else
  npm install --no-audit --no-fund
  ok "deps installed"
fi

# ── 3. prisma migrate ────────────────────────────────────────────────────────
step "3/5  Applying Prisma migrations (web/prisma/dev.db)"
npx --yes prisma migrate deploy
ok "schema in sync (includes SavedChart for the chart-builder)"

# ── 4. DuckDB build (analytics fact_runs) ────────────────────────────────────
cd "$ROOT"
step "4/5  Building DuckDB analytics DB (db/linewise.duckdb · fact_runs)"
if [ -f "$DUCKDB" ] && [ "$REBUILD_DUCK" -eq 0 ]; then
  ok "$DUCKDB already exists (use --rebuild-duck to rebuild from Excels)"
else
  command -v python3 >/dev/null 2>&1 || fail "python3 not found — needed to (re)build $DUCKDB"
  if ! python3 -c "import duckdb, pandas, openpyxl" 2>/dev/null; then
    warn "python3 is missing duckdb/pandas/openpyxl."
    cat <<EOF
${C_DIM}  Install them in a venv:
    python3 -m venv .venv && source .venv/bin/activate
    pip install duckdb pandas openpyxl
  …then re-run ./start.sh
${C_RESET}
EOF
    fail "DuckDB cannot be built without these Python packages."
  fi
  mkdir -p "$ROOT/db" "$ROOT/parquet"
  python3 "$ROOT/scripts/01_ingest.py"
  python3 "$ROOT/scripts/03_derived_tables.py"
  ok "DuckDB rebuilt — chart-builder will see fresh data"
fi

# ── 6. servers ───────────────────────────────────────────────────────────────
if [ "$SETUP_ONLY" -eq 1 ]; then
  printf "\n${C_BOLD}${C_GREEN}✓ Setup complete.${C_RESET} Launch manually with: ${C_BOLD}cd web && npm run dev${C_RESET}\n"
  exit 0
fi

cd "$WEB"

# Free port 3000 if a previous run is still bound.
if lsof -i :3000 -t >/dev/null 2>&1; then
  warn "port 3000 already in use — killing the old process"
  lsof -i :3000 -t | xargs -r kill -9 || true
fi

STUDIO_PID=""
cleanup() {
  [ -n "$STUDIO_PID" ] && kill "$STUDIO_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "$NO_STUDIO" -eq 0 ]; then
  if lsof -i :5555 -t >/dev/null 2>&1; then
    warn "port 5555 already in use — skipping Prisma Studio launch"
  else
    step "5/5  Launching Prisma Studio on http://localhost:5555 (background)"
    BROWSER=none npx --yes prisma studio --browser none >/tmp/prisma-studio.log 2>&1 &
    STUDIO_PID=$!
    ok "Prisma Studio pid=$STUDIO_PID — visualises SavedChart, Sku, OfHecho, Plan, …"
    printf "${C_DIM}  log: /tmp/prisma-studio.log${C_RESET}\n"
  fi
fi

step "Launching Next dev server"
printf "${C_DIM}  Dashboard      http://localhost:3000/observabilidad${C_RESET}\n"
[ "$NO_STUDIO" -eq 0 ] && printf "${C_DIM}  Prisma Studio  http://localhost:5555${C_RESET}\n"
printf "${C_DIM}  Ctrl+C to stop both${C_RESET}\n\n"

npm run dev
