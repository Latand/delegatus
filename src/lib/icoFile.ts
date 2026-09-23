/**
 * Packs PNG images into one ICO container. Every current reader of /favicon.ico
 * accepts PNG-compressed entries (Windows Vista onward, every browser), so the
 * PNGs go in as they are: a 6-byte header, one 16-byte directory entry per
 * image, then the image bytes.
 */
export interface IcoImage {
  /** Square edge in pixels, 1..256. */
  size: number;
  png: Uint8Array;
}

export function packIco(images: readonly IcoImage[]): Uint8Array<ArrayBuffer> {
  const headerBytes = 6 + images.length * 16;
  const total = headerBytes + images.reduce((sum, image) => sum + image.png.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type 1 = icon
  view.setUint16(4, images.length, true);
  let offset = headerBytes;
  images.forEach((image, index) => {
    if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256) {
      throw new RangeError(`ICO entries are 1..256 px, got ${image.size}`);
    }
    const entry = 6 + index * 16;
    view.setUint8(entry, image.size === 256 ? 0 : image.size); // width, 0 means 256
    view.setUint8(entry + 1, image.size === 256 ? 0 : image.size); // height
    view.setUint8(entry + 2, 0); // no palette
    view.setUint8(entry + 3, 0); // reserved
    view.setUint16(entry + 4, 1, true); // colour planes
    view.setUint16(entry + 6, 32, true); // bits per pixel
    view.setUint32(entry + 8, image.png.byteLength, true);
    view.setUint32(entry + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.byteLength;
  });
  return out;
}
