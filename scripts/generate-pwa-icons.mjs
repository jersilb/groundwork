#!/usr/bin/env node
// Generates placeholder PWA icons (solid-color PNGs) so installability
// criteria (manifest requires real image files at the claimed sizes) can
// be tested for real without adding an image-processing dependency or
// doing actual visual design here — real branding is
// ultimate-web-designer's job (CLAUDE.md), not this script's.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function crc32(buf) {
  let c;
  const table = crc32.table ?? (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function solidColorPng(size, [r, g, b], mark) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0); // width
  ihdrData.writeUInt32BE(size, 4); // height
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = chunk("IHDR", ihdrData);

  const rowLength = size * 3 + 1; // filter byte + RGB per pixel
  const raw = Buffer.alloc(rowLength * size);
  const markColor = mark?.color ?? [246, 243, 236];
  for (let y = 0; y < size; y++) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // no filter
    for (let x = 0; x < size; x++) {
      let [pr, pg, pb] = [r, g, b];
      if (mark) {
        // Centered disc whose diameter is `mark.fraction` of the icon —
        // used by the maskable variant so the mark survives any launcher
        // mask (Android's safe zone is the central 80% circle).
        const half = size / 2;
        const radius = (size * mark.fraction) / 2;
        const dist = Math.hypot(x + 0.5 - half, y + 0.5 - half);
        if (dist <= radius) {
          [pr, pg, pb] = markColor;
        }
      }
      const px = rowStart + 1 + x * 3;
      raw[px] = pr;
      raw[px + 1] = pg;
      raw[px + 2] = pb;
    }
  }
  const idat = chunk("IDAT", deflateSync(raw));
  const iend = chunk("IEND", Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

const GROUNDWORK_PLACEHOLDER_COLOR = [30, 58, 95]; // arbitrary placeholder navy, not real branding

for (const size of [192, 512]) {
  const png = solidColorPng(size, GROUNDWORK_PLACEHOLDER_COLOR);
  const outPath = path.join(REPO_ROOT, "public", `icon-${size}.png`);
  writeFileSync(outPath, png);
  console.log(`Wrote ${outPath} (${png.length} bytes)`);
}

// Maskable variant: the full square is background color, with a centered
// mark inside the launcher safe zone — every pixel survives masking.
const maskable = solidColorPng(512, GROUNDWORK_PLACEHOLDER_COLOR, { fraction: 0.44, color: [246, 243, 236] });
const maskablePath = path.join(REPO_ROOT, "public", "icon-maskable-512.png");
writeFileSync(maskablePath, maskable);
console.log(`Wrote ${maskablePath} (${maskable.length} bytes)`);
