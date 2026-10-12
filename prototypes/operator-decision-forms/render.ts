/*
 * Renders every frame of the operator decision forms prototype.
 *
 *   bun prototypes/operator-decision-forms/render.ts
 *
 * It copies this directory and the token file into a scratch directory under
 * $TMPDIR, links the dependency tree, bundles `main.tsx` with Bun, compiles
 * the app's Tailwind tokens, and drives headless Chromium over every frame.
 * Each PNG carries its variant number in a band above the app; `frames.json`
 * records each frame's measured geometry, and the run fails when an Answer
 * button leaves the screen or is covered, a touch row is under 44 px, a
 * thumbnail is not the size drawn, or the page scrolls sideways. PNGs stay
 * out of Git (`.gitignore` here).
 *
 * THUMBS names a directory holding v1.png and v2.png for the prototype round's
 * previews (default: the self-update lane's frames, when present).
 * NODE_MODULES names the dependency tree (default: the main checkout's).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "playwright-core";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
const scratchRoot = process.env.TMPDIR;
if (!scratchRoot) throw new Error("TMPDIR is unset: the build goes under the stage's scratch directory");
const work = fs.mkdtempSync(path.join(scratchRoot, "odf-"));
const outDir = path.join(here, "frames");
fs.mkdirSync(outDir, { recursive: true });

function mainCheckoutModules(): string {
  if (process.env.NODE_MODULES) return process.env.NODE_MODULES;
  const local = path.join(repo, "node_modules");
  if (fs.existsSync(local)) return local;
  const first = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }).split("\n")[0]!.replace(/^worktree /, "");
  return path.join(first, "node_modules");
}

/* 1. The scratch tree: this directory, the token file, linked dependencies. */
const protoDir = path.join(work, "prototypes", "operator-decision-forms");
fs.mkdirSync(protoDir, { recursive: true });
for (const name of ["app.css", "card.tsx", "copy.ts", "main.tsx"]) fs.copyFileSync(path.join(here, name), path.join(protoDir, name));
fs.mkdirSync(path.join(work, "src", "styles"), { recursive: true });
fs.copyFileSync(path.join(repo, "src/styles/tokens.css"), path.join(work, "src/styles/tokens.css"));
fs.symlinkSync(mainCheckoutModules(), path.join(work, "node_modules"));
const out = path.join(protoDir, "out");
fs.mkdirSync(path.join(out, "thumbs"), { recursive: true });
const thumbs = process.env.THUMBS ?? path.join(path.dirname(repo), "delegatus-pipeline-e9e98524/prototypes/self-update-confirm/frames");
for (const n of [1, 2]) {
  const source = [path.join(thumbs, `v${n}.png`), path.join(thumbs, `v${n}-desktop-light-uk-ready.png`)].find((file) => fs.existsSync(file));
  if (!source) throw new Error(`no thumbnail for variant ${n} under ${thumbs}; set THUMBS`);
  fs.copyFileSync(source, path.join(out, "thumbs", `v${n}.png`));
}

/* 2. The bundle and the stylesheet. */
const build = await Bun.build({
  entrypoints: [path.join(protoDir, "main.tsx")],
  outdir: out,
  target: "browser",
  minify: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!build.success) throw new AggregateError(build.logs, "bundle failed");
const cssIn = path.join(protoDir, "app.css");
const css = await postcss([tailwind({ base: work })]).process(fs.readFileSync(cssIn, "utf8"), { from: cssIn });
fs.writeFileSync(path.join(out, "app.css"), css.css);
fs.writeFileSync(path.join(out, "app.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script type="module" src="main.js"></script></body></html>`);
fs.writeFileSync(path.join(out, "frame.html"), `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#1d1f27}
.pf-band{box-sizing:border-box;height:56px;display:flex;align-items:center;gap:14px;padding:0 16px;font:600 15px/1.2 -apple-system,"Segoe UI",Inter,Roboto,sans-serif;color:#fff;background:#1d1f27;white-space:nowrap;overflow:hidden}
.pf-num{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:36px;padding:0 8px;border-radius:8px;background:#e8a33d;color:#1d1f27;font-size:22px;font-weight:800}
.pf-caption{min-width:0;overflow:hidden;text-overflow:ellipsis}
.pf-caption small{display:block;font-weight:500;font-size:12px;color:#b7bac6}
iframe{display:block;border:0}
</style></head><body><div class="pf-band"><span class="pf-num" id="pf-num"></span><span class="pf-caption"><span id="pf-name"></span><small id="pf-meta"></small></span></div><iframe id="pf-app"></iframe>
<script>const q=new URLSearchParams(location.search);document.getElementById("pf-num").textContent=q.get("v");document.getElementById("pf-name").textContent=q.get("name");document.getElementById("pf-meta").textContent=q.get("meta");const f=document.getElementById("pf-app");f.width=q.get("w");f.height=q.get("h");f.src="app.html?"+q.get("app");</script></body></html>`);

/* 3. The frames. */
const NAMES: Record<string, string> = { "1": "У розмові + стрічка зверху", "2": "Над полем вводу, по одному", "3": "Колонка «Рішення»" };
const STATES: Record<string, string> = { open: "питання оркестратора", proto: "прототипи від лейну", answered: "після відповіді" };
type Device = "desktop" | "phone";
interface Frame { v: string; device: Device; theme: "light" | "dark"; lang: "uk" | "en"; state: "open" | "proto" | "answered" }
const frames: Frame[] = [];
for (const v of ["1", "2", "3"]) {
  for (const device of ["desktop", "phone"] as const) {
    frames.push({ v, device, theme: "light", lang: "uk", state: "open" });
    frames.push({ v, device, theme: "dark", lang: "en", state: "open" });
    frames.push({ v, device, theme: "light", lang: "uk", state: "proto" });
    frames.push({ v, device, theme: "dark", lang: "uk", state: "answered" });
  }
}
const SIZE = { desktop: { w: 1440, h: 900 }, phone: { w: 390, h: 844 } };
const BAND = 56;

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(request) {
    const file = path.join(out, new URL(request.url).pathname.replace(/^\/+/, "") || "frame.html");
    if (!file.startsWith(out) || !fs.existsSync(file)) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file));
  },
});

