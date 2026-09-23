// Flai's regional overview is a separate COPC, not the full-resolution tile set.
export const FLAI_OVERVIEW_URL =
  "https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/BE/EODaS/LiDAR_DHMV_II-2013-2015/overview/overview.copc.laz";
// Flai dataset whose full-resolution tiles extend the overview (EPSG:31370 tiles).
export const FLAI_DATASET_ID = "b729323b-332c-46e7-878d-acac932b1013";
const DEFAULT_POINT_CLOUD_PATH = FLAI_OVERVIEW_URL;

function resolvePointCloudUrl(value) {
  const configuredUrl = value?.trim() || DEFAULT_POINT_CLOUD_PATH;
  return new URL(configuredUrl, document.baseURI).href;
}

export const POINT_CLOUD_URL = resolvePointCloudUrl(import.meta.env.VITE_POINT_CLOUD_URL);
export const IS_FLAI_OVERVIEW = POINT_CLOUD_URL === FLAI_OVERVIEW_URL;
export const POINT_CLOUD_NAME = IS_FLAI_OVERVIEW
  ? "DHMV II · Flai"
  : "DHMV Flanders";
export const ELEVATION_RANGE = Object.freeze([-20, 350]);

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
