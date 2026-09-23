// Full-resolution COPC extraction, independent of Potree's render cache/LOD.
const MAX_NODE_BYTES = 128 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;

export function createRangeGetter(url, fetcher = fetch) {
  return async (begin, end) => {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 || end <= begin || end - begin > MAX_NODE_BYTES) {
      throw new Error("Invalid or oversized COPC byte range. Choose a smaller clipping box.");
    }
    const response = await fetcher(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`COPC server must support byte-range requests (HTTP ${response.status}).`);
    }
    const range = response.headers.get("Content-Range");
    let expected = end - begin;
    if (range) {
      const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range);
      if (!match || Number(match[1]) !== begin || Number(match[2]) >= end ||
        (Number(match[2]) !== end - 1 && (match[3] === "*" || Number(match[2]) !== Number(match[3]) - 1))) {
        await response.body?.cancel();
        throw new Error("COPC server returned the wrong byte range.");
      }
      expected = Number(match[2]) - begin + 1;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== expected) throw new Error("Incomplete COPC response. Please retry the download.");
    return bytes;
  };
}

export function transformPoint(matrix, x, y, z) {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

export function containsPoint(matrix, x, y, z) {
  return transformPoint(matrix, x, y, z).every((value) => Math.abs(value) <= 0.5 + 1e-9);
}

export function nodeIntersectsBox(key, cube, matrix) {
  const [depth, ix, iy, iz] = key.split("-").map(Number);
  const width = (cube[3] - cube[0]) / 2 ** depth;
  const min = [cube[0] + ix * width, cube[1] + iy * width, cube[2] + iz * width];
  const lower = [Infinity, Infinity, Infinity];
  const upper = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p = transformPoint(matrix, ...min.map((value, axis) => value + ((corner >> axis) & 1) * width));
    for (let axis = 0; axis < 3; axis++) {
      lower[axis] = Math.min(lower[axis], p[axis]);
      upper[axis] = Math.max(upper[axis], p[axis]);
    }
  }
  // Conservative for rotated boxes: exact clipping happens on decoded points.
  return lower.every((value, axis) => value <= 0.5 + 1e-9 && upper[axis] >= -0.5 - 1e-9);
}

export async function* intersectingNodes(api, get, copc, matrix, onPage = () => {}) {
  const pending = [copc.info.rootHierarchyPage];
  const pagesSeen = new Set();
  const nodesSeen = new Set();
  while (pending.length) {
    const page = pending.pop();
    if (pagesSeen.has(page.pageOffset)) continue;
    pagesSeen.add(page.pageOffset);
    const hierarchy = await api.Copc.loadHierarchyPage(get, page);
    onPage(pagesSeen.size);
    for (const [key, node] of Object.entries(hierarchy.nodes)) {
      // Parent levels hold distinct points too; leaf-only export loses them.
      if (!nodesSeen.has(key) && node.pointCount > 0 && nodeIntersectsBox(key, copc.info.cube, matrix)) {
        nodesSeen.add(key);
        yield node;
      }
    }
    for (const [key, child] of Object.entries(hierarchy.pages)) {
      if (nodeIntersectsBox(key, copc.info.cube, matrix)) pending.push(child);
    }
  }
}

export function clipRecords(bytes, header, matrix, stats) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = header.pointDataRecordLength;
  let kept = 0;
  for (let start = 0; start < bytes.length; start += size) {
    const xyz = header.scale.map((scale, axis) => view.getInt32(start + axis * 4, true) * scale + header.offset[axis]);
    if (!containsPoint(matrix, ...xyz)) continue;
    const returnNumber = view.getUint8(start + 14) & 15;
    if (returnNumber) stats.returns[returnNumber - 1]++;
    xyz.forEach((value, axis) => {
      stats.min[axis] = Math.min(stats.min[axis], value);
      stats.max[axis] = Math.max(stats.max[axis], value);
    });
    bytes.copyWithin(kept * size, start, start + size);
    kept++;
  }
  stats.count += kept;
  return bytes.subarray(0, kept * size);
}

