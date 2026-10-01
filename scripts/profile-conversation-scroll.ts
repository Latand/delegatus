/**
 * Scroll profile of a fully expanded conversation inside its kanban card
 * (docs/design/conversation-scroll-perf.md).
 *
 * Opens the board of one project, clicks the card tile that opens the
 * conversation as a reader, wheels up and clicks «показати раніше» until the
 * whole history is in the feed, then drives a scripted wheel scroll at a fixed
 * speed through it and records a Chrome trace of that scroll alone.
 *
 *   # same transcript, local build: pages from a local `next start`, data from the Viewer
 *   bun scripts/profile-conversation-scroll.ts proxy --app http://127.0.0.1:<next port> --data http://127.0.0.1:8898
 *
 *   bun scripts/profile-conversation-scroll.ts run --url <proxy or Viewer origin> \
 *     --project <project key> --card task:<task id> --tile <n> --conversation <conversation id> \
 *     --out <dir> [--runs 3] [--speed 2000] [--seconds 5] [--count] [--invalidation] [--ablate speech,frameh,cv,composite]
 *
 *   bun scripts/profile-conversation-scroll.ts analyze <trace.json>
 *
 *   # rendered evidence: the expanded feed in the card (1440), the full view (1440) and the phone (390), light and dark
 *   bun scripts/profile-conversation-scroll.ts shots --url <proxy or Viewer origin> \
 *     --project <project key> --card task:<task id> --tile <n> --conversation <conversation id> --out <dir> [--only card-1440|full-1440|phone-390]
 *
 * Read-only against whatever it is pointed at: in the page every non-GET
 * fetch, XHR and beacon is refused, and the proxy refuses every non-GET /api
 * request. The readers it opens live in a throwaway browser profile.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";

const [mode, ...rest] = process.argv.slice(2);
const args = new Map<string, string>();
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i]!;
  if (!a.startsWith("--")) { args.set("_", a); continue; }
  const n = rest[i + 1];
  if (n !== undefined && !n.startsWith("--")) { args.set(a.slice(2), n); i += 1; } else args.set(a.slice(2), "1");
}

/* ── proxy ─────────────────────────────────────────────────────────────── */

function proxy(): void {
  const app = args.get("app")!;
  const data = args.get("data") ?? "http://127.0.0.1:8898";
  const HOP = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "accept-encoding", "content-length", "content-encoding", "host"];
  const server = Bun.serve({
    port: Number(args.get("port") ?? 0),
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const isApi = url.pathname.startsWith("/api/");
      if (isApi && !/^(GET|HEAD)$/.test(request.method)) return Response.json({ error: "read-only profile" }, { status: 403 });
      const headers = new Headers(request.headers);
      for (const h of HOP) headers.delete(h);
      const upstream = await fetch(new URL(url.pathname + url.search, isApi ? data : app), {
        method: request.method, headers, redirect: "manual",
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      });
      const out = new Headers(upstream.headers);
      for (const h of HOP) out.delete(h);
      return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
    },
  });
  console.log(`proxy http://127.0.0.1:${server.port} pages=${app} data=${data}`);
}

/* ── analyze ───────────────────────────────────────────────────────────── */

type Ev = { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: any };

