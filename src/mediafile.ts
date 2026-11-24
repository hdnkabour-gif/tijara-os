/**
 * File safety for shop media, without native image libraries:
 *  - the REAL type comes from the bytes (magic numbers), never from the file name or the declared type;
 *  - only JPEG, PNG, WebP images and MP4/WebM videos are accepted (no SVG/HTML/scripts);
 *  - image dimensions are read from the headers and bounded;
 *  - metadata (EXIF/GPS, XMP, comments, text chunks) is removed byte-wise from JPEG, PNG and WebP;
 *  - MP4 duration is read from the movie header; videos are size- and duration-bounded.
 * The browser also re-encodes images before upload (dropping metadata); this server pass does not trust that.
 */
export type MediaType = 'image/jpeg' | 'image/png' | 'image/webp' | 'video/mp4' | 'video/webm';
export interface Checked { type: MediaType; kind: 'image' | 'video'; width?: number; height?: number; durationMs?: number; data: Buffer }

export class MediaError extends Error {}
const fail = (m: string): never => { throw new MediaError(m); };

export function sniff(b: Buffer): MediaType | null {
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length > 12 && b.toString('ascii', 4, 8) === 'ftyp' && /^(isom|iso2|mp41|mp42|avc1|M4V |dash)$/.test(b.toString('ascii', 8, 12))) return 'video/mp4';
  if (b.length > 4 && b.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  return null;
}

// ───────── images ─────────
function pngInfo(b: Buffer) {
  if (b.toString('ascii', 12, 16) !== 'IHDR') fail('PNG without header');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
/** keep only the chunks needed to display the picture (drop tEXt/iTXt/zTXt/eXIf/tIME and any unknown ancillary chunk) */
function pngStrip(b: Buffer): Buffer {
  const keep = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'cHRM', 'sRGB', 'iCCP', 'sBIT', 'pHYs', 'bKGD']);
  const out: Buffer[] = [b.subarray(0, 8)];
  let p = 8, seenEnd = false;
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), end = p + 12 + len;
    if (end > b.length) fail('truncated PNG');
    if (keep.has(type)) out.push(b.subarray(p, end));
    p = end;
    if (type === 'IEND') { seenEnd = true; break; }
  }
  if (!seenEnd) fail('PNG without end');
  return Buffer.concat(out);
}
function jpegScan(b: Buffer, strip: boolean): { width: number; height: number; data: Buffer } {
  const out: Buffer[] = [b.subarray(0, 2)];
  let p = 2, width = 0, height = 0;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) fail('corrupted JPEG');
    const marker = b[p + 1];
    if (marker === 0xd9) { out.push(b.subarray(p, p + 2)); break; }
    if (marker >= 0xd0 && marker <= 0xd7) { out.push(b.subarray(p, p + 2)); p += 2; continue; }
    const len = b.readUInt16BE(p + 2), end = p + 2 + len;
    if (len < 2 || end > b.length) fail('truncated JPEG');
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) { height = b.readUInt16BE(p + 5); width = b.readUInt16BE(p + 7); }
    // APP1 (EXIF/XMP), APP2..APP15 except the ICC profile in APP2, and COM (comments) are metadata
    const isMeta = marker === 0xfe || (marker >= 0xe1 && marker <= 0xef && !(marker === 0xe2 && b.toString('ascii', p + 4, p + 15) === 'ICC_PROFILE'));
    if (!(strip && isMeta)) out.push(b.subarray(p, end));
    p = end;
    if (marker === 0xda) { out.push(b.subarray(p)); break; }   // start of scan: the rest is image data
  }
  if (!width || !height) fail('JPEG without size');
  return { width, height, data: Buffer.concat(out) };
}
function webpScan(b: Buffer, strip: boolean): { width: number; height: number; data: Buffer } {
  let p = 12, width = 0, height = 0;
  const chunks: Buffer[] = [];
  while (p + 8 <= b.length) {
    const type = b.toString('ascii', p, p + 4), len = b.readUInt32LE(p + 4), end = p + 8 + len + (len & 1);
    if (p + 8 + len > b.length) fail('truncated WebP');
    if (type === 'VP8 ' && len >= 10) { width = b.readUInt16LE(p + 14) & 0x3fff; height = b.readUInt16LE(p + 16) & 0x3fff; }
    else if (type === 'VP8L' && len >= 5) { const v = b.readUInt32LE(p + 9); width = (v & 0x3fff) + 1; height = ((v >> 14) & 0x3fff) + 1; }
    else if (type === 'VP8X' && len >= 10) { width = 1 + b.readUIntLE(p + 12, 3); height = 1 + b.readUIntLE(p + 15, 3); }
    if (!(strip && (type === 'EXIF' || type === 'XMP '))) {
      const c = Buffer.from(b.subarray(p, Math.min(end, b.length)));
      if (strip && type === 'VP8X') c[8] &= ~0x0c;            // clear the EXIF/XMP flags we removed
      chunks.push(c);
    }
    p = end;
  }
  if (!width || !height) fail('WebP without size');
  const body = Buffer.concat(chunks), head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'ascii');
  return { width, height, data: Buffer.concat([head, body]) };
}

