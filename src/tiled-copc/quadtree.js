// 2D spatial index over tile footprints, after the one in Flai's Lidar Hub.
// Items are stored in every leaf they overlap, so queries deduplicate.

const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

export class Quadtree {
  constructor(bounds, capacity = 20, depth = 0) {
    this.bounds = bounds; // [minX, minY, maxX, maxY]
    this.capacity = capacity;
    this.depth = depth;
    this.children = null;
    this.items = [];
  }

  insert(item, rect) {
    // Items outside the root bounds still need to be found; keep them at the root.
    if (this.depth === 0 && !intersects(this.bounds, rect)) { this.items.push({ item, rect }); return; }
    if (this.children) {
      for (const child of this.children) if (intersects(child.bounds, rect)) child.insert(item, rect);
      return;
    }
    this.items.push({ item, rect });
    if (this.items.length > this.capacity && this.depth < 16) this.subdivide();
  }

  subdivide() {
    const [minX, minY, maxX, maxY] = this.bounds;
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    this.children = [
      [minX, minY, midX, midY], [midX, minY, maxX, midY],
      [minX, midY, midX, maxY], [midX, midY, maxX, maxY],
    ].map((bounds) => new Quadtree(bounds, this.capacity, this.depth + 1));
    const items = this.items;
    this.items = [];
    for (const { item, rect } of items) this.insert(item, rect);
  }

  query(rect, found = new Set()) {
    for (const entry of this.items) if (intersects(entry.rect, rect)) found.add(entry.item);
    if (this.children) {
      for (const child of this.children) if (intersects(child.bounds, rect)) child.query(rect, found);
    }
    return found;
  }
}
