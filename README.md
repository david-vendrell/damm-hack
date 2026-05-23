# LineWise · Damm × Engineering HUB Hackathon

> Intelligent line sequencing and OEE optimization for canning lines **14**, **17**, **19** at El Prat.

Blue Yonder tells you what the plan *should* be. **LineWise** tells you what reality says will actually happen — and rearranges your week when an urgent order lands.

## Repo layout

```
damm-hack/
├── Repte operacions/   ← raw Damm Excels (single source of truth)
├── web/                ← Next.js app: ingest, API, dashboard
└── LineWise Operaciones ES.pdf
```

## Quick start

```bash
cd web
npm i
npx prisma migrate dev
npm run ingest          # reads Repte operacions/*.xlsx → SQLite (OfHecho)
npm run dev             # http://localhost:3000 → /observabilidad
```

See `web/README.md` for details on the ingest pipeline, cleaning decisions, and how to add more years.
