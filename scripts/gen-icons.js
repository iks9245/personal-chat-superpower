'use strict';
// A tiny dependency-free RGBA PNG encoder. Run from any working directory.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, crc]);
}
function png(size) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    const bubble = u >= .18 && u <= .82 && v >= .20 && v <= .68;
    const tail = u >= .23 && u <= .40 && v > .68 && v <= .83 && u < .40 - (v - .68);
    const line = u >= .30 && u <= .69 && ((v >= .33 && v <= .39) || (v >= .49 && v <= .55));
    const color = (bubble || tail) && !line ? [244, 255, 252, 255] : [28, 127, 111, 255];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    for (let channel = 0; channel < 4; channel++) pixels[offset + channel] = color[channel];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const directory = path.resolve(__dirname, '../icons'); fs.mkdirSync(directory, { recursive: true });
for (const size of [16, 32, 48, 128]) { fs.writeFileSync(path.join(directory, `${size}.png`), png(size)); console.log(`icons/${size}.png`); }
