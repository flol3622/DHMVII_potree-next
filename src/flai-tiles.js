// Flai's DHMV II overview and its full-resolution tiles form one virtual octree:
// the overview supplies the top levels, and every 500 m tile is a subtree that
// takes over where the overview's nodes reach tile size. The patched Potree
// traversal (`isSubtree`) gives each tile root the same screen-size test and
// priority as a child node. This module only decides which tiles are registered.

const CELL_SIZE = 4000; // Catalogue cache cell in metres; ~64 tiles, one API page.
const MAX_REACH = 15000;
const MAX_ACTIVE = 128;
const MAX_CACHED = 256;
const MAX_LOADING = 4;
const TILE_ROOT_RADIUS = (500 * Math.sqrt(3)) / 2; // Bounding sphere of a 500 m tile cube.

// Material settings mirrored from the overview, so tiles follow the Appearance
// and scene-tree controls of the single visible model.
const MATERIAL_KEYS = [
  'size', 'minSize', 'pointSizeType', 'shape', 'activeAttributeName', 'opacity',
  'heightMin', 'heightMax', 'elevationGradientRepat', 'gradient', 'matcap',
  'intensityGamma', 'intensityContrast', 'intensityBrightness',
  'rgbGamma', 'rgbContrast', 'rgbBrightness', 'backfaceCulling',
  'weightRGB', 'weightIntensity', 'weightElevation', 'weightClassification',
  'weightReturnNumber', 'weightSourceID',
];

// Flai's spatial filter uses the map's Web Mercator coordinates.
export function catalogueUrl(endpoint, bounds, project, page = 1) {
  const [minX, minY, maxX, maxY] = bounds;
  const ring = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]];
  const url = new URL(endpoint);
  url.searchParams.set('filter[geom]', `gi=${ring.flatMap(project).join(',')}`);
  url.searchParams.set('order_by', 'created_at');
  url.searchParams.set('order_direction', 'desc');
  url.searchParams.set('page', String(page));
  return url.href;
}

// Catalogue cells whose footprint lies within `reach` of (x, y), nearest first.
export function cellsNear(x, y, reach, size = CELL_SIZE) {
  const cells = [];
  for (let i = Math.floor((x - reach) / size); i <= Math.floor((x + reach) / size); i++) {
    for (let j = Math.floor((y - reach) / size); j <= Math.floor((y + reach) / size); j++) {
      const dx = Math.max(i * size - x, 0, x - (i + 1) * size);
      const dy = Math.max(j * size - y, 0, y - (j + 1) * size);
      const distance = Math.hypot(dx, dy);
      if (distance <= reach) cells.push({ key: `${i},${j}`, bounds: [i * size, j * size, (i + 1) * size, (j + 1) * size], distance });
    }
  }
  return cells.sort((a, b) => a.distance - b.distance);
}

// COPC roots are cubes around the tile bounds; this matches Potree's root sphere.
export function tileSphere(tile) {
  const [minX, minY, minZ, maxX, maxY, maxZ] = tile.extent_3d;
  const side = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2, r: (side * Math.sqrt(3)) / 2 };
}

// Same projection as Potree's node LOD test.
export function screenRadius(sphere, eye, fov, height) {
  const distance = Math.hypot(sphere.x - eye.x, sphere.y - eye.y, sphere.z - eye.z);
  if (distance < sphere.r) return Infinity;
  return (sphere.r * 0.5 * height) / (Math.tan((fov * Math.PI) / 360) * distance);
}

export function syncMaterial(from, to) {
  for (const key of MATERIAL_KEYS) {
    if (key in from && to[key] !== from[key]) to[key] = from[key];
  }
  const [lo, hi] = from.intensityRange;
  if (to.intensityRange[0] !== lo || to.intensityRange[1] !== hi) to.intensityRange = [lo, hi];
}

