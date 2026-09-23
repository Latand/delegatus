import { expect, test } from "bun:test";
import { GET } from "./route";

/* The Delegatus brand change removed the committed favicon.ico, and
   /favicon.ico answered 404. The route draws it from the emblem SVGs. */
test("GET /favicon.ico answers an ICO holding 16, 32 and 48 px PNGs", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/x-icon");

  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.subarray(0, 4)]).toEqual([0x00, 0x00, 0x01, 0x00]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  expect(count).toBe(3);

  const sizes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = bytes[entry];
    expect(bytes[entry + 1]).toBe(width);
    sizes.push(width);
    const length = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    expect(offset + length).toBeLessThanOrEqual(bytes.byteLength);
    const png = bytes.subarray(offset, offset + length);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // The PNG's own IHDR must agree with the directory entry.
    const pngView = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(pngView.getUint32(16)).toBe(width);
    expect(pngView.getUint32(20)).toBe(width);
  }
  expect(sizes).toEqual([16, 32, 48]);
});
