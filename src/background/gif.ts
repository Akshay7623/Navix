/**
 * Session recording.
 *
 * Frames are captured with `Page.captureScreenshot` and encoded to GIF89a in
 * the service worker. No dependency and no offscreen document: MV3 workers have
 * `createImageBitmap` and `OffscreenCanvas`, which is everything the encoder
 * needs to turn a JPEG into indexed pixels.
 *
 * Colour handling is deliberately simple — a fixed 6x6x6 cube (216 colours).
 * Median-cut would look better on photographic pages, but UI screenshots are
 * mostly flat fills and text, where the cube is indistinguishable and the
 * per-pixel cost is O(1) instead of O(palette).
 */

const MAX_FRAMES = 60;
const MAX_WIDTH = 900;
const MIN_FRAME_INTERVAL_MS = 250;

export interface Recording {
  frames: Array<{ jpeg: string; at: number }>;
  startedAt: number;
  lastCaptureAt: number;
  width: number;
  height: number;
}

const recordings = new Map<number, Recording>();

export function isRecording(tabId: number): boolean {
  return recordings.has(tabId);
}

export function start(tabId: number): void {
  recordings.set(tabId, {
    frames: [],
    startedAt: Date.now(),
    lastCaptureAt: 0,
    width: 0,
    height: 0,
  });
}

export function stop(tabId: number): Recording | undefined {
  const rec = recordings.get(tabId);
  recordings.delete(tabId);
  return rec;
}

export function frameCount(tabId: number): number {
  return recordings.get(tabId)?.frames.length ?? 0;
}

export interface FinishedGif {
  dataUrl: string;
  frames: number;
  at: number;
}

/**
 * The most recent finished recording per tab. Kept after the run ends so the
 * user can still export it from the side panel.
 */
const lastGifs = new Map<number, FinishedGif>();

/**
 * Stop recording, encode, and stash the result. Returns the frame count, or 0
 * when there was nothing worth encoding (a single frame is not an animation).
 */
export async function finish(tabId: number): Promise<number> {
  const rec = stop(tabId);
  if (!rec || rec.frames.length < 2) return 0;
  try {
    const bytes = await encode(rec);
    lastGifs.set(tabId, {
      dataUrl: `data:image/gif;base64,${toBase64(bytes)}`,
      frames: rec.frames.length,
      at: Date.now(),
    });
    return rec.frames.length;
  } catch {
    return 0;
  }
}

export function getLast(tabId: number): FinishedGif | undefined {
  return lastGifs.get(tabId);
}

export function clearLast(tabId: number): void {
  lastGifs.delete(tabId);
}

/**
 * Record one frame. Throttled so a burst of fast tool calls does not produce a
 * hundred near-identical frames, and capped so a long run cannot exhaust memory.
 */
export async function captureFrame(tabId: number, jpeg: string): Promise<void> {
  const rec = recordings.get(tabId);
  if (!rec) return;
  if (rec.frames.length >= MAX_FRAMES) return;

  const now = Date.now();
  if (now - rec.lastCaptureAt < MIN_FRAME_INTERVAL_MS) return;
  rec.lastCaptureAt = now;
  rec.frames.push({ jpeg, at: now });
}

/* ------------------------------------------------------------------ */
/* GIF89a encoding                                                     */
/* ------------------------------------------------------------------ */

/** 6x6x6 colour cube: index = r6*36 + g6*6 + b6. */
function buildPalette(): Uint8Array {
  const table = new Uint8Array(256 * 3);
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        const i = (r * 36 + g * 6 + b) * 3;
        table[i] = Math.round((r * 255) / 5);
        table[i + 1] = Math.round((g * 255) / 5);
        table[i + 2] = Math.round((b * 255) / 5);
      }
    }
  }
  // Remaining 40 slots are a neutral ramp; unused by the quantizer but they
  // keep the table a legal power-of-two size.
  for (let i = 216; i < 256; i += 1) {
    const v = Math.round(((i - 216) * 255) / 39);
    table[i * 3] = v;
    table[i * 3 + 1] = v;
    table[i * 3 + 2] = v;
  }
  return table;
}

const PALETTE = buildPalette();

function quantize(rgba: Uint8ClampedArray, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  for (let p = 0; p < pixelCount; p += 1) {
    const i = p * 4;
    const r = Math.round((rgba[i] * 5) / 255);
    const g = Math.round((rgba[i + 1] * 5) / 255);
    const b = Math.round((rgba[i + 2] * 5) / 255);
    out[p] = r * 36 + g * 6 + b;
  }
  return out;
}

