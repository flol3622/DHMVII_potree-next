// Builds a static, per-cell tile index from Flai's public catalogue API, for
// deployments whose origin the API's CORS policy does not allow (e.g. GitHub
// Pages). Tiles themselves still stream from Flai's Amazon S3 bucket.
//
//   node scripts/build-tile-index.mjs <out-dir> [datasetId]
//
// Output: <out-dir>/meta.json and <out-dir>/<i>_<j>.json per non-empty cell,
// read by cellIndexCatalogue() in src/tiled-copc/catalogues.js.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { groupTilesByCell } from '../src/tiled-copc/catalogues.js';

const [outDir, datasetId = 'b729323b-332c-46e7-878d-acac932b1013'] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: node scripts/build-tile-index.mjs <out-dir> [datasetId]');
  process.exit(1);
}

const CELL_SIZE = 4000;
const endpoint = `https://api.flai.ai/public/datasets/${datasetId}/pointclouds`;

async function page(number, attempt = 1) {
  try {
    const response = await fetch(`${endpoint}?page=${number}`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    if (attempt >= 4) throw new Error(`page ${number}: ${error.message}`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    return page(number, attempt + 1);
  }
}

const first = await page(1);
const pages = first.pagination.total_pages;
const items = [...first.items];
let next = 2;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next <= pages) items.push(...(await page(next++)).items);
}));
if (items.length !== first.pagination.total_items) {
  throw new Error(`expected ${first.pagination.total_items} tiles, got ${items.length}`);
}

const hosts = new Set(items.map((item) => item.datasource_host));
if (hosts.size !== 1) throw new Error(`expected one datasource_host, got ${[...hosts].join(', ')}`);

const cells = groupTilesByCell(items.map((item) => ({ path: item.path, extent: item.extent_3d })), CELL_SIZE);
await mkdir(outDir, { recursive: true });
for (const [key, tiles] of cells) await writeFile(path.join(outDir, `${key}.json`), JSON.stringify(tiles));
await writeFile(path.join(outDir, 'meta.json'), JSON.stringify({
  source: endpoint,
  generated: new Date().toISOString(),
  host: [...hosts][0],
  cellSize: CELL_SIZE,
  tiles: items.length,
  cells: cells.size,
}, null, 2));
console.log(`${items.length} tiles in ${cells.size} cells → ${outDir}`);
