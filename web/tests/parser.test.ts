import { readFileSync } from 'node:fs';
import { parseDiarioHl } from '../src/server/parser';

const buf = readFileSync(new URL('../sample/Diario_Hl_Planif.xlsx', import.meta.url));
const items = parseDiarioHl(buf);

if (!items.length) {
  console.error('FAIL: parser returned 0 items');
  process.exit(1);
}

const lineas = new Set(items.map((i) => i.linea));
const dias = new Set(items.map((i) => i.dia));
const skus = new Set(items.map((i) => i.sku));

console.log('parsed_items:', items.length);
console.log('lineas:', [...lineas].sort());
console.log('dias:', [...dias].sort());
console.log('skus_distinct:', skus.size);
console.log('sample[0..3]:', items.slice(0, 3));

// Aserciones mínimas: hay al menos 3 líneas (14, 17, 19) y varios días
const must = [14, 17, 19].every((l) => lineas.has(l));
if (!must) {
  console.error('FAIL: missing one of expected lines 14/17/19');
  process.exit(1);
}
if (dias.size < 3) {
  console.error('FAIL: expected several days');
  process.exit(1);
}
console.log('OK');
