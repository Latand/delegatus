import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { packIco } from "@/lib/icoFile";

/* /favicon.ico for the clients that ask for it by name: bookmarks, feed
   readers, link previews, older browsers. The page head links icon.svg, and
   this route adds no <link>, so the SVG stays the icon a modern browser picks.
   A committed .ico is a raster the privacy gate cannot read, so the ICO is
   drawn at build time from the committed emblem SVGs, like apple-icon.tsx:
   the 16 px grid mark for the smallest size, the 64-grid mark for the rest. */
export const dynamic = "force-static";

const SIZES = [
  { size: 16, source: "delegatus-mark-16.svg" },
  { size: 32, source: "delegatus-mark.svg" },
  { size: 48, source: "delegatus-mark.svg" },
] as const;

async function renderPng(size: number, source: string): Promise<Uint8Array> {
  const svg = readFileSync(join(process.cwd(), "public", "brand", source));
  const response = new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`data:image/svg+xml;base64,${svg.toString("base64")}`} width={size} height={size} alt="" />
      </div>
    ),
    { width: size, height: size },
  );
  return new Uint8Array(await response.arrayBuffer());
}

export async function GET(): Promise<Response> {
  const images = await Promise.all(SIZES.map(async ({ size, source }) => ({ size, png: await renderPng(size, source) })));
  return new Response(packIco(images), {
    headers: { "Content-Type": "image/x-icon" },
  });
}
