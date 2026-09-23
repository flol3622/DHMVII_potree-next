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

export function selectTiles(items, x, y, limit = 32) {
  return [...items].sort((a, b) => {
    const distance = (tile) => {
      const e = tile.extent_3d;
      return Math.hypot((e[0] + e[3]) / 2 - x, (e[1] + e[4]) / 2 - y);
    };
    return distance(a) - distance(b);
  }).slice(0, limit);
}

export function initializeFlaiTiles({ viewer, overview, center, endpoint, configure, status }) {
  const cache = new Map();
  let generation = 0;
  let controller;
  let lastKey = '';
  let timer;
  let lastRun = 0;
  const project = (xy) => proj4('EPSG:31370', 'EPSG:3857', xy);

  function remove(cloud) {
    viewer.scene.pointclouds = viewer.scene.pointclouds.filter((item) => item !== cloud);
    viewer.scene.scenePointCloud.remove(cloud);
    const tree = $('#jstree_scene').jstree(true);
    if (tree) {
      const entry = tree.get_json('#', { flat: true }).find((node) => node.data?.uuid === cloud.uuid);
      if (entry) tree.delete_node(entry.id);
    }
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
    viewer.scene.dispatchEvent({ type: 'pointcloud_removed', pointcloud: cloud });
  }

  async function refresh() {
    const view = viewer.scene.view;
    const pivot = view.getPivot();
    const x = pivot.x + center.x, y = pivot.y + center.y;
    const radius = Math.max(350, Math.min(1800, view.radius));
    const key = view.radius > 3000 ? 'overview' : `${Math.round(x / 150)},${Math.round(y / 150)},${Math.round(radius / 150)}`;
    if (key === lastKey) return;
    lastKey = key;
    const current = ++generation;
    controller?.abort();
    controller = new AbortController();
    overview.visible = true;
    for (const cloud of cache.values()) cloud.visible = false;
    if (key === 'overview') {
      status.textContent = 'Flai overview · zoom in for full-resolution tiles';
      return;
    }
    status.textContent = 'Loading full-resolution tile catalogue…';
    try {
      const bounds = [x - radius, y - radius, x + radius, y + radius];
      let items = [];
      for (let page = 1; page <= 10; page++) {
        const response = await fetch(catalogueUrl(endpoint, bounds, project, page), { signal: controller.signal });
        if (!response.ok) throw new Error(`Catalogue HTTP ${response.status}`);
        const data = await response.json();
        items.push(...data.items);
        if (page >= data.pagination.total_pages) break;
        if (page === 10) throw new Error('Too many tiles; zoom in further');
      }
      if (current !== generation) return;
      const tiles = selectTiles(items, x, y);
      const wanted = new Set(tiles.map((tile) => tile.path));
      for (const [path, cloud] of cache) {
        if (!wanted.has(path)) { remove(cloud); cache.delete(path); }
      }
      // Load headers sequentially to avoid flooding the host while navigating.
      let ready = 0;
      for (const tile of tiles) {
        if (current !== generation) return;
        let cloud = cache.get(tile.path);
        if (!cloud) {
          const url = `${tile.datasource_host}/${tile.path}`;
          const event = await Potree.loadPointCloud(url, tile.filename);
          cloud = event.pointcloud;
          if (current !== generation) { remove(cloud); return; }
          configure(cloud, tile.filename);
          cloud.minimumNodePixelSize = 1;
          // Respect the user's global point budget without a hidden per-tile cap.
          cloud.pointBudget = Infinity;
          cloud.material.pointSizeType = Potree.PointSizeType.FIXED;
          cloud.material.size = 2;
          viewer.scene.addPointCloud(cloud);
          cache.set(tile.path, cloud);
        }
        cloud.visible = true;
        status.textContent = `Full-resolution tiles · ${++ready}/${tiles.length} loaded`;
      }
      overview.visible = tiles.length === 0;
      status.textContent = tiles.length
        ? `Full-resolution tiles · ${ready}${items.length > tiles.length ? ' nearest · zoom in for wider coverage' : ' loaded'}`
        : 'No full-resolution tiles here · showing overview';
    } catch (error) {
      if (current !== generation || error.name === 'AbortError') return;
      status.textContent = `Detail unavailable · ${error.message} · move to retry`;
      lastKey = '';
      lastRun = performance.now() + 4000;
      console.error(error);
    }
  }
  viewer.addEventListener('update', () => {
    if (performance.now() - lastRun < 700) return;
    lastRun = performance.now();
    clearTimeout(timer);
    timer = setTimeout(refresh, 100);
  });
  window.addEventListener('pagehide', () => { ++generation; controller?.abort(); clearTimeout(timer); });
}
