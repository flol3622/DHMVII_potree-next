const DEFAULT_POINT_CLOUD_PATH = "pointclouds/test.copc.laz";

function resolvePointCloudUrl(value) {
  const configuredUrl = value?.trim() || DEFAULT_POINT_CLOUD_PATH;
  return new URL(configuredUrl, document.baseURI).href;
}

export const POINT_CLOUD_URL = resolvePointCloudUrl(import.meta.env.VITE_POINT_CLOUD_URL);
export const POINT_CLOUD_NAME = "DHMV test tile";
export const ELEVATION_RANGE = Object.freeze([3, 84]);

export const MAP_TILE_URL =
  import.meta.env.VITE_MAP_TILE_URL?.trim() ||
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const GEOCODER_URL =
  import.meta.env.VITE_GEOCODER_URL?.trim() ||
  "https://photon.komoot.io/api/";

export const CROP = Object.freeze({
  minX: 105000,
  minY: 193500,
  maxX: 105499.99,
  maxY: 193999.99,
});

export const CENTER = Object.freeze({
  x: (CROP.minX + CROP.maxX) / 2,
  y: (CROP.minY + CROP.maxY) / 2,
});

export const INITIAL_VIEW = Object.freeze({
  position: [0, -700, 500],
  target: [0, 0, 40],
});