// ───────── video ─────────
/** MP4: find moov/mvhd and read timescale + duration (version 0 or 1). */
function mp4Duration(b: Buffer): number | null {
  const box = (start: number, end: number, name: string): [number, number] | null => {
    let p = start;
    while (p + 8 <= end) {
      let size = b.readUInt32BE(p); const type = b.toString('ascii', p + 4, p + 8); let head = 8;
      if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); head = 16; } else if (size === 0) size = end - p;
      if (size < head || p + size > end) return null;
      if (type === name) return [p + head, p + size];
      p += size;
    }
    return null;
  };
  const moov = box(0, b.length, 'moov'); if (!moov) return null;
  const mvhd = box(moov[0], moov[1], 'mvhd'); if (!mvhd) return null;
  const v = b[mvhd[0]], o = mvhd[0] + 4;
  const timescale = v === 1 ? b.readUInt32BE(o + 16) : b.readUInt32BE(o + 8);
  const duration = v === 1 ? Number(b.readBigUInt64BE(o + 20)) : b.readUInt32BE(o + 12);
  return timescale ? Math.round((duration / timescale) * 1000) : null;
}

export const LIMITS = { imageBytes: 3_000_000, thumbBytes: 300_000, videoBytes: 15_000_000, maxSide: 4096, minSide: 32, videoMs: 30_000 };

/** Validate and clean an upload. `expect` restricts the family (an image slot never accepts a video). */
export function checkMedia(raw: Buffer, expect: 'image' | 'video' | 'thumb'): Checked {
  const type = sniff(raw) ?? fail('unsupported file: use a JPEG, PNG or WebP photo, or an MP4/WebM video');
  const kind = type.startsWith('image/') ? 'image' : 'video';
  if ((expect === 'video') !== (kind === 'video')) fail(expect === 'video' ? 'this is not a video' : 'this is not a photo');
  if (kind === 'image') {
    const max = expect === 'thumb' ? LIMITS.thumbBytes : LIMITS.imageBytes;
    if (raw.length > max) fail(`photo larger than ${Math.round(max / 1000)} KB`);
    const r = type === 'image/png' ? { ...pngInfo(raw), data: pngStrip(raw) } : type === 'image/jpeg' ? jpegScan(raw, true) : webpScan(raw, true);
    if (r.width < LIMITS.minSide || r.height < LIMITS.minSide || r.width > LIMITS.maxSide || r.height > LIMITS.maxSide)
      fail(`photo size must be between ${LIMITS.minSide} and ${LIMITS.maxSide} pixels`);
    return { type, kind, width: r.width, height: r.height, data: r.data };
  }
  if (raw.length > LIMITS.videoBytes) fail(`video larger than ${LIMITS.videoBytes / 1_000_000} MB`);
  const durationMs = type === 'video/mp4' ? mp4Duration(raw) : null;
  if (type === 'video/mp4' && durationMs === null) fail('unreadable MP4 (no movie header)');
  if (durationMs !== null && durationMs > LIMITS.videoMs) fail(`video longer than ${LIMITS.videoMs / 1000} seconds`);
  return { type, kind, durationMs: durationMs ?? undefined, data: raw };
}
