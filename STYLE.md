# STYLE.md: LineWise

Onboarding guide for everyone touching the LineWise UI: engineers, designers, PMs, copywriters, accessibility reviewers. Read this top to bottom once. Keep the checklist in section 14 nearby.

This doc is self-contained but cross-links to canonical sources where relevant:

- `DESIGN.md`: short visual spec, distilled from code.
- `PRODUCT.md`: product tone, personas, anti-references.
- `web/README.md`: how to run the app.
- `web/tailwind.config.ts`: source of truth for every token.
- `web/src/app/globals.css`: CSS variables and ornamental classes.
- `web/src/components/ui.tsx`: every reusable primitive.

When this doc and the codebase disagree, the **codebase wins**. Open an edit to fix this doc.

---

## 1. Mission

LineWise is the OEE planner that Damm's planners and shop-floor leads use in a warmly lit office or under fluorescent factory light. The interface is:

- **Light only.** No dark-mode tokens exist. Don't build for one.
- **Warm and restrained.** Cream surfaces, ink-tinted text, Damm red as the single accent.
- **Evidence first.** Answers and verdicts above the fold; ceremonies and inputs below.
- **Spanish-speaking.** All UI copy is es-ES; proper nouns stay in English (OEE, SKU, OF, Hl, L14/L17/L19).

If a design decision fights any of these, default to the mission.

---

## 2. Stack

| Layer | Choice | Version |
|---|---|---|
| Framework | Next.js (App Router) | 14 |
| UI runtime | React | 18 |
| Language | TypeScript | 5+ |
| Styles | Tailwind CSS | 3.4 |
| Data fetching | TanStack React Query | 5 |
| Charts | Recharts | 2 |
| Icons | lucide-react | latest |
| ORM | Prisma + SQLite | 5 |

**Not in use, do not introduce:** shadcn/ui, Radix, Headless UI, Framer Motion, CSS-in-JS, styled-components, dark mode, custom icon sets.

### Where things live

```
web/
  src/
    app/                Next.js routes; each page is small, delegates to a view component
      globals.css       CSS vars, .eyebrow, .nav-item, .hatch, focus ring
      observabilidad/   chart-builder.tsx, chart-preview.tsx, saved-charts-grid.tsx
      validar/          validar plan
      post-mortem/
      urgencias/
    components/
      ui.tsx            ALL shared primitives live here
      app-shell.tsx     sidebar + top bar + main
      brief-card.tsx    BriefHero (answers-first banner)
      sidebar.tsx       Favoritos + 4 routes
      top-bar.tsx       sticky header with backdrop blur
      scope-bar.tsx     línea + periodo + filtros
      scope-provider.tsx
      icons.ts          lucide re-exports (import from here, NOT from lucide-react)
      query-provider.tsx
    lib/
      utils.ts          cn, pct, pts, hl
    types.ts            API response types, Linea / Veredicto enums
  tailwind.config.ts    tokens (colors, fontSize, radius, shadow, animation)
interactive-3d/         Three.js HTML files (separate ruleset, section 13)
```

---

## 3. Design tokens

These are the only values you may type. If you find yourself reaching for a raw hex or a pixel value, look here first; add a token in `tailwind.config.ts` if something is genuinely missing.

### Colors (warm neutrals, never `#000` / `#fff`)

| Token | Hex | Role |
|---|---|---|
| `bone` | `#FAF7F1` | accent background, eyebrow strip |
| `cream` | `#F5F1EA` | page background |
| `linen` | `#EFE9DE` | sidebar, secondary surface |
| `surface` | `#FFFFFF` | card body, input field |
| `sand` | `#F2ECDF` | rare accent surface |
| `ink` | `#171513` | primary text, headings |
| `ink-2` | `#3A3631` | body, secondary text |
| `ink-3` | `#6E665B` | muted labels, hints |
| `ink-4` | `#A39B8C` | eyebrow micro-text |
| `hairline` | `#E8E1D3` | default 1px border |
| `hairline-strong` | `#D6CDB9` | emphasised divider, hover border |
| `damm` | `#A4161A` | primary accent, selected nav, CTA, focus |
| `damm-700` | `#7E1116` | denser accent, hover |
| `damm-soft` | `#FBEAEA` | accent surface tint |
| `gold` | `#C99700` | volume / Hl metrics, attention |
| `gold-soft` | `#FBF4DE` | warn surface tint |
| `moss` | `#3F7A52` | on-plan, healthy positive |
| `moss-soft` | `#E8F0E9` | positive surface tint |

