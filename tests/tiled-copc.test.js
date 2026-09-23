import test from 'node:test';
import assert from 'node:assert/strict';
import { Quadtree } from '../src/tiled-copc/quadtree.js';
import { cellsNear, cornersCovered, screenRadius, syncMaterial, tileSphere } from '../src/tiled-copc/lod.js';
import { flaiQueryUrl, staticCatalogue } from '../src/tiled-copc/catalogues.js';

test('Flai query projects a closed polygon and retains pagination', () => {
  const url = new URL(flaiQueryUrl('https://example.org/pointclouds', [1, 2, 3, 4], ([x, y]) => [x * 10, y * 10], 2));
  assert.equal(url.searchParams.get('filter[geom]'), 'gi=10,20,30,20,30,40,10,40,10,20');
  assert.equal(url.searchParams.get('page'), '2');
});

test('static catalogue fills ids and names and infers tile size', async () => {
  const catalogue = staticCatalogue([
    { url: 'https://x/a.copc.laz', extent: [0, 0, 0, 500, 500, 10] },
    { url: 'https://x/b.copc.laz', extent: [500, 0, 0, 1000, 500, 10] },
  ]);
  assert.equal(catalogue.tileSize, 500);
  assert.deepEqual((await catalogue.all()).map((tile) => [tile.id, tile.name]),
    [['https://x/a.copc.laz', 'a.copc.laz'], ['https://x/b.copc.laz', 'b.copc.laz']]);
});

test('quadtree finds items across subdivisions and outside its bounds', () => {
  const tree = new Quadtree([0, 0, 1000, 1000], 2);
  for (let i = 0; i < 10; i++) tree.insert(`t${i}`, [i * 100, i * 100, i * 100 + 150, i * 100 + 150]);
  tree.insert('outside', [5000, 5000, 5100, 5100]);
  assert.ok(tree.children);
  assert.deepEqual([...tree.query([120, 120, 180, 180])].sort(), ['t0', 't1']);
  assert.deepEqual([...tree.query([5050, 5050, 5060, 5060])], ['outside']);
});

test('catalogue cells cover the reach, nearest first', () => {
  const cells = cellsNear(5000, 5000, 1500, 4000);
  assert.equal(cells[0].key, '1,1');
  assert.deepEqual(cells.map((cell) => cell.key).sort(), ['0,0', '0,1', '1,0', '1,1']);
});

test('tile LOD matches a Potree node of the same cube', () => {
  const sphere = tileSphere([0, 0, 10, 500, 500, 60]);
  assert.deepEqual([sphere.x, sphere.y, sphere.z], [250, 250, 35]);
  assert.ok(Math.abs(sphere.r - 433.01) < 0.01);
  const near = screenRadius(sphere, { x: 250, y: 250, z: 1035 }, 60, 800);
  const far = screenRadius(sphere, { x: 250, y: 250, z: 2035 }, 60, 800);
  assert.ok(near > far * 1.9);
  assert.equal(screenRadius(sphere, { x: 250, y: 250, z: 100 }, 60, 800), Infinity);
});

test('overview nodes are skipped only when every corner is under a tile', () => {
  const tiles = [[0, 0, 500, 500], [500, 0, 1000, 500], [0, 500, 500, 1000], [500, 500, 1000, 1000]];
  assert.equal(cornersCovered([250, 250, 700, 700], tiles), true);
  assert.equal(cornersCovered([250, 250, 700, 700], tiles.slice(0, 3)), false);
});

test('tiles mirror the overview material without redundant writes', () => {
  const from = { size: 2, activeAttributeName: 'rgba', intensityRange: [0, 300] };
  const writes = [];
  const to = new Proxy({ size: 1, activeAttributeName: 'rgba', intensityRange: [0, 300] }, {
    set(target, key, value) { writes.push(key); target[key] = value; return true; },
  });
  syncMaterial(from, to);
  assert.deepEqual(writes, ['size']);
});
