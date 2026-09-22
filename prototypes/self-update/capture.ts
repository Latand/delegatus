/* Captures the prototype page at 1440 and 390 px and measures it.

     CHROME_BIN=google-chrome-stable bun prototypes/self-update/capture.ts \
       --url http://127.0.0.1:<port>/ --out <dir> --name <state> [--click <action>]... [--open-logs]

   Writes <out>/<name>-1440.png and <name>-390.png and appends one entry per
   viewport to <out>/geometry.json: horizontal overflow of the page, buttons
   whose box leaves the viewport, and pairs of text runs whose ink overlaps
   (text rects clipped by every overflow ancestor, so a truncated title is
   measured as drawn). `--click` presses a UI-only control before the capture
   (arm-host arms the runtime-host confirm); `--open-logs` expands every log
   disclosure. Mutating actions go through the API, not through this driver. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

interface Measure {
  overflowX: boolean;
  scrollWidth: number;
  clientWidth: number;
  clippedButtons: string[];
  overlaps: string[];
  height: number;
}

function flags(argv: string[], name: string): string[] {
  const out: string[] = [];
  argv.forEach((value, index) => { if (value === name && argv[index + 1]) out.push(argv[index + 1]!); });
  return out;
}

const argv = process.argv.slice(2);
const url = flags(argv, "--url")[0];
const out = resolve(flags(argv, "--out")[0] ?? "/var/tmp/llv-self-update-frames");
const name = flags(argv, "--name")[0];
const clicks = flags(argv, "--click");
const openLogs = argv.includes("--open-logs");
if (!url || !name) {
  console.error("Usage: capture.ts --url <url> --out <dir> --name <state> [--click <action>]... [--open-logs]");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

/* Runs in the page. Kept as a string-free function so playwright serialises it. */
function measure(): Measure {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const clipped: string[] = [];
  document.querySelectorAll("button").forEach((button) => {
    const rect = button.getBoundingClientRect();
    if (rect.width === 0) return;
    if (rect.left < -0.5 || rect.right > vw + 0.5) clipped.push(`${button.textContent?.trim()} [${Math.round(rect.left)}..${Math.round(rect.right)}]`);
  });

  const clipTo = (rect: DOMRect, node: Element): DOMRect | null => {
    let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
    for (let element: Element | null = node; element && element !== doc; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        const box = element.getBoundingClientRect();
        left = Math.max(left, box.left); right = Math.min(right, box.right);
        top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
      }
    }
    return right - left > 0.5 && bottom - top > 0.5 ? new DOMRect(left, top, right - left, bottom - top) : null;
  };

  const runs: { label: string; rect: DOMRect; owner: Element }[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim() || !node.parentElement) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      const visible = clipTo(rect, node.parentElement);
      if (visible) runs.push({ label: node.textContent.trim().slice(0, 40), rect: visible, owner: node.parentElement });
    }
  }
  const overlaps: string[] = [];
  for (let i = 0; i < runs.length; i += 1) {
    for (let j = i + 1; j < runs.length; j += 1) {
      const a = runs[i]!, b = runs[j]!;
      if (a.owner === b.owner) continue;
      const x = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
      const y = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
      if (x > 1 && y > 1) overlaps.push(`"${a.label}" × "${b.label}"`);
    }
  }
  return { overflowX: doc.scrollWidth > doc.clientWidth, scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, clippedButtons: clipped, overlaps, height: doc.scrollHeight };
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN ?? "google-chrome-stable", headless: true });
const report = join(out, "geometry.json");
let entries: Record<string, unknown>[] = [];
try { entries = JSON.parse(readFileSync(report, "utf8")) as Record<string, unknown>[]; } catch { /* first capture */ }
let failed = false;
try {
  for (const [width, height, mobile] of [[1440, 900, false], [390, 844, true]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: mobile ? 2 : 1, hasTouch: mobile, isMobile: mobile });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("#footer")?.textContent?.includes("Live") ?? false, undefined, { timeout: 10_000 });
    for (const action of clicks) {
      await page.locator(`[data-action="${action}"]`).first().click();
    }
    if (openLogs) {
      for (const toggle of await page.locator('[data-action="toggle-log"][aria-expanded="false"]').all()) await toggle.click();
    }
    await page.waitForTimeout(400);
    const file = join(out, `${name}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    const measured = await page.evaluate(measure);
    const bad = measured.overflowX || measured.clippedButtons.length > 0 || measured.overlaps.length > 0;
    failed ||= bad;
    entries = entries.filter((entry) => !(entry.name === name && entry.width === width));
    entries.push({ name, width, file, capturedAt: new Date().toISOString(), ...measured });
    console.log(`${bad ? "FAIL" : "ok  "} ${name} @${width}: overflowX=${measured.overflowX} clipped=${measured.clippedButtons.length} overlaps=${measured.overlaps.length} height=${measured.height} → ${file}`);
    for (const line of [...measured.clippedButtons, ...measured.overlaps]) console.log(`       ${line}`);
    await context.close();
  }
} finally {
  await browser.close();
  writeFileSync(report, `${JSON.stringify(entries, null, 2)}\n`);
}
process.exit(failed ? 1 : 0);