function writeString(bytes, offset, length, value) {
  bytes.fill(0, offset, offset + length);
  bytes.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

export function buildLasFile(sourceHeader, metadata, chunks, stats) {
  const header = sourceHeader.slice();
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const vlrs = metadata.vlrs;
  const dataSize = chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  const dataOffset = header.length + vlrs.reduce((sum, bytes) => sum + bytes.length, 0);
  writeString(header, 58, 32, "Flanders in Points");
  const now = new Date();
  view.setUint16(90, Math.floor((now - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86400000), true);
  view.setUint16(92, now.getUTCFullYear(), true);
  view.setUint32(96, dataOffset, true);
  view.setUint32(100, vlrs.length, true);
  view.setUint8(104, view.getUint8(104) & 0x3f);
  header.fill(0, 107, 131); // LAS 1.4 formats 6–8 use only extended counts.
  view.setBigUint64(227, 0n, true);
  view.setBigUint64(235, metadata.evlrs.length ? BigInt(dataOffset + dataSize) : 0n, true);
  view.setUint32(243, metadata.evlrs.length, true);
  view.setBigUint64(247, BigInt(stats.count), true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(179 + 16 * axis, stats.max[axis], true);
    view.setFloat64(187 + 16 * axis, stats.min[axis], true);
  }
  stats.returns.forEach((count, index) => view.setBigUint64(255 + index * 8, BigInt(count), true));
  return new Blob([header, ...vlrs, ...chunks, ...metadata.evlrs], { type: "application/octet-stream" });
}

export async function exportClippedLas({ api, lazPerf, get, matrix, onProgress = () => {} }) {
  onProgress({ phase: "Reading COPC metadata", count: 0, nodes: 0 });
  const copc = await api.Copc.create(get);
  const { header } = copc;
  if (header.minorVersion !== 4 || ![6, 7, 8].includes(header.pointDataRecordFormat)) {
    throw new Error("Expected LAS 1.4 COPC with point format 6, 7 or 8.");
  }
  const sourceHeader = await get(0, header.headerLength);
  const metadata = { vlrs: [], evlrs: [] };
  let metadataSize = 0;
  for (const vlr of copc.vlrs) {
    // A clipped file is ordinary LAS: COPC indexes refer to the original data.
    if (vlr.userId === "copc") continue;
    metadataSize += vlr.contentLength + (vlr.isExtended ? 60 : 54);
    if (metadataSize > MAX_METADATA_BYTES) throw new Error("Source metadata exceeds the browser export limit.");
    if (vlr.userId === "laszip encoded" && vlr.recordId === 22204) {
      continue;
    }
    const bytes = await get(vlr.contentOffset - (vlr.isExtended ? 60 : 54), vlr.contentOffset + vlr.contentLength);
    metadata[vlr.isExtended ? "evlrs" : "vlrs"].push(bytes);
  }
  const chunks = [];
  let outputBytes = sourceHeader.length + metadataSize;
  const stats = { count: 0, returns: Array(15).fill(0), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let nodes = 0;
  let pages = 0;
  const report = () => onProgress({ phase: "Clipping at full detail", count: stats.count, nodes, pages });
  for await (const node of intersectingNodes(api, get, copc, matrix, (count) => { pages = count; report(); })) {
    const nodeBytes = node.pointCount * header.pointDataRecordLength;
    if (!Number.isSafeInteger(nodeBytes) || nodeBytes > MAX_NODE_BYTES) {
      throw new Error("A source node exceeds the browser memory limit.");
    }
    const compressed = await get(node.pointDataOffset, node.pointDataOffset + node.pointDataLength);
    const decoded = await api.Las.PointData.decompressChunk(compressed, { ...header, pointCount: node.pointCount }, lazPerf);
    const clipped = clipRecords(decoded, header, matrix, stats);
    outputBytes += clipped.length;
    if (outputBytes > MAX_OUTPUT_BYTES) {
      throw new Error("Export exceeds the 256 MiB browser limit. Choose a smaller clipping box.");
    }
    // Blob copies only the kept records; do not retain whole decoded nodes.
    if (clipped.length) chunks.push(new Blob([clipped]));
    nodes++;
    report();
  }
  if (!stats.count) throw new Error("No points inside this clipping box. Move or resize it and try again.");
  onProgress({ phase: "Finishing LAS", count: stats.count, nodes, pages });
  return { blob: buildLasFile(sourceHeader, metadata, chunks, stats), count: stats.count };
}