**Restraint rule:** Damm red never covers more than ~10% of a surface. Charts are the only place this is relaxed.

**Chart line palette (fixed, do not change):**

```
L14 #7E1116   L17 #A4161A   L19 #D85D62
```

For multi-series charts beyond the three lines, use the `PALETTE` array in `web/src/app/observabilidad/chart-preview.tsx`. It wraps at 12.

### Typography

Single family: **Inter** (loaded via `next/font`, fallback `system-ui, sans-serif`). Numeric blocks use the `.num` class (`font-variant-numeric: tabular-nums`) so columns align. The `.serif` class is allowed **only** on the `kpi` and `hero` sizes; never in body, labels, or buttons.

| Size | rem | px | Use |
|---|---|---|---|
| `eyebrow` | 0.6875 | 11 | uppercase tracked label above a section or KPI |
| `xs` | 0.75 | 12 | table cells, hints, micro UI |
| `sm` | 0.875 | 14 | body, form controls (default) |
| `base` | 1 | 16 | prose only |
| `kpi` | 2.25 | 36 | StatBlock value |
| `hero` | 3.5 | 56 | BriefHero headline only |

Cap prose line-length at 65–75ch. Dense controls and tables can exceed.

### Radii, shadows, motion

| Token | Value | Use |
|---|---|---|
| `rounded-soft` | 10px | inputs, pills |
| `rounded-card` | 14px | cards, modals, dropdowns |
| `rounded-pill` | 999px | badges, pill buttons |
| `shadow-hairline` | 1px ring | thin border emphasis |
| `shadow-card` | 1px ring + faint shadow | every card |
| `shadow-elevated` | lifted | modals, dropdowns |
| `shadow-focus` | 3px Damm halo | focus state (auto via focus-visible) |
| `animate-fade-in` | 280ms ease-out | hero panels, first-paint content |
| `animate-stripe` | 1.4s loop | loading stripe |

The fade-in uses `cubic-bezier(0.2, 0.7, 0.2, 1)`. Any other animation needs a written justification; you almost certainly do not need one.

### Spacing rhythm

Vary it. Tight (8–12px: `gap-2`, `gap-3`, `space-y-1`) within a group; generous (24–64px: `mt-6`, `mt-8`, `gap-6`, `py-10`) between sections. Monotone padding (everything `p-4`) is a smell.

---

## 4. Components, do not reinvent

Every reusable primitive lives in `web/src/components/ui.tsx`. If you need one that's missing, add it there instead of inlining a div. Import from `@/components/ui`.

### Surfaces

- **`Card`**: base chrome (`rounded-card`, `border-hairline`, `bg-surface`, `shadow-card`). Pass `elevated` for modal-style lift. **Never nest cards.**
- **`CardHeader`**: `eyebrow` + `title` + optional `subtitle` and `action`. Sits at the top of a `Card`.

### Numbers

- **`KPI`**: number with optional `delta`, `hint`, `unit`. The standard editorial readout.
- **`DeltaPill`**: up/down/flat pill. Formats: `'pts' | 'pct' | 'abs'`. `invert` for metrics where down is good.
- **`StatBlock`**: KPI inside a flex cell with optional `divider`.
- **`StatStrip`**: horizontal row of `StatBlock`s, aligned bases.

### Verdicts and badges

- **`VeredictoBadge`**: `procede` / `revisar` / `evitar`. Vocabulary of the optimizer; do not invent new states.

### Controls

- **`Button`**: variants: `primary` (ink), `secondary` (hairline), `ghost`, `danger` (damm). Sizes: `sm`, `md`. Accepts `leftIcon` / `rightIcon`.
- **`Select`**: single source of truth for dropdowns; handles click-outside + Escape.
- **`SegmentedControl<T>`**: top-level layer/scope toggles (e.g. Resumen / Gráficos).
- **`Pill`**: segmented choice inside a panel (granularidad, presets, top N, viz).

### Editorial

- **`SectionTitle`**: `eyebrow` + serif H2 + optional `subtitle`. Every divider in the app uses this shape.

