import type { MetadataRoute } from "next";
import { PRODUCT_NAME } from "@/lib/brand";

/* The web app manifest: Chrome and Edge install Delegatus from this as an app
   with its own window and icon, from 127.0.0.1 as well (no service worker is
   needed for that). It is a route handler and not the `manifest.ts` file
   convention because the layout links it with `crossorigin="use-credentials"`.
   On an install with the access key on, the browser then sends the key's cookie
   with the manifest request like it does with the page's own, and the proxy
   answers both the same way. The file convention would add a second link that
   sends no credentials. The body holds the product's name, its colours and the
   two icons the page already serves, and nothing about this machine. */
export const dynamic = "force-static";

const TOUCH_ICON = "/brand/delegatus-touch-icon.svg";

function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    description: `${PRODUCT_NAME}: run and watch Codex and Claude agents from one board`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#262A36",
    theme_color: "#262A36",
    icons: [
      { src: TOUCH_ICON, sizes: "192x192", type: "image/svg+xml", purpose: "any" },
      { src: TOUCH_ICON, sizes: "512x512", type: "image/svg+xml", purpose: "any" },
    ],
  };
}

export function GET(): Response {
  return new Response(JSON.stringify(manifest()), {
    headers: { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
