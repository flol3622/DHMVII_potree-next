// Tiled COPC: an overview COPC plus a catalogue of full-resolution COPC tiles,
// shown in Potree as one model. The approach follows Flai's Lidar Hub viewer:
// a quadtree over tile footprints, and an overview that hides its points where
// a loaded tile covers it. Unlike a fixed "nearest N" tile set, each tile is a
// subtree of one octree: the patched Potree traversal (`isSubtree`) gives its
// root the same screen-size test, priority and point budget as a child node.
//
// Requires the local patches in public/vendor/potree/potree.js:
//   pointcloud.isSubtree, pointcloud.skipNode(node), material.maskBoxes.

import { Quadtree } from './quadtree.js';
import { cellsNear, cornersCovered, screenRadius, sphereInView, syncMaterial, tileSphere } from './lod.js';

export { flaiCatalogue, staticCatalogue } from './catalogues.js';

const MASK_CAPACITY = 64; // Matches num_mask_boxes in the Potree patch.

export function createTiledCopc({
  viewer,
  overview,
  catalogue,
  maxActive = MASK_CAPACITY,
  maxCached = 256,
  maxLoading = 4,
  maxReach = 15000,
  onStatus = () => {},
}) {
  // Node boxes and tile extents are in source coordinates; world = source + position.
  const origin = overview.position.clone();
  const box = overview.pcoGeometry.boundingBox;
  const tight = overview.pcoGeometry.tightBoundingBox ?? box;
  const groundZ = (tight.min.z + tight.max.z) / 2;
  const index = new Quadtree([box.min.x, box.min.y, box.max.x, box.max.y]);
  const cells = new Map(); // key -> 'loading' | 'failed' | 'done'
  const entries = new Map(); // tile id -> { tile, sphere, rect, weight }
  const clouds = new Map(); // tile id -> pointcloud
  const loading = new Set();
  let wanted = [];
  let ready = []; // World-space rects of tiles that are drawing.
  let levelOffset = null;
  let failedAt = -Infinity;
  let lastRun = 0;
  let disposed = false;
  const tileRadius = (catalogue.tileSize * Math.sqrt(3)) / 2;

  overview.levelOffset = 0;
  overview.material.maskBoxes = [];
  // Skip overview nodes whose footprint is entirely replaced by drawing tiles.
  overview.skipNode = (node) => {
    if (!ready.length) return false;
    const b = node.getBoundingBox();
    if (b.max.x - b.min.x > catalogue.tileSize) return false;
    return cornersCovered([b.min.x + origin.x, b.min.y + origin.y, b.max.x + origin.x, b.max.y + origin.y], ready);
  };

  function add(tiles) {
    for (const tile of tiles) {
      if (entries.has(tile.id)) continue;
      const [minX, minY, , maxX, maxY] = tile.extent;
      const entry = { tile, sphere: tileSphere(tile.extent), rect: [minX, minY, maxX, maxY], weight: 0 };
      entries.set(tile.id, entry);
      index.insert(entry, entry.rect);
    }
  }

  async function loadCell(key, load) {
    cells.set(key, 'loading');
    try {
      add(await load());
      cells.set(key, 'done');
    } catch (error) {
      console.error(error);
      cells.set(key, 'failed');
      failedAt = performance.now();
    }
  }

  async function loadTile(entry) {
    const { tile } = entry;
    loading.add(tile.id);
    try {
      const { pointcloud: cloud } = await Potree.loadPointCloud(tile.url, tile.name);
      if (disposed) return;
      cloud.name = tile.name;
      cloud.position.copy(origin);
      cloud.isSubtree = true;
      cloud.pointBudget = Infinity;
      // Potree numbers levels per cloud; offset them to the overview's depth.
      const size = cloud.pcoGeometry.boundingBox.max.x - cloud.pcoGeometry.boundingBox.min.x;
      levelOffset ??= Math.max(0, Math.round(Math.log2((box.max.x - box.min.x) / size)));
      cloud.levelOffset = levelOffset;
      syncMaterial(overview.material, cloud.material);
      // Added directly, not via scene.addPointCloud, so the scene tree keeps a
      // single entry for the whole model.
      viewer.scene.pointclouds.push(cloud);
      viewer.scene.scenePointCloud.add(cloud);
      clouds.set(tile.id, cloud);
    } catch (error) {
      console.error(error);
      entry.failed = true;
    } finally {
      loading.delete(tile.id);
      pump();
    }
  }

  function remove(cloud) {
    viewer.scene.pointclouds = viewer.scene.pointclouds.filter((item) => item !== cloud);
    viewer.scene.scenePointCloud.remove(cloud);
    const visit = (node) => {
      if (!node) return;
      Object.values(node.children || {}).forEach(visit);
      // A detached node can still have a decoder in flight. Release it once done.
      if (node.loading) { setTimeout(() => visit(node), 500); return; }
      node.dispose?.();
      node.geometry?.dispose();
      node.geometry = null;
      Potree.lru.remove(node);
    };
    visit(cloud.pcoGeometry.root);
    cloud.material.dispose();
  }

  function pump() {
    for (const entry of wanted) {
      if (loading.size >= maxLoading) break;
      if (!clouds.has(entry.tile.id) && !loading.has(entry.tile.id) && !entry.failed) loadTile(entry);
    }
  }

  function refresh() {
    const camera = viewer.scene.getActiveCamera();
    if (!camera.isPerspectiveCamera) return;
    const height = viewer.renderer.domElement.clientHeight;
    const minNodeSize = viewer.getMinNodeSize();
    const eye = { x: camera.position.x - origin.x, y: camera.position.y - origin.y, z: camera.position.z - origin.z };

    // Horizontal distance within which a tile root can pass the LOD test.
    const reach = Math.min(maxReach, (tileRadius * 0.5 * height) / (Math.tan((camera.fov * Math.PI) / 360) * minNodeSize));
    const ground = Math.max(0, eye.z - groundZ);
    const horizontal = ground < reach ? Math.sqrt(reach ** 2 - ground ** 2) : -1;

    let failed = false;
    if (catalogue.all) {
      if (!cells.has('all') || (cells.get('all') === 'failed' && performance.now() - failedAt > 5000)) loadCell('all', catalogue.all);
      failed = cells.get('all') === 'failed';
    } else if (horizontal >= 0) {
      const needed = cellsNear(eye.x, eye.y, horizontal, catalogue.cellSize).slice(0, 64);
      // At most 3 requests in flight, and none for 5 s after a failure.
      let slots = performance.now() - failedAt < 5000 ? 0 : 3 - [...cells.values()].filter((value) => value === 'loading').length;
      for (const { key, bounds } of needed) {
        if (slots <= 0) break;
        const state = cells.get(key);
        if (state === 'loading' || state === 'done') continue;
        slots--;
        loadCell(key, () => catalogue.query(bounds));
      }
      failed = needed.some(({ key }) => cells.get(key) === 'failed');
    }

    wanted = [];
    if (horizontal >= 0) {
      for (const entry of index.query([eye.x - horizontal, eye.y - horizontal, eye.x + horizontal, eye.y + horizontal])) {
        entry.weight = screenRadius(entry.sphere, eye, camera.fov, height);
        const { x, y, z, r } = entry.sphere;
        if (entry.weight >= minNodeSize && sphereInView(camera, { x: x + origin.x, y: y + origin.y, z: z + origin.z, r })) wanted.push(entry);
      }
    }
    wanted.sort((a, b) => b.weight - a.weight);
    // Like Potree's own node loading, do not fetch tiles the point budget would
    // cut anyway: stop below the largest loaded tile that drew nothing.
    const drawn = viewer.scene.pointclouds.reduce((sum, cloud) => sum + (cloud.visible ? cloud.numVisiblePoints || 0 : 0), 0);
    const starved = drawn > 0.95 * viewer.getPointBudget()
      && wanted.find((entry) => clouds.get(entry.tile.id)?.numVisibleNodes === 0);
    wanted = wanted.filter((entry) => !starved || entry.weight > starved.weight || clouds.has(entry.tile.id))
      .slice(0, maxActive);
    pump();

    if (clouds.size > maxCached) {
      const keep = new Set(wanted.map((entry) => entry.tile.id));
      const stale = [...clouds.keys()].filter((id) => !keep.has(id))
        .sort((a, b) => entries.get(a).weight - entries.get(b).weight);
      for (const id of stale.slice(0, clouds.size - maxCached)) {
        remove(clouds.get(id));
        clouds.delete(id);
      }
    }

    const pending = wanted.filter((entry) => !clouds.has(entry.tile.id) && !entry.failed).length;
    onStatus({ wanted: wanted.length, loaded: wanted.length - pending, drawing: ready.length, failed });
  }

  function onUpdate() {
    // Tiles are branches of the overview: same visibility and appearance.
    const drawing = [];
    for (const [id, cloud] of clouds) {
      cloud.visible = overview.visible;
      syncMaterial(overview.material, cloud.material);
      // A tile replaces the overview once its root is on screen.
      if (cloud.visible && cloud.numVisibleNodes > 0 && cloud.root?.isTreeNode()) drawing.push(entries.get(id));
    }
    drawing.sort((a, b) => b.weight - a.weight);
    ready = drawing.slice(0, MASK_CAPACITY).map(({ rect }) => [rect[0] + origin.x, rect[1] + origin.y, rect[2] + origin.x, rect[3] + origin.y]);
    overview.material.maskBoxes = ready.flat();

    if (performance.now() - lastRun < 250) return;
    lastRun = performance.now();
    refresh();
  }

  viewer.addEventListener('update', onUpdate);

  return {
    get tiles() { return [...clouds.values()]; },
    dispose() {
      disposed = true;
      viewer.removeEventListener('update', onUpdate);
      for (const cloud of clouds.values()) remove(cloud);
      clouds.clear();
      delete overview.skipNode;
      overview.material.maskBoxes = null;
    },
  };
}
