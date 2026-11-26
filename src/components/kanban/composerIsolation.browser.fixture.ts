import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { Browser, Page, Route } from "playwright-core";
import { isolationCatalogReplies } from "./composerIsolationCatalog.fixture";

import type { IsolationMix, IsolationWindow } from "./composerIsolation.fixture";
import { installTypingProbe, type TypingWindow } from "./composerTypingProbe.fixture";
import { buildEvidenceAssets, openFixture } from "./issue1695BrowserHarness";
import { taskIconNodes } from "@/lib/tasks/taskIconNodes";

const ORIGIN = "https://composer-fixture.test";
const hash = (s: Uint8Array | string) => createHash("sha256").update(s).digest("hex");

async function routeAssets(page: Page, entry: string, assets: Awaited<ReturnType<typeof buildEvidenceAssets>>, catalog: (route: Route) => Promise<void>) {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    switch (url.pathname) {
      case "/": return route.fulfill({ contentType: "text/html", body: assets.html });
      case "/app.js": return route.fulfill({ contentType: "text/javascript", path: entry });
      case "/style.css": return route.fulfill({ contentType: "text/css", body: assets.css });
      case "/api/files": return catalog(route);
      case "/api/task-icons": return route.fulfill({ json: { icons: await taskIconNodes((url.searchParams.get("names") ?? "").split(",").filter(Boolean)) } });
      case "/brand/delegatus-mark.svg": return route.fulfill({ path: path.resolve("public/brand/delegatus-mark.svg"), contentType: "image/svg+xml" });
      default: return route.fulfill({ status: 404, body: "" });
    }
  });
}

const cells: Array<{ label: string; mix: IsolationMix; rate: number; plain?: boolean }> = [
  { label: "quiet", mix: "quiet", rate: 0 }, { label: "plain", mix: "quiet", rate: 0, plain: true },
  { label: "foreign-6", mix: "foreign", rate: 6 }, { label: "foreign-40", mix: "foreign", rate: 40 },
  { label: "sibling-6", mix: "sibling", rate: 6 }, { label: "sibling-40", mix: "sibling", rate: 40 },
  { label: "mixed-6", mix: "mixed", rate: 6 },
  { label: "catalog", mix: "catalog", rate: 0.5 },
];

async function keys(page: Page, text: string, delay = 100) {
  const start = performance.now();
  const dispatch: number[] = [];
  for (let i = 0; i < text.length; i++) {
    await page.waitForTimeout(Math.max(0, start + i * delay - performance.now()));
    dispatch.push(performance.now()-start);
    await page.keyboard.press(text[i] === " " ? "Space" : text[i]!);
  }
  return dispatch;
}