function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  let maxCode = (1 << codeSize) - 1;
  let nextCode = endCode + 1;
  let dict = new Map<number, number>();

  const emit = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>= 8;
      bitCount -= 8;
    }
  };

  emit(clearCode);

  if (indices.length === 0) {
    emit(endCode);
    if (bitCount > 0) out.push(bitBuffer & 0xff);
    return Uint8Array.from(out);
  }

  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = dict.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }

    emit(prefix);

    // The decoder builds its table one entry behind the encoder, so the code
    // width has to grow one code later than the naive "next code no longer
    // fits" check. Bumping immediately here produces a stream that decodes
    // correctly for the first ~250 pixels and then desynchronises.
    if (nextCode > maxCode && codeSize < 12) {
      codeSize += 1;
      maxCode = (1 << codeSize) - 1;
    }

    if (nextCode < 4096) {
      dict.set(key, nextCode);
      nextCode += 1;
    } else {
      emit(clearCode);
      dict = new Map();
      codeSize = minCodeSize + 1;
      maxCode = (1 << codeSize) - 1;
      nextCode = endCode + 1;
    }

    prefix = k;
  }

  emit(prefix);
  emit(endCode);
  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return Uint8Array.from(out);
}

function pushSubBlocks(target: number[], data: Uint8Array): void {
  for (let i = 0; i < data.length; i += 255) {
    const chunk = data.subarray(i, Math.min(i + 255, data.length));
    target.push(chunk.length);
    for (let j = 0; j < chunk.length; j += 1) target.push(chunk[j]);
  }
  target.push(0);
}

function pushU16(target: number[], value: number): void {
  target.push(value & 0xff, (value >> 8) & 0xff);
}

interface DecodedFrame {
  indices: Uint8Array;
  width: number;
  height: number;
}

async function decodeFrame(jpeg: string, width: number, height: number): Promise<DecodedFrame> {
  const binary = atob(jpeg);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not create a 2d context for GIF encoding");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const image = ctx.getImageData(0, 0, width, height);
  return { indices: quantize(image.data, width * height), width, height };
}

export interface RawFrame {
  indices: Uint8Array;
  delayCs: number;
}

/**
 * Build a GIF89a byte stream from already-indexed frames.
 *
 * Kept free of browser APIs so the container and LZW logic can be tested
 * directly in Node against a real decoder.
 */
export function encodeIndexed(frames: RawFrame[], width: number, height: number): Uint8Array {
  if (!frames.length) throw new Error("no frames to encode");

  const out: number[] = [];

  // Header + logical screen descriptor.
  for (const ch of "GIF89a") out.push(ch.charCodeAt(0));
  pushU16(out, width);
  pushU16(out, height);
  out.push(0xf7); // global colour table, 8-bit, 256 entries
  out.push(0); // background colour index
  out.push(0); // pixel aspect ratio
  for (let i = 0; i < PALETTE.length; i += 1) out.push(PALETTE[i]);

  // Netscape application extension: loop forever.
  out.push(0x21, 0xff, 0x0b);
  for (const ch of "NETSCAPE2.0") out.push(ch.charCodeAt(0));
  out.push(0x03, 0x01, 0x00, 0x00, 0x00);

  for (const frame of frames) {
    // Graphic control extension: disposal method 1 (leave in place).
    out.push(0x21, 0xf9, 0x04, 0x04);
    pushU16(out, Math.max(2, Math.min(65535, Math.round(frame.delayCs))));
    out.push(0x00, 0x00);

    // Image descriptor.
    out.push(0x2c);
    pushU16(out, 0);
    pushU16(out, 0);
    pushU16(out, width);
    pushU16(out, height);
    out.push(0x00); // no local colour table, not interlaced

    out.push(8); // LZW minimum code size
    pushSubBlocks(out, lzwEncode(frame.indices, 8));
  }

  out.push(0x3b); // trailer
  return Uint8Array.from(out);
}

/**
 * Encode recorded frames into a GIF89a byte array.
 *
 * Every frame is scaled to the same dimensions because GIF has no per-frame
 * scaling; the first frame's aspect ratio wins.
 */
export async function encode(rec: Recording): Promise<Uint8Array> {
  if (!rec.frames.length) throw new Error("no frames were recorded");

  const first = await createImageBitmap(
    new Blob([Uint8Array.from(atob(rec.frames[0].jpeg), (c) => c.charCodeAt(0))], {
      type: "image/jpeg",
    }),
  );
  const scale = Math.min(1, MAX_WIDTH / first.width);
  const width = Math.max(2, Math.round(first.width * scale));
  const height = Math.max(2, Math.round(first.height * scale));
  first.close();

  const frames: RawFrame[] = [];
  for (let f = 0; f < rec.frames.length; f += 1) {
    const decoded = await decodeFrame(rec.frames[f].jpeg, width, height);
    const next = rec.frames[f + 1];
    const delayMs = next ? next.at - rec.frames[f].at : 600;
    // GIF delays are in hundredths of a second; 2 is the practical floor
    // because most viewers clamp anything lower to 100ms anyway.
    frames.push({ indices: decoded.indices, delayCs: Math.max(2, delayMs / 10) });
  }

  return encodeIndexed(frames, width, height);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
