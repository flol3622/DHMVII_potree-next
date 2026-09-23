import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueUrl, cellsNear, screenRadius, syncMaterial, tileSphere } from '../src/flai-tiles.js';

test('spatial query projects a closed polygon and retains pagination', () => {
  const url = new URL(catalogueUrl('https://example.org/pointclouds', [1, 2, 3, 4], ([x, y]) => [x * 10, y * 10], 2));
  assert.equal(url.searchParams.get('filter[geom]'), 'gi=10,20,30,20,30,40,10,40,10,20');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('order_by'), 'created_at');
});

test('catalogue cells cover the reach, nearest first', () => {
  const cells = cellsNear(5000, 5000, 1500, 4000);
  assert.equal(cells[0].key, '1,1');
  assert.deepEqual(cells.map((cell) => cell.key).sort(), ['0,0', '0,1', '1,0', '1,1']);
  assert.deepEqual(cellsNear(2000, 2000, 100, 4000).map((cell) => cell.key), ['0,0']);
});

test('tile LOD matches a Potree node of the same cube', () => {
  const sphere = tileSphere({ extent_3d: [0, 0, 10, 500, 500, 60] });
  assert.deepEqual([sphere.x, sphere.y, sphere.z], [250, 250, 35]);
  assert.ok(Math.abs(sphere.r - 433.01) < 0.01);
  const near = screenRadius(sphere, { x: 250, y: 250, z: 1035 }, 60, 800);
  const far = screenRadius(sphere, { x: 250, y: 250, z: 2035 }, 60, 800);
  assert.ok(near > far * 1.9);
  assert.equal(screenRadius(sphere, { x: 250, y: 250, z: 100 }, 60, 800), Infinity);
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
