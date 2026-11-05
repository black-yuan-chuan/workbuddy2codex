#!/usr/bin/env node
/**
 * Generates media/icon.png (128x128), the icon shown in the VS Code
 * extension list / Marketplace sidebar.
 *
 * Design: two interlocked rings on a blue-violet rounded tile. The rings stand
 * for WorkBuddy and Codex being linked; ring A passes over ring B near the
 * crossing so the link reads as connected rather than merged.
 *
 * Run: node dev/make-icon.mjs
 * No dependencies: pixels are rasterised here and compressed with node:zlib.
 */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 128;
const SUBSAMPLES = 8;
const CORNER = 30;
const TILE_TOP = [37, 99, 235];
const TILE_BOTTOM = [124, 58, 237];
const GLYPH = [255, 255, 255];

const RING_RADIUS = 25;
const RING_STROKE = 15;
const RING_A = { x: -15, y: -15 };
const RING_B = { x: 15, y: 15 };
/**
 * How far past ring A's stroke ring B is erased, so the break stays visible at
 * 16-24px. Values below ~4px turn the gap into a hairline at small sizes.
 */
const OVERLAP_MARGIN = 9;

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

/** Point-in-rounded-square test for the tile. */
function inTile(x, y) {
  const cx = Math.min(Math.max(x, CORNER), SIZE - CORNER);
  const cy = Math.min(Math.max(y, CORNER), SIZE - CORNER);
  return (x - cx) ** 2 + (y - cy) ** 2 <= CORNER * CORNER;
}

/**
 * True when (x, y) falls on either ring stroke. Ring A is drawn on top, so the
 * part of ring B that would sit underneath A's stroke is erased - that break is
 * what makes two overlapping circles read as interlocked links.
 */
function onRings(x, y) {
  const cx = x - SIZE / 2;
  const cy = y - SIZE / 2;
  const distA = Math.abs(Math.hypot(cx - RING_A.x, cy - RING_A.y) - RING_RADIUS);
  const distB = Math.abs(Math.hypot(cx - RING_B.x, cy - RING_B.y) - RING_RADIUS);
  if (distA <= RING_STROKE / 2) return true;
  if (distB > RING_STROKE / 2) return false;
  return distA > RING_STROKE / 2 + OVERLAP_MARGIN;
}

/** Sample one pixel with anti-aliasing and return 8-bit RGBA. */
function renderPixel(x, y) {
  let tile = 0;
  let glyph = 0;
  for (let sy = 0; sy < SUBSAMPLES; sy += 1) {
    for (let sx = 0; sx < SUBSAMPLES; sx += 1) {
      const px = x + (sx + 0.5) / SUBSAMPLES;
      const py = y + (sy + 0.5) / SUBSAMPLES;
      if (inTile(px, py)) tile += 1;
      if (onRings(px, py)) glyph += 1;
    }
  }
  const total = SUBSAMPLES * SUBSAMPLES;
  const alpha = tile / total;
  const coverage = glyph / total;
  const base = mix(TILE_TOP, TILE_BOTTOM, (x + y) / (2 * SIZE - 2));
  return [
    Math.round(lerp(base[0], GLYPH[0], coverage)),
    Math.round(lerp(base[1], GLYPH[1], coverage)),
    Math.round(lerp(base[2], GLYPH[2], coverage)),
    Math.round(255 * alpha),
  ];
}

/** Raw RGBA scanlines, each prefixed with filter type 0. */
function renderRaw() {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  let p = 0;
  for (let y = 0; y < SIZE; y += 1) {
    raw[p] = 0;
    p += 1;
    for (let x = 0; x < SIZE; x += 1) {
      const [r, g, b, a] = renderPixel(x, y);
      raw[p] = r; p += 1;
      raw[p] = g; p += 1;
      raw[p] = b; p += 1;
      raw[p] = a; p += 1;
    }
  }
  return raw;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(renderRaw(), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const target = join(dirname(fileURLToPath(import.meta.url)), "..", "media", "icon.png");
writeFileSync(target, encodePng());
console.log(`[make-icon] wrote ${target} (${SIZE}x${SIZE})`);