// Tile catalogues for createTiledCopc. A catalogue provides either
//   query(bounds) -> Promise<Tile[]>   spatial lookup, called per `cellSize` cell, or
//   all()         -> Promise<Tile[]>   the complete list, loaded once.
// Tile = { id, url, name, extent: [minX, minY, minZ, maxX, maxY, maxZ] } in the
// overview's source coordinates. `tileSize` is the typical tile width in metres.

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

// A fixed list, e.g. a JSON index published next to self-hosted tiles.
export function staticCatalogue(tiles, { tileSize } = {}) {
  const list = tiles.map((tile) => ({ id: tile.id ?? tile.url, name: tile.name ?? tile.url.split('/').pop(), ...tile }));
  const widths = list.map(({ extent }) => extent[3] - extent[0]).sort((a, b) => a - b);
  return { tileSize: tileSize ?? widths[widths.length >> 1] ?? 500, all: async () => list };
}
