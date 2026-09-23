import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Copc, Las } from "copc";
import { createRangeGetter, exportClippedLas, intersectingNodes } from "../src/las-export-core.js";

const source = new Uint8Array(await readFile(new URL("./fixtures/export.copc.laz", import.meta.url)));
const get = async (begin, end) => source.slice(begin, end);
const copc = await Copc.create(get);
const sourcePoints = await Las.PointData.decompressFile(source);
const box = [0.2, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 1, 0, -20001, -38001, -30.3, 1];
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function records(bytes, size) {
  const result = [];
  for (let i = 0; i < bytes.length; i += size) result.push(Buffer.from(bytes.subarray(i, i + size)).toString("hex"));
  return result.sort();
}

test("exports an actual COPC as uncompressed LAS, preserving all point bytes and CRS", async () => {
  const result = await exportClippedLas({ api: { Copc, Las }, get, matrix: box });
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  const header = Las.Header.parse(bytes);
  assert.equal(result.count, 625);
  assert.equal(header.pointCount, 625);
  assert.equal(bytes[104], 8); // No compression bit, original RGB/NIR format.
  assert.equal(header.pointDataRecordLength, 42); // Including custom extra bytes.
  assert.deepEqual(header.scale, copc.header.scale);
  assert.deepEqual(header.offset, copc.header.offset);
  assert.deepEqual(header.min, [100002.6, 190002.6, 30]);
  [100007.4, 190007.4, 30.6].forEach((value, axis) => assert.ok(Math.abs(header.max[axis] - value) < 1e-8));
  assert.equal(header.pointCountByReturn.reduce((a, b) => a + b), 625);
  assert.equal(header.evlrCount, 0);
  assert.equal(header.evlrOffset, 0);
  assert.equal(bytes.length, header.pointDataOffset + 625 * 42);

  const expected = [];
  const returns = Array(15).fill(0);
  for (let i = 0; i < sourcePoints.length; i += 42) {
    const record = sourcePoints.slice(i, i + 42);
    const view = new DataView(record.buffer);
    const x = view.getInt32(0, true) * 0.01;
    const y = view.getInt32(4, true) * 0.01;
    if (x >= 100002.5 && x <= 100007.5 && y >= 190002.5 && y <= 190007.5) {
      expected.push(Buffer.from(record).toString("hex"));
      returns[(view.getUint8(14) & 15) - 1]++;
    }
  }
  assert.deepEqual(records(bytes.subarray(header.pointDataOffset), 42), expected.sort());
  assert.deepEqual(header.pointCountByReturn, returns);
  const vlrs = await Las.Vlr.walk(async (a, b) => bytes.slice(a, b), header);
  assert.deepEqual(vlrs.map(({ userId, recordId }) => [userId, recordId]), [["LASF_Projection", 2112], ["LASF_Spec", 4]]);
  for (const vlr of vlrs) {
    const original = copc.vlrs.find((item) => item.userId === vlr.userId && item.recordId === vlr.recordId);
    assert.deepEqual(await Las.Vlr.fetch(async (a, b) => bytes.slice(a, b), vlr), await Las.Vlr.fetch(get, original));
  }
});

test("clips a rotated box exactly, rather than exporting its enclosing bounds", async () => {
  const c = Math.cos(Math.PI / 4);
  const s = Math.sin(Math.PI / 4);
  const cx = 100005, cy = 190005;
  const matrix = [c / 8, -s / 2, 0, 0, s / 8, c / 2, 0, 0, 0, 0, 1, 0, -(c * cx + s * cy) / 8, (s * cx - c * cy) / 2, -30.3, 1];
  const result = await exportClippedLas({ api: { Copc, Las }, get, matrix });
  const expected = [];
  for (let i = 0; i < 10000; i++) {
    const dx = (i % 100) * 0.2 - 5;
    const dy = Math.floor(i / 100) * 0.2 - 5;
    if (Math.abs(c * dx + s * dy) <= 4 && Math.abs(-s * dx + c * dy) <= 1) expected.push(i);
  }
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  const header = Las.Header.parse(bytes);
  const view = new DataView(bytes.buffer);
  const ids = Array.from({ length: header.pointCount }, (_, i) => view.getUint32(header.pointDataOffset + i * 42 + 38, true));
  assert.deepEqual(ids.sort((a, b) => a - b), expected);
});

