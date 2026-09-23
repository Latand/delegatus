import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

/* The iOS home-screen icon. Apple accepts only a raster here, and a committed
   raster needs generator provenance under the privacy gate, so the PNG is drawn
   at build time from the committed SVG: the emblem mark on a full-bleed slate
   square, the shape iOS rounds itself. */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  const svg = readFileSync(join(process.cwd(), "public", "brand", "delegatus-touch-icon.svg"));
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:image/svg+xml;base64,${svg.toString("base64")}`} width={size.width} height={size.height} alt="" />
      </div>
    ),
    size,
  );
}
