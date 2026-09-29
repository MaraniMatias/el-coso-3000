/**
 * Color quantization by median cut.
 *
 * There is one palette for the entire GIF, and this design choice is the most
 * noticeable in the result: if each frame is quantized separately, the
 * palette flickers from frame to frame even when the image barely changes,
 * which looks much worse than any color banding. With a global palette, a
 * pixel's index means the same thing in every frame, so motion stays clean.
 *
 * The other reason is cost: indexing against a fixed palette is a lookup,
 * while per-frame quantization requires a decision tree or linear search per
 * pixel, repeated for every frame.
 */

export interface Palette {
  /** Packed RGB triples, 3 bytes per color, in the order used by the GCT. */
  rgb: Uint8Array;
  /** Actual colors. May be fewer than the size of the table that holds them. */
  size: number;
}

/** A unique input color and its occurrence count. */
interface Bucket {
  packed: number;
  count: number;
}

/** A group of colors represented by one palette average. */
interface Box {
  items: Bucket[];
  /** Pixels represented by the box; determines its weight when choosing which to split. */
  pixels: number;
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
}

/** Channel 0 is the median channel, 1 the mean, and 2 the mode. */
function channelOf(packed: number, channel: 0 | 1 | 2): number {
  if (channel === 0) return (packed >> 16) & 0xff;
  if (channel === 1) return (packed >> 8) & 0xff;
  return packed & 0xff;
}

function makeBox(items: Bucket[]): Box {
  const box: Box = { items, pixels: 0, rMin: 255, rMax: 0, gMin: 255, gMax: 0, bMin: 255, bMax: 0 };
  for (const item of items) {
    const r = channelOf(item.packed, 0);
    const g = channelOf(item.packed, 1);
    const b = channelOf(item.packed, 2);
    box.pixels += item.count;
    if (r < box.rMin) box.rMin = r;
    if (r > box.rMax) box.rMax = r;
    if (g < box.gMin) box.gMin = g;
    if (g > box.gMax) box.gMax = g;
    if (b < box.bMin) box.bMin = b;
    if (b > box.bMax) box.bMax = b;
  }
  return box;
}

/** Length of the box's longest side. If 0, all its colors are identical. */
function longestSide(box: Box): number {
  return Math.max(box.rMax - box.rMin, box.gMax - box.gMin, box.bMax - box.bMin);
}

/**
 * Splits the box along its longest channel, at the median weighted by pixel
 * count. Weighting matters: splitting the longest channel at its geometric
 * midpoint can leave 90% of the original pixels in one box, with no improvement
 * in quantization.
 */
function splitBox(box: Box): [Box, Box] {
  const rSide = box.rMax - box.rMin;
  const gSide = box.gMax - box.gMin;
  const bSide = box.bMax - box.bMin;
  const channel: 0 | 1 | 2 = rSide >= gSide && rSide >= bSide ? 0 : gSide >= bSide ? 1 : 2;

  // Breaking ties by `packed` makes the palette deterministic: colors with the
  // same channel value could otherwise be ordered arbitrarily.
  const sorted = box.items;
  sorted.sort((a, b) => channelOf(a.packed, channel) - channelOf(b.packed, channel) || a.packed - b.packed);

  const half = box.pixels / 2;
  let acc = 0;
  // `cut` always stays in [1, length-1]: both halves need at least one color or
  // the split would never make progress.
  let cut = 1;
  while (cut < sorted.length - 1 && acc + sorted[cut]!.count < half) {
    acc += sorted[cut]!.count;
    cut++;
  }

  return [makeBox(sorted.slice(0, cut)), makeBox(sorted.slice(cut))];
}

/** A palette color is the pixel-weighted average of the colors it represents. */
function averageColor(items: Bucket[]): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let total = 0;
  for (const item of items) {
    r += channelOf(item.packed, 0) * item.count;
    g += channelOf(item.packed, 1) * item.count;
    b += channelOf(item.packed, 2) * item.count;
    total += item.count;
  }
  return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
}

/**
 * Builds a palette of at most `maxColors` colors from RGB samples packed in
 * groups of 3 bytes (`RRGGBB` per triple).
 *
 * The split is deterministic: the same input always produces the same palette.
 */
export function buildPalette(samples: Uint8Array, maxColors = 256): Palette {
  const limit = Math.max(1, Math.min(256, Math.floor(maxColors)));

  // Histogram of unique colors. Scanning each input pixel and splitting boxes
  // of individual pixels would produce the same result, but much more slowly:
  // with 65536 samples and few colors, reducing to unique colors first and
  // using their weights makes the difference between milliseconds and seconds.
  const hist = new Map<number, number>();
  for (let i = 0; i + 2 < samples.length; i += 3) {
    const packed = (samples[i]! << 16) | (samples[i + 1]! << 8) | samples[i + 2]!;
    hist.set(packed, (hist.get(packed) ?? 0) + 1);
  }
  if (hist.size === 0) return { rgb: new Uint8Array([0, 0, 0]), size: 1 };

  const items: Bucket[] = [];
  for (const [packed, count] of hist) items.push({ packed, count });

  const boxes: Box[] = [makeBox(items)];
  while (boxes.length < limit) {
    let pick = -1;
    let heaviest = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!;
      if (box.items.length < 2) continue;
      // Always split the heaviest box to distribute error well: a box of two
      // nearly identical colors weighs less than one with very different
      // colors, and the former is the one that needs no split.
      const weight = box.pixels * longestSide(box);
      if (weight > heaviest) {
        heaviest = weight;
        pick = i;
      }
    }
    if (pick < 0) break; // no box can be split further
    const [left, right] = splitBox(boxes[pick]!);
    boxes.splice(pick, 1, left, right);
  }

  const rgb = new Uint8Array(boxes.length * 3);
  for (let i = 0; i < boxes.length; i++) {
    const [r, g, b] = averageColor(boxes[i]!.items);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { rgb, size: boxes.length };
}

/**
 * Returns a function that maps a packed color (`RRGGBB` in a 24-bit integer)
 * to the nearest palette index.
 *
 * Results are cached by color: the placeholder has three or four colors, so
 * the linear search runs once per color and the remaining millions of pixels
 * are map lookups. Text antialiasing adds a few intermediate colors, but there
 * are still few of them and they repeat from frame to frame.
 */
export function createPaletteMapper(palette: Palette): (rgb: number) => number {
  const { rgb, size } = palette;
  const cache = new Map<number, number>();

  return (packed: number): number => {
    const hit = cache.get(packed);
    if (hit !== undefined) return hit;

    let bestIndex = 0;
    let bestDist = Infinity;
    for (let i = 0; i < size; i++) {
      const dr = channelOf(packed, 0) - rgb[i * 3]!;
      const dg = channelOf(packed, 1) - rgb[i * 3 + 1]!;
      const db = channelOf(packed, 2) - rgb[i * 3 + 2]!;
      // Squared distance: the square root does not change the order, and
      // multiplying by three is costly in a loop that runs per pixel.
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
        if (dist === 0) break; // the exact color cannot be closer
      }
    }

    cache.set(packed, bestIndex);
    return bestIndex;
  };
}