test("reads parent points and deeper hierarchy pages, pruning unrelated pages and duplicates", async () => {
  const visited = [];
  const pageData = {
    10: { nodes: { "0-0-0-0": { pointCount: 2 } }, pages: { "1-0-0-0": { pageOffset: 20 }, "1-1-1-1": { pageOffset: 30 } } },
    20: { nodes: { "0-0-0-0": { pointCount: 2 }, "1-0-0-0": { pointCount: 3 }, "2-0-0-0": { pointCount: 4 }, "2-1-1-1": { pointCount: 0 } }, pages: { "1-0-0-0": { pageOffset: 20 } } },
  };
  const api = { Copc: { loadHierarchyPage: async (_, page) => { visited.push(page.pageOffset); return pageData[page.pageOffset]; } } };
  const cloud = { info: { cube: [0, 0, 0, 4, 4, 4], rootHierarchyPage: { pageOffset: 10 } } };
  const nodes = [];
  for await (const node of intersectingNodes(api, null, cloud, identity)) nodes.push(node.pointCount);
  assert.deepEqual(nodes, [2, 3, 4]);
  assert.deepEqual(visited, [10, 20]);
});

test("preserves non-COPC EVLRs and relocates them after the uncompressed points", async () => {
  const evlr = new Uint8Array(64);
  evlr.set(new TextEncoder().encode("test"), 2);
  new DataView(evlr.buffer).setBigUint64(20, 4n, true);
  evlr.set([1, 2, 3, 4], 60);
  const extended = new Uint8Array(source.length + evlr.length);
  extended.set(source);
  extended.set(evlr, source.length);
  new DataView(extended.buffer).setUint32(243, 2, true);
  const result = await exportClippedLas({ api: { Copc, Las }, get: async (a, b) => extended.slice(a, b), matrix: box });
  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  const header = Las.Header.parse(bytes);
  assert.equal(header.evlrCount, 1);
  assert.equal(header.evlrOffset, header.pointDataOffset + header.pointCount * 42);
  assert.deepEqual(bytes.subarray(header.evlrOffset), evlr);
});

test("rejects empty selections and network failures without producing a partial file", async () => {
  await assert.rejects(exportClippedLas({ api: { Copc, Las }, get, matrix: identity }), /No points/);
  await assert.rejects(exportClippedLas({ api: { Copc, Las }, matrix: box, get: async () => { throw new Error("offline"); } }), /offline/);
});

test("requires HTTP range support before reading a potentially enormous response", async () => {
  let cancelled = false;
  const fetcher = async () => ({ status: 200, body: { cancel: async () => { cancelled = true; } }, arrayBuffer: () => { throw new Error("must not read"); } });
  await assert.rejects(createRangeGetter("cloud", fetcher)(0, 100), /byte-range/);
  assert.equal(cancelled, true);
});

test("checks range offsets and truncated responses, accepting an EOF-clamped header read", async () => {
  const wrong = async () => new Response(new Uint8Array(4), { status: 206, headers: { "Content-Range": "bytes 1-4/10" } });
  await assert.rejects(createRangeGetter("cloud", wrong)(0, 4), /wrong byte range/);
  const short = async () => new Response(new Uint8Array(3), { status: 206, headers: { "Content-Range": "bytes 0-3/10" } });
  await assert.rejects(createRangeGetter("cloud", short)(0, 4), /Incomplete/);
  const eof = async () => new Response(new Uint8Array(4), { status: 206, headers: { "Content-Range": "bytes 0-3/4" } });
  assert.equal((await createRangeGetter("cloud", eof)(0, 65536)).length, 4);
});