### Async

- **`Skeleton`**: placeholder shimmer (`animate-pulse`, `bg-hairline/50`). Every loading surface uses this. **No spinners in content.**

### Route-level pieces (not in `ui.tsx`)

- **`BriefHero`** (`brief-card.tsx`): answers-first hero on every route entry.
- **`AppShell`** (`app-shell.tsx`): sidebar + top bar + main; wraps every page.
- **`Sidebar`**, **`TopBar`**, **`ScopeBar`**: global navigation and scope.
- **`ScopeProvider`**: context for línea + periodo + filtros; consume with `useScope()`.

---

## 5. Layout

### App shell

`web/src/components/app-shell.tsx` defines:

```
<div className="flex min-h-screen bg-cream">
  <Sidebar />                       {/* 252px, sticky, bg-linen */}
  <div className="flex flex-1 flex-col">
    <TopBar />                      {/* sticky, backdrop-blur */}
    <main className="flex-1 px-8 py-8">{children}</main>
  </div>
</div>
```

Don't override the shell from a page. Compose inside `<main>`.

### Page template

Every route opens with the same shape: answers first, ceremonies second.

1. `BriefHero` (or a route-specific hero) at the top.
2. `SegmentedControl` for sub-modes when relevant.
3. Sections of `Card` + `CardHeader` underneath, separated by generous vertical space.

### Grid

Use Tailwind's implicit CSS grid. Mobile first; add `md:` (768px) for desktop variants. No fixed max-width on content; the 32px main padding sets the right margin.

---

## 6. Writing components (engineer rules)

### File and export naming

- Filenames: **kebab-case** (`brief-card.tsx`, `scope-bar.tsx`).
- Exports: **PascalCase** (`export function BriefHero`).
- Interactive components start with `'use client'`.

### Import order

```ts
'use client';

import { useState } from 'react';              // external
import { useQuery } from '@tanstack/react-query';

import { Card, CardHeader, KPI } from '@/components/ui';   // shared
import { Activity } from '@/components/icons';
import { cn, pct } from '@/lib/utils';

import { LocalHelper } from './local-helper';             // siblings
import type { Linea, Veredicto } from '@/types';          // types last
```

### Class merging

Always use `cn()` from `@/lib/utils`. Never template-string class concatenation.

```tsx
// good
<div className={cn(
  'flex items-center gap-3 px-5 py-4 transition-colors',
  active ? 'bg-ink text-surface font-medium' : 'text-ink-3 hover:bg-linen',
)} />

// bad
<div className={`flex ${active ? 'bg-ink' : 'bg-surface'}`} />
```

### Data fetching

TanStack `useQuery`. Always set a `staleTime` (60s is the house default), and render `Skeleton` while loading.

```tsx
const q = useQuery({
  queryKey: ['observabilidad', scope, filters],
  queryFn: () => fetch(`/api/observabilidad?${scope.toQuery()}`).then(r => r.json()),
  staleTime: 60_000,
});

if (q.isLoading) return <Skeleton className="h-32" />;
if (q.error) return null;
if (!q.data) return null;
```

### Numbers

Format with the helpers in `web/src/lib/utils.ts`. All use es-ES locale.

```ts
pct(0.853)     // '85%'
pct(0.853, 1)  // '85.3%'
pts(2.1)       // '+2.1 pts'
hl(1234)       // '1.234 Hl'
```

### Example shell (model after `brief-card.tsx`)

```tsx
'use client';

import { useQuery } from '@tanstack/react-query';

import { Card, CardHeader, KPI, Skeleton } from '@/components/ui';
import { useScope } from '@/components/scope-provider';
import { pct } from '@/lib/utils';

export function OEEPanel() {
  const { scope } = useScope();
  const q = useQuery({
    queryKey: ['oee', scope],
    queryFn: () => fetch(`/api/oee?${scope.toQuery()}`).then(r => r.json()),
    staleTime: 60_000,
  });

  if (q.isLoading) return <Skeleton className="h-40" />;
  if (!q.data) return null;

  return (
    <Card>
      <CardHeader eyebrow="Operación" title="OEE semanal" subtitle="Línea 17" />
      <div className="px-6 py-5">
        <KPI label="Promedio" value={pct(q.data.oee, 1)} />
      </div>
    </Card>
  );
}
```

