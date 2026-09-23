import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogueUrl, selectTiles } from '../src/flai-tiles.js';

test('spatial query projects a closed polygon and retains pagination', () => {
  const url = new URL(catalogueUrl('https://example.org/pointclouds', [1, 2, 3, 4], ([x, y]) => [x * 10, y * 10], 2));
  assert.equal(url.searchParams.get('filter[geom]'), 'gi=10,20,30,20,30,40,10,40,10,20');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(url.searchParams.get('order_by'), 'created_at');
});

test('tile budget prioritizes nearest bounds without mutating the catalogue', () => {
  const far = { extent_3d: [900, 900, 0, 1000, 1000, 50] };
  const near = { extent_3d: [0, 0, 0, 100, 100, 50] };
  const items = [far, near];
  assert.deepEqual(selectTiles(items, 50, 50, 1), [near]);
  assert.deepEqual(items, [far, near]);
});