export function initializeFlaiTiles({ viewer, overview, center, endpoint, configure, status }) {
  const cells = new Map(); // key -> 'loading' | 'failed' | true
  const catalogue = new Map(); // path -> { tile, sphere }
  const clouds = new Map(); // path -> pointcloud
  const loading = new Set();
  let wanted = [];
  let failedAt = 0;
  let lastRun = 0;
  let closed = false;
  const project = (xy) => proj4('EPSG:31370', 'EPSG:3857', xy);

  const overviewSide = overview.pcoGeometry.boundingBox.max.x - overview.pcoGeometry.boundingBox.min.x;
  let levelOffset = null;
  overview.levelOffset = 0;

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

  async function loadCell({ key, bounds }) {
    cells.set(key, 'loading');
    try {
      for (let page = 1, pages = 1; page <= pages; page++) {
        const response = await fetch(catalogueUrl(endpoint, bounds, project, page));
        if (!response.ok) throw new Error(`Catalogue HTTP ${response.status}`);
        const data = await response.json();
        pages = data.pagination.total_pages;
        for (const tile of data.items) catalogue.set(tile.path, { tile, sphere: tileSphere(tile) });
      }
      cells.set(key, true);
    } catch (error) {
      console.error(error);
      cells.set(key, 'failed');
      failedAt = performance.now();
    }
  }

  async function loadTile(entry) {
    const { tile } = entry;
    loading.add(tile.path);
    try {
      const { pointcloud: cloud } = await Potree.loadPointCloud(`${tile.datasource_host}/${tile.path}`, tile.filename);
      if (closed) return;
      configure(cloud, tile.filename);
      cloud.isSubtree = true;
      cloud.pointBudget = Infinity;
      // Potree numbers levels per cloud; offset them to the overview's depth.
      const box = cloud.pcoGeometry.boundingBox;
      levelOffset ??= Math.round(Math.log2(overviewSide / (box.max.x - box.min.x)));
      cloud.levelOffset = levelOffset;
      syncMaterial(overview.material, cloud.material);
      // Added directly, not via scene.addPointCloud, so the scene tree keeps a
      // single entry for the whole model.
      viewer.scene.pointclouds.push(cloud);
      viewer.scene.scenePointCloud.add(cloud);
      clouds.set(tile.path, cloud);
    } catch (error) {
      console.error(error);
      entry.failed = true;
    } finally {
      loading.delete(tile.path);
      pump();
    }
  }

  function pump() {
    for (const entry of wanted) {
      if (loading.size >= MAX_LOADING) break;
      if (!clouds.has(entry.tile.path) && !loading.has(entry.tile.path) && !entry.failed) loadTile(entry);
    }
  }

  function inView(camera, s) {
    const e = camera.matrixWorldInverse.elements;
    const x = s.x - center.x, y = s.y - center.y, z = s.z;
    const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const tanV = Math.tan((camera.fov * Math.PI) / 360), tanH = tanV * camera.aspect;
    return vz < s.r
      && Math.abs(vy) <= -vz * tanV + s.r * Math.hypot(1, tanV)
      && Math.abs(vx) <= -vz * tanH + s.r * Math.hypot(1, tanH);
  }

  function refresh() {
    const camera = viewer.scene.getActiveCamera();
    if (!camera.isPerspectiveCamera) return;
    const height = viewer.renderer.domElement.clientHeight;
    const minNodeSize = viewer.getMinNodeSize();
    const eye = { x: camera.position.x + center.x, y: camera.position.y + center.y, z: camera.position.z };

    // Distance at which a tile root passes the LOD test, as a 3D reach.
    const reach = Math.min(MAX_REACH, (TILE_ROOT_RADIUS * 0.5 * height) / (Math.tan((camera.fov * Math.PI) / 360) * minNodeSize));
    const ground = Math.max(0, eye.z - 50);
    const horizontal = ground < reach ? Math.sqrt(reach ** 2 - ground ** 2) : -1;
    const needed = horizontal < 0 ? [] : cellsNear(eye.x, eye.y, horizontal);
    const retry = performance.now() - failedAt > 5000;
    for (const cell of needed.slice(0, 64)) {
      const state = cells.get(cell.key);
      if (state === undefined || (state === 'failed' && retry)) {
        if ([...cells.values()].filter((value) => value === 'loading').length >= 3) break;
        loadCell(cell);
      }
    }

    wanted = [];
    for (const entry of catalogue.values()) {
      entry.weight = screenRadius(entry.sphere, eye, camera.fov, height);
      if (entry.weight >= minNodeSize && inView(camera, entry.sphere)) wanted.push(entry);
    }
    wanted.sort((a, b) => b.weight - a.weight);
    // Like Potree's own node loading, do not fetch tiles the point budget would
    // cut anyway: stop below the largest loaded tile that drew nothing.
    const drawn = viewer.scene.pointclouds.reduce((sum, cloud) => sum + (cloud.visible ? cloud.numVisiblePoints || 0 : 0), 0);
    const starved = drawn > 0.95 * viewer.getPointBudget()
      && wanted.find((entry) => clouds.get(entry.tile.path)?.numVisibleNodes === 0);
    wanted = wanted.filter((entry) => !starved || entry.weight > starved.weight || clouds.has(entry.tile.path))
      .slice(0, MAX_ACTIVE);
    pump();

    if (clouds.size > MAX_CACHED) {
      const keep = new Set(wanted.map((entry) => entry.tile.path));
      const stale = [...clouds.keys()].filter((path) => !keep.has(path))
        .sort((a, b) => catalogue.get(a).weight - catalogue.get(b).weight);
      for (const path of stale.slice(0, clouds.size - MAX_CACHED)) {
        remove(clouds.get(path));
        clouds.delete(path);
      }
    }

    // The overview stops where tiles take over. If the catalogue cannot be read
    // for this view, it keeps its own deeper levels as a fallback.
    const failed = needed.some((cell) => cells.get(cell.key) === 'failed');
    overview.maxLevel = failed || levelOffset === null ? Infinity : levelOffset;
    const pending = wanted.filter((entry) => !clouds.has(entry.tile.path) && !entry.failed).length;
    status.textContent = failed
      ? 'Tile catalogue unavailable · showing overview detail · retrying'
      : wanted.length
        ? `DHMV II full resolution · ${wanted.length - pending}/${wanted.length} tiles${pending ? ' streaming' : ''}`
        : 'DHMV II · zoom in to stream full-resolution tiles';
  }

  viewer.addEventListener('update', () => {
    // Tiles are branches of the overview: same visibility and appearance.
    for (const cloud of clouds.values()) {
      cloud.visible = overview.visible;
      syncMaterial(overview.material, cloud.material);
    }
    if (closed || performance.now() - lastRun < 250) return;
    lastRun = performance.now();
    refresh();
  });
  window.addEventListener('pagehide', () => { closed = true; });
}
