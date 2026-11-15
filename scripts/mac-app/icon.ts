import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const directory = process.argv[2];
if (!directory) throw new Error("Pass an iconset directory");
await mkdir(directory, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    await sharp("public/brand/delegatus-touch-icon.svg").resize(size * scale, size * scale)
      .png().toFile(`${directory}/icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`);
  }
}
