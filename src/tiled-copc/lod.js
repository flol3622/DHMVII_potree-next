// Pure helpers for treating tiles as nodes of one octree.

// Catalogue cells whose footprint lies within `reach` of (x, y), nearest first.
export function cellsNear(x, y, reach, size) {
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
export function tileSphere([minX, minY, minZ, maxX, maxY, maxZ]) {
  const side = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2, r: (side * Math.sqrt(3)) / 2 };
}

// Same projection as Potree's node LOD test.
export function screenRadius(sphere, eye, fov, height) {
  const distance = Math.hypot(sphere.x - eye.x, sphere.y - eye.y, sphere.z - eye.z);
  if (distance < sphere.r) return Infinity;
  return (sphere.r * 0.5 * height) / (Math.tan((fov * Math.PI) / 360) * distance);
}

// Conservative sphere-in-frustum test for a perspective camera; `sphere` is in world space.
export function sphereInView(camera, sphere) {
  const e = camera.matrixWorldInverse.elements;
  const { x, y, z, r } = sphere;
  const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
  const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
  const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
  const tanV = Math.tan((camera.fov * Math.PI) / 360), tanH = tanV * camera.aspect;
  return vz < r
    && Math.abs(vy) <= -vz * tanV + r * Math.hypot(1, tanV)
    && Math.abs(vx) <= -vz * tanH + r * Math.hypot(1, tanH);
}

// Whether every corner of `rect` lies in one of `rects`. For a rect no larger
// than the smallest covering rect, this means the rect is fully covered.
export function cornersCovered([minX, minY, maxX, maxY], rects) {
  const inside = (x, y) => rects.some((r) => x >= r[0] && y >= r[1] && x <= r[2] && y <= r[3]);
  return inside(minX, minY) && inside(maxX, minY) && inside(minX, maxY) && inside(maxX, maxY);
}

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

export function syncMaterial(from, to) {
  for (const key of MATERIAL_KEYS) {
    if (key in from && to[key] !== from[key]) to[key] = from[key];
  }
  const [lo, hi] = from.intensityRange;
  if (to.intensityRange[0] !== lo || to.intensityRange[1] !== hi) to.intensityRange = [lo, hi];
}