/* CHROME_BIN, else the newest headless shell in the Playwright cache. */
function chromeBinary(): string | undefined {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(process.env.HOME ?? "", ".cache", "ms-playwright");
  if (!fs.existsSync(cache)) return undefined;
  const shell = fs.readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))[0];
  const binary = shell ? path.join(cache, shell, "chrome-headless-shell-linux64", "chrome-headless-shell") : null;
  return binary && fs.existsSync(binary) ? binary : undefined;
}

const browser = await chromium.launch({ headless: true, executablePath: chromeBinary() });
const results: Record<string, unknown>[] = [];
const failures: string[] = [];
try {
  for (const frame of frames) {
    const size = SIZE[frame.device];
    const context = await browser.newContext({ viewport: { width: size.w, height: size.h + BAND }, colorScheme: frame.theme, deviceScaleFactor: frame.device === "phone" ? 2 : 1, hasTouch: frame.device === "phone" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const app = new URLSearchParams({ v: frame.v, state: frame.state, lang: frame.lang, theme: frame.theme });
    const meta = [String(size.w), frame.theme === "dark" ? "темна" : "світла", frame.lang, STATES[frame.state]].join(" · ");
    const query = new URLSearchParams({ v: frame.v, name: NAMES[frame.v]!, meta, w: String(size.w), h: String(size.h), app: app.toString() });
    await page.goto(`http://127.0.0.1:${server.port}/frame.html?${query}`);
    const handle = await page.waitForSelector("#pf-app");
    const appFrame = (await handle.contentFrame())!;
    await appFrame.waitForSelector("[data-decision-card], [data-dc-pointer]", { timeout: 15_000 });
    await appFrame.evaluate(() => Promise.all([...document.images].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; }))));
    const geometry = await appFrame.evaluate((phone) => {
      const box = (element: Element) => {
        const r = element.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      };
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      /* A control counts as reachable when it is wholly inside the viewport and
         inside every clipping ancestor, and the point at its centre hits it. */
      const clipOf = (element: Element) => {
        let top = 0, bottom = vh, left = 0, right = vw;
        for (let node = element.parentElement; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.overflowY !== "visible" || style.overflowX !== "visible") {
            const r = node.getBoundingClientRect();
            top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom); left = Math.max(left, r.left); right = Math.min(right, r.right);
          }
        }
        return { top, bottom, left, right };
      };
      const reachable = (element: Element) => {
        const r = element.getBoundingClientRect();
        const c = clipOf(element);
        if (!(r.width > 0 && r.height > 0 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5 && r.left >= c.left - 0.5 && r.right <= c.right + 0.5)) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return Boolean(hit && (hit === element || element.contains(hit)));
      };
      /* A label is cut when its text's own range is wider than its box. */
      const cut = (element: Element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().width > element.getBoundingClientRect().width + 1;
      };
      const cards = [...document.querySelectorAll("[data-dc-subject]")].map((card) => {
        const options = [...card.querySelectorAll("[data-dc-option]")];
        const send = card.querySelector("[data-dc-send]")!;
        return {
          box: box(card),
          sendReachable: reachable(send),
          optionsReachable: options.filter(reachable).length,
          options: options.length,
          bodyScrolls: (() => { const body = card.querySelector("[data-dc-body]")!; return body.scrollHeight > body.clientHeight + 1; })(),
          minOptionHeight: Math.min(...options.map((o) => Math.round(o.getBoundingClientRect().height))),
          titleCut: card.querySelector("[data-dc-title]") ? cut(card.querySelector("[data-dc-title]")!) : null,
          thumbsOverlap: (() => {
            const r = [...card.querySelectorAll("[data-dc-thumb]")].map((img) => img.parentElement!.getBoundingClientRect());
            const c = card.getBoundingClientRect();
            return r.some((a, i) => a.right > c.right + 0.5 || r.slice(i + 1).some((b) => a.right > b.left + 0.5 && a.left < b.right - 0.5));
          })(),
          thumbs: [...card.querySelectorAll("[data-dc-thumb]")].map((img) => ({ n: img.getAttribute("data-dc-thumb"), ...box(img), natural: (img as HTMLImageElement).naturalWidth })),
        };
      });
      /* The transcript's share: the scroller's visible height, as a share of
         the conversation column (desktop) or the screen (phone). */
      const scroller = document.querySelector("[data-scroller]")!.getBoundingClientRect();
      const column = phone ? { height: vh } : document.querySelector("[data-conversation]")!.getBoundingClientRect();
      const sheet = document.querySelector("[data-decision-sheet]");
      const overlay = document.querySelector("[data-dc-overlay]");
      const strip = document.querySelector("[data-decision-strip]");
      return {
        viewport: { w: vw, h: vh },
        cards,
        pointer: document.querySelector("[data-dc-pointer]") && !sheet ? reachable(document.querySelector("[data-dc-pointer]")!) : null,
        strip: strip ? box(strip) : null,
        stripChipsCut: strip ? [...strip.querySelectorAll("[data-dc-chip] span")].filter(cut).length : 0,
        /* Overlays are subtracted: what they cover is not readable. */
        transcriptShare: sheet ? 0 : Math.round(((scroller.height - (overlay ? Math.max(0, Math.min(scroller.bottom, overlay.getBoundingClientRect().bottom) - scroller.top) : 0)) / column.height) * 100) / 100,
        horizontalOverflow: document.documentElement.scrollWidth > vw + 1,
        rawKeys: (document.body.innerText.match(/\b(?:dir|repo)-[0-9a-f]{8,}|conversation_[\w-]+/g) ?? []),
      };
    }, frame.device === "phone");
    const name = `v${frame.v}-${size.w}-${frame.theme}-${frame.lang}-${frame.state}`;
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    const thumbW = frame.device === "phone" || frame.v === "3" ? 150 : 176;
    const problems = [
      ...errors.map((message) => `page error: ${message}`),
      ...geometry.cards.filter((card) => !card.sendReachable).map(() => "Answer button not reachable"),
      ...geometry.cards.filter((card) => card.optionsReachable !== card.options && !card.bodyScrolls).map((card) => `${card.options - card.optionsReachable} option rows hidden`),
      ...(frame.device === "phone" ? geometry.cards.filter((card) => card.minOptionHeight < 44).map((card) => `option row ${card.minOptionHeight}px < 44px`) : []),
      ...geometry.cards.flatMap((card) => card.thumbs.filter((t) => t.w !== thumbW || t.h !== Math.round(thumbW * 0.6) || !t.natural).map((t) => `thumb ${t.n} drawn ${t.w}x${t.h}`)),
      ...(geometry.pointer === false ? ["pointer not reachable"] : []),
      ...(geometry.cards.length || (frame.v === "1" && frame.state === "answered") ? [] : ["no subject card"]),
      ...(geometry.cards.some((card) => card.titleCut) ? ["card title cut"] : []),
      ...(geometry.cards.some((card) => card.thumbsOverlap) ? ["thumbnails overlap or leave the card"] : []),
      ...(geometry.stripChipsCut ? [`${geometry.stripChipsCut} strip chips cut`] : []),
      ...(geometry.horizontalOverflow ? ["horizontal overflow"] : []),
      ...geometry.rawKeys.map((key) => `raw key shown: ${key}`),
    ];
    if (problems.length) failures.push(`${name}: ${problems.join("; ")}`);
    results.push({ frame: name, ...frame, width: size.w, geometry, problems });
    await context.close();
  }
} finally {
  await browser.close();
  server.stop(true);
  fs.rmSync(work, { recursive: true, force: true });
}
fs.writeFileSync(path.join(here, "frames.json"), `${JSON.stringify(results, null, 1)}\n`);
console.log(`${results.length} frames → ${path.relative(repo, outDir)}`);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
