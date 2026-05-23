import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// SKUs realistas usando códigos del estilo Damm (ED..LTNN). Marcas y formatos
// coherentes con la cartera real de El Prat.
const SKUS: { codigo: string; nombre: string; marca: string; formato: '1/3' | '1/2' }[] = [
  { codigo: 'ED13LTNN', nombre: 'Estrella Damm 1/3', marca: 'Estrella Damm', formato: '1/3' },
  { codigo: 'ED12LTNN', nombre: 'Estrella Damm 1/2', marca: 'Estrella Damm', formato: '1/2' },
  { codigo: 'DL13LTNN', nombre: 'Damm Lemon 1/3', marca: 'Damm Lemon', formato: '1/3' },
  { codigo: 'DL12LTNN', nombre: 'Damm Lemon 1/2', marca: 'Damm Lemon', formato: '1/2' },
  { codigo: 'EL13LTNN', nombre: 'Estrella Levante 1/3', marca: 'Estrella Levante', formato: '1/3' },
  { codigo: 'EL12LTNN', nombre: 'Estrella Levante 1/2', marca: 'Estrella Levante', formato: '1/2' },
  { codigo: 'LF13LTNN', nombre: 'La Fría 1/3', marca: 'La Fría', formato: '1/3' },
  { codigo: 'VL13LTNN', nombre: 'Voll-Damm 1/3', marca: 'Voll-Damm', formato: '1/3' },
  { codigo: 'VL12LTNN', nombre: 'Voll-Damm 1/2', marca: 'Voll-Damm', formato: '1/2' },
  { codigo: 'XB13LTNN', nombre: 'Xibeca 1/3', marca: 'Xibeca', formato: '1/3' },
  { codigo: 'XB12LTNN', nombre: 'Xibeca 1/2', marca: 'Xibeca', formato: '1/2' },
  { codigo: 'FR13LTNN', nombre: 'Free Damm 1/3', marca: 'Free Damm', formato: '1/3' },
  { codigo: 'DD13LTNN', nombre: 'Daura Damm 1/3', marca: 'Daura', formato: '1/3' },
  { codigo: 'IN13LTNN', nombre: 'Inedit 1/3', marca: 'Inedit', formato: '1/3' },
];

// Baselines reales (medianas y p80 del histórico de "días buenos" del SKU-línea)
// según los hallazgos: L14 alcanzable ~54%, L17/L19 alcanzable ~67%.
// Pequeña dispersión por SKU para que el explorador tenga variedad.
function baselineFor(linea: number, formato: '1/3' | '1/2', jitter: number) {
  if (linea === 14) {
    return { mediana: 0.46 + jitter * 0.04, alcanzable: 0.54 + jitter * 0.04, rate: formato === '1/3' ? 95000 : 78000 };
  }
  if (linea === 17) {
    return { mediana: 0.58 + jitter * 0.05, alcanzable: 0.67 + jitter * 0.05, rate: formato === '1/3' ? 110000 : 88000 };
  }
  return { mediana: 0.59 + jitter * 0.05, alcanzable: 0.67 + jitter * 0.05, rate: formato === '1/3' ? 105000 : 85000 };
}

// Tabla CF Prat resumida. Estados: "1/3", "1/2" representan el formato corriendo.
const CO: { linea: number; o: string; d: string; min: number }[] = [
  { linea: 14, o: '1/3', d: '1/3', min: 40 },
  { linea: 14, o: '1/2', d: '1/2', min: 40 },
  { linea: 14, o: '1/3', d: '1/2', min: 180 },
  { linea: 14, o: '1/2', d: '1/3', min: 180 },
  { linea: 17, o: '1/3', d: '1/3', min: 35 },
  { linea: 17, o: '1/2', d: '1/2', min: 35 },
  { linea: 17, o: '1/3', d: '1/2', min: 480 },
  { linea: 17, o: '1/2', d: '1/3', min: 480 },
  { linea: 19, o: '1/3', d: '1/3', min: 40 },
  { linea: 19, o: '1/2', d: '1/2', min: 40 },
  { linea: 19, o: '1/3', d: '1/2', min: 200 },
  { linea: 19, o: '1/2', d: '1/3', min: 200 },
];

