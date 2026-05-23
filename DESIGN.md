# DESIGN.md — LineWise

Distilled from `web/src/app/globals.css`, `web/tailwind.config.ts`, and `web/src/components/ui.tsx`. Single source of truth for visual decisions.

## Theme

Light only. The planner uses this in a back office or on a shop floor under ambient fluorescent light; dark would fight the environment. No dark-mode tokens.

## Color (OKLCH-equivalent, anchored to existing hex tokens)

All neutrals are warm: chroma ≈ 0.005 - 0.01 tinted toward Damm red. Never `#000` or `#fff`.

| Token | Hex | Role |
|---|---|---|
| `cream` | `#F5F1EA` | page background |
| `linen` | `#EFE9DE` | sidebar, secondary surface |
| `surface` | `#FFFFFF` | card body |
| `ink` | `#171513` | primary text |
| `ink-2` | `#3A3631` | secondary text |
| `ink-3` | `#6E665B` | tertiary text, muted labels |
| `ink-4` | `#9A9286` | hints, eyebrow micro-text |
| `hairline` | `#E8E1D3` | default border |
| `hairline-strong` | `#D6CDB9` | emphasized border, dividers |
| `damm` | `#A4161A` | primary accent, current selection, primary actions |
| `damm-700` | `#7E1116` | hover, denser accent |
| `damm-soft` | `#FBEAEA` | accent surface tint |
| `gold-600` | `#C99700` | volume / hl metric accent |
| `gold-soft` | `#FBF4DE` | gold surface tint |
| `moss` | `#3F7A52` | on-plan, healthy |
| `moss-soft` | `#E8F0E9` | moss surface tint |
| `warn` | inherited | data-quality warnings only |

Line palette for charts (do not change): `L14 #7E1116`, `L17 #A4161A`, `L19 #D85D62`. Recharts series palette (4+ breakdowns) lives in `web/src/app/observabilidad/chart-preview.tsx::PALETTE`.

Color strategy: **Restrained**. Damm red is the single accent and never exceeds ~10% of any given surface. Charts are the only exception (Committed for the OEE temporal headline). Resist the urge to paint anything else red.

## Typography

Single family: **Inter** (system fallback `system-ui, sans-serif`). Numeric blocks use `tabular-nums` via the `.num` class. Editorial KPIs allowed to use the `.serif` class (Tinos / serif fallback) for the kpi/hero scales only.

Tight scale (1.125 - 1.2 ratio), fixed rem (not fluid):

| Size | rem | Use |
|---|---|---|
| `eyebrow` | 0.6875 | uppercase tracked label above section / KPI |
| `xs` | 0.75 | body micro, table cells |
| `sm` | 0.875 | body, form controls |
| `base` | 1 | rare, prose only |
| `kpi` | 2.25 | StatBlock value |
| `hero` | 3.5 | BriefHero headline only |

Line length cap for prose: 65 - 75ch. Tables and dense controls may exceed.

## Layout

- 12-column implicit grid. Sidebar 252px sticky, main `px-8 py-8` (Tailwind 32px).
- Vary spacing for rhythm: tight (8-12px) within groups, generous (32-64px) between sections. Avoid monotone padding.
- Cards (`rounded-card`, hairline, soft shadow) only when content is genuinely distinct and actionable. **Never nest cards**.
- Layer switcher pattern: `SegmentedControl` at the top of a view selects between answer-first sub-modes (Resumen / Gráficos). Each sub-mode renders its own header.

## Components (reuse, do not reinvent)

In `web/src/components/ui.tsx`:

- `Card`, `CardHeader` — every panel uses the same chrome.
- `StatBlock`, `StatStrip` — the only place hero numerals appear.
- `KPI`, `DeltaPill` — number + delta in editorial scale.
- `VeredictoBadge` — procede / revisar / evitar; the optimizer's vocabulary.
- `Skeleton` — every async surface during fetch. No spinners in content.
- `Pill` — segmented choices inside panels (granularity, presets, top N, viz).
- `Button` variants: `primary` (ink), `secondary` (hairline), `ghost`, `danger` (damm).
- `Select` — single source of truth for native-style dropdowns.
- `SegmentedControl` — top-level layer/scope toggles.
- `SectionTitle` — eyebrow + serif H2; the editorial header.

In `web/src/components/`:

- `BriefHero` (brief-card.tsx) — answers-first card on every route entry.
- `Sidebar` — Favoritos + 4 routes; nav vocabulary in `globals.css::.nav-item`.
- `TopBar`, `ScopeBar` — global scope (línea, periodo) lives here.

## Patterns

- **Hatch motif**: `.hatch` in `globals.css` evokes the beer-label print register. Use for empty backgrounds, never as decoration on data.
- **Eyebrow + serif H2**: every editorial divider follows this shape.
- **Hairline borders**: section separation is always a 1px hairline rule, not a card. Side-stripe accent borders are banned (matches the impeccable absolute ban).
- **Numerals with `.num`**: every figure, count, or delta uses tabular nums so columns align in tables.

## Motion

150 - 250ms transitions, exponential ease-out (`cubic-bezier(0.22, 1, 0.36, 1)` if custom). Motion conveys state, not decoration. No bounce, no elastic. No orchestrated page-load sequences except `animate-fade-in` on first-paint hero (BriefHero).

## Absolute bans (in addition to the shared `impeccable` bans)

- Side-stripe colored borders on cards / callouts / list items.
- Gradient text (`background-clip: text` + gradient).
- Glassmorphism by default; reserve for the rare on-purpose overlay.
- "Hero metric" SaaS template (big number + gradient + 4 stat tiles + supporting bar).
- Identical icon-tile grids (icon + heading + body, repeated).
- Modal-first interactions; exhaust inline / progressive disclosure first.
- Em dashes (`—`) anywhere in copy or comments.
- `#000` / `#fff`; always use the warm-neutral tokens above.
- Mixing serif into body / labels / buttons; serif is for kpi/hero numerals only.
