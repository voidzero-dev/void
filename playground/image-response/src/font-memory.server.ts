import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { setImmediate } from 'node:timers/promises';
import { ImageResponse } from 'void/image';
import type { FontMemorySample } from './font-memory.ts';

const startedAt = Date.now();
let original: Uint8Array | undefined;
let headOffset = 0;
let headRecord = 0;
let rendered = 0;
let running = false;
let stopping = false;
let completed = 0;
let requested = 0;
let warmed = false;
let imageHash: string | null = null;
const gc = (globalThis as { gc?: () => void }).gc;

async function loadFont() {
  if (original) {
    return original;
  }
  const data = new Uint8Array(await readFile(process.env.VOID_IMAGE_MEMORY_FONT_PATH!));
  const view = new DataView(data.buffer);
  for (let index = 0; index < view.getUint16(4); index++) {
    const record = 12 + index * 16;
    if (view.getUint32(record) === 0x68656164) {
      headRecord = record;
      headOffset = view.getUint32(record + 8);
      original = data;
      return data;
    }
  }
  throw new Error('The demo font has no TrueType head table.');
}

function checksum(data: Uint8Array, start: number, length: number) {
  let sum = 0;
  for (let offset = start; offset < start + length; offset += 4) {
    let word = 0;
    for (let byte = 0; byte < 4; byte++) {
      word = (word << 8) | (offset + byte < start + length ? data[offset + byte]! : 0);
    }
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

/** Different valid binaries, identical glyphs: vary head.modified, then repair SFNT checksums. */
function distinctFont(sequence: number): Uint8Array {
  const data = new Uint8Array(original!);
  const view = new DataView(data.buffer);
  view.setUint32(headOffset + 32, (view.getUint32(headOffset + 32) + sequence) >>> 0);
  view.setUint32(headOffset + 8, 0);
  view.setUint32(headRecord + 4, checksum(data, headOffset, view.getUint32(headRecord + 12)));
  view.setUint32(headOffset + 8, (0xb1b0afba - checksum(data, 0, data.length)) >>> 0);
  return data;
}

async function draw(sequence: number) {
  const response = new ImageResponse(
    { type: 'text', text: 'Same family — A Ω', style: { fontSize: 24 } },
    {
      width: 320,
      height: 48,
      defaultFont: 'Geist',
      fallbackFonts: false,
      fonts: [{ name: 'Font Memory Demo', data: distinctFont(sequence) }],
    },
  );
  const hash = createHash('sha256')
    .update(new Uint8Array(await response.arrayBuffer()))
    .digest('hex');
  if (imageHash && hash !== imageHash) {
    throw new Error('The rendered pixels changed unexpectedly.');
  }
  imageHash = hash;
  // Only the original font and counters survive here. The demo does not keep
  // generated font buffers or images: retained copies belong to the renderer.
}

export function memorySample(): FontMemorySample {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  return {
    pid: process.pid,
    startedAt,
    sampledAt: Date.now(),
    uptime: process.uptime(),
    rss,
    heapUsed,
    external,
    arrayBuffers,
    fontBytes: original?.byteLength ?? 0,
    rendered,
    running,
    completed,
    requested,
    warmed,
    gcAvailable: Boolean(gc),
    imageHash,
  };
}

export function stopRendering() {
  stopping = true;
}

export async function collectGarbage() {
  gc?.();
  await setImmediate();
  gc?.();
  return memorySample();
}

export async function renderFonts(count: number, warmup = false) {
  if (running) {
    throw new Error('A font batch is already running.');
  }
  running = true;
  stopping = false;
  completed = 0;
  requested = count;
  try {
    await loadFont();
    for (let index = 0; index < count && !stopping; index++) {
      // Warm up with one stable font so compilation/allocation is not mistaken
      // for growth from distinct registrations. Every real batch gets new IDs.
      await draw(warmup ? 0 : rendered + 1);
      if (!warmup) {
        rendered++;
      }
      completed++;
      await setImmediate();
    }
    warmed = true;
  } finally {
    running = false;
  }
  return collectGarbage();
}
