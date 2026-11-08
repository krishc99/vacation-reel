// Builds public/geo/places.tsv (offline place names for captions) from GeoNames
// cities1000.txt (CC BY 4.0, https://download.geonames.org/export/dump/).
// Usage: node scripts/places.mjs path/to/cities1000.txt
// Keeps towns with ≥ 5000 people: name, country code, lat, lon, log10(population).
import { readFileSync, writeFileSync } from 'node:fs';

const MIN_POP = 5000;
const rows = readFileSync(process.argv[2], 'utf8').split('\n');
const out = ['# GeoNames cities (pop >= 5000), CC BY 4.0, geonames.org. name\tcc\tlat\tlon\tlog10pop'];
for (const line of rows) {
  const f = line.split('\t');
  const pop = Number(f[14]);
  if (!(pop >= MIN_POP)) continue;
  out.push([f[1], f[8], Number(f[4]).toFixed(2), Number(f[5]).toFixed(2), Math.log10(pop).toFixed(1)].join('\t'));
}
writeFileSync('public/geo/places.tsv', out.join('\n') + '\n');
console.log(`${out.length - 1} places`);