export function analyze(file: string) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const events: Ev[] = Array.isArray(raw) ? raw : raw.traceEvents;
  const threads = new Map<string, string>();
  for (const e of events) if (e.ph === "M" && e.name === "thread_name") threads.set(`${e.pid}:${e.tid}`, e.args.name);
  const busy = new Map<string, number>();
  for (const e of events) {
    const key = `${e.pid}:${e.tid}`;
    if (threads.get(key) === "CrRendererMain" && e.ph === "X" && e.name === "RunTask") busy.set(key, (busy.get(key) ?? 0) + (e.dur ?? 0));
  }
  const mainKey = [...busy].sort((a, b) => b[1] - a[1])[0]![0];
  const renderer = Number(mainKey.split(":")[0]);
  const inputs = events.filter((e) => /GestureScrollUpdate|EventLatency/.test(e.name)).map((e) => e.ts);
  const start = Math.min(...inputs);
  const end = Math.max(...inputs);
  const inWindow = (e: Ev) => e.ts >= start && e.ts <= end;
  const windowMs = (end - start) / 1000;

  /* Frames: one per frame_sequence. With a main-thread scroll only a frame
     PRESENTED_ALL shows the new offset; a PARTIAL one repeats the old. */
  const rank = (s: string) => (s === "STATE_PRESENTED_ALL" ? 3 : s === "STATE_PRESENTED_PARTIAL" ? 2 : s === "STATE_DROPPED" ? 1 : 0);
  const frames = new Map<number, { state: string; scroll: string; ts: number }>();
  for (const e of events) {
    if (e.name !== "PipelineReporter" || e.ph !== "b" || e.pid !== renderer || !inWindow(e)) continue;
    const r = e.args?.frame_reporter ?? e.args?.chrome_frame_reporter ?? {};
    const seq = Number(r.frame_sequence);
    const previous = frames.get(seq);
    if (!previous || rank(r.state) > rank(previous.state)) frames.set(seq, { state: r.state ?? "?", scroll: r.scroll_state ?? "?", ts: e.ts });
  }
  const full = [...frames.values()].filter((f) => f.state === "STATE_PRESENTED_ALL").map((f) => f.ts).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < full.length; i += 1) gaps.push((full[i]! - full[i - 1]!) / 1000);
  const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10 : NaN; };
  const scrollThread: Record<string, number> = {};
  for (const f of frames.values()) scrollThread[f.scroll] = (scrollThread[f.scroll] ?? 0) + 1;

  /* Main thread: long tasks, self time by phase, and who forced layout. */
  const main = events.filter((e) => `${e.pid}:${e.tid}` === mainKey && e.ph === "X" && e.dur !== undefined && inWindow(e)).sort((a, b) => a.ts - b.ts || b.dur! - a.dur!);
  const children = new Map<Ev, number>();
  const stack: Ev[] = [];
  const layoutBy: Record<string, number> = {};
  for (const e of main) {
    while (stack.length && stack[stack.length - 1]!.ts + stack[stack.length - 1]!.dur! <= e.ts) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) children.set(parent, (children.get(parent) ?? 0) + e.dur!);
    if (e.name === "Layout" || e.name === "UpdateLayoutTree") {
      const owner = [...stack].reverse().find((p) => /^(FunctionCall|FireAnimationFrame|EventDispatch|TimerFire|RunMicrotasks)$/.test(p.name));
      const d = owner?.args?.data ?? {};
      const key = owner ? `forced by ${owner.name}${d.type ? `:${d.type}` : ""} ${d.functionName ?? ""}@${String(d.url ?? "").split("/").pop()}:${d.lineNumber}:${d.columnNumber}` : "lifecycle";
      layoutBy[key] = (layoutBy[key] ?? 0) + e.dur! / 1000;
    }
    stack.push(e);
  }
  const phase = (name: string) =>
    /^(FunctionCall|EvaluateScript|v8\.|V8\.|TimerFire|FireAnimationFrame|EventDispatch|RunMicrotasks|MajorGC|MinorGC|IntersectionObserverController|ResizeObserver)/.test(name) ? "scripting"
      : /^(UpdateLayoutTree|Document::recalcStyle|Document::updateStyle|ParseAuthorStyleSheet)/.test(name) ? "style"
      : /^(Layout|LocalFrameView::performLayout|UpdateLayout)/.test(name) ? "layout"
      : /^(Paint|PrePaint|PaintArtifactCompositor|PaintImage|Blink\.PrePaint)/.test(name) ? "paint"
      : /^(Layerize|UpdateLayer|CompositeLayers|Commit|LayerTreeHost|Blink\.CompositingInputs)/.test(name) ? "composite"
      : "other";
  const phases: Record<string, number> = {};
  const jsBy: Record<string, number> = {};
  for (const e of main) {
    phases[phase(e.name)] = (phases[phase(e.name)] ?? 0) + Math.max(0, e.dur! - (children.get(e) ?? 0)) / 1000;
    if (/^(FunctionCall|FireAnimationFrame|EventDispatch|TimerFire)$/.test(e.name)) {
      const d = e.args?.data ?? {};
      const key = `${e.name}${d.type ? `:${d.type}` : ""} ${d.functionName ?? ""}@${String(d.url ?? "").split("/").pop()}:${d.lineNumber}:${d.columnNumber}`;
      jsBy[key] = (jsBy[key] ?? 0) + e.dur! / 1000;
    }
  }
  const invalidations: Record<string, number> = {};
  for (const e of events) {
    if (e.name !== "LayoutInvalidationTracking" || !inWindow(e)) continue;
    const d = e.args?.data ?? {};
    const key = `${d.reason} | ${String(d.nodeName).slice(0, 60)}`;
    invalidations[key] = (invalidations[key] ?? 0) + 1;
  }
  const top = (o: Record<string, number>, n: number) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => [k, Math.round(v)]);
  const runTasks = main.filter((e) => e.name === "RunTask");
  return {
    windowMs: Math.round(windowMs),
    frames: frames.size,
    fullFrames: full.length,
    fullFrameShare: Math.round((100 * full.length) / Math.max(1, frames.size)),
    fullFrameIntervalMs: { p50: pct(gaps, 50), p95: pct(gaps, 95), max: Math.round(Math.max(0, ...gaps)) },
    scrollThread,
    mainBusyShare: Math.round((runTasks.reduce((s, e) => s + e.dur!, 0) / 1000 / windowMs) * 100),
    longTasks: runTasks.filter((e) => e.dur! > 50_000).map((e) => Math.round(e.dur! / 1000)),
    phasesMs: Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, Math.round(v)])),
    layoutMs: top(layoutBy, 6),
    topJsMs: top(jsBy, 8),
    layoutInvalidations: top(invalidations, 6),
  };
}