---

## 7. Icons

Source: `lucide-react`. Always import from the re-export at `web/src/components/icons.ts`, never directly from `lucide-react`. If the icon you need is not in the re-export, add it there in alphabetical order.

```tsx
import { Activity, ChevronDown, Sparkles } from '@/components/icons';

<Activity className="h-4 w-4" strokeWidth={1.75} />
```

| Size class | Px | Use |
|---|---|---|
| `h-3 w-3` | 12 | micro icons inside eyebrows and pills |
| `h-3.5 w-3.5` | 14 | standard nav and button icons |
| `h-4 w-4` | 16 | inline body, table cells, inputs |
| `h-5 w-5` / `h-6 w-6` | 20 / 24 | header buttons, large affordances |

Always set `strokeWidth` explicitly: `1.75` default, `2` for emphasis or selected, `2.5` for ornamental marks (delta arrows). No custom or hand-drawn icons.

---

## 8. Interaction and motion

### Hover

`transition-colors` on every interactive element. Move background, text, or border: never size or position.

### Focus

`web/src/app/globals.css` sets a global `*:focus-visible` ring using the Damm accent. Never set `outline: none`. If you build a custom focusable element (rare), apply `shadow-focus` on focus-visible to match.

### Loading

`Skeleton` for any async surface. No spinners in content. If a button is loading, it disables and shows a subtle inline state.

### Dropdowns and popovers

Close on outside-click and on Escape. Pattern lives in `web/src/components/scope-bar.tsx`:

```tsx
useEffect(() => {
  if (!open) return;
  const handle = (e: MouseEvent) => {
    if (!ref.current?.contains(e.target as Node)) setOpen(false);
  };
  document.addEventListener('mousedown', handle);
  return () => document.removeEventListener('mousedown', handle);
}, [open]);
```

### Allowed animations

Only the two defined in `tailwind.config.ts`:

- `animate-fade-in`: 280ms ease-out, for first-paint hero content.
- `animate-stripe`: 1.4s loop, for striped loading bars.

No bounce, no elastic, no orchestrated page-load sequences.

---

## 9. Charts and data viz

Recharts only. The whole catalog lives in `web/src/app/observabilidad/chart-preview.tsx`; use `ChartPreview` directly when you need a chart in a new place.

### Supported `viz` values

`line | bar | stackedBar | donut | bigNumber | table | auto`

`auto` resolves based on the shape of the data: prefer it when you have a chart builder context.

### Visual conventions

- Axis stroke `#6B6B6B`, tick `font-size: 12`.
- Gridlines dashed, horizontal only: `stroke="#E6E0D6" strokeDasharray="3 3" vertical={false}`.
- Tooltip on `bg-surface` with `border-hairline` and `rounded-card`.
- Line colors fixed for L14/L17/L19; multi-series use `PALETTE`.

### Data shape

Every measure has a `kind` from `web/src/types.ts`: `'pct' | 'count' | 'hours' | 'hl' | 'units'`. Use the matching formatter (`pct`, `hl`, etc.) for axis labels and tooltips.

---

## 10. Copy and i18n

All UI copy is **Spanish (es-ES)**. Keep proper nouns in English: OEE, SKU, KPI, SHAP, OF, Hl, L14/L17/L19.

### Tone

Evidence-backed, calm, declarative. See `PRODUCT.md` for the canonical voice. Do / don't pairs:

- Do: *"Sin datos para la combinación elegida. Prueba a ampliar el rango."*
- Don't: *"No results found."*
- Do: *"Auto → Línea apilada."*
- Don't: *"Visualization rendered."*

### Hard rules

- **No em dashes** (`—`, `--`) in copy, comments, or this kind of doc. Use commas, colons, periods, parentheses.
- Numbers always go through the formatter utilities so locale stays consistent.
- Product vocabulary stays consistent with the enums in `web/src/types.ts` (`Veredicto`, `Linea`, `MeasureKind`). Don't invent synonyms.
- Common abbreviations: `L14` (línea 14), `Hl` (hectolitros), `pp` / `pts` (puntos porcentuales), `OF` (orden de fabricación).

---

## 11. Accessibility

### Semantics