// Caso estrella L19 octubre 2025 + más casos peores.
const PEORES = [
  {
    of: 'OF-19-202510-0231',
    linea: 19,
    fecha: '2025-10-14',
    skuAnterior: 'EL12LTNN',
    skuActual: 'DL13LTNN',
    tipoCambio: 'formato',
    oeeReal: 0.15,
    oeeAlcanzable: 0.67,
    ptsPerdidos: 52,
    motivo: 'Cambio de formato 1/2→1/3 en L19 (200 min). Disponibilidad 21%. Día siguiente, mismo formato → OEE 86%.',
  },
  {
    of: 'OF-17-202507-0118',
    linea: 17,
    fecha: '2025-07-22',
    skuAnterior: 'ED13LTNN',
    skuActual: 'ED12LTNN',
    tipoCambio: 'formato',
    oeeReal: 0.21,
    oeeAlcanzable: 0.67,
    ptsPerdidos: 46,
    motivo: 'Cambio de formato 1/3→1/2 en L17 (8 h teóricas). L17 casi no cambia de formato por algo.',
  },
  {
    of: 'OF-14-202503-0042',
    linea: 14,
    fecha: '2025-03-11',
    skuAnterior: 'XB13LTNN',
    skuActual: 'XB12LTNN',
    tipoCambio: 'formato',
    oeeReal: 0.28,
    oeeAlcanzable: 0.54,
    ptsPerdidos: 26,
    motivo: 'Cambio de formato en L14 (3 h). Día corto y mantenimiento programado a continuación.',
  },
  {
    of: 'OF-19-202509-0190',
    linea: 19,
    fecha: '2025-09-03',
    skuAnterior: 'DL13LTNN',
    skuActual: 'ED13LTNN',
    tipoCambio: 'cerveza',
    oeeReal: 0.41,
    oeeAlcanzable: 0.67,
    ptsPerdidos: 26,
    motivo: 'Cambio de cerveza dentro de 1/3 con incidencia de calidad en arranque.',
  },
  {
    of: 'OF-17-202506-0094',
    linea: 17,
    fecha: '2025-06-18',
    skuAnterior: 'ED13LTNN',
    skuActual: 'FR13LTNN',
    tipoCambio: 'cerveza',
    oeeReal: 0.49,
    oeeAlcanzable: 0.67,
    ptsPerdidos: 18,
    motivo: 'Cambio de cerveza con limpieza extendida por arranque de Free Damm.',
  },
  {
    of: 'OF-14-202508-0156',
    linea: 14,
    fecha: '2025-08-05',
    skuAnterior: 'ED13LTNN',
    skuActual: 'DL13LTNN',
    tipoCambio: 'mantenimiento',
    oeeReal: 0.32,
    oeeAlcanzable: 0.54,
    ptsPerdidos: 22,
    motivo: 'OF pegada a mantenimiento preventivo no consolidado.',
  },
];

async function main() {
  // Limpieza
  await prisma.planItem.deleteMany();
  await prisma.plan.deleteMany();
  await prisma.cambioIneficiente.deleteMany();
  await prisma.changeoverTime.deleteMany();
  await prisma.skuLineaBaseline.deleteMany();
  await prisma.oeeObservacion.deleteMany();
  await prisma.mantenimiento.deleteMany();
  await prisma.sku.deleteMany();

  // SKUs
  for (const s of SKUS) {
    await prisma.sku.create({ data: s });
  }

  // Baselines por SKU-línea. Cada SKU corre en sus líneas naturales.
  // Estrella Damm, Damm Lemon, Voll-Damm, Xibeca: en las 3 líneas.
  // Estrella Levante: L17/L19. La Fría: L19. Free/Daura/Inedit: L14.
  const matrix: Record<string, number[]> = {
    ED13LTNN: [14, 17, 19],
    ED12LTNN: [14, 17, 19],
    DL13LTNN: [14, 17, 19],
    DL12LTNN: [17, 19],
    EL13LTNN: [17, 19],
    EL12LTNN: [17, 19],
    LF13LTNN: [19],
    VL13LTNN: [14, 17, 19],
    VL12LTNN: [17, 19],
    XB13LTNN: [14, 17, 19],
    XB12LTNN: [14, 17, 19],
    FR13LTNN: [14],
    DD13LTNN: [14],
    IN13LTNN: [14],
  };

  let i = 0;
  for (const sku of SKUS) {
    const lineas = matrix[sku.codigo] ?? [];
    for (const linea of lineas) {
      const jitter = (Math.sin(i++ * 1.7) + 1) / 2; // 0..1 estable
      const b = baselineFor(linea, sku.formato, jitter);
      await prisma.skuLineaBaseline.create({
        data: {
          skuCodigo: sku.codigo,
          linea,
          oeeMediana: round3(b.mediana),
          oeeAlcanzable: round3(b.alcanzable),
          rateHlH: Math.round(b.rate),
          nRuns: 8 + Math.floor(jitter * 12),
        },
      });
      // observaciones para el explorador (n=20 por par)
      const obs = generaObservaciones(b.mediana, b.alcanzable);
      for (const o of obs) {
        await prisma.oeeObservacion.create({ data: { skuCodigo: sku.codigo, linea, oee: round3(o) } });
      }
    }
  }

  // Changeover matrix
  for (const c of CO) {
    await prisma.changeoverTime.create({
      data: { linea: c.linea, estadoOrigen: c.o, estadoDestino: c.d, minutos: c.min },
    });
  }

  // Peores cambios
  for (const p of PEORES) {
    await prisma.cambioIneficiente.create({ data: p });
  }

  // Mantenimientos: algunos días para penalizar el plan
  const mantos = [
    { linea: 14, dia: '2025-05-20', motivo: 'Preventivo paletizadora' },
    { linea: 17, dia: '2025-05-22', motivo: 'Cambio de bandeja' },
    { linea: 19, dia: '2025-05-21', motivo: 'Mantenimiento llenadora' },
  ];
  for (const m of mantos) await prisma.mantenimiento.create({ data: m });

  console.log('Seed OK');
}

function generaObservaciones(mediana: number, alcanzable: number): number[] {
  const out: number[] = [];
  // Distribución amplia: bajos por cambios malos, altos cerca del alcanzable.
  const peor = Math.max(0.18, mediana - 0.25);
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    // mezcla: 1/3 cerca de peor, 1/3 cerca de mediana, 1/3 cerca de alcanzable
    const base = i < 7 ? peor + t * 0.1 : i < 14 ? mediana - 0.05 + (t - 0.35) * 0.2 : alcanzable - 0.04 + (t - 0.7) * 0.12;
    const noise = (Math.sin(i * 2.9 + mediana * 31) + 1) * 0.04 - 0.04;
    out.push(Math.min(0.92, Math.max(0.15, base + noise)));
  }
  return out;
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