/* ── run ───────────────────────────────────────────────────────────────── */

const READONLY_GUARD = `(() => {
  window.__blocked = [];
  const allow = (m) => !m || /^(GET|HEAD)$/i.test(m);
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const method = (init && init.method) || (input && input.method) || 'GET';
    if (!allow(method)) { window.__blocked.push(method); return Promise.reject(new TypeError('read-only profile')); }
    return nativeFetch(input, init);
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, ...rest) { this.__m = m; return open.call(this, m, ...rest); };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) { if (!allow(this.__m)) { window.__blocked.push(this.__m); throw new Error('read-only profile'); } return send.apply(this, a); };
  navigator.sendBeacon = () => false;
})();`;

function pageInit(options: { count: boolean; ablate: Set<string> }): string {
  const ablate = JSON.stringify([...options.ablate]);
  return `(() => {
  const stats = { commits: 0, walk: false, commitLog: [], observers: { ResizeObserver: 0, IntersectionObserver: 0, MutationObserver: 0 }, rects: { range: 0, element: 0 } };
  window.__scrollPerf = stats;
  /* React calls this hook on every commit, production builds included. */
  let next = 1;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(), supportsFiber: true, isDisabled: false,
    inject(renderer) { const id = next++; this.renderers.set(id, renderer); return id; },
    onCommitFiberRoot(id, root) {
      stats.commits += 1;
      if (!stats.walk) return;
      let rendered = 0, rows = 0;
      const stack = [root.current];
      while (stack.length) {
        const f = stack.pop();
        if ((f.flags & 1) && [0, 1, 11, 14, 15].includes(f.tag)) rendered += 1;
        if (f.tag === 5 && f.memoizedProps && f.memoizedProps['data-feed-kind'] && f.alternate && f.memoizedProps !== f.alternate.memoizedProps) rows += 1;
        if (f.sibling) stack.push(f.sibling);
        if (f.child && !(f.alternate && f.alternate.child === f.child)) stack.push(f.child);
      }
      stats.commitLog.push({ rendered, rows });
    },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, onScheduleFiberRoot() {}, setStrictMode() {},
  };
  for (const name of Object.keys(stats.observers)) {
    const Native = window[name];
    if (Native) window[name] = class extends Native { constructor(cb, opts) { super((...a) => { stats.observers[name] += 1; return cb(...a); }, opts); } };
  }
  if (${options.count}) {
    const range = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () { stats.rects.range += 1; return range.call(this); };
    const box = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () { stats.rects.element += 1; return box.call(this); };
  }
  /* Diagnostics only: each one removes a suspected cause inside this page. */
  const ablate = ${ablate};
  const css = ['[data-team-sign-in-required]{display:none !important}'];
  if (ablate.includes('composite')) css.push('[data-log-feed-scroller]{will-change:scroll-position}');
  if (ablate.includes('cv')) css.push('.feed-cv{content-visibility:visible !important}');
  if (ablate.includes('frameh')) css.push('.kb .board-frame{height:max(440px, 90vh) !important}');
  if (ablate.includes('speech')) {
    const walker = Document.prototype.createTreeWalker;
    Document.prototype.createTreeWalker = function (root, what, filter) { return what === 4 ? { nextNode() { return null; } } : walker.call(this, root, what, filter); };
  }
  document.addEventListener('DOMContentLoaded', () => { const style = document.createElement('style'); style.textContent = css.join('\\n'); document.head.appendChild(style); });
})();`;
}

