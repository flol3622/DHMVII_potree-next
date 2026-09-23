// Tile catalogues for createTiledCopc. A catalogue provides either
//   query(bounds) -> Promise<Tile[]>   spatial lookup, called per `cellSize` cell, or
//   all()         -> Promise<Tile[]>   the complete list, loaded once.
// Tile = { id, url, name, extent: [minX, minY, minZ, maxX, maxY, maxZ] } in the
// overview's source coordinates. `tileSize` is the typical tile width in metres.
//
// flaiCatalogue queries Flai's API live; its CORS policy only admits some origins.
// cellIndexCatalogue reads a static copy of it, built at deploy time.

// Flai's public dataset API (https://hub.flai.ai). Its spatial filter takes Web
// Mercator coordinates, so each query rectangle is projected from `crs`.
export function flaiCatalogue({ datasetId, crs, cellSize = 4000, tileSize = 500, api = 'https://api.flai.ai/public' }) {
  const endpoint = `${api}/datasets/${datasetId}/pointclouds`;
  const project = (xy) => proj4(crs, 'EPSG:3857', xy);
  return {
    cellSize,
    tileSize,
    async query(bounds) {
      const tiles = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        const response = await fetch(flaiQueryUrl(endpoint, bounds, project, page));
        if (!response.ok) throw new Error(`Flai catalogue HTTP ${response.status}`);
        const data = await response.json();
        pages = data.pagination.total_pages;
        for (const item of data.items) {
          tiles.push({ id: item.path, url: `${item.datasource_host}/${item.path}`, name: item.filename, extent: item.extent_3d });
        }
      }
      return tiles;
    },
  };
}

export function flaiQueryUrl(endpoint, [minX, minY, maxX, maxY], project, page = 1) {
  const ring = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]];
  const url = new URL(endpoint);
  url.searchParams.set('filter[geom]', `gi=${ring.flatMap(project).join(',')}`);
  url.searchParams.set('order_by', 'created_at');
  url.searchParams.set('order_direction', 'desc');
  url.searchParams.set('page', String(page));
  return url.href;
}

// Groups tiles into `size` cells as compact [path, minX, minY, minZ, maxX, maxY, maxZ]
// rows, keyed "i_j". Used by scripts/build-tile-index.mjs.
export function groupTilesByCell(tiles, size) {
  const cells = new Map();
  for (const { path, extent } of tiles) {
    const row = [path, ...extent.map((value) => Math.round(value * 100) / 100)];
    for (let i = Math.floor(extent[0] / size); i <= Math.floor(extent[3] / size); i++) {
      for (let j = Math.floor(extent[1] / size); j <= Math.floor(extent[4] / size); j++) {
        const key = `${i}_${j}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(row);
      }
    }
  }
  return cells;
}

// A static per-cell index built by scripts/build-tile-index.mjs, for origins
// the Flai API's CORS policy does not allow. `url` is the index directory.
export function cellIndexCatalogue({ url, cellSize = 4000, tileSize = 500 }) {
  let meta;
  const base = url.replace(/\/$/, '');
  return {
    cellSize,
    tileSize,
    async query([minX, minY]) {
      meta ??= fetch(`${base}/meta.json`).then((response) => {
        if (!response.ok) throw new Error(`Tile index HTTP ${response.status}`);
        return response.json();
      }).then((data) => {
        if (data.cellSize !== cellSize) throw new Error(`Tile index cell size ${data.cellSize}, expected ${cellSize}`);
        return data;
      });
      const { host } = await meta.catch((error) => { meta = null; throw error; });
      const response = await fetch(`${base}/${Math.round(minX / cellSize)}_${Math.round(minY / cellSize)}.json`);
      if (response.status === 404) return []; // No tiles in this cell.
      if (!response.ok) throw new Error(`Tile index HTTP ${response.status}`);
      return (await response.json()).map(([path, ...extent]) => (
        { id: path, url: `${host}/${path}`, name: path.split('/').pop(), extent }
      ));
    },
  };
}

// A fixed list, e.g. a JSON index published next to self-hosted tiles.
export function staticCatalogue(tiles, { tileSize } = {}) {
  const list = tiles.map((tile) => ({ id: tile.id ?? tile.url, name: tile.name ?? tile.url.split('/').pop(), ...tile }));
  const widths = list.map(({ extent }) => extent[3] - extent[0]).sort((a, b) => a - b);
  return { tileSize: tileSize ?? widths[widths.length >> 1] ?? 500, all: async () => list };
}
