import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { FRAME_SCOPE_TTL_MS, mintFrameScope } from "@/lib/artifact/frameScope";
import { FRAME_SANDBOX } from "@/components/preview/DocumentPanes";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-artifact-frame-"));
const { GET } = await import("./route");
const { GET: GET_ARTIFACT } = await import("../../route");

const savedHome = process.env.HOME;
let home = "";

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(sandbox, "home-")));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
});
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function write(rel: string, content: string): string {
  const abs = path.join(home, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/* What the report frame's own requests look like: an opaque origin, so the
   browser marks them cross-site and sends `Origin: null` on CORS requests. */
const FRAME_REQUEST_HEADERS = { host: "127.0.0.1:8898", "sec-fetch-site": "cross-site", "sec-fetch-dest": "iframe" };

function frameRequest(urlPath: string, headers: Record<string, string> = FRAME_REQUEST_HEADERS): NextRequest {
  return new NextRequest(new URL(urlPath, "http://127.0.0.1:8898"), { headers });
}

function reportDir(): string {
  const dir = path.join(home, "checkout/reports/round-2");
  write("checkout/reports/round-2/index.html", '<link rel="stylesheet" href="style.css"><h2 id="decision-graph">Graph</h2><img src="assets/g.png">');
  write("checkout/reports/round-2/style.css", "h2 { color: teal }");
  write("checkout/reports/round-2/assets/app.js", "document.title = 'ok';");
  write("checkout/secrets.md", "outside the report");
  return dir;
}

test("the meta read of an HTML report mints a frame URL scoped to its directory", async () => {
  const dir = reportDir();
  const url = new URL("http://127.0.0.1:8898/api/artifact");
  url.searchParams.set("path", path.join(dir, "index.html"));
  url.searchParams.set("mode", "meta");
  const res = await GET_ARTIFACT(new NextRequest(url, { headers: { host: "127.0.0.1:8898" } }));
  expect(res.status).toBe(200);
  const meta = (await res.json()) as { frame?: string };
  expect(meta.frame).toMatch(/^\/api\/artifact\/frame\/[^/]+\/index\.html$/);

  const page = await GET(frameRequest(meta.frame!));
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await page.text()).toContain('id="decision-graph"');
});

test("relative assets load with their real types, from the same scope", async () => {
  const scope = mintFrameScope(reportDir());
  const css = await GET(frameRequest(`/api/artifact/frame/${scope}/style.css`));
  expect(css.status).toBe(200);
  expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
  const js = await GET(frameRequest(`/api/artifact/frame/${scope}/assets/app.js`));
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
});

test("every response runs in an origin-less sandbox: scripts yes, the viewer's origin no", async () => {
  const scope = mintFrameScope(reportDir());
  for (const res of [
    await GET(frameRequest(`/api/artifact/frame/${scope}/index.html`)),
    await GET(frameRequest(`/api/artifact/frame/${scope}/missing.html`)),
    await GET(frameRequest(`/api/artifact/frame/forged/index.html`)),
  ]) {
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp.startsWith("sandbox ")).toBe(true);
    expect(csp).toContain("allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  }
  /* The iframe attribute carries the same promise. */
  expect(FRAME_SANDBOX).toContain("allow-scripts");
  expect(FRAME_SANDBOX).not.toContain("allow-same-origin");
});

test("the frame cannot read the viewer: its requests to the viewer's API are refused", async () => {
  const dir = reportDir();
  const url = new URL("http://127.0.0.1:8898/api/artifact");
  url.searchParams.set("path", path.join(dir, "../../secrets.md"));
  for (const headers of [
    /* fetch() from the sandboxed page */
    { host: "127.0.0.1:8898", origin: "null", "sec-fetch-site": "cross-site" },
    /* a no-cors subresource from the sandboxed page */
    { host: "127.0.0.1:8898", "sec-fetch-site": "cross-site" },
  ]) {
    const res = await GET_ARTIFACT(new NextRequest(url, { headers }));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain("outside the report");
  }
});

test("a scope reaches nothing outside its report directory", async () => {
  const scope = mintFrameScope(reportDir());
  for (const escape of ["../../secrets.md", "..%2F..%2Fsecrets.md", "%2E%2E/%2E%2E/secrets.md", "assets/..%2F..%2F..%2Fsecrets.md"]) {
    const res = await GET(frameRequest(`/api/artifact/frame/${scope}/${escape}`));
    expect([403, 404]).toContain(res.status);
    expect(await res.text()).not.toContain("outside the report");
  }
});

test("a symlink inside the report that points out of it is refused", async () => {
  const dir = reportDir();
  fs.symlinkSync(path.join(home, "checkout/secrets.md"), path.join(dir, "linked.md"));
  const res = await GET(frameRequest(`/api/artifact/frame/${mintFrameScope(dir)}/linked.md`));
  expect(res.status).toBe(403);
});

test("forged, altered and expired scopes are refused", async () => {
  const dir = reportDir();
  const scope = mintFrameScope(dir);
  const [encodedDir, expiry, signature] = scope.split(".");
  const other = Buffer.from(path.join(home, "checkout"), "utf8").toString("base64url");
  for (const bad of [
    "forged",
    `${other}.${expiry}.${signature}`,
    `${encodedDir}.${(Date.now() + 10 * FRAME_SCOPE_TTL_MS).toString(36)}.${signature}`,
    `${encodedDir}.${expiry}.${signature!.slice(0, -2)}AA`,
    mintFrameScope(dir, Date.now() - 2 * FRAME_SCOPE_TTL_MS),
  ]) {
    const res = await GET(frameRequest(`/api/artifact/frame/${bad}/index.html`));
    expect(res.status).toBe(403);
  }
});

test("a scope for a directory outside home serves nothing", async () => {
  const outside = fs.mkdtempSync(path.join(sandbox, "outside-"));
  fs.writeFileSync(path.join(outside, "index.html"), "<p>outside</p>");
  const res = await GET(frameRequest(`/api/artifact/frame/${mintFrameScope(outside)}/index.html`));
  expect(res.status).toBe(403);
});

test("types the preview does not serve stay unserved", async () => {
  const dir = reportDir();
  write("checkout/reports/round-2/session.jsonl", "{}\n");
  write("checkout/reports/round-2/.env", "X=1\n");
  const scope = mintFrameScope(dir);
  expect((await GET(frameRequest(`/api/artifact/frame/${scope}/session.jsonl`))).status).toBe(415);
  expect((await GET(frameRequest(`/api/artifact/frame/${scope}/.env`))).status).toBe(415);
});

test("a foreign Host header is refused before the scope is read", async () => {
  const scope = mintFrameScope(reportDir());
  const res = await GET(frameRequest(`/api/artifact/frame/${scope}/index.html`, { host: "attacker.example" }));
  expect(res.status).toBe(403);
});