/* Opens the conversation the way the operator does: the board of its project,
   then the tile on its card, so the reader sits inside the card. */
async function openCardReader(page: Page, base: string, project: string, card: string, tile: number, reader: string): Promise<void> {
  await page.goto(`${base}/#p=${project}`, { waitUntil: "domcontentloaded" });
  const tiles = `.card[data-id="${card}"] button[data-stage], .card[data-id="${card}"] [data-member]`;
  await page.waitForSelector(tiles, { state: "attached", timeout: 180_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(([selector, i]) => document.querySelectorAll<HTMLElement>(selector as string)[i as number]!.click(), [tiles, tile] as const);
  await page.waitForSelector(`${reader} [data-feed-state="items"]`, { state: "attached", timeout: 180_000 });
  if (!(await page.evaluate((s) => Boolean(document.querySelector(s)?.closest(".card")), reader))) throw new Error("the conversation did not open inside its card");
}

/* Expands like the operator: wheel up to the button (which releases the follow
   magnet), click it, until it is gone. Returns the number of clicks. */
async function expandFeed(page: Page, feed: string): Promise<number> {
  const t0 = Date.now();
  let clicks = 0;
  for (;;) {
    const state = await page.evaluate((s) => {
      const scroller = document.querySelector<HTMLElement>(s);
      const button = scroller && [...scroller.querySelectorAll<HTMLButtonElement>("button")].find((b) => /показати раніше|show earlier|завантажити раніше|load earlier|Завантаження|Loading/i.test(b.textContent ?? ""));
      return { button: Boolean(button), busy: Boolean(button?.disabled) };
    }, feed);
    if (!state.button) break;
    if (!state.busy) {
      const b = await page.evaluate((s) => { const r = document.querySelector<HTMLElement>(s)!.getBoundingClientRect(); return { x: r.x + r.width / 2, y: Math.max(r.y, 0) + 40 }; }, feed);
      await page.mouse.move(b.x, b.y);
      for (let k = 0; k < 6; k += 1) { await page.mouse.wheel(0, -4000); await page.waitForTimeout(30); }
      await page.waitForTimeout(150);
      await page.evaluate((s) => [...document.querySelector<HTMLElement>(s)!.querySelectorAll<HTMLButtonElement>("button")].find((b) => /показати раніше|show earlier|завантажити раніше|load earlier/i.test(b.textContent ?? ""))?.click(), feed);
      clicks += 1;
    }
    await page.waitForTimeout(400);
    if (Date.now() - t0 > 900_000) throw new Error("expansion did not finish in 15 min");
  }
  return clicks;
}

async function run(): Promise<void> {
  const base = args.get("url") ?? "http://127.0.0.1:8898";
  const project = args.get("project")!;
  const card = args.get("card")!;
  const tile = Number(args.get("tile") ?? 0);
  const conversation = args.get("conversation")!;
  const out = args.get("out") ?? "conversation-scroll";
  const speed = Number(args.get("speed") ?? 2000);
  const seconds = Number(args.get("seconds") ?? 5);
  const runs = Number(args.get("runs") ?? 3);
  const count = args.has("count");
  const ablate = new Set((args.get("ablate") ?? "").split(",").filter(Boolean));
  const tag = ["desktop", ...[...ablate].sort(), ...(count ? ["count"] : []), ...(args.has("invalidation") ? ["inv"] : [])].join("-");
  fs.mkdirSync(out, { recursive: true });
  const reader = `[data-kanban-reader="${conversation}"]`;
  const feed = `${reader} [data-log-feed-scroller]`;
  const categories = [
    "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
    "toplevel", "blink", "cc", "benchmark", "input", "latencyInfo", "v8", "blink.user_timing", "viz",
    ...(args.has("invalidation") ? ["disabled-by-default-devtools.timeline.invalidationTracking"] : []),
  ];

  const server = await chromium.launchServer({
    executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable",
    headless: true,
    args: ["--hide-scrollbars", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
  });
  console.error(`chrome pid ${server.process().pid}`);
  const browser = await chromium.connect(server.wsEndpoint());
  const results: unknown[] = [];
  try {
    for (let index = 0; index < runs; index += 1) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
      await context.addInitScript(READONLY_GUARD);
      await context.addInitScript(pageInit({ count, ablate }));
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await openCardReader(page, base, project, card, tile, reader);
      const t0 = Date.now();
      const clicks = await expandFeed(page, feed);
      await page.waitForTimeout(3000);

      const shape = await page.evaluate((s) => {
        const scroller = document.querySelector<HTMLElement>(s)!;
        scroller.scrollIntoView({ block: "center" });
        scroller.scrollTop = 0;
        const style = getComputedStyle(scroller);
        return {
          rows: scroller.querySelectorAll("[data-feed-kind]").length,
          proseRows: scroller.querySelectorAll("[data-tts-answer-index]").length,
          feedNodes: scroller.getElementsByTagName("*").length,
          domNodes: document.getElementsByTagName("*").length,
          scrollHeight: scroller.scrollHeight,
          dpr: devicePixelRatio,
          scroller: { background: style.backgroundColor, willChange: style.willChange },
        };
      }, feed);
      await page.waitForTimeout(1500);
      const box = await page.evaluate((s) => {
        const b = document.querySelector<HTMLElement>(s)!.getBoundingClientRect();
        const top = Math.max(0, b.top), bottom = Math.min(innerHeight, b.bottom), left = Math.max(0, b.left), right = Math.min(innerWidth, b.right);
        return { x: left, y: top, w: right - left, h: bottom - top };
      }, feed);
      if (box.h < 200 || box.w < 200) throw new Error(`the feed is not on screen: ${JSON.stringify(box)}`);

      await page.evaluate(([s, walk]) => {
        const st = (window as unknown as { __scrollPerf: any }).__scrollPerf;
        st.at = { commits: st.commits, observers: { ...st.observers }, rects: { ...st.rects } };
        st.walk = walk; st.commitLog = []; st.scrollEvents = 0;
        document.querySelector<HTMLElement>(s as string)!.addEventListener("scroll", () => { st.scrollEvents += 1; }, { passive: true });
      }, [feed, count] as const);
      const traceFile = path.join(out, `trace-${tag}-${index}.json`);
      await cdp.send("Tracing.start", { traceConfig: { includedCategories: categories, recordMode: "recordAsMuchAsPossible" }, transferMode: "ReturnAsStream" });
      await page.waitForTimeout(300);
      await cdp.send("Input.synthesizeScrollGesture", {
        x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2),
        yDistance: -Math.round(speed * seconds), speed, gestureSourceType: "mouse", preventFling: true,
      });
      await page.waitForTimeout(300);
      const complete = new Promise<{ stream: string }>((resolve) => cdp.once("Tracing.tracingComplete", (e: any) => resolve(e)));
      await cdp.send("Tracing.end");
      const { stream } = await complete;
      const chunks: string[] = [];
      for (;;) {
        const r: any = await cdp.send("IO.read", { handle: stream, size: 4 << 20 });
        chunks.push(r.base64Encoded ? Buffer.from(r.data, "base64").toString() : r.data);
        if (r.eof) break;
      }
      await cdp.send("IO.close", { handle: stream });
      fs.writeFileSync(traceFile, chunks.join(""));

      const inPage = await page.evaluate((s) => {
        const st = (window as unknown as { __scrollPerf: any }).__scrollPerf;
        st.walk = false;
        const rendered = st.commitLog.map((c: { rendered: number }) => c.rendered).sort((a: number, b: number) => a - b);
        return {
          moved: document.querySelector<HTMLElement>(s)!.scrollTop,
          scrollEvents: st.scrollEvents,
          commits: st.commits - st.at.commits,
          commitFibersP50: rendered.length ? rendered[Math.floor(rendered.length / 2)] : null,
          commitsOver100Components: st.commitLog.filter((c: { rendered: number }) => c.rendered > 100).length,
          commitsRerenderingRows: st.commitLog.filter((c: { rows: number }) => c.rows > 0).length,
          observerCallbacks: Object.fromEntries(Object.entries(st.observers).map(([k, v]) => [k, (v as number) - st.at.observers[k]])),
          rectReads: { range: st.rects.range - st.at.rects.range, element: st.rects.element - st.at.rects.element },
          blockedWrites: (window as unknown as { __blocked: string[] }).__blocked.length,
        };
      }, feed);
      const result = { run: index, tag, clicks, expandMs: Date.now() - t0, shape, inPage, trace: analyze(traceFile), traceFile };
      console.log(JSON.stringify(result));
      results.push(result);
      await context.close();
    }
  } finally {
    fs.writeFileSync(path.join(out, `runs-${tag}.json`), JSON.stringify(results, null, 1));
    await browser.close();
    await server.close();
  }
}

/* ── shots ─────────────────────────────────────────────────────────────── */

/* The same expanded conversation on every surface that renders it, in both
   colour schemes: inside its card on the desktop board, opened on the whole
   panel, and on the phone. Screenshots go to <out>; the shapes (rows, clicks, sideways
   overflow) are printed, one JSON line per picture set. */
async function shots(): Promise<void> {
  const base = args.get("url") ?? "http://127.0.0.1:8898";
  const project = args.get("project")!;
  const card = args.get("card")!;
  const tile = Number(args.get("tile") ?? 0);
  const conversation = args.get("conversation")!;
  const out = args.get("out") ?? "conversation-scroll";
  fs.mkdirSync(out, { recursive: true });
  const surfaces = [
    { name: "card-1440", viewport: { width: 1440, height: 900 }, mobile: false, open: "card" },
    { name: "full-1440", viewport: { width: 1440, height: 900 }, mobile: false, open: "full-panel" },
    { name: "phone-390", viewport: { width: 390, height: 844 }, mobile: true, open: "deep-link" },
  ] as const;
  const reader = `[data-kanban-reader="${conversation}"]`;
  const server = await chromium.launchServer({
    executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable",
    headless: true,
    args: ["--hide-scrollbars"],
  });
  console.error(`chrome pid ${server.process().pid}`);
  const browser = await chromium.connect(server.wsEndpoint());
  try {
    for (const scheme of ["light", "dark"] as const) {
      for (const surface of surfaces) {
        if (args.has("only") && args.get("only") !== surface.name) continue;
        const context = await browser.newContext({
          viewport: surface.viewport, deviceScaleFactor: surface.mobile ? 2 : 1, isMobile: surface.mobile, hasTouch: surface.mobile, colorScheme: scheme,
        });
        await context.addInitScript(READONLY_GUARD);
        await context.addInitScript(pageInit({ count: false, ablate: new Set() }));
        const page = await context.newPage();
        const feed = surface.open === "deep-link" ? "[data-log-feed-scroller]" : `${reader} [data-log-feed-scroller]`;
        if (surface.open === "deep-link") {
          await page.goto(`${base}/#c=${conversation}`, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(feed, { state: "attached", timeout: 180_000 });
          await page.waitForSelector("[data-feed-kind]", { state: "attached", timeout: 180_000 });
        } else {
          await openCardReader(page, base, project, card, tile, reader);
          /* "Open on the whole panel": the same reader, out of its card. */
          if (surface.open === "full-panel") {
            await page.evaluate((s) => document.querySelector<HTMLElement>(s)!.closest(".card")!.querySelector<HTMLElement>("button.opt-full")!.click(), reader);
            await page.waitForTimeout(2500);
          }
        }
        const clicks = await expandFeed(page, feed);
        await page.waitForTimeout(3000);
        const shape = await page.evaluate((s) => {
          const scroller = document.querySelector<HTMLElement>(s)!;
          scroller.scrollIntoView({ block: "center" });
          return {
            rows: scroller.querySelectorAll("[data-feed-kind]").length,
            proseRows: scroller.querySelectorAll("[data-tts-answer-index]").length,
            scrollHeight: scroller.scrollHeight,
            sidewaysOverflow: document.documentElement.scrollWidth - innerWidth,
            theme: getComputedStyle(document.body).backgroundColor,
          };
        }, feed);
        for (const [where, fraction] of [["top", 0], ["middle", 0.45]] as const) {
          await page.evaluate(([s, f]) => { const scroller = document.querySelector<HTMLElement>(s as string)!; scroller.scrollTop = scroller.scrollHeight * (f as number); }, [feed, fraction] as const);
          await page.waitForTimeout(1500);
          await page.screenshot({ path: path.join(out, `${surface.name}-${scheme}-${where}.png`) });
        }
        console.log(JSON.stringify({ surface: surface.name, scheme, clicks, shape }));
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

if (mode === "proxy") proxy();
else if (mode === "analyze") console.log(JSON.stringify(analyze(args.get("_")!), null, 1));
else if (mode === "run") await run();
else if (mode === "shots") await shots();
else {
  console.error("usage: profile-conversation-scroll.ts proxy|run|shots|analyze …");
  process.exit(2);
}
