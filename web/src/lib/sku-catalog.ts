export type SkuFamily =
  | 'lager'
  | 'sin-alcohol'
  | 'tostada'
  | 'gluten-free'
  | 'aromatizada'
  | 'especial'
  | 'otra';

export type SkuMeta = {
  brand: string;
  variant?: string;
  format: string;
  description: string;
  family: SkuFamily;
  color: string;
};

const lager: SkuFamily = 'lager';
const sinAlcohol: SkuFamily = 'sin-alcohol';
const tostada: SkuFamily = 'tostada';
const gluten: SkuFamily = 'gluten-free';
const aromatizada: SkuFamily = 'aromatizada';
const especial: SkuFamily = 'especial';

const ESTRELLA = '#2563eb';
const FREE = '#19c37d';
const VOLL = '#92400e';
const DAURA = '#16a34a';
const TURIA = '#b91c1c';
const VICTORIA = '#f59e0b';
const XIBECA = '#0ea5e9';
const KELER = '#0369a1';
const LIMON = '#facc15';
const INEDIT = '#7c3aed';
const SKOL = '#d97706';
const BOCK = '#3f3f46';

export const SKU_CATALOG: Record<string, SkuMeta> = {
  // Estrella Damm — la lager mediterránea de Damm
  ED12LN: { brand: 'Estrella Damm', format: '33cl lata', description: 'La lager clásica mediterránea: maíz, cebada y arroz, suave y refrescante.', family: lager, color: ESTRELLA },
  ED12LNF: { brand: 'Estrella Damm', variant: 'pack familiar', format: '33cl lata · multipack', description: 'Mismo perfil de la lager Estrella Damm, en formato multipack para distribución.', family: lager, color: ESTRELLA },
  ED13LCN: { brand: 'Estrella Damm', format: '33cl lata', description: 'Lager Estrella Damm — 5,4% vol., perfil maltoso suave.', family: lager, color: ESTRELLA },
  ED13LTNN: { brand: 'Estrella Damm', variant: 'nueva receta', format: '33cl lata', description: 'Lager Estrella Damm para mercados exteriores (etiquetado internacional).', family: lager, color: ESTRELLA },

  // Estrella + variantes premium (Inèdit, Export)
  EN12B24I: { brand: 'Estrella Damm', variant: 'edición premium', format: '33cl · pack 24', description: 'Variante premium de la familia Estrella Damm, formato pack 24.', family: especial, color: ESTRELLA },
  EN1324BI: { brand: 'Estrella Damm', variant: 'edición premium', format: '33cl · pack 24', description: 'Variante premium de Estrella Damm en pack 24, perfil más maltoso.', family: especial, color: ESTRELLA },
  ENB13LBF: { brand: 'Estrella Damm', variant: 'barril / familiar', format: '33cl lata', description: 'Línea Estrella Damm para canal HORECA, lata de 33cl.', family: lager, color: ESTRELLA },
  EX12LB24: { brand: 'Inèdit', format: '33cl · pack 24', description: 'Inèdit Damm — coupage de lager y trigo, creada con elBulli, cítrica y especiada.', family: especial, color: INEDIT },
  EX12LBN: { brand: 'Inèdit', format: '33cl', description: 'Inèdit Damm — coupage de cebada y trigo, perfil aromático complejo.', family: especial, color: INEDIT },
  EX1324NB: { brand: 'Inèdit', format: '33cl · pack 24', description: 'Inèdit Damm en pack 24, gastronómica, suave en boca con notas cítricas.', family: especial, color: INEDIT },

  // Free Damm — la sin alcohol de Damm
  FDT13LT: { brand: 'Free Damm', variant: 'sin alcohol', format: '33cl lata', description: 'Cerveza sin alcohol (0,0%) elaborada por fermentación detenida — perfil maltoso y refrescante.', family: sinAlcohol, color: FREE },
  FD13LTNN: { brand: 'Free Damm', variant: 'sin alcohol', format: '33cl lata', description: 'Free Damm sin alcohol — 0,0%, sabor pleno con cuerpo de cerveza tradicional.', family: sinAlcohol, color: FREE },
  FDL13LN: { brand: 'Free Damm Limón', variant: 'sin alcohol · limón', format: '33cl lata', description: 'Free Damm con un toque de limón mediterráneo, 0,0% vol.', family: aromatizada, color: LIMON },

  // Voll-Damm — la doble malta tostada
  VO12LTN: { brand: 'Voll-Damm', variant: 'doble malta', format: '33cl lata', description: 'Doble malta de Damm — más cuerpo, más alcohol (7,2%), tonos tostados y caramelo.', family: tostada, color: VOLL },
  VO13LT: { brand: 'Voll-Damm', variant: 'doble malta', format: '33cl lata', description: 'Voll-Damm — cerveza de doble malta, intensa y maltosa, 7,2% vol.', family: tostada, color: VOLL },
  VO13LTMP: { brand: 'Voll-Damm', variant: 'doble malta · multipack', format: '33cl lata · pack', description: 'Voll-Damm en multipack para distribución masiva, mismo perfil intenso.', family: tostada, color: VOLL },

  // Daura — sin gluten
  DL12LT: { brand: 'Daura Damm', variant: 'sin gluten', format: '33cl lata', description: 'Lager Damm apta para celíacos — gluten <3 ppm, perfil seco y refrescante.', family: gluten, color: DAURA },
  DL13LT: { brand: 'Daura Damm', variant: 'sin gluten', format: '33cl lata', description: 'Daura Damm — la cerveza sin gluten de la casa, lager clásica mediterránea.', family: gluten, color: DAURA },

  // Turia — la "rubia" del Mediterráneo, marca valenciana del grupo
  TU13LTN: { brand: 'Turia', variant: 'mârzen tostada', format: '33cl lata', description: 'Turia — cerveza tostada estilo Märzen, suave, valenciana de origen.', family: tostada, color: TURIA },
  TUP13LT: { brand: 'Turia', variant: 'mârzen tostada · pack', format: '33cl lata · pack', description: 'Turia en formato pack — tostada mediterránea, color cobrizo.', family: tostada, color: TURIA },

  // Victoria — la "Malagueña" tradicional
  VI12LTW: { brand: 'Victoria', format: '33cl lata', description: 'Victoria — la lager malagueña tradicional, ligera y amable, 4,8% vol.', family: lager, color: VICTORIA },
  VI12LTX: { brand: 'Victoria', variant: 'export', format: '33cl lata', description: 'Victoria en formato export, perfil lager dorado, fácil de beber.', family: lager, color: VICTORIA },

  // Xibeca — la cerveza popular catalana del grupo
  XI13L12M: { brand: 'Xibeca', format: '33cl lata · pack 12', description: 'Xibeca — lager catalana popular, refrescante, formato familiar pack 12.', family: lager, color: XIBECA },
  XI13LTN: { brand: 'Xibeca', format: '33cl lata', description: 'Xibeca — la lager económica y refrescante de Damm para el día a día.', family: lager, color: XIBECA },
  XI13P24M: { brand: 'Xibeca', format: '33cl lata · pack 24', description: 'Xibeca en pack 24 — lager de consumo masivo, perfil ligero.', family: lager, color: XIBECA },

  // Keler — la cerveza vasca del grupo
  KE13LTNN: { brand: 'Keler', format: '33cl lata', description: 'Keler — cerveza vasca con carácter tostado, parte de la familia Damm desde 1985.', family: tostada, color: KELER },
  KE13PL12: { brand: 'Keler', format: '33cl lata · pack 12', description: 'Keler en pack 12 — tostada vasca con notas a caramelo.', family: tostada, color: KELER },

  // LC — variantes ligeras / con limón / Skol
  LC12LTW: { brand: 'Skol', variant: 'ligera', format: '33cl lata', description: 'Skol — lager ligera, baja graduación, refrescante.', family: lager, color: SKOL },
  LC13LTNN: { brand: 'Skol', variant: 'ligera', format: '33cl lata', description: 'Skol — lager ligera mediterránea de bajo alcohol.', family: lager, color: SKOL },

  // SK — Skol (otro código del mismo paraguas)
  SK13LN: { brand: 'Skol', format: '33cl lata', description: 'Skol — lager económica de consumo masivo, perfil suave.', family: lager, color: SKOL },

  // ID — Identidades varias (probablemente Bock o variantes)
  ID12LBN: { brand: 'Damm', variant: 'edición especial', format: '33cl lata', description: 'Edición especial Damm — perfil personalizado para distribución específica.', family: especial, color: BOCK },

  // 3BN — Bock Damm
  '3BNMSL20': { brand: 'Bock-Damm', variant: 'negra tostada', format: '33cl lata', description: 'Bock-Damm — cerveza negra estilo munich, tostada y maltosa, 5,4%.', family: tostada, color: BOCK },
  '3BNZFLB1': { brand: 'Bock-Damm', variant: 'negra tostada', format: '33cl lata', description: 'Bock-Damm — cerveza negra, color caoba, tonos a regaliz y café.', family: tostada, color: BOCK },
};

export const SKU_FAMILY_LABEL: Record<SkuFamily, string> = {
  lager: 'Lager mediterránea',
  'sin-alcohol': 'Sin alcohol (0,0%)',
  tostada: 'Tostada / doble malta',
  'gluten-free': 'Sin gluten',
  aromatizada: 'Aromatizada',
  especial: 'Especialidad / premium',
  otra: 'Otra',
};

export function lookupSku(code: string | null | undefined): SkuMeta {
  if (!code) {
    return {
      brand: 'Sin bloque',
      format: '—',
      description: 'No hay un bloque activo en esta línea en este momento.',
      family: 'otra',
      color: '#94a3b8',
    };
  }
  const hit = SKU_CATALOG[code];
  if (hit) return hit;
  return {
    brand: 'Damm',
    format: 'sin formato registrado',
    description: `SKU sin descripción en el catálogo (${code}). Pertenece al portfolio de Damm pero aún no está mapeado.`,
    family: 'otra',
    color: '#64748b',
  };
}
