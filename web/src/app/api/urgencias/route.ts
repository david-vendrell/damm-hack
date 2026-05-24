import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { analizarConIncidencia } from '@/server/analysis';
import { loadUpload } from '@/server/upload-store';

export const runtime = 'nodejs';
export const maxDuration = 300;     // LineWise can take ~15 s

/**
 * POST /api/urgencias
 *
 * Re-optimizes the active plan with ONE incident applied (either an outage
 * blocking a slot, or an urgent priority OF inserted). Returns the post-
 * incident AnalisisPlan as a *preview* — does NOT persist. The frontend
 * then offers an "Aplicar" button that hits /api/planes/[id]/aplicar-
 * incidencia to overwrite the cached plan.
 *
 * Body shape (exactly ONE of outage or priorityOf required):
 *   { planId, outage:     { linea, fecha, turno, motivo } }
 *   { planId, priorityOf: { sku, hl, deadline, preferred_linea?, reason? } }
 */
interface OutageBody {
  linea: 14 | 17 | 19;
  fecha: string;           // ISO yyyy-mm-dd
  turno: 'M' | 'T' | 'N';
  motivo?: string;
}
interface PriorityOfBody {
  sku: string;
  hl: number;
  deadline: string;        // ISO yyyy-mm-dd
  preferred_linea?: 14 | 17 | 19;
  reason?: string;
}
interface Body {
  planId?: string;
  outage?: OutageBody;
  priorityOf?: PriorityOfBody;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 });
  }
  if (!body.planId) {
    return NextResponse.json(
      { error: 'missing_planId', detail: 'Indica el planId del plan activo.' },
      { status: 400 },
    );
  }
  if ((!body.outage && !body.priorityOf) || (body.outage && body.priorityOf)) {
    return NextResponse.json(
      {
        error: 'invalid_incident',
        detail: 'Envía exactamente UNO de: outage (avería) o priorityOf (pedido urgente).',
      },
      { status: 400 },
    );
  }

  const plan = await prisma.plan.findUnique({
    where: { id: body.planId },
    include: { items: { orderBy: { secuencia: 'asc' } } },
  });
  if (!plan) {
    return NextResponse.json(
      { error: 'plan_not_found', detail: `No existe el plan ${body.planId}.` },
      { status: 404 },
    );
  }

  const upload = await loadUpload(plan.id);
  if (!upload) {
    return NextResponse.json(
      {
        error: 'no_buffer',
        detail:
          'El Excel original ya no está disponible (planes antiguos). ' +
          'Vuelve a subir el plan desde /validar.',
      },
      { status: 410 },
    );
  }

  const incident = body.outage
    ? {
        outages: [
          {
            linea: body.outage.linea,
            fecha: body.outage.fecha,
            turno: body.outage.turno,
            reason: body.outage.motivo ?? 'Avería declarada',
          },
        ],
      }
    : {
        priority_ofs: [
          {
            sku: body.priorityOf!.sku,
            hl: body.priorityOf!.hl,
            deadline: body.priorityOf!.deadline,
            preferred_linea: body.priorityOf!.preferred_linea,
            reason: body.priorityOf!.reason ?? 'Pedido urgente',
          },
        ],
      };

  const items = plan.items.map((it) => ({
    linea: it.linea,
    sku: it.sku,
    dia: it.dia,
    hlPlan: it.hlPlan,
  }));
  const analisis = await analizarConIncidencia(
    plan.id,
    plan.nombre,
    items,
    upload.buffer,
    upload.fileName,
    incident,
  );
  if (!analisis) {
    return NextResponse.json(
      {
        error: 'linewise_unavailable',
        detail: 'Modelo LineWise no respondió. Comprueba el sidecar local en :8001.',
      },
      { status: 502 },
    );
  }

  return NextResponse.json(analisis);
}
