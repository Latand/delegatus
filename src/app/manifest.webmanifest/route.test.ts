import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isGateExempt } from "@/lib/team/gate";
import { NextRequest } from "next/server";
import { GET } from "./route";

test("the manifest answers with the members Chromium needs to install the app", async () => {
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toStartWith("application/manifest+json");
  const body = await response.json() as Record<string, unknown> & { icons: { src: string; sizes: string; type: string }[] };
  expect(body.name).toBe("Delegatus");
  expect(body.start_url).toBe("/");
  expect(body.display).toBe("standalone");
  expect(body.icons.map((icon) => icon.sizes).sort()).toEqual(["192x192", "512x512"]);
  for (const icon of body.icons) {
    /* The icon is a file this repository serves, under the prefix the team gate lets through. */
    expect(readFileSync(join(process.cwd(), "public", icon.src), "utf8")).toContain("<svg");
    expect(icon.type).toBe("image/svg+xml");
  }
});

test("the manifest holds nothing about this machine or its key", async () => {
  const text = await GET().text();
  expect(text).not.toMatch(/token|\bk=|\/home\/|\/Users\//i);
});

test("the team gate lets a signed-out browser read the manifest and its icon", () => {
  const read = (path: string) => new NextRequest(`http://127.0.0.1${path}`, { method: "GET" });
  expect(isGateExempt(read("/manifest.webmanifest"))).toBe(true);
  expect(isGateExempt(read("/brand/delegatus-touch-icon.svg"))).toBe(true);
});

test("the document head links the manifest with the page's credentials", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: RootLayout } = await import("../layout");
  const html = renderToStaticMarkup(RootLayout({ children: null }));
  const links = html.match(/<link [^>]*rel="manifest"[^>]*>/g) ?? [];
  expect(links).toHaveLength(1);
  expect(links[0]).toContain('href="/manifest.webmanifest"');
  expect(links[0]).toContain('crossorigin="use-credentials"');
});