export async function measureComposerIsolation(browser: Browser, hostSample: () => { load: number[]; groups: Array<{quota:string; memory:string; throttledUsec:number}> }) {
  const mode = process.env.ISOLATION_MODE ?? "timing";
  if (!["smoke", "structure", "timing"].includes(mode)) throw Error("unknown isolation mode");
  const structure = mode === "structure";
  const out = path.resolve(process.env.ISOLATION_OUT ?? ".artifacts/composer-isolation");
  fs.mkdirSync(out, { recursive: true });
  const assets = await buildEvidenceAssets(out, undefined, { isolationCounters: structure, derivationTiming: structure });
  const base = process.env.ISOLATION_BASE_BUNDLE;
  if (mode === "timing" && !base) throw Error("paired timings require ISOLATION_BASE_BUNDLE");
  const widths = process.env.ISOLATION_WIDTH ? [Number(process.env.ISOLATION_WIDTH)] : [1440, 915, 390];
  const rounds = process.env.ISOLATION_PAIR ? [Number(process.env.ISOLATION_PAIR)] : mode === "timing" ? [1,2,3,4,5] : [1];
  const selected = process.env.ISOLATION_CELLS ? cells.filter(c => process.env.ISOLATION_CELLS!.split(",").includes(c.label))
    : structure ? cells.filter(c => ["foreign-6","sibling-6","catalog"].includes(c.label))
    : mode === "smoke" ? cells.filter(c => c.label === "foreign-6") : cells;
  if (structure && !process.env.ISOLATION_CELLS) selected.push({ label: "missing-6", mix: "miss", rate: 6 });
  if (!selected.length || widths.some(w => ![390,915,1440].includes(w)) || rounds.some(n => !Number.isInteger(n) || n<1 || n>5)) throw Error("invalid corpus selection");
  for (const width of widths) for (const pair of rounds) for (const cell of selected) {
    const sides = base ? pair % 2 ? ["before","after"] : ["after","before"] : ["after"];
    for (const side of sides) {
      const name = `${mode}-${width}-${cell.label}-${pair}-${side}`;
      const entry = side === "before" ? base! : assets.entry;
      const bundle = hash(fs.readFileSync(entry));
      const file = path.join(out, name + ".json");
      const { context, page, pageErrors } = await openFixture(browser, "about:blank", { width, height: width === 390 ? 844 : width === 915 ? 872 : 900 },
        "light", "en", "reduce", width === 390, 1);
      try {
        await page.bringToFront();
        // Freeze fixture dates while the browser timestamps input, runs timers and schedules real frames.
        await page.addInitScript(epoch => {
          const nativeDate = Date;
          let start: number | undefined;
          const fixtureNow = () => epoch + (start === undefined ? 0 : Math.floor(performance.now() - start));
          Object.defineProperty(window, "__startIsolationDate", { value: () => { start ??= performance.now(); } });
          globalThis.Date = new Proxy(nativeDate, {
            get(target, key, receiver) { return key === "now" ? fixtureNow : Reflect.get(target, key, receiver); },
            apply() { return new nativeDate(fixtureNow()).toString(); },
            construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [fixtureNow()], newTarget); },
          });
        }, Date.parse("2026-11-25T12:00:00Z"));
        const catalogRoute: { current?: ReturnType<typeof isolationCatalogReplies> } = {};
        await routeAssets(page, entry, assets, route => {
          const transport = catalogRoute.current;
          if (!transport) throw Error("catalog route was used before admission");
          const headers = route.request().headers();
          const delta = headers["x-llv-board-protocol"] === "2" && headers["x-llv-board-scope"] === "fixture.global";
          return route.fulfill(transport.reply(Number(headers["x-isolation-revision"]), headers["if-none-match"], delta));
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await page.goto(ORIGIN + "/?scenario=composer-isolation&streaming=1&seathost=30");
        await page.waitForFunction(() => (window as IsolationWindow).composerIsolation?.census().connection === "live", undefined, { timeout: 90000 });
        if (width === 390) {
          await page.locator("[data-mobile2-seat-open]").click({ timeout: 60000 });
          await page.waitForFunction(() => location.hash === "#c=" + (window as IsolationWindow).composerIsolation.census().openId);
        }
        const field = page.locator(width === 390 ? "textarea[data-composer-field]:visible" : "[data-kanban-seat] textarea[data-composer-field]:visible");
        await field.waitFor({ timeout: 60000 });
        await field.focus();
        if (cell.plain) await field.evaluate(element => {
          const source = element as HTMLTextAreaElement;
          const box = source.getBoundingClientRect();
          const style = getComputedStyle(source);
          const el = document.createElement("textarea");
          el.wrap = source.wrap; el.value = source.value; el.spellcheck = source.spellcheck;
          Object.assign(el.style, { position:"fixed", left:box.left+"px", top:box.top+"px", zIndex:"99999",
            boxSizing:"border-box", width:box.width+"px", height:box.height+"px", padding:style.padding,
            border:style.border, font:style.font, letterSpacing:style.letterSpacing, whiteSpace:style.whiteSpace, overflowWrap:style.overflowWrap });
          document.body.appendChild(el); el.focus();
        });
        await page.evaluate(async () => { await document.fonts.ready; });
        await page.waitForTimeout(1000);
        const corpus = await page.evaluate(() => ({ ...(window as IsolationWindow).composerIsolation.census(),
          font: getComputedStyle(document.activeElement!).fontFamily, nodes: document.querySelectorAll("*").length, cards: document.querySelectorAll("[data-kanban-board] .card[data-id]").length }));
        const seedDigest = await page.evaluate(() => (window as IsolationWindow).composerIsolation.seedDigest());
        const wire = await page.evaluate(() => (window as IsolationWindow).composerIsolation.catalogSeed());
        const transport = isolationCatalogReplies(wire.body, wire.targetPath, cell.mix === "catalog");
        catalogRoute.current = transport;
        await page.evaluate(() => (window as IsolationWindow).composerIsolation.routeCatalog());
        const certifySize = (target: string) => page.evaluate(path =>
          (window as IsolationWindow & { __isolationCertifiedSize(path: string): number | undefined }).__isolationCertifiedSize(path), target);
        const initialSize = structure && cell.mix === "catalog" ? await certifySize(wire.targetPath) : undefined;
        if (structure && cell.mix === "catalog" && initialSize === undefined) throw Error("catalog target has no admitted row");
        if (corpus.admittedRows !== corpus.files) throw Error("partial catalog in the measured view");
        if (corpus.reads.catalog === 0 || corpus.reads.board === 0 || corpus.reads.snapshots === 0) throw Error("missing fixture bootstrap read");
        if (corpus.sessions !== 1710) throw Error("expected 1710 runtime conversations: " + JSON.stringify(corpus));
        if (mode === "timing" && width === 1440 && Math.abs(corpus.nodes - 23500) > 1200) {
          throw Error("desktop DOM size outside the calibrated range: " + corpus.nodes);
        }
        await page.evaluate(() => (window as typeof window & { __startIsolationDate(): void }).__startIsolationDate());
        await page.evaluate(installTypingProbe);
        await keys(page, mode === "smoke" ? "key " : "type ".repeat(4));
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const text = "type ".repeat(24).slice(0, structure ? 37 : mode === "smoke" ? 12 : 120);
        const wireBefore = { ...transport.counts };
        const startedUtc = new Date().toISOString();
        const hostBefore = hostSample();
        await page.evaluate(({ mix, rate, text, structure }) => (window as TypingWindow).isolationTyping.start(mix,rate,text,structure), { ...cell,text,structure });
        const driverDispatchMs = await keys(page, text);
        await page.waitForFunction(() => (window as TypingWindow).isolationTyping.complete(), undefined, { timeout: 15000 });
        const reading = await page.evaluate(() => (window as TypingWindow).isolationTyping.finish());
        const hostAfter = hostSample();
        if (!reading.focus || !reading.text || !reading.caret || (cell.rate > 0 && !reading.events) || pageErrors.length) {
          throw Error("invalid typing run: " + JSON.stringify({ focus:reading.focus,text:reading.text,caret:reading.caret,events:reading.events,pageErrors }));
        }
        const sorted = [...reading.samples].sort((a,b)=>a-b);
        const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
        const finalReads = await page.evaluate(() => (window as IsolationWindow).composerIsolation.census().reads);
        const wireAfter = { ...transport.counts };
        if (initialSize !== undefined) {
          await page.waitForFunction(({ target, initial }) => {
            const read = (window as IsolationWindow & { __isolationCertifiedSize(path: string): number | undefined }).__isolationCertifiedSize;
            return (read(target) ?? -1) > initial;
          }, { target: wire.targetPath, initial: initialSize }, { timeout: 5000 });
        }
        const catalogResponses = { ...transport.counts, wireBefore, wireAfter, initialSize, acceptedSize: initialSize === undefined ? undefined : await certifySize(wire.targetPath) };
        if (cell.mix === "catalog" && reading.events && !catalogResponses.delta) throw Error("catalog revision did not deliver its delta");
        const ownReceiptMs = structure && cell.mix === "foreign" ? await page.evaluate(() => {
          const root = document.activeElement?.closest("[data-kanban-seat], main");
          if (!root) throw Error("missing focused seat");
          const selector = "[data-receipt-problem-count], [data-receipts-chip]";
          if (root.querySelector(selector)) throw Error("receipt positive control needs an empty slot");
          return new Promise<number>((resolve, reject) => {
            const start = performance.now();
            const timeout = setTimeout(() => { observer.disconnect(); reject(Error("receipt never reached the focused composer")); }, 3000);
            const observer = new MutationObserver(() => {
              if (root.querySelector(selector)) { clearTimeout(timeout); observer.disconnect(); resolve(performance.now()-start); }
            });
            observer.observe(root,{ childList: true, subtree:true, attributes:true });
            (window as IsolationWindow).composerIsolation.ownReceipt();
          });
        }) : null;
        const result = { name, width, pair, side, mode, catalogResponses, startedUtc, hostBefore, hostAfter, seedDigest, finalReads, driverDispatchMs, cpuThrottle: 4, browser: browser.version(), ownReceiptMs, ...cell, corpus, bundle, stylesheet:hash(assets.css), p95,
          p50:sorted[Math.ceil(sorted.length/2)-1], max:sorted.at(-1), ...reading };
        fs.writeFileSync(file, JSON.stringify(result, null, 2)+"\n");
        if (structure && (cell.mix === "miss" || cell.mix === "foreign")) {
          const c = reading.counters;
          if (reading.events !== 12 || !c || c.fieldGeometry || c.projectReplacedRows || c.projectArraysPublished
            || (cell.mix === "miss" && (c.publishedArrays || c.replacedRows))) {
            throw Error("baseline structural guard: " + JSON.stringify(c));
          }
        }
        if (structure && cell.mix === "foreign") await page.screenshot({ path:path.join(out, name+".png") });
        console.log(name, "p95", p95.toFixed(2), "events", reading.events, "nodes", corpus.nodes);
      } catch (error) {
        const state = await page.evaluate(() => ({ url:location.href, title:document.title, focus:document.activeElement?.outerHTML.slice(0,260),
          corpus:(window as IsolationWindow).composerIsolation?.census(), fields:[...document.querySelectorAll("textarea")].map(f=>[f.getAttribute("aria-label"),f.closest("[data-kanban-seat],[data-mobile2-sheet]")?.tagName]),
          body:document.body.innerText.slice(0,800) })).catch(()=>null);
        fs.writeFileSync(path.join(out, name+"-failure.json"),JSON.stringify({ error:String(error),state,pageErrors },null,2));
        throw error;
      } finally { await context.close(); }
    }
  }
}
