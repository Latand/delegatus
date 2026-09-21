/**
 * The profiling probe's own verdicts, each driven to the answer it must NOT
 * give, in a real Chrome (#1821 review).
 *
 *   LLV_PROFILE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test scripts/profileBrowser.browser.test.ts
 *
 * A timing table is only as good as the milestone and the attribution under
 * it, and both used to go green on the wrong subject: a target row under
 * display:none counted as painted, a renderer with no animation frames still
 * produced a milestone, a poll that asked for another transcript was credited
 * to the target, and a poll was stamped delivered when its headers arrived.
 * The page here is a bare stand-in for the Viewer — the probe reads only the
 * attributes the Viewer renders — and the server answers a poll the way
 * POST /api/logs does, with its body held back on request.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import { armDocuments, Cdp, devToolsPort, launchChrome, navigate, pageWebSocketUrl, stop } from "./profileBrowser";

const CHROME = process.env.CHROME_BIN ?? "";
const browserTest = process.env.LLV_PROFILE_BROWSER_TEST === "1" && CHROME && fs.existsSync(CHROME) ? test : test.skip;

const TARGET = "/sessions/probe/target.jsonl";
const OTHER = "/sessions/probe/other.jsonl";

const PAGE = `<!doctype html><html><body style="margin:0">
<div id="target" data-link-path="${TARGET}" style="display:none"><div data-feed-kind="prose" style="height:40px">target row</div></div>
<div id="other" data-link-path="${OTHER}"><div data-feed-kind="prose" style="height:40px">other row</div></div>
</body></html>`;

let server: ReturnType<typeof Bun.serve> | null = null;
let chrome: ChildProcess | null = null;
let cdp: Cdp | null = null;
let scratch = "";

beforeAll(async () => {
  if (process.env.LLV_PROFILE_BROWSER_TEST !== "1" || !CHROME || !fs.existsSync(CHROME)) return;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/logs" && request.method === "POST") {
        const { reqs } = (await request.json()) as { reqs: Array<{ id: string; path: string; offset: number }> };
        const delay = Number(url.searchParams.get("delay") ?? 0);
        const chunks = Object.fromEntries(reqs.map((req) => [req.id, { data: "{\"type\":\"user\"}\n".repeat(8), offset: 128, size: 128, start: 0 }]));
        const body = JSON.stringify({ chunks });
        const encoder = new TextEncoder();
        /* Headers and the first bytes now, the rest after `delay`: the moment
           the fetch resolves is not the moment the answer is in hand. */
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode(body.slice(0, 8)));
            await Bun.sleep(delay);
            controller.enqueue(encoder.encode(body.slice(8)));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "application/json" } });
      }
      return new Response(PAGE, { headers: { "content-type": "text/html" } });
    },
  });
  scratch = fs.mkdtempSync(path.join(fs.existsSync("/var/tmp") ? "/var/tmp" : "/tmp", "llv-probe-check-"));
  const userDataDir = path.join(scratch, "chrome");
  chrome = launchChrome({ cdpPort: 0, userDataDir, home: scratch, chrome: CHROME });
  cdp = await Cdp.connect(await pageWebSocketUrl(await devToolsPort(userDataDir)));
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await armDocuments(cdp);
}, 60_000);

afterAll(async () => {
  cdp?.close();
  await stop(chrome);
  server?.stop(true);
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

const js = JSON.stringify;

async function fresh(): Promise<Cdp> {
  await navigate(cdp!, `http://127.0.0.1:${server!.port}/`);
  return cdp!;
}

/** How a probe promise ended, as a value: `resolved:<json>` or the rejection. */
function outcome(expression: string): string {
  return `(async () => {
    const p = window.__profile;
    try { return 'resolved:' + JSON.stringify(await (${expression})); }
    catch (error) { return 'rejected:' + (error && error.message ? error.message : String(error)); }
  })()`;
}

browserTest("a target row under display:none is never a painted milestone, and becomes one only once shown", async () => {
  const page = await fresh();
  /* In the DOM, with a row — and not on screen. */
  expect(await page.evaluate<number>(`window.__profile.rows(${js(TARGET)})`)).toBe(1);
  const hidden = await page.evaluate<string>(outcome(`p.paintedAt(() => p.targetPainted(${js(TARGET)}, "desktop"), 700)`));
  expect(hidden).toStartWith("rejected:milestone not reached");

  /* Shown 200 ms from now: the milestone is the frame that carries it. */
  const shown = await page.evaluate<string>(outcome(`(() => {
    const at = performance.now() + 200;
    setTimeout(() => { document.getElementById('target').style.display = 'block'; }, 200);
    return p.paintedAt(() => p.targetPainted(${js(TARGET)}, "desktop"), 5000).then((m) => ({ ...m, shownAt: at }));
  })()`));
  expect(shown).toStartWith("resolved:");
  const milestone = JSON.parse(shown.slice("resolved:".length)) as { rafConfirmed: boolean; detected: number; painted: number; shownAt: number };
  expect(milestone.rafConfirmed).toBe(true);
  expect(milestone.detected).toBeGreaterThanOrEqual(milestone.shownAt - 5);
  expect(milestone.painted).toBeGreaterThanOrEqual(milestone.detected);
}, 30_000);

browserTest("a milestone no animation frame confirms is rejected, never resolved unconfirmed", async () => {
  const page = await fresh();
  const suppressed = await page.evaluate<string>(outcome(`(() => {
    window.requestAnimationFrame = () => 0;
    return p.paintedAt(() => true, 5000);
  })()`));
  expect(suppressed).toStartWith("rejected:milestone not confirmed");
}, 30_000);

browserTest("a poll that asked only for another transcript is never the target's delivery", async () => {
  const page = await fresh();
  const seen = await page.evaluate<{ target: unknown; other: { via: string } | null }>(`(async () => {
    const response = await fetch('/api/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reqs: [{ id: '0', path: ${js(OTHER)}, offset: 0 }] }) });
    await response.json();
    const p = window.__profile;
    return { target: p.deliveryFor(${js(TARGET)}, 0), other: p.deliveryFor(${js(OTHER)}, 0) };
  })()`);
  expect(seen.target).toBeNull();
  expect(seen.other?.via).toBe("poll");
}, 30_000);

browserTest("a poll is delivered when its body completed, not when its headers arrived", async () => {
  const page = await fresh();
  const seen = await page.evaluate<{ headersAt: number; parsedAt: number; delivery: { at: number; via: string } | null }>(`(async () => {
    const response = await fetch('/api/logs?delay=400', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reqs: [{ id: '0', path: ${js(TARGET)}, offset: 0 }] }) });
    const headersAt = performance.now();
    /* Nothing is delivered while the body is still on its way. */
    const early = window.__profile.deliveryFor(${js(TARGET)}, 0);
    if (early !== null) return { headersAt, parsedAt: headersAt, delivery: { ...early, early: true } };
    await response.json();
    const parsedAt = performance.now();
    return { headersAt, parsedAt, delivery: window.__profile.deliveryFor(${js(TARGET)}, 0) };
  })()`);
  expect(seen.delivery?.via).toBe("poll");
  expect(seen.delivery!.at).toBeGreaterThanOrEqual(seen.headersAt + 300);
  expect(seen.delivery!.at).toBeLessThanOrEqual(seen.parsedAt + 1);
}, 30_000);