- `<section>` for major content blocks, with `aria-label` if there's no visible heading.
- `<nav>` for navigation.
- `<button type="button">` to avoid accidental form submission.
- `<label htmlFor>` explicitly connected to inputs.

### Focus and keyboard

- Focus ring is always visible. Never `outline: none`.
- Tab order follows DOM order. Don't manipulate `tabindex` unless absolutely necessary.
- Dropdowns and modals close on Escape.

### Icon-only buttons

Always include screen-reader text and an `aria-label`. Pattern from `brief-card.tsx`:

```tsx
<button
  type="button"
  aria-label={collapsed ? 'Expandir brief' : 'Contraer brief'}
  aria-expanded={!collapsed}
>
  <ChevronDown className="h-4 w-4" />
  <span className="sr-only">{collapsed ? 'Expandir brief' : 'Contraer brief'}</span>
</button>
```

### Color

Body text passes WCAG AA (4.5:1). Color is never the sole signal; always pair with an icon, label, or pattern.

---

## 12. Absolute bans

The following are non-negotiable. If you find one in code, fix it.

- Side-stripe colored borders on cards, callouts, list items.
- Gradient text (`background-clip: text` + gradient).
- Default glassmorphism. The 3D HTML overlay is the rare exception.
- The "hero metric" SaaS template (big number + gradient + four stat tiles + bar).
- Identical icon-tile grids (icon + heading + body, repeated).
- Modal-first interactions. Exhaust inline and progressive disclosure first.
- Em dashes (`—` or `--`) anywhere in copy, comments, or docs.
- `#000` or `#fff`. Use the warm tokens.
- Serif in body, labels, or buttons. Serif is for `kpi` and `hero` only.
- Dark mode.
- Custom or hand-drawn icons. Lucide only.
- CSS-in-JS, styled-components.
- Spinners during content loading. Use `Skeleton`.
- Nested `Card`s.

---

## 13. The 3D factory overlay (different ruleset)

`interactive-3d/*.html` (notably `linewise_tres_lineas_oee_fabrica_3d_sin_paredes.html`) is a standalone Three.js demo. It has its own inline styles and **none of the rules above apply there**:

- Dark navy background (`rgba(8,15,28,0.86)`), slate borders (`rgba(148,163,184,0.22)`), `backdrop-filter: blur(7px)` allowed.
- Text color `#e2e8f0`, system-ui 11–13px.
- OEE rings use a red → amber → green gradient (`#ff3b3b` / `#f2a623` / `#19c37d`).

If you copy that aesthetic into the web app you are doing it wrong, and vice versa.

---

## 14. Before you ship: checklist

- [ ] Filename kebab-case, export PascalCase.
- [ ] `cn()` used for every dynamic class.
- [ ] Only token colors, no raw hex, no `#000` / `#fff`.
- [ ] Icons from `@/components/icons` with explicit `strokeWidth`.
- [ ] Spacing rhythm varies (tight within groups, generous between).
- [ ] `Skeleton` for loading, never a spinner.
- [ ] Copy in es-ES, no em dashes, vocabulary matches `types.ts` enums.
- [ ] Numbers go through `pct` / `pts` / `hl`.
- [ ] Focus ring visible, semantic HTML, ARIA on icon-only buttons.
- [ ] Responsive at `md:` (768px) breakpoint.
- [ ] No banned patterns (section 12).
- [ ] No nested `Card`s.
- [ ] Tested with keyboard and mouse, in latest Chrome and Safari.

---

## 15. References

- `DESIGN.md`: visual spec (color, type, motion, bans)
- `PRODUCT.md`: product tone and personas
- `README.md`: repo overview
- `web/README.md`: running the app
- `web/tailwind.config.ts`: tokens (authoritative)
- `web/src/app/globals.css`: CSS variables, `.eyebrow`, `.nav-item`, `.hatch`, focus ring
- `web/src/components/ui.tsx`: every shared primitive
- `web/src/components/brief-card.tsx`: model for new components
- `web/src/components/scope-bar.tsx`: dropdown / click-outside pattern
- `web/src/app/observabilidad/chart-preview.tsx`: Recharts catalog and `PALETTE`
- `web/src/lib/utils.ts`: `cn`, `pct`, `pts`, `hl`
- `web/src/types.ts`: `Linea`, `Veredicto`, `MeasureKind`
