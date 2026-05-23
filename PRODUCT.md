# PRODUCT.md — LineWise (damm-hack)

register: product

## Product purpose

LineWise is an internal OEE planning tool for Damm's El Prat canning plant (lines L14, L17, L19). It predicts what real OEE a planned production week will achieve against the theoretical changeover matrix coming from Blue Yonder / JDA, and proposes resequencing the week's blocks to lift the ceiling. Every recommendation is deterministic and explained with SHAP drivers ("L17 swap day 3 → day 5 because changeover Damm Lemon → Estrella is 38 min vs 14 min in the original slot").

The web app is the planner's day-to-day surface: a Brief de turno hero, four routes (Observabilidad, Validar plan, Post mortem, Urgencias), and a self-serve chart builder under Observabilidad.

## Users

- **Shift supervisor** — reads the Brief de turno at the start of a shift. Needs to know what's worth flagging in the next 8 hours without reading 6 charts.
- **Production planner** — lives in Observabilidad + Validar plan. Uploads next-week Excels, accepts/rejects optimizer recommendations, builds custom charts to investigate patterns.
- **Plant engineer** — uses Post mortem to understand why a past week underperformed (changeovers, SKU mix, CIP windows).
- **Operations manager** — uses Urgencias to replan when a rush order arrives mid-week.

All users are Spanish-speaking. None are dashboard tourists; they are looking for one specific decision per visit. They open the app on a 27" monitor in a back office during a shift handover, or on a laptop on the shop floor under fluorescent light. Not at 2am, not under stress: they need the tool to be calm, legible, and quick.

## Tone

Evidence-backed and calm. Industrial-editorial, not SaaS-glossy. The interface should feel closer to a craft beer label printed on uncoated stock than to a Linear dashboard. Spanish copy first; English only for proper nouns (OEE, SKU, KPI, SHAP). Numerals with `es-ES` separators.

- Do say: "Sin datos para la combinación elegida. Prueba a ampliar el rango."
- Don't say: "No results found."
- Do say: "Auto → Línea apilada."
- Don't say: "Visualization rendered."

No em dashes (no `—` in copy, no `--`). Use commas, colons, semicolons, periods, or parentheses.

## Strategic principles

- **Answers first, ceremonies second.** The Brief de turno is the home; every other view is a follow-up.
- **Show the system state.** The planner must always see which scope, filters, granularity and resolved visualization the screen is reflecting. Silent degradation (no data → blank pane) is the single worst sin.
- **Reuse Damm's craft language, not generic SaaS chrome.** Paper grain, hairline rules, hatch patterns, serif KPI numerals. No glassmorphism, no gradient text, no hero-metric template.
- **Edits are reversible.** Saving a chart, deleting it, accepting an optimizer rec: each is an action the planner can undo without losing context.

## Anti-references (don't look like these)

- Generic dark-blue observability dashboard (Grafana, Datadog default).
- "AI dashboard" with gradient hero metric, neon accents, identical icon-tile grids.
- White + teal healthcare aesthetic.
- Centered everything, hero card with 4 KPI tiles below.
- Modal-first interactions for routine flows.

## References (do look like these)

- Editorial business publications (Monocle, The Economist data spreads): generous spacing, restrained palette, serif numerals, hairline dividers.
- Damm's own beer labels: cream / linen background, deep red, hatched motifs, sans body + restrained display.
- Linear and Stripe for control density and form vocabulary; never for color or surface.
