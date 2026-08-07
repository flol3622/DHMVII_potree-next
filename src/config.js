const DEFAULT_POINT_CLOUD_PATH = "pointclouds/rawpoints_flat_BE.copc.laz";
const TEST_POINT_CLOUD_PATH = "pointclouds/test.copc.laz";

function resolvePointCloudUrl(value) {
  const configuredUrl = value?.trim() || DEFAULT_POINT_CLOUD_PATH;
  return new URL(configuredUrl, document.baseURI).href;
}

export const POINT_CLOUD_URL = resolvePointCloudUrl(import.meta.env.VITE_POINT_CLOUD_URL);

// Test dataset URL, only used by the test-data loading block in main.js.
export const TEST_POINT_CLOUD_URL = resolvePointCloudUrl(TEST_POINT_CLOUD_PATH);

export const MAP_TILE_URL =
  import.meta.env.VITE_MAP_TILE_URL?.trim() ||
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export const GEOCODER_URL =
  import.meta.env.VITE_GEOCODER_URL?.trim() ||
  "https://photon.komoot.io/api/";

export const CROP = Object.freeze({
  minX: -2200,
  minY: 106182,
  maxX: 293263,
  maxY: 278396,
});

export const CENTER = Object.freeze({
  x: (CROP.minX + CROP.maxX) / 2,
  y: (CROP.minY + CROP.maxY) / 2,
});

export const INITIAL_VIEW = Object.freeze({
  position: [0, -205000, 265000],
  target: [0, 0, 75],
});
