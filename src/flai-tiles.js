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

  // The overview's large adaptive splats cover the finer tiles. While detail is
  // active, draw it as thin background points and restore it when zooming out.
  const overviewStyle = {
    size: overview.material.size,
    pointSizeType: overview.material.pointSizeType,
    minimumNodePixelSize: overview.minimumNodePixelSize,
  };
  function setOverviewMode(mode) {
    overview.visible = mode !== 'hidden';
    const background = mode !== 'full';
    overview.material.size = background ? 1 : overviewStyle.size;
    overview.material.pointSizeType = background ? Potree.PointSizeType.FIXED : overviewStyle.pointSizeType;
    overview.minimumNodePixelSize = background ? 150 : overviewStyle.minimumNodePixelSize;
  }

  async function load(tile, current) {
    const url = `${tile.datasource_host}/${tile.path}`;
    const { pointcloud: cloud } = await Potree.loadPointCloud(url, tile.filename);
    if (current !== generation) { remove(cloud); return null; }
    configure(cloud, tile.filename);
    cloud.minimumNodePixelSize = 1;
    // Respect the user's global point budget without a hidden per-tile cap.
    cloud.pointBudget = Infinity;
    cloud.material.pointSizeType = Potree.PointSizeType.FIXED;
    cloud.material.size = 2;
    viewer.scene.addPointCloud(cloud);
    cache.set(tile.path, cloud);
    return cloud;
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
    if (key === 'overview') {
      setOverviewMode('full');
      for (const cloud of cache.values()) cloud.visible = false;
      status.textContent = 'Flai overview · zoom in for full-resolution tiles';
      return;
    }
    // Keep already loaded tiles on screen while the catalogue is queried.
    setOverviewMode('background');
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
      if (!tiles.length) {
        setOverviewMode('full');
        status.textContent = 'No full-resolution tiles here · showing overview';
        return;
      }
      // Nearest tiles first, a few at a time, so the view centre sharpens quickly
      // without flooding the host.
      let ready = 0;
      const queue = [...tiles];
      const report = () => { status.textContent = `Full-resolution tiles · ${ready}/${tiles.length} loaded`; };
      const worker = async () => {
        for (let tile; (tile = queue.shift());) {
          if (current !== generation) return;
          const cloud = cache.get(tile.path) || await load(tile, current);
          if (!cloud) return;
          cloud.visible = true;
          ready++;
          report();
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      if (current !== generation) return;
      // Once every tile in the query is loaded, the overview adds nothing.
      const complete = items.length === tiles.length;
      setOverviewMode(complete ? 'hidden' : 'background');
      status.textContent = `Full-resolution tiles · ${ready}${complete ? ' loaded' : ' nearest · zoom in for wider coverage'}`;
    } catch (error) {
      if (current !== generation || error.name === 'AbortError') return;
      setOverviewMode('full');
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
