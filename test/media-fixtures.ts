import zlib from 'node:zlib';

/** Small but structurally real media files for tests (no binary fixtures in the repo). */
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** A w x h RGB PNG; optionally with a tEXt chunk carrying "secret" metadata (must be stripped). */
export function png(w = 64, h = 48, text?: string) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x7f); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr),
    ...(text ? [chunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1'))] : []), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A JPEG marker skeleton (SOI, APP1 EXIF with a GPS string, SOF0 w x h, SOS + data, EOI). */
export function jpeg(w = 64, h = 48, exif?: string) {
  const seg = (marker: number, data: Buffer) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(data.length + 2, 2); return Buffer.concat([head, data]); };
  const sof = Buffer.alloc(15); sof[0] = 8; sof.writeUInt16BE(h, 1); sof.writeUInt16BE(w, 3); sof[5] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...(exif ? [seg(0xe1, Buffer.from(`Exif\0\0${exif}`, 'latin1'))] : []),
    seg(0xdb, Buffer.alloc(65)), seg(0xc0, sof), seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.alloc(200, 0x55), Buffer.from([0xff, 0xd9])]);
}
/** An MP4 skeleton: ftyp(isom) + moov/mvhd with the given duration (ms) + some mdat bytes. */
export function mp4(durationMs = 5000) {
  const box = (type: string, data: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(data.length + 8); h.write(type, 4, 'ascii'); return Buffer.concat([h, data]); };
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(durationMs, 16);
  return Buffer.concat([box('ftyp', Buffer.concat([Buffer.from('isom', 'ascii'), Buffer.alloc(4), Buffer.from('isomavc1', 'ascii')])),
    box('moov', box('mvhd', mvhd)), box('mdat', Buffer.alloc(2000, 0x11))]);
}
