import { test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import { chromium, type Browser, type ConnectOptions, type Page } from "playwright-core";
import postcss from "postcss";
import sharp from "sharp";

import { translate } from "@/lib/i18n";
import { createHash } from "node:crypto";
import { taskIconNodes } from "@/lib/tasks/taskIconNodes";

/* The rendered-evidence harness shared by the browser drivers: a fixture
   module bundled for the browser and served with the production stylesheet on
   an ephemeral loopback port. `entry` defaults to the kanban board's fixture,
   so every #1695 caller is unchanged; another surface's driver passes its own.
   It also answers `/api/task-icons` the way the Viewer does (#2102), so a
   fixture draws lucide's real icons. */

/* One case of a browser driver, run so that its timeout fails that case and
   nothing after it. Bun's own per-test timeout abandons the body and kills the
   processes it spawned, so a wait still pending on the killed browser rejected
   later as "Unhandled error between tests" and a merge gate read the whole
   file as broken (2026-10-07). Here the case owns a deadline of its own, ahead
   of Bun's: when it passes, every browser and fixture server the case opened
   is closed, which settles its pending waits as failures of this case, and
   only then does the case fail. A body still running after its deadline cannot
   open another browser into the next case.

   The deadline is the declared timeout scaled for a loaded machine (load 25-35
   on 24 cores runs a case several times slower than an idle one) with a floor
   that covers bundling the fixture and starting Chromium. A hang costs the
   longer wait; a passing case is not slowed. LLV_BROWSER_TIMEOUT_SCALE
   overrides the factor. */
const BROWSER_TIMEOUT_SCALE = Number(process.env.LLV_BROWSER_TIMEOUT_SCALE) > 0 ? Number(process.env.LLV_BROWSER_TIMEOUT_SCALE) : 2;
const BROWSER_TIMEOUT_FLOOR = 90_000;
/* How long a timed-out body gets to unwind its own `finally` blocks once its
   browsers are gone, and how long each close may take. */
const SETTLE_MS = 15_000;

type CaseScope = { closers: (() => unknown)[]; expired: boolean };
const caseScope = new AsyncLocalStorage<CaseScope>();

function adopt(close: () => unknown) {
  caseScope.getStore()?.closers.push(close);
}

function openable(): CaseScope | undefined {
  const scope = caseScope.getStore();
  if (scope?.expired) throw new Error("this browser case has timed out; it cannot open another browser");
  return scope;
}

async function owned<T>(open: () => Promise<T>, close: (value: T) => unknown): Promise<T> {
  const scope = openable();
  const value = await open();
  scope?.closers.push(() => close(value));
  if (scope?.expired) {
    await close(value);
    throw new Error("this browser case timed out while its browser was starting");
  }
  return value;
}

async function closeAll(scope: CaseScope) {
  const closers = scope.closers.splice(0).reverse();
  await Promise.all(closers.map(async (close) => {
    await Promise.race([Promise.resolve().then(close).catch(() => undefined), Bun.sleep(SETTLE_MS)]);
  }));
}

/* The drivers launch through this, so the case that opened a browser can close it. */
export const caseChromium = {
  launch: (...args: Parameters<typeof chromium.launch>) => owned(() => chromium.launch(...args), (browser) => browser.close()),
  launchServer: (...args: Parameters<typeof chromium.launchServer>) => owned(() => chromium.launchServer(...args), (server) => server.kill()),
  connect: (wsEndpoint: string, options?: ConnectOptions) => owned(() => chromium.connect(wsEndpoint, options), (browser) => browser.close()),
};

export function browserCaseDeadline(declared: number): number {
  return Math.max(Math.round(declared * BROWSER_TIMEOUT_SCALE), BROWSER_TIMEOUT_FLOOR);
}

/** `test` for a gated browser driver; a disabled gate skips every case. */
export function browserCase(enabled: boolean) {
  return (name: string, body: () => void | Promise<unknown>, declared = 5_000) => {
    if (!enabled) return test.skip(name, body);
    const deadline = browserCaseDeadline(declared);
    test(name, async () => {
      const scope: CaseScope = { closers: [], expired: false };
      const run = caseScope.run(scope, () => Promise.resolve().then(body));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<"expired">((resolve) => { timer = setTimeout(() => resolve("expired"), deadline); });
      try {
        if (await Promise.race([run.then(() => "done" as const), expiry]) === "expired") {
          scope.expired = true;
          // The wait the case was stuck on rejects once its browser closes; its call log names it.
          const stuck = run.then(() => null, (error: unknown) => error);
          await closeAll(scope);
          const reason = await Promise.race([stuck, Bun.sleep(SETTLE_MS).then(() => null)]);
          const where = reason instanceof Error ? `\n${reason.message}` : "";
          throw new Error(`browser case timed out after ${deadline} ms; its browsers and fixture servers were closed before the next case${where}`);
        }
      } finally {
        clearTimeout(timer);
        await closeAll(scope);
      }
    }, deadline + 3 * SETTLE_MS);
  };
}

export async function serveEvidenceFixture(
  outDir: string,
  entryFixture = "src/components/kanban/issue1695Evidence.fixture.tsx",
  responses: Record<string, unknown> = {},
  options: { derivationTiming?: boolean; serialComposerPrerequisites?: boolean } = {},
): Promise<{ base: string; stop: () => void }> {
  /* Bundled in a separate process: inside the `bun test` process,
     `Bun.build` resolves the `@/` alias for some module graphs and not for
     others, and the fixture's graph is one of the others. The builder stubs
     server actions the way Next does for the client bundle (#2009). */
  const bundle = path.join(outDir, "bundle");
  const build = Bun.spawnSync([
    process.execPath, path.resolve("src/components/kanban/buildEvidenceFixture.ts"), path.resolve(entryFixture), bundle,
    ...(options.serialComposerPrerequisites ? ["--serial-composer-prerequisites"] : []),
  ], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LLV_DERIVATION_TIMING: options.derivationTiming ? "1" : "0" } });
  if (build.exitCode !== 0) throw new Error(`fixture bundle failed: ${build.stderr.toString()}${build.stdout.toString()}`);
  const entry = path.join(bundle, `${path.basename(entryFixture).replace(/\.tsx?$/, "")}.js`);
  const css = await postcss([tailwind()]).process(fs.readFileSync("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // Browser Stop aborts an in-flight HTTP response. Bun's fixture adapter
    // needs the same aborted-request boundary the Next adapter supplies.
    error(error) {
      if (error.name === "AbortError") return new Response(null, { status: 499 });
      console.error(error);
      return new Response("fixture request failed", { status: 500 });
    },
    async fetch(request) {
      const { pathname, searchParams } = new URL(request.url);
      if (Object.hasOwn(responses, pathname)) {
        const response = responses[pathname];
        return typeof response === "function" ? response(request) : Response.json(response);
      }
      if (pathname === "/api/task-icons") return Response.json({ icons: await taskIconNodes((searchParams.get("names") ?? "").split(",")) });
      if (pathname === "/brand/delegatus-mark.svg") return new Response(Bun.file("public/brand/delegatus-mark.svg"), { headers: { "content-type": "image/svg+xml" } });
      if (pathname === "/app.js") return new Response(Bun.file(entry), { headers: { "content-type": "text/javascript" } });
      if (pathname === "/style.css") return new Response(css.css, { headers: { "content-type": "text/css" } });
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>'
        + '<body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  adopt(() => server.stop(true));
  return { base: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

export async function openFixture(
  browser: Browser,
  url: string,
  viewport: { width: number; height: number },
  scheme: "light" | "dark",
  /* The Viewer reads its language from `llv_lang` in localStorage, so a case
     that gates both languages seeds it before the first render (#1743). */
  lang?: "en" | "uk",
  /* A surface whose resting state is drawn by an animation has a second
     rendering under `prefers-reduced-motion`, and a case that gates the one
     the motion leaves behind has to ask for it (#1798). */
  motion: "no-preference" | "reduce" = "no-preference",
  /* A phone has a coarse pointer, and several controls in this product are
     sized off `(pointer: coarse)` rather than off width (#1439). A 390px
     context with a mouse is therefore NOT a phone, and a case that measures
     phone geometry has to say so (send-latency slice 3). */
  touch = false,
  /* A drawing a few pixels across (the model glyphs) is read at the density
     an operator's screen draws it; everything else is measured at 1. */
  deviceScaleFactor = 1,
) {
  const context = await browser.newContext({
    viewport, deviceScaleFactor, colorScheme: scheme, reducedMotion: motion,
    ...(touch ? { hasTouch: true, isMobile: true } : {}),
  });
  if (lang) await context.addInitScript(`try { localStorage.setItem("llv_lang", ${JSON.stringify(lang)}); } catch {}`);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(url);
  return { context, page, pageErrors };
}

/** Finished-frame lifetime, shared by the existing board and phone drivers.
 * Serve the real state copy after deleting this case's capture directory. */
export async function captureDoneFrames(browser: Browser, phone: boolean) {
  const { preserveDoneFrame } = await import("@/lib/done/media");
  const { copyDoneFrameSource } = await import("@/lib/done/source");
  const { GET } = await import("@/app/api/image/route");
  const { NextRequest } = await import("next/server");
  const sharp = (await import("sharp")).default;
  const out = path.resolve(".artifacts/done-frames",phone ? "phone" : "desktop");
  fs.mkdirSync(out,{recursive:true});
  const lane = fs.mkdtempSync(path.join(process.env.HOME!,"done-render-lane-"));
  const source = path.join(lane,"result.png");
  const raster = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="460"><rect width="720" height="460" fill="#1b2332"/><rect x="40" y="45" width="640" height="110" rx="12" fill="#314660"/><text x="65" y="112" fill="#ffffff" font-family="sans-serif" font-size="34">Saved result</text><rect x="40" y="190" width="640" height="210" rx="12" fill="#243649"/></svg>')).png().toBuffer();
  fs.writeFileSync(source,raster);
  let server: Awaited<ReturnType<typeof serveEvidenceFixture>> | undefined;
  const readings: unknown[] = [], failures: string[] = [];
  try {
    const saved = await preserveDoneFrame(`task:rendered-${phone ? "phone" : "desktop"}`,{src:`/api/artifact?${new URLSearchParams({path:source})}`,caption:"Saved result"},copyDoneFrameSource,Date.parse("2026-10-18T08:00:00Z"));
    if (saved.unavailable) throw new Error("fixture state copy failed");
    fs.rmSync(lane,{recursive:true,force:true});
    server = await serveEvidenceFixture(out,"src/components/attention/needsYouPanel.fixture.tsx",{
      "/api/image":(request: Request)=>GET(new NextRequest(request)),
    });
    for (const width of phone ? [390] : [800,1440]) for (const lang of ["en","uk"] as const) for (const theme of ["light","dark"] as const) for (const state of ["retained","missing","error"] as const) {
      const name = `${width}-${lang}-${theme}-${state}`;
      const { page,context,pageErrors } = await openFixture(browser,`${server.base}?${new URLSearchParams({lang,open:"1",done:"1",doneframes:state,"done-frame-src":saved.src})}`,{width,height:phone?844:900},theme,lang,"reduce",phone);
      try {
        if (phone) {
          await page.waitForFunction(()=>Number(document.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count"))>1);
          await page.locator('[data-mobile2-open="attention"]').click();
        }
        const section = page.locator(`[data-done-section="${phone ? "phone" : "desktop"}"][data-done-place="needs-you"]`);
        await section.waitFor();
        if (!phone) await page.waitForFunction(()=>document.querySelectorAll("[data-needs-you-section]").length >= 3);
        if (state === "retained") {
          await page.waitForFunction(()=>{const image=document.querySelector<HTMLImageElement>("[data-done-thumb] img");return Boolean(image?.complete && image.naturalWidth);});
          const loaded=await section.locator("[data-done-thumb] img").evaluate((image)=>({width:(image as HTMLImageElement).naturalWidth,src:image.getAttribute("src")}));
          if (loaded.width !== 720 || !loaded.src?.startsWith("/api/image?done=")) failures.push(`${name}: retained copy did not load`);
          await section.scrollIntoViewIfNeeded();
          await page.screenshot({path:path.join(out,`${name}.png`)});
          await section.locator("[data-done-thumb]").click();
          const dialog=page.locator('[role="dialog"][aria-modal="true"]:not([data-mobile2-sheet])'); await dialog.waitFor();
          if (await dialog.locator("[data-lightbox-compare-side]").count() !== 2) failures.push(`${name}: pair did not open`);
          await page.screenshot({path:path.join(out,`${name}-viewer.png`)});
          await page.keyboard.press("Escape");
          readings.push({name,loaded,sourceRemoved:!fs.existsSync(source),viewer:true});
        } else {
          const missing=section.locator("[data-done-frame-missing]"); await missing.waitFor(); await missing.scrollIntoViewIfNeeded();
          const expected=lang==="uk" ? "Кадри не збереглися" : "Frames were not retained";
          if ((await missing.innerText()).trim()!==expected || await section.locator("[data-done-thumb] img").count()) failures.push(`${name}: missing-frame state is wrong`);
          const text=await missing.evaluate(element=>{
            const box=element.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(element);
            return {whole:[...range.getClientRects()].every(r=>r.left>=box.left && r.right<=box.right && r.top>=box.top && r.bottom<=box.bottom && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight),label:element.textContent};
          });
          if (!text.whole) failures.push(`${name}: missing-frame text clipped`);
          await page.screenshot({path:path.join(out,`${name}.png`)});
          readings.push({name,...text});
        }
        if(pageErrors.length) failures.push(`${name}: ${pageErrors.join(", ")}`);
      } finally {await context.close();}
    }
  } finally {server?.stop();fs.rmSync(lane,{recursive:true,force:true});}
  const evidence=path.resolve("evidence/done-frames");fs.mkdirSync(evidence,{recursive:true});
  fs.writeFileSync(path.join(evidence,phone ? "phone.json" : "desktop.json"),JSON.stringify({driver:phone ? "src/components/mobile/issue1671Evidence.browser.test.tsx" : "src/components/kanban/kanbanBoard.browser.test.tsx",readings,failures},null,2)+"\n");
  return failures;
}

type WorkersRowReading = { icon: number; titleSize: number; titleWeight: number; titleColor: string; titleX: number; stateWeight: number; stateColor: string;
  inputWeight: number; inputAlign: string; inputX: number; inputY: number; inputH: number; stateRight: number; stateTop: number; stateBottom: number };

/** Worker-limit frames shared by the board and phone drivers. The fixture
    serves invented counts and the frame's own operator language. */
export async function captureWorkerLimitFrames(browser: Browser, base: string, out: string, phone: boolean) {
  const readings: unknown[] = [];
  const failures: string[] = [];
  async function frame(page: Page, selector: string, name: string, budget?: number, expectedHostWidth?: number) {
    const target = page.locator(selector).first();
    await target.waitFor();
    await target.scrollIntoViewIfNeeded();
    const measurement = await target.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const clipped: string[] = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.trim() || !node.parentElement) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        const text = range.getBoundingClientRect(); const parent = node.parentElement.getBoundingClientRect();
        if (!text.width || !text.height) continue;
        if (text.left < parent.left - 1 || text.right > parent.right + 1 || text.top < parent.top - 1 || text.bottom > parent.bottom + 1) clipped.push(node.textContent.trim());
      }
      const input = element.querySelector("input");
      const dot = element.querySelector("[data-worker-limit-own]")?.getBoundingClientRect();
      const overlappingText: { text: string; rect: number[] }[] = [];
      if (element.matches("[data-worker-limit-popover]")) {
        const scroller = document.querySelector<HTMLElement>("[data-kanban-seat].side [data-log-feed-scroller]");
        if (scroller) {
          const scroll = scroller.getBoundingClientRect();
          const readable = { left: scroll.left, right: scroll.right, top: scroll.top + 8, bottom: scroll.bottom - 8 };
          const popup = box;
          const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_TEXT);
          let textNode: Node | null;
          while ((textNode = walker.nextNode())) {
            if (!textNode.textContent?.trim() || !textNode.parentElement) continue;
            let visible = true;
            for (let parent: HTMLElement | null = textNode.parentElement; parent && parent !== scroller; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) { visible = false; break; }
            }
            if (!visible) continue;
            const range = document.createRange(); range.selectNodeContents(textNode);
            for (const rect of range.getClientRects()) if (rect.right > popup.left && rect.left < popup.right
              && rect.bottom > popup.top && rect.top < popup.bottom
              && rect.bottom > readable.top && rect.top < readable.bottom
              && rect.right > readable.left && rect.left < readable.right) {
              overlappingText.push({ text: textNode.textContent.trim(), rect: [rect.left, rect.top, rect.right, rect.bottom] });
            }
          }
        }
      }
      let left = 0, right = innerWidth, top = 0, bottom = innerHeight;
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor); const rect = ancestor.getBoundingClientRect();
        if (/hidden|clip|auto|scroll/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right); }
        if (/hidden|clip|auto|scroll/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom); }
      }
      const titleEl = element.querySelector("[data-worker-limit-title]"), stateEl = element.querySelector("[data-worker-limit-state]"), iconEl = element.querySelector("[data-worker-limit-icon]");
      const row = titleEl && stateEl && iconEl && input ? (() => {
        const title = getComputedStyle(titleEl), state = getComputedStyle(stateEl), field = getComputedStyle(input);
        const stateBox = stateEl.getBoundingClientRect(), inputBox = input.getBoundingClientRect();
        return { icon: iconEl.getBoundingClientRect().width, titleSize: parseFloat(title.fontSize), titleWeight: Number(title.fontWeight), titleColor: title.color,
          titleX: titleEl.getBoundingClientRect().left - box.left, stateWeight: Number(state.fontWeight), stateColor: state.color,
          inputWeight: Number(field.fontWeight), inputAlign: field.textAlign, inputX: inputBox.left, inputY: inputBox.top, inputH: inputBox.height,
          stateRight: stateBox.right, stateTop: stateBox.top, stateBottom: stateBox.bottom };
      })() : null;
      return { rect: [box.x, box.y, box.width, box.height], clipped, clippedControl: box.left < left - .5 || box.right > right + .5 || box.top < top - .5 || box.bottom > bottom + .5, overlappingText, inputWidth: input?.getBoundingClientRect().width ?? null, row, dot: dot ? [dot.width, dot.height] : null, text: element.textContent, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    const dock = page.locator("[data-kanban-seat].side").first();
    const picture = expectedHostWidth !== undefined && selector.includes("popover")
      ? target
      : expectedHostWidth !== undefined
        ? dock
      : selector === "[data-worker-limit-chip]" ? page.locator(phone ? "[data-mobile2-sheet='seat']" : "[data-orchestrator-incumbent]").first() : target;
    const hostRect = expectedHostWidth !== undefined
      ? await dock.boundingBox()
      : await picture.boundingBox();
    readings.push({ name, ...measurement, frameRect: hostRect });
    if (measurement.clipped.length) failures.push(`${name}: clipped labels ${measurement.clipped.join(" | ")}`);
    if (measurement.overflow) failures.push(`${name}: horizontal page overflow`);
    if (measurement.clippedControl) failures.push(`${name}: control is sliced by its visible band`);
    if (measurement.overlappingText.length) failures.push(`${name}: popover overlaps transcript text ${measurement.overlappingText.map(item => item.text).join(" | ")}`);
    if (budget && measurement.rect[3]! > budget + 1) failures.push(`${name}: height ${measurement.rect[3]} exceeds ${budget}`);
    if (expectedHostWidth !== undefined && Math.abs((hostRect?.width ?? 0) - expectedHostWidth) > 1) failures.push(`${name}: dock width ${hostRect?.width ?? "missing"} does not match ${expectedHostWidth}px`);
    if (selector === "[data-header-menu-workers]") {
      if (Math.abs((measurement.inputWidth ?? 0) - 48) > .5) failures.push(`${name}: wrong field width ${measurement.inputWidth}`);
      const row = measurement.row as WorkersRowReading | null;
      const want = phone ? { icon: 18, title: 13, titleX: 46, stateWeight: 500 } : { icon: 16, title: 12, titleX: 32, stateWeight: 500 };
      if (!row) failures.push(`${name}: row geometry missing`);
      else {
        if (Math.abs(row.icon - want.icon) > .5) failures.push(`${name}: icon ${row.icon}px, siblings ${want.icon}px`);
        if (Math.abs(row.titleSize - want.title) > .5 || row.titleWeight !== 600) failures.push(`${name}: title ${row.titleSize}px/${row.titleWeight}`);
        if (Math.abs(row.titleX - want.titleX) > .5) failures.push(`${name}: label x ${row.titleX}, siblings ${want.titleX}`);
        if (row.stateWeight !== want.stateWeight || row.stateColor === row.titleColor) failures.push(`${name}: state line ${row.stateWeight}/${row.stateColor} is not the muted sibling word`);
        if (row.inputWeight !== 400 || row.inputAlign !== "center") failures.push(`${name}: field number weight ${row.inputWeight}, align ${row.inputAlign}`);
        if (row.inputX < row.stateRight - .5 && row.inputY < row.stateBottom - .5 && row.inputY + row.inputH > row.stateTop + .5) failures.push(`${name}: field overlaps the state line`);
      }
    }
    if (selector.includes("popover")) {
      const viewport = page.viewportSize()!;
      const [x, y, w, h] = measurement.rect as [number, number, number, number];
      if (x < 8 - .5 || x + w > viewport.width - 8 + .5 || y < 8 - .5 || y + h > viewport.height - 8 + .5) failures.push(`${name}: popover leaves viewport margins`);
      if (Math.abs(w - 256) > 1) failures.push(`${name}: popover width ${w}`);
    }
    await picture.screenshot({ path: path.join(out, `${name}.png`) });
    return measurement;
  }
  for (const lang of ["en", "uk"] as const) for (const theme of ["light", "dark"] as const) for (const scene of ["machine", "own", "over"] as const) {
    const name = `${phone ? 390 : 1440}-${lang}-${theme}-${scene}`;
    const { page, context, pageErrors } = await openFixture(browser, `${base}?scenario=seat-head&workers=${scene}&lang=${lang}`, { width: phone ? 390 : 1440, height: phone ? 844 : 900 }, theme, lang, "reduce", phone);
    let step = "initial render";
    try {
      await page.waitForTimeout(350);
      await page.evaluate(() => { for (const button of document.querySelectorAll<HTMLElement>("[data-attention-toast] button")) button.click(); });
      if (phone) { step = "open phone seat"; await page.locator("[data-mobile2-open=seat]").first().click(); }
      const chip = page.locator("[data-worker-limit-chip]").first(); await chip.waitFor();
      const closed = await frame(page, "[data-worker-limit-chip]", `${name}-closed`, phone ? 44 : undefined);
      if (phone && Math.abs(closed.rect[3]! - 44) > .5) failures.push(`${name}: phone row is not 44 px`);
      if ((scene === "machine") !== (closed.dot === null)) failures.push(`${name}: wrong override dot`);
      if (closed.dot && (closed.dot[0] !== 4 || closed.dot[1] !== 4)) failures.push(`${name}: dot is not 4 px`);
      const warning = await chip.evaluate(element => element.classList.contains("text-warning"));
      if (warning !== (scene === "over")) failures.push(`${name}: wrong warning tone`);
      step = "open worker-limit popover";
      await chip.click();
      await frame(page, "[data-worker-limit-popover]", `${name}-popover`);
      await page.keyboard.press("Escape");
      await page.locator("[data-worker-limit-popover]").waitFor({ state: "detached" });
      if (!phone && scene === "machine") {
        // Exercise the production side dock, whose width owns the incumbent
        // header's flex budget. Styling the header itself leaves its flex slot
        // at the board width and does not test the dock's minimum width.
        const seat = page.locator("[data-kanban-seat]").first();
        await seat.locator("[data-seat-placement]").waitFor({ state: "visible" });
        step = "switch seat to dock";
        await seat.locator("[data-seat-placement]").click({ force: true });
        await seat.evaluate(element => (element as HTMLElement).style.setProperty("--seat-w", "360px"));
        await page.waitForFunction(() => {
          const dock = document.querySelector<HTMLElement>("[data-kanban-seat].side");
          return dock && Math.abs(dock.getBoundingClientRect().width - 360) <= 1;
        });
        const dockChip = seat.locator("[data-worker-limit-chip]").first();
        await frame(page, "[data-worker-limit-chip]", `${name}-floor360`, undefined, 360);
        step = "open dock worker-limit popover";
        await dockChip.click();
        await frame(page, "[data-worker-limit-popover]", `${name}-floor360-popover`, undefined, 360);
        await page.keyboard.press("Escape");
      }
      if (phone) {
        // Escape closes the seat's layer before opening the board menu.
        await page.keyboard.press("Escape");
        await page.locator('[data-mobile2-open="menu"]').first().click();
        await page.locator('[data-mobile2-menu-row="settings"]').click();
      } else {
        await page.locator("[data-rail-menu]").first().click();
        await page.locator("[data-rail-menu-settings]").click();
      }
      await page.locator("[data-header-menu-workers] input").waitFor();
      await frame(page, "[data-header-menu-workers]", `${name}-settings-row`);
      /* The 232 px panel wraps the override line («7 here (own limit 10) · 19 on machine») onto a second state line: 14 px more than the machine scene. */
      await frame(page, phone ? "[data-mobile2-sheet='menu']" : "[data-rail-menu-panel]", `${name}-settings`, phone ? 743 : 436);
      if (!phone && scene === "machine") {
        await page.keyboard.press("Escape");
        await page.locator("[data-rail-overview]").click();
        await page.locator("[data-rail-menu]").first().click();
        await page.locator("[data-rail-menu-settings]").click();
        await page.locator("[data-header-menu-workers] input").waitFor();
        await frame(page, "[data-header-menu-workers]", `${name}-overview`);
      }
      if (phone && scene === "machine") {
        await page.keyboard.press("Escape");
        await page.locator("[data-mobile2-open='projects']").first().click();
        await page.locator("[data-mobile2-project='__overview__']").click();
        await page.locator("[data-mobile2-open='menu']").first().click();
        await page.locator("[data-mobile2-menu-row='settings']").click();
        await page.locator("[data-header-menu-workers] input").waitFor();
        const overview = await frame(page, "[data-header-menu-workers]", `${name}-overview`);
        if (overview.text?.includes(lang === "en" ? " here" : " тут")) failures.push(`${name}: overview names a project's running count`);
      }
      if (pageErrors.length) failures.push(`${name}: ${pageErrors.join(" | ")}`);
    } catch (error) { failures.push(`${name}: ${step}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
    finally { await context.close(); }
  }
  return { readings, failures };
}

/** Waits until an opened `<details>` shows all of its content. The board's
 * sections ease their content open from no height under `overflow: clip`, so
 * a control near the end is clipped for a moment; a click there lands on the
 * card behind it. */
export async function waitForSectionOpen(page: Page, selector: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction((target) => {
    const details = document.querySelector<HTMLDetailsElement>(target);
    if (!details?.open) return false;
    const last = details.lastElementChild;
    return !last || last.getBoundingClientRect().bottom <= details.getBoundingClientRect().bottom + 0.5;
  }, selector, { timeout, polling: "raf" });
}

/** Shared fast-speech case for the existing phone and desktop drivers. The
 * provider is stubbed; the client and production route remain in the path. */
export async function captureFastTtsHeaders(browser: Browser, mobile: boolean): Promise<void> {
  const { expect } = await import("bun:test");
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/tts/route");
  const os = await import("node:os");
  const out = path.join(os.homedir(), "Pictures/delegatus-review/fast-tts");
  fs.mkdirSync(out, { recursive: true });
  const originalFetch = globalThis.fetch;
  const names = ["LLV_TTS_BACKEND", "SONIOX_API_KEY"];
  const prior = names.map((name) => process.env[name]);
  process.env[names[0]!] = "soniox"; process.env[names[1]!] = "fixture-key";
  let clockMode = false;
  let refuseNext = false;
  const providerTexts: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    if (!String(_input).startsWith("https://tts-rt.soniox.com/")) return originalFetch(_input, init);
    if (refuseNext) { refuseNext = false; return new Response(null, { status: 401 }); }
    if (clockMode) providerTexts.push(JSON.parse(String(init?.body)).text);
    const bytes = new Uint8Array(24000 * 2 * (clockMode ? 2.4 : 6));
    const view = new DataView(bytes.buffer);
    for (let sample = 0; sample < bytes.length / 2; sample++) view.setInt16(sample * 2, clockMode ? providerTexts.length * 5000 : Math.round(Math.sin(sample * 2 * Math.PI * 440 / 24000) * 8000), true);
    let timer: ReturnType<typeof setTimeout>;
    return new Response(new ReadableStream({ start(c) { timer = setTimeout(() => { c.enqueue(bytes); c.close(); }, 600); }, cancel() { clearTimeout(timer); } }), { headers: { "content-type": "audio/pcm" } });
  }) as typeof fetch;
  const info = { backend: "soniox", lockedByEnv: false, options: [{ id: "soniox", available: true, keyPath: "$CONFIG/soniox-api-key", model: "tts-rt-v2", voice: "Adrian", language: "en", cap: 4000 }] };
  const server = await serveEvidenceFixture(path.resolve(".artifacts/fast-tts", mobile ? "phone" : "desktop"), mobile ? "src/components/mobile/issue1671Evidence.fixture.tsx" : undefined, {
    "/api/tts/backend": info,
    "/api/tts": (request: Request) => POST(new NextRequest(request)),
  });
  const readings = [];
  try {
    for (const scheme of ["light", "dark"] as const) {
      const width = mobile ? 390 : 1440;
      const { context, page, pageErrors } = await openFixture(browser, `${server.base}?${mobile ? "fast-tts=1&runtime=structured#c=conversation_running" : "scenario=fast-tts#c=conversation_export-impl"}`, { width, height: mobile ? 844 : 900 }, scheme, "en", "reduce", mobile);
      try {
        /* The phone reads aloud from the control beside the message (its header carries none). */
        const control = page.locator(mobile ? '[data-mobile-message-actions] [data-tts-trigger]' : '[data-kanban-reader="conversation_export-impl"] [data-tts-header]').last();
        const phase = mobile ? '[data-mobile-message-actions] [data-tts-trigger]' : '[data-tts-header]';
        await control.waitFor({ timeout: 20000 });
        await page.waitForFunction((selector) => !!document.querySelector(`${selector}:enabled`), phase);
        const prefix = `${mobile ? "phone" : "desktop"}-${width}-${scheme}`;
        const measure = async () => control.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const header = node.closest("header, .conv-head, [data-orchestrator-incumbent]") ?? document.querySelector("[data-mobile2-bar]");
          const title = header?.querySelector("[data-mobile2-chat-title], [data-pane-title-override], .ch-title");
          const titleRect = title?.getBoundingClientRect();
          return { x: rect.x, right: rect.right, width: rect.width, height: rect.height, barHeight: header?.getBoundingClientRect().height ?? 0,
            titleOverlap: !!titleRect && rect.left < titleRect.right && rect.right > titleRect.left && rect.top < titleRect.bottom && rect.bottom > titleRect.top };
        });
        const idle = await measure();
        expect(idle.width).toBeGreaterThan(0); expect(idle.right).toBeLessThanOrEqual(width); expect(idle.titleOverlap).toBe(false);
        if (mobile) {
          expect(idle.width).toBe(44); expect(idle.height).toBe(44);
          expect(await page.locator('[data-mobile2-bar] [data-tts-trigger], [data-mobile2-bar] [data-tts-header]').count()).toBe(0);
          expect((await page.locator('[data-mobile2-bar]').boundingBox())!.height).toBe(52);
        }
        await page.screenshot({ path: path.join(out, `${prefix}-idle.png`) });
        await control.click();
        await page.waitForFunction((selector) => document.querySelector(`${selector}[data-tts-phase="loading"]`), phase);
        await page.screenshot({ path: path.join(out, `${prefix}-loading.png`) });
        expect(await control.getAttribute("aria-busy")).toBe("true");
        await page.waitForFunction((selector) => document.querySelector(`${selector}[data-tts-phase="playing"]`), phase);
        await page.screenshot({ path: path.join(out, `${prefix}-playing.png`) });
        expect((await measure()).barHeight).toBe(idle.barHeight);
        await control.click(); expect(await control.getAttribute("data-tts-phase")).toBe("idle");
        if (!mobile) {
          // The row and header use the same session and stop surface.
          const row = page.locator('[data-kanban-reader="conversation_export-impl"] [data-log-feed-scroller] [data-tts-trigger]').first();
          await row.click(); await page.waitForFunction(() => document.querySelector('[data-tts-header][data-tts-phase="playing"]'));
          await control.click(); expect(await row.getAttribute("data-tts-phase")).toBe("idle");
        }
        if (!mobile) {
          /* The link opened the conversation in the agent window, where its header plays. */
          await control.click(); await page.waitForFunction(() => document.querySelector('[data-tts-header][data-tts-phase="playing"]'));
          const inWindow = page.locator('[data-agent-window] [data-kanban-reader="conversation_export-impl"] [data-tts-header]');
          expect(await inWindow.getAttribute("data-tts-phase")).toBe("playing");
          await page.screenshot({ path: path.join(out, `${prefix}-agent-window-playing.png`) });
          /* The seat lies under the window's scrim: the window closes first, and its pill brings it back after. */
          await inWindow.click(); await page.keyboard.press("Escape");
          await page.waitForFunction(() => !document.querySelector("[data-agent-window]"));
          const incumbent = page.locator('[data-orchestrator-incumbent]');
          await incumbent.scrollIntoViewIfNeeded();
          const seat = incumbent.locator('[data-tts-header]'); await seat.waitFor();
          await page.waitForFunction(() => document.querySelector('[data-orchestrator-incumbent] [data-tts-header]:enabled'));
          const seatRect = await seat.boundingBox(); expect(seatRect!.width).toBeGreaterThan(0);
          await page.screenshot({ path: path.join(out, `${prefix}-orchestrator.png`) });
          await page.locator("[data-open-agents-pill]").click();
          await page.waitForSelector('[data-agent-window] [data-kanban-reader="conversation_export-impl"] [data-tts-header]:enabled');
        }
        // Loading is stoppable even on a cache hit, and a permanent provider
        // refusal returns the header to idle with a dismissible alert.
        await control.click(); await control.click();
        expect(await control.getAttribute("data-tts-phase")).toBe("idle");
        refuseNext = true; await control.click();
        await page.locator('[data-tts-alert]').first().waitFor({ timeout: 5000 });
        await page.screenshot({ path: path.join(out, `${prefix}-error.png`) });
        expect(await control.getAttribute("data-tts-phase")).toBe("idle"); await page.keyboard.press("Escape");
        expect(pageErrors).toEqual([]);
        readings.push({ viewport: width, scheme, idle, sharedStop: true, pageErrors });
      } finally { await context.close(); }
    }
    /* The narrow orchestrator dock stood beside the desktop's Conversations view. The Board is the one desktop
       view now and its seat is where the orchestrator's header control is, so a project with conversations has
       no dock to measure; the frames above cover the control on the Board. */
    if (mobile) {
      const { context, page } = await openFixture(browser, `${server.base}?fast-tts=1&seatnoise=ii&runtime=structured#c=conversation_running`, { width: 390, height: 844 }, "dark", "uk", "reduce", true);
      try {
        await page.locator('[data-mobile-message-actions] [data-tts-trigger]:enabled').last().waitFor();
        /* The seat's report button stays on the bar next to the attention badge, and the bar carries no speech control. */
        expect(await page.locator('[data-mobile2-bar] [data-mobile2-open="reports"]').count()).toBe(1);
        expect(await page.locator('[data-mobile2-bar] [data-tts-header], [data-mobile2-bar] [data-tts-trigger]').count()).toBe(0);
        const title = await page.locator('[data-mobile2-title]').boundingBox(); expect(title!.width).toBeGreaterThanOrEqual(190);
        await page.screenshot({ path: path.join(out, "phone-390-dark-attention-reports-overflow.png") });
        await page.locator('[data-mobile2-open="menu"]').click();
        expect(await page.locator('[data-mobile2-menu-row="speech"]').count()).toBe(0);
        expect(await page.locator('[data-mobile2-menu-row="reports"]').count()).toBe(1);
        await page.screenshot({ path: path.join(out, "phone-390-dark-reports-menu.png") });
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 375, height: 844 });
        await page.waitForFunction(() => !document.querySelector('[data-mobile2-bar] [data-mobile2-open="attention"]'));
        expect(await page.locator('[data-mobile2-bar] [data-mobile2-open="attention"]').count()).toBe(0);
        expect(await page.locator('[data-mobile2-bar] [data-mobile2-open="reports"]').count()).toBe(1);
        expect((await page.locator('[data-mobile2-title]').boundingBox())!.width).toBeGreaterThanOrEqual(190);
        await page.locator('[data-mobile2-open="menu"]').click();
        expect(await page.locator('[data-mobile2-menu-row="attention"]').count()).toBe(1);
        await page.screenshot({ path: path.join(out, "phone-375-dark-attention-menu.png") });
      } finally { await context.close(); }
    }
    if (mobile) {
      clockMode = true;
      const { context, page } = await openFixture(browser, `${server.base}?fast-tts=1&runtime=structured#c=conversation_running`, { width: 390, height: 844 }, "light", "en", "reduce", true);
      try {
        const control = page.locator('[data-mobile-message-actions] [data-tts-trigger]:enabled').last(); await control.waitFor();
        await page.evaluate(async () => {
          const context = new AudioContext({ sampleRate: 24000 });
          const nativeClose = context.close.bind(context);
          const source = `class Capture extends AudioWorkletProcessor { process(inputs, outputs) { const out = outputs[0][0]; const input = inputs[0][0]; if (input) out.set(input); else out.fill(0); this.port.postMessage({ frame: currentFrame, samples: Array.from(out) }); return true; } } registerProcessor("speech-capture", Capture);`;
          const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
          await context.audioWorklet.addModule(url); URL.revokeObjectURL(url);
          const capture = new AudioWorkletNode(context, "speech-capture"); capture.connect(context.destination);
          const chunks: number[][] = [], frames: number[] = []; capture.port.onmessage = (event) => { chunks.push(event.data.samples); frames.push(event.data.frame); };
          const create = context.createBufferSource.bind(context);
          context.createBufferSource = () => {
            const node = create(); const connect = node.connect.bind(node);
            node.connect = ((target: AudioNode) => connect(target === context.destination ? capture : target)) as typeof node.connect;
            return node;
          };
          context.close = async () => undefined;
          window.AudioContext = function () { return context; } as unknown as typeof AudioContext;
          (window as unknown as { capturedSpeech: { chunks: number[][]; frames: number[]; clock: AudioContext; close: () => Promise<void> } }).capturedSpeech = { chunks, frames, clock: context, close: nativeClose };
        });
        await control.click(); await page.waitForFunction(() => document.querySelector('[data-mobile-message-actions] [data-tts-trigger][data-tts-phase="playing"]'));
        await page.waitForTimeout(2000);
        await page.evaluate(() => { const until = performance.now() + 500; while (performance.now() < until) { /* stall UI across the queued join */ } });
        await page.waitForFunction(() => document.querySelector('[data-mobile-message-actions] [data-tts-trigger][data-tts-phase="idle"]'), undefined, { timeout: 15000 });
        await page.waitForTimeout(50);
        const output = await page.evaluate(() => {
          const evidence = (window as unknown as { capturedSpeech: { chunks: number[][]; clock: AudioContext } }).capturedSpeech;
          const samples = evidence.chunks.flat(); const first = samples.findIndex((sample) => Math.abs(sample) > 0.001);
          const length = 24000 * 2.4; let mismatches = 0;
          for (let index = 0; index < length * 3; index++) if (Math.abs((samples[first + index] ?? 0) - (Math.floor(index / length) + 1) * 5000 / 32768) > 0.00001) mismatches++;
          return { firstSample: first, expectedSamples: length * 3, mismatches, sampleRate: evidence.clock.sampleRate, uiStallMs: 500 };
        });
        expect(output.firstSample).toBeGreaterThanOrEqual(0); expect(output.mismatches).toBe(0);
        expect(providerTexts).toHaveLength(3);
        // Cached replay buys nothing, and Stop removes old samples promptly.
        await page.evaluate(() => { const evidence = (window as unknown as { capturedSpeech: { chunks: number[][]; frames: number[] } }).capturedSpeech; evidence.chunks.length = 0; evidence.frames.length = 0; });
        await control.click(); await page.waitForFunction(() => document.querySelector('[data-mobile-message-actions] [data-tts-trigger][data-tts-phase="playing"]'));
        const stopped = await control.evaluate((node) => {
          const evidence = (window as unknown as { capturedSpeech: { clock: AudioContext } }).capturedSpeech;
          (node as HTMLButtonElement).click(); return evidence.clock.currentTime;
        });
        await page.waitForTimeout(100);
        expect(providerTexts).toHaveLength(3);
        const tail = await page.evaluate((stopped) => {
          const evidence = (window as unknown as { capturedSpeech: { chunks: number[][]; frames: number[]; clock: AudioContext } }).capturedSpeech;
          const samples = evidence.chunks.flat(); let lastSoundFrame = -1;
          evidence.chunks.forEach((chunk, index) => chunk.forEach((sample, offset) => { if (Math.abs(sample) > 0.001) lastSoundFrame = evidence.frames[index]! + offset; }));
          return { finalQuantumSilent: samples.slice(-128).every((sample) => sample === 0), samplesBeyondStopClock: Math.max(0, lastSoundFrame - Math.ceil(stopped * evidence.clock.sampleRate)), baseLatency: evidence.clock.baseLatency, outputLatency: evidence.clock.outputLatency };
        }, stopped);
        expect(tail.finalQuantumSilent).toBe(true); expect(tail.samplesBeyondStopClock).toBeLessThanOrEqual(128);
        readings.push({ pcmOutput: output, providerTexts, stopClock: stopped, cachedReplayRequests: 0, ...tail });
        await page.evaluate(() => (window as unknown as { capturedSpeech: { close: () => Promise<void> } }).capturedSpeech.close());
      } finally { await context.close(); }
    }
  } finally {
    server.stop(); globalThis.fetch = originalFetch;
    names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index]; });
  }
  fs.mkdirSync("evidence/fast-tts", { recursive: true });
  fs.writeFileSync(`evidence/fast-tts/${mobile ? "phone" : "desktop"}-renders.json`, `${JSON.stringify(readings, null, 2)}\n`);
}

/** Opt-in measured browser audio signal, using the same client/route/provider
 * chain for both revisions. Never runs a paid request in the stubbed cases. */
export async function measureFastTtsLatency(browser: Browser): Promise<void> {
  const { expect } = await import("bun:test");
  const { NextRequest } = await import("next/server");
  const { POST } = await import("@/app/api/tts/route");
  const os = await import("node:os");
  const root = path.resolve(".artifacts/fast-tts/latency");
  const base = path.join(root, "base"); fs.mkdirSync(base, { recursive: true });
  const reference = "c49d27a33391f70b9d87b4c8f1a62a8b98058e8d";
  const files = ["SpeakButton.tsx", "SpeakMenu.tsx", "ttsSession.ts", "ttsKaraoke.ts"];
  for (const file of files) {
    const result = Bun.spawnSync(["git", "show", `${reference}:src/components/feed/${file}`], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode) throw new Error("baseline source unavailable");
    fs.writeFileSync(path.join(base, file), result.stdout);
  }
  const routeSource = Bun.spawnSync(["git", "show", `${reference}:src/app/api/tts/route.ts`], { stdout: "pipe", stderr: "pipe" });
  if (routeSource.exitCode) throw new Error("baseline route unavailable");
  fs.writeFileSync(path.join(base, "route.ts"), routeSource.stdout);
  const baseline = await import(path.join(base, "route.ts"));
  const answer = "The first sentence should start speaking immediately. The next sentences should arrive while the first one plays. A single tap in the conversation header starts reading the answer. A second tap stops the voice immediately. Starting another answer cancels the previous read. Highlighting follows the sentence that is being spoken.";
  const fixture = path.join(root, "latency.fixture.tsx");
  fs.writeFileSync(fixture, `import { createRoot } from "react-dom/client";
import { SpeakButton as Base } from "./base/SpeakButton";
import { SpeakButton } from "@/components/feed/SpeakButton";
import { conversationSpeech } from "@/components/feed/conversationSpeech";
const text = ${JSON.stringify(answer)};
conversationSpeech("measurement").select({ id: "answer", text, roots: () => Array.from(document.querySelectorAll("[data-tts-body]")) });
createRoot(document.getElementById("root")!).render(<div data-feed-kind="prose"><header><h1>Speech measurement</h1>{location.search.includes("base") ? <Base text={text}/> : <SpeakButton scope="measurement" header/>}</header><div data-tts-message="answer"><div data-tts-body>{text}</div></div></div>);`);
  const configRoot = path.join(os.homedir(), ".config");
  const readSetting = (name: string): string | null => {
    for (const folder of ["delegatus", "agent-log-viewer", "live-log-viewer"]) {
      try { const value = fs.readFileSync(path.join(configRoot, folder, name), "utf8").trim(); if (value) return value; } catch { /* next installed spelling */ }
    }
    return null;
  };
  const key = process.env.SONIOX_API_KEY?.trim() || readSetting("soniox-api-key");
  if (!key) throw new Error("configured Soniox key unavailable for latency acceptance");
  const names = ["LLV_TTS_BACKEND", "SONIOX_API_KEY", "LLV_TTS_SONIOX_MODEL", "LLV_TTS_SONIOX_VOICE", "LLV_TTS_SONIOX_LANGUAGE"];
  const prior = names.map((name) => process.env[name]);
  const values = ["soniox", key, process.env[names[2]!] || readSetting("tts-model-soniox") || "tts-rt-v2", process.env[names[3]!] || readSetting("tts-voice-soniox") || "Adrian", process.env[names[4]!] || readSetting("tts-language-soniox") || "en"];
  names.forEach((name, index) => { process.env[name] = values[index]; });
  const info = { backend: "soniox", lockedByEnv: false, options: [{ id: "soniox", available: true, keyPath: "$CONFIG/soniox-api-key", model: values[2], voice: values[3], language: values[4], cap: 4000 }] };
  let mode: "base" | "candidate" = "base";
  const server = await serveEvidenceFixture(path.join(root, "bundle-server"), fixture, {
    "/api/tts/backend": info,
    "/api/tts": (request: Request) => (mode === "base" ? baseline.POST : POST)(new NextRequest(request)),
  });
  const resume = process.env.LLV_TTS_RESUME_LATENCY === "1";
  const results: Record<string, unknown>[] = resume ? JSON.parse(fs.readFileSync("evidence/fast-tts/latency.json", "utf8")).results : [];
  try {
    const replayOnly = process.env.LLV_TTS_LIVE_REPLAY === "1";
    for (let trial = replayOnly ? 10 : resume ? 7 : 1; trial <= 10; trial++) {
      for (const revision of ["base", "candidate"] as const) {
        if (replayOnly && revision === "base") continue;
        if (results.some((result) => result.trial === trial && result.revision === revision && result.cache === "cold page")) continue;
        mode = revision;
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        try {
          await context.addInitScript(() => {
            const NativeContext = window.AudioContext;
            const NativeAudio = window.Audio;
            const analysers: { analyser: AnalyserNode; element?: HTMLAudioElement; context: AudioContext }[] = [];
            let tap = 0; let onset = 0;
            const timeline: { start: number; duration: number }[] = [];
            const makeAnalyser = (context: AudioContext) => { const analyser = context.createAnalyser(); analyser.fftSize = 256; analyser.connect(context.destination); return analyser; };
            const attachContext = (context: AudioContext) => {
              const analyser = makeAnalyser(context); analysers.push({ analyser, context });
              const create = context.createBufferSource.bind(context);
              context.createBufferSource = () => { const node = create(); const start = node.start.bind(node); node.start = ((when: number) => { timeline.push({ start: when, duration: node.buffer?.duration ?? 0 }); start(when); }) as typeof node.start; const connect = node.connect.bind(node); node.connect = ((target: AudioNode) => connect(target === context.destination ? analyser : target)) as typeof node.connect; return node; };
              return context;
            };
            window.AudioContext = new Proxy(NativeContext, { construct(target, args) { return attachContext(new target(...args)); } });
            let monitor: AudioContext | null = null;
            window.Audio = function (src?: string) {
              const element = new NativeAudio(src);
              monitor ??= new NativeContext(); void monitor.resume();
              const analyser = makeAnalyser(monitor); monitor.createMediaElementSource(element).connect(analyser);
              analysers.push({ analyser, element, context: monitor }); return element;
            } as unknown as typeof Audio;
            document.addEventListener("click", (event) => {
              if ((event.target as Element)?.closest("[data-tts-trigger]") && !tap) tap = performance.now();
            }, true);
            const samples = new Float32Array(256);
            const timer = setInterval(() => {
              if (!tap || onset) return;
              for (const { analyser, element, context } of analysers) {
                if (context.state !== "running") continue;
                if (element && (element.muted || !element.src.startsWith("blob:"))) continue;
                analyser.getFloatTimeDomainData(samples);
                if (samples.some((sample) => Math.abs(sample) > 0.001)) { onset = performance.now(); break; }
              }
            }, 2);
            (window as unknown as { audioEvidence: () => unknown }).audioEvidence = () => ({ tap, onset, latency: onset - tap,
              timeline, audio: analysers.map(({ context }) => ({ rate: context.sampleRate, baseLatency: context.baseLatency, outputLatency: context.outputLatency })), timer });
            (window as unknown as { resetAudioEvidence: () => void }).resetAudioEvidence = () => { tap = 0; onset = 0; timeline.length = 0; };
          });
          const page = await context.newPage();
          const statuses: number[] = []; page.on("response", (response) => { if (new URL(response.url()).pathname === "/api/tts") statuses.push(response.status()); });
          let requests = 0; page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/tts") requests++; });
          const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${server.base}?${revision}`);
          const control = page.locator("[data-tts-trigger]"); await control.waitFor();
          await control.click();
          try {
            await page.waitForFunction(() => (window as unknown as { audioEvidence: () => { onset: number } }).audioEvidence().onset > 0, undefined, { timeout: 45000 });
          } catch {
            const signal = await page.evaluate(() => (window as unknown as { audioEvidence: () => Record<string, unknown> }).audioEvidence());
            results.push({ trial, revision, cache: "cold page", failure: "no browser speech signal within 45000 ms", responseStatuses: statuses, ...signal });
            console.log(`speech signal ${revision} trial ${trial}: failed (${statuses.join(",")})`);
            continue;
          }
          const signal = await page.evaluate(() => (window as unknown as { audioEvidence: () => Record<string, unknown> }).audioEvidence());
          results.push({ trial, revision, cache: "cold page", responseStatuses: statuses, ...signal });
          if (trial === 10 && revision === "candidate") {
            await page.waitForFunction(() => document.querySelector('[data-tts-trigger][data-tts-phase="idle"]'), undefined, { timeout: 60000 });
            const complete = await page.evaluate(() => (window as unknown as { audioEvidence: () => Record<string, unknown> }).audioEvidence());
            results.push({ trial, revision, cache: "complete cold read", ...complete });
            const beforeReplay = requests;
            await page.evaluate(() => (window as unknown as { resetAudioEvidence: () => void }).resetAudioEvidence());
            await control.click();
            await page.waitForFunction(() => (window as unknown as { audioEvidence: () => { onset: number } }).audioEvidence().onset > 0);
            const replay = await page.evaluate(() => (window as unknown as { audioEvidence: () => Record<string, unknown> }).audioEvidence());
            results.push({ trial, revision, cache: "cached replay", newRequests: requests - beforeReplay, ...replay });
            expect(requests - beforeReplay).toBe(0);
            console.log(`speech signal cached replay: ${Number(replay.latency).toFixed(1)} ms`);
          }
          await control.click();
          expect(errors).toEqual([]);
          console.log(`speech signal ${revision} trial ${trial}: ${Number(signal.latency).toFixed(1)} ms`);
        } finally { await context.close(); }
      }
    }
  } finally {
    server.stop(); names.forEach((name, index) => { if (prior[index] === undefined) delete process.env[name]; else process.env[name] = prior[index]; });
    const evidence = { reference, answer, provider: { backend: "soniox", model: values[2], voice: values[3], language: values[4], rate: 24000 }, chunks: (await import("@/lib/ttsChunks")).chunkSpeech(answer, { backend: "soniox", language: values[4] }), responseFormats: { base: "mp3", candidate: "pcm_s16le" }, browser: browser.version(), viewport: { width: 390, height: 844 }, route: "ephemeral loopback / production handler / real provider", measurement: "tap to first unmuted browser sample above 0.001, sampled every 2 ms; physical device unmeasured", results };
    fs.mkdirSync("evidence/fast-tts", { recursive: true });
    fs.writeFileSync(process.env.LLV_TTS_LIVE_REPLAY === "1" ? "evidence/fast-tts/replay-latency.json" : "evidence/fast-tts/latency.json", `${JSON.stringify(evidence, null, 2)}\n`);
  }
  expect(results.filter((result) => result.cache === "cold page")).toHaveLength(process.env.LLV_TTS_LIVE_REPLAY === "1" ? 1 : 20);
}

/** The same seat hand-over in the desktop and phone drivers: provenance is
 * released after the answered record and reply are already visible. */
export async function captureSeatMandateHandover(browser: Browser, base: string, mobile: boolean): Promise<void> {
  const { expect } = await import("bun:test");
  const surface = mobile ? "phone" : "desktop";
  const out = path.resolve(`.artifacts/seat-handover/${surface}`);
  fs.mkdirSync(out, { recursive: true });
  const frames: Record<string, unknown>[] = [];
  for (const engine of ["claude", "codex"] as const) for (const handover of ["answered", "adopted"] as const)
    for (const locale of ["en", "uk"] as const) for (const scheme of ["light", "dark"] as const) {
      const label = `${engine}-${handover}-${scheme}-${locale}`;
      const query = mobile ? "kanban=1&seatless=donly&firstmessage=s" : "scenario=first-message&case=s";
      const { context, page, pageErrors } = await openFixture(browser, `${base}?${query}&engine=${engine}&handover=${handover}#p=atlas`,
        { width: mobile ? 390 : 1440, height: mobile ? 844 : 900 }, scheme, locale, "reduce", mobile);
      try {
        await page.addStyleTag({ content: "[data-attention-toast] { display: none !important; }" });
        if (mobile) {
          await page.locator("[data-mobile2-seat-open]").first().click();
          await page.locator('[data-orchestrator-sheet-mode="create"]').waitFor();
        }
        await page.locator("[data-orchestrator-confirm]").first().click();
        await page.locator("[data-mandate-card]").first().waitFor();
        /* Until the launch's own record arrives the card holds the mandate the
           page expected to send, and a section opened then keeps that text
           until it is reopened (MandateCard). The fixture's seat delivers a
           one-line mandate of its own: open the card once it shows that. */
        await page.waitForFunction(() => /·\s*1\s+\S+\s*·/.test(document.querySelector("[data-mandate-card] .text-muted")?.textContent ?? ""));
        await page.locator("[data-mandate-card] summary").first().click();
        await page.waitForFunction(() => document.querySelector("[data-mandate-card] details[open] > div")?.textContent?.includes("Keep the project moving."));
        await page.evaluate(() => {
          const sink = { lapses: [] as string[] };
          (window as unknown as { __seatHandover: typeof sink }).__seatHandover = sink;
          const scan = () => {
            const root = document.querySelector("[data-log-feed-scroller]");
            if (!root) { sink.lapses.push("no feed"); return; }
            const clone = root.cloneNode(true) as HTMLElement;
            clone.querySelectorAll("[data-mandate-card]").forEach((card) => card.remove());
            if (root.querySelectorAll("[data-mandate-card]").length !== 1) sink.lapses.push("card count");
            if ((clone.textContent ?? "").includes("Keep the project moving.")) sink.lapses.push("mandate outside card");
            if (root.querySelector("[data-user-bubble]")) sink.lapses.push("operator bubble");
          };
          new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
          scan();
        });
        const read = () => page.evaluate(() => {
          const root = document.querySelector("[data-log-feed-scroller]")!;
          const card = root.querySelector<HTMLElement>("[data-mandate-card]")!;
          const rect = card.getBoundingClientRect();
          const clone = root.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("[data-mandate-card]").forEach((node) => node.remove());
          return {
            cards: root.querySelectorAll("[data-mandate-card]").length,
            recordKind: card.closest("[data-feed-kind]")?.getAttribute("data-feed-kind") ?? null,
            open: card.querySelector("details")!.hasAttribute("open"),
            height: rect.height, top: rect.top, left: rect.left, width: rect.width,
            text: card.querySelector("details")!.textContent,
            outside: (clone.textContent ?? "").includes("Keep the project moving."),
            userBubbles: root.querySelectorAll("[data-user-bubble]").length,
            json: /structured launch recovery|"phase"|\{\s*"/.test(root.textContent ?? ""),
            danger: [...root.querySelectorAll("[class*=danger]")].filter((node) => [...node.classList].some((token) => /^(text|bg|border)-danger/.test(token))).length,
            overflow: document.documentElement.scrollWidth - innerWidth,
            beforeReply: card.closest("[data-feed-kind]")?.nextElementSibling?.textContent?.includes("Looking at the export test.") ?? false,
          };
        });
        const initial = await read();
        await page.screenshot({ path: path.join(out, `${label}-pending.png`) });
        await page.evaluate(() => {
          const evidence = (window as unknown as { evidence: { advanceFirstMessage(): void } }).evidence;
          evidence.advanceFirstMessage(); evidence.advanceFirstMessage();
        });
        await page.waitForFunction(() => document.querySelector("[data-log-feed-scroller]")?.textContent?.includes("Looking at the export test."), undefined, { timeout: 25_000 });
        const held = await read();
        await page.screenshot({ path: path.join(out, `${label}-evidence-pending.png`) });
        await page.evaluate(() => (window as unknown as { evidence: { releaseFirstMessageEvidence(): void } }).evidence.releaseFirstMessageEvidence());
        await page.waitForTimeout(200);
        const resolved = await read();
        await page.screenshot({ path: path.join(out, `${label}-evidence-resolved.png`) });
        const lapses = await page.evaluate(() => (window as unknown as { __seatHandover: { lapses: string[] } }).__seatHandover.lapses);
        frames.push({ engine, handover, locale, scheme, initial, held, resolved, lapses, pageErrors });
        for (const state of [initial, held, resolved]) {
          expect(state.cards).toBe(1); expect(state.open).toBe(true);
          expect(state.outside).toBe(false); expect(state.userBubbles).toBe(0);
          expect(state.json).toBe(false); expect(state.danger).toBe(0); expect(state.overflow).toBeLessThanOrEqual(1);
          expect(Math.abs(state.height - initial.height)).toBeLessThanOrEqual(2);
          expect(state.text).toBe(initial.text);
          expect(Math.abs(state.top - initial.top)).toBeLessThanOrEqual(2);
        }
        expect(held.beforeReply).toBe(true); expect(resolved.beforeReply).toBe(true);
        expect(held.recordKind).toBe("mandate");
        expect(resolved.recordKind).toBe(engine === "claude" ? "sysmsg" : "user");
        expect(lapses).toEqual([]); expect(pageErrors).toEqual([]);
      } finally { await context.close(); }
    }
  fs.mkdirSync("evidence/first-message", { recursive: true });
  fs.writeFileSync(`evidence/first-message/${surface}-handover.json`, JSON.stringify({ surface, width: mobile ? 390 : 1440, frames }, null, 2) + "\n");
}


/** The question's last row stays within its fieldset and clear of its choices. */
export async function capturePrototypeSkipRows(page: Page, scope: string) {
  return page.locator(scope).evaluate(frame => [...frame.querySelectorAll<HTMLButtonElement>("[data-prototype-question-skip]")].map(row => {
    const box = row.getBoundingClientRect(); const style = getComputedStyle(row); const fieldset = row.closest("fieldset"); const field = fieldset?.getBoundingClientRect();
    const options = [...fieldset?.querySelectorAll("[data-prototype-option], [data-prototype-other]") ?? []];
    const group = fieldset?.querySelector("[role=radiogroup], [role=group]");
    return { question: row.dataset.prototypeQuestionSkip, checked: row.getAttribute("aria-checked") === "true", disabled: row.disabled, height: box.height,
      label: row.textContent ?? "", reason: row.getAttribute("aria-label") ?? "", optionsOpacity: group ? Number(getComputedStyle(group).opacity) : 1,
      markBackground: getComputedStyle(row.querySelector("[data-prototype-skip-mark]")!).backgroundColor,
      insideFieldset: !!fieldset && fieldset.dataset.prototypeQuestion === row.dataset.prototypeQuestionSkip,
      background: style.backgroundColor, borderStyle: style.borderTopStyle,
      clipped: !field || box.left < field.left - 0.5 || box.right > field.right + 0.5 || box.top < field.top - 0.5 || box.bottom > field.bottom + 0.5 || row.scrollWidth > row.clientWidth + 1,
      overlapsOptions: options.some(option => { const other = option.getBoundingClientRect(); return box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom; }) };
  }));
}

/** Shared questionnaire readings for the board and phone evidence drivers. */
export async function capturePrototypeQuestions(page: Page, phone: boolean) {
  const skipRows = await capturePrototypeSkipRows(page, phone ? "[data-mobile2-sheet=prototype-review]" : "[data-prototype-review] [role=dialog]");
  const reading = await page.evaluate((phone) => {
    const frame = document.querySelector<HTMLElement>(phone ? "[data-mobile2-sheet=prototype-review]" : "[data-prototype-review] [role=dialog]")!;
    const questions = frame.querySelector<HTMLElement>("[data-prototype-questions]")!;
    const stage = frame.querySelector<HTMLElement>("[data-prototype-gallery]");
    const bounds = frame.getBoundingClientRect();
    const options = [...frame.querySelectorAll<HTMLElement>("[data-prototype-option], [data-prototype-other]")];
    const pillOverflow = [...frame.querySelectorAll<HTMLElement>("[data-prototype-recommended]")].filter(pill => {
      const box = pill.getBoundingClientRect(); const row = pill.closest("button")!.getBoundingClientRect();
      return box.left < row.left || box.right > row.right + 0.5;
    }).length;
    const actions = [...frame.querySelectorAll<HTMLElement>("[data-prototype-save], [data-prototype-skip]")].map(button => {
      const b = button.getBoundingClientRect(); return { text: button.textContent, visible: b.top >= bounds.top && b.bottom <= bounds.bottom + 0.5, x: b.x, y: b.y, width: b.width };
    });
    const marks = [...frame.querySelectorAll<HTMLElement>("[data-prototype-mark]")].map(mark => {
      const box = mark.getBoundingClientRect();
      return { multiple: mark.closest("button")!.getAttribute("role") === "checkbox", radius: parseFloat(getComputedStyle(mark).borderTopLeftRadius), width: box.width };
    });
    /* A button is as tall as its words need (44 at least): the recommended pill adds nothing. */
    const heightExcess = Math.max(...options.map(button => {
      const style = getComputedStyle(button); const words = button.querySelector<HTMLElement>("span:not([data-prototype-mark])")!.getBoundingClientRect().height;
      const need = words + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      return button.getBoundingClientRect().height - Math.max(44, need);
    }));
    const unpicked = options.filter(o => o.getAttribute("aria-checked") === "false");
    const decision = frame.querySelector<HTMLElement>("[data-prototype-decision]");
    return { heightExcess, markLetters: [...frame.querySelectorAll("[data-prototype-mark]")].filter(m => (m.textContent ?? "").trim() !== "").length,
      hints: frame.querySelectorAll("[data-prototype-hint]").length,
      unpickedFaded: unpicked.length > 0 && unpicked.every(o => parseFloat(getComputedStyle(o).opacity) < 1),
      statusLine: decision ? decision.querySelector("span")?.textContent ?? null : null, decisionText: decision?.textContent ?? null,
      title: frame.querySelector<HTMLElement>(phone ? "h2" : "header p")?.textContent ?? null,
      sideways: frame.scrollWidth - frame.clientWidth, questionWidth: questions.getBoundingClientRect().width,
      stageWidth: stage?.getBoundingClientRect().width ?? null, questionCount: frame.querySelectorAll("[data-prototype-question]").length,
      optionHeight: Math.min(...options.map(o => o.getBoundingClientRect().height)), pillOverflow, marks, actions,
      actionsWidth: frame.querySelector<HTMLElement>("[data-prototype-actions]")?.getBoundingClientRect().width ?? null,
      readonly: options.every(o => (o as HTMLButtonElement).disabled), skipped: Boolean(frame.querySelector("[data-prototype-skipped]")) };
  }, phone);
  return { ...reading, skipRows };
}


/** Fish Audio model choices in the real message controls, without provider calls. */
export async function captureFishAudioMenu(browser: Browser, mobile: boolean): Promise<void> {
  const { expect } = await import("bun:test");
  const os = await import("node:os");
  const out = path.join(os.homedir(), "Pictures/delegatus-review/fish-audio");
  fs.mkdirSync(out, { recursive: true });
  const fish = { id: "fishaudio", available: true, keyPath: "$CONFIG/fishaudio-api-key", model: "s2.1-pro-free", voice: "default", cap: 4000, freeUntil: "2026-11-30", freeEnded: false };
  const speech = { backend: "fishaudio", lockedByEnv: false, options: [
    { id: "openai", available: false, keyPath: "$CONFIG/openai-api-key", model: "gpt-4o-mini-tts", voice: "alloy", cap: 4000 },
    { id: "elevenlabs", available: false, keyPath: "$CONFIG/elevenlabs-api-key", model: "eleven_v4_turbo", voice: "default", cap: 4000 },
    { id: "soniox", available: false, keyPath: "$CONFIG/soniox-api-key", model: "tts-rt-v2", voice: "Adrian", cap: 4000 }, fish,
  ] };
  const server = await serveEvidenceFixture(path.resolve(".artifacts/fish-audio", mobile ? "phone" : "desktop"), mobile ? "src/components/mobile/issue1671Evidence.fixture.tsx" : undefined, { "/api/tts/backend": speech });
  const readings: unknown[] = [];
  try {
    for (const locale of ["en", "uk"] as const) for (const scheme of ["light", "dark"] as const) for (const width of mobile ? [320, 390] : [1440, 1000]) {
      const height = width === 320 ? 640 : mobile ? 844 : width === 1000 ? 700 : 900;
      const { context, page, pageErrors } = await openFixture(browser, `${server.base}?${mobile ? "fast-tts=1&runtime=structured#c=conversation_running" : "scenario=fast-tts#c=conversation_export-impl"}`, { width, height }, scheme, locale, "reduce", mobile);
      try {
        const current = structuredClone(speech);
        const saves: unknown[] = [];
        await page.route("**/api/tts/backend", async (route) => {
          if (route.request().method() === "POST") {
            const body = route.request().postDataJSON(); saves.push(body);
            current.options = current.options.map((option) => option.id === "fishaudio" ? { ...option, model: body.model } : option);
          }
          await route.fulfill({ json: current });
        });
        await page.route("**/api/tts/voices?*", async (route) => route.fulfill({ json: { backend: "fishaudio", voices: [], truncated: false, selected: { id: "default", name: null, known: true } } }));
        await page.route("**/api/tts", async (route) => {
          if (route.request().method() !== "POST") { await route.fallback(); return; }
          await route.fulfill({ status: 403, json: { error: "provider refused", code: "fishaudio-free-refused" } });
        });
        const control = page.locator(mobile ? '[data-mobile-message-actions] [data-tts-trigger]' : '[data-kanban-reader="conversation_export-impl"] [data-tts-header]').last();
        await control.waitFor({ timeout: 20000 });
        // The first navigation may already have read the fixture response; the menu refresh is authoritative.
        await control.click({ button: "right" });
        const menu = page.locator("[data-tts-menu]"); await menu.waitFor();
        const group = menu.getByRole("group").filter({ hasNot: page.locator("input") });
        expect(await group.getByRole("menuitemradio").count()).toBe(2);
        expect(await menu.locator("[data-tts-provider]").count()).toBe(4);
        expect(await menu.textContent()).toContain(locale === "en" ? "free until" : "безкоштовно до");
        expect(await menu.textContent()).not.toMatch(/left click|лівий клік/);
        expect(await menu.getByRole("menuitemradio").filter({ hasText: "Fish Audio" }).first().textContent()).toBe("Fish Audio");
        const prefix = `${mobile ? "phone" : "desktop"}-${width}-${locale}-${scheme}`;
        const readGeometry = () => menu.evaluate((node) => {
          const menu = node.getBoundingClientRect();
          const controls = [...node.querySelectorAll<HTMLButtonElement>("button")].map((button) => { const box = button.getBoundingClientRect(); return { label: button.textContent?.trim(), left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height, width: box.width }; });
          return { left: menu.left, right: menu.right, top: menu.top, bottom: menu.bottom, background: getComputedStyle(node).backgroundColor, sideways: node.scrollWidth > node.clientWidth, controls };
        });
        for (const state of ["free", "paid", "ended"] as const) {
          const models = group.getByRole("menuitemradio");
          if (state === "paid") {
            await models.nth(1).click(); await menu.waitFor({ state: "hidden" });
            expect(saves).toEqual([{ backend: "fishaudio", model: "s2.1-pro" }]);
            await control.click({ button: "right" }); await menu.waitFor();
            expect(await models.nth(1).getAttribute("aria-checked")).toBe("true");
            expect(await menu.textContent()).toContain(locale === "en" ? "Cyrillic letters cost about twice" : "вдвічі дорожче");
            expect(await menu.textContent()).not.toContain("UTF-8");
          }
          if (state === "ended") {
            current.options = current.options.map((option) => option.id === "fishaudio" ? { ...option, model: "s2.1-pro-free", freeEnded: true } : option);
            await page.keyboard.press("Escape"); await control.click({ button: "right" }); await menu.waitFor();
            await page.waitForFunction((label) => document.querySelector("[data-tts-menu]")?.textContent?.includes(label), locale === "en" ? "free period ended" : "безкоштовний період закінчився");
          }
          await models.nth(1).scrollIntoViewIfNeeded();
          const geometry = await readGeometry();
          expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(width);
          expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(height);
          expect(geometry.sideways).toBe(false); expect(geometry.background).not.toBe("rgba(0, 0, 0, 0)");
          const modelBoxes = geometry.controls.slice(-2);
          expect(modelBoxes[0]!.bottom).toBeLessThanOrEqual(modelBoxes[1]!.top);
          expect(modelBoxes[1]!.bottom).toBeLessThanOrEqual(geometry.bottom);
          if (mobile) for (const box of modelBoxes) { expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44); }
          await page.screenshot({ path: path.join(out, `${prefix}-${state}.png`) });
          const text = (await menu.textContent()) ?? "";
          // The selection is marked on the chosen model row only, the ended state promises no free read, and the provider has one name.
          expect(text).not.toMatch(/\.\./); expect(text).not.toContain("fishaudio ·");
          expect(await menu.getByRole("menuitemradio").first().evaluate((node) => node.className.includes("bg-accent/10"))).toBe(false);
          if (state === "ended") { expect(text).not.toMatch(/No charge|Без оплати/); expect(text).not.toMatch(/Right-click|правою кнопкою/); }
          const alertFrame = state === "free" ? "alert-refused" : state === "ended" ? "alert-ended" : null;
          let alertReading: unknown = null;
          if (alertFrame) {
            await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
            await control.click();
            const alert = page.locator("[data-tts-alert]"); await alert.first().waitFor({ timeout: 8000 }); await page.waitForTimeout(200);
            expect(await alert.count()).toBe(1);
            const words = await alert.evaluate((node) => ({ text: node.textContent ?? "", wordBreak: getComputedStyle(node).wordBreak, overflowWrap: getComputedStyle(node).overflowWrap, sideways: node.scrollWidth > node.clientWidth }));
            expect(words.wordBreak).not.toBe("break-all"); expect(words.sideways).toBe(false); expect(words.text).not.toMatch(/HTTP|\.\./);
            expect(words.text).toMatch(mobile ? /Press and hold|Затисніть/ : /Right-click|правою кнопкою/);
            if (mobile) expect(words.text).not.toMatch(/Right-click|правою кнопкою/);
            await page.screenshot({ path: path.join(out, `${prefix}-${alertFrame}.png`) });
            alertReading = words;
            await page.keyboard.press("Escape"); await alert.waitFor({ state: "detached" });
            if (state === "free") { await control.click({ button: "right" }); await menu.waitFor(); }
          }
          readings.push({ width, height, locale, scheme, state, geometry, alert: alertReading });
        }
        if (mobile) {
          current.options = current.options.map((option) => option.id === "fishaudio" ? { ...option, available: false } : option);
          const prefix = `phone-${width}-${locale}-${scheme}`;
          await control.click({ button: "right" }); await menu.waitFor();
          await page.waitForFunction(() => /Fish Audio API|API-ключ Fish Audio/.test(document.querySelector("[data-tts-menu]")?.textContent ?? ""));
          await page.keyboard.press("Escape"); await menu.waitFor({ state: "hidden" });
          await control.click();
          const alert = page.locator("[data-tts-alert]"); await alert.waitFor({ timeout: 8000 }); await page.waitForTimeout(200);
          expect(await alert.count()).toBe(1); expect(await alert.textContent()).toContain("fishaudio-api-key");
          await page.screenshot({ path: path.join(out, `${prefix}-alert-missing.png`) });
        }
        expect(pageErrors).toEqual([]);
      } finally { await context.close(); }
    }
    fs.mkdirSync("evidence/fish-audio", { recursive: true });
    fs.writeFileSync(`evidence/fish-audio/${mobile ? "phone" : "desktop"}.json`, JSON.stringify({ driver: mobile ? "src/components/mobile/issue1671Evidence.browser.test.tsx" : "src/components/kanban/kanbanBoard.browser.test.tsx", readings }, null, 2) + "\n");
  } finally { server.stop(); }
}

/** Read-aloud provider voice choices, rendered by both existing surface drivers. */
export async function captureReadAloudVoiceMenu(browser: Browser, mobile: boolean): Promise<void> {
  const { expect } = await import("bun:test");
  const os = await import("node:os");
  const out = process.env.LLV_TTS_EVIDENCE_DIR || path.join(os.homedir(), "Pictures/delegatus-review/read-aloud-voice");
  fs.mkdirSync(out, { recursive: true });
  const server = await serveEvidenceFixture(path.resolve(".artifacts/read-aloud-voice", mobile ? "phone" : "desktop"), mobile ? "src/components/mobile/issue1671Evidence.fixture.tsx" : undefined);
  const readings: unknown[] = [];
  const states = ["loaded", "filtered", "typed-unlisted", "loading", "failed", "unconfigured", "locked", "fish-jarvis", "selected-unknown", "long-selected-name", "alert-voice-not-found"] as const;
  try {
    for (const locale of ["en", "uk"] as const) for (const scheme of ["light", "dark"] as const) for (const width of mobile ? [320, 390] : [1440, 1000]) {
      const height = mobile ? (width === 320 ? 640 : 844) : width === 1000 ? 700 : 900;
      const { context, page, pageErrors } = await openFixture(browser, `${server.base}?${mobile ? "fast-tts=1&runtime=structured#c=conversation_running" : "scenario=fast-tts#c=conversation_export-impl"}`, { width, height }, scheme, locale, "reduce", mobile);
      let state: typeof states[number] = "loaded";
      const longVoiceName = `Narrator${"A".repeat(80)}`;
      const voices = () => Array.from({ length: 12 }, (_, i) => ({ id: `voice-${i}`, name: i === 0 ? state === "long-selected-name" ? longVoiceName : "Delegatus" : `Narrator ${i}`, own: i < 2 }));
      let listCalls = 0; let synthesisCalls = 0; const saves: unknown[] = [];
      let release: (() => void) | undefined;
      let controlsReachable: { provider: boolean; voiceInput: boolean } | undefined;
      const speech = () => ({ backend: state === "fish-jarvis" ? "fishaudio" : "elevenlabs", lockedByEnv: false, options: [
        { id: "openai", available: false, keyPath: "$CONFIG/openai-api-key", model: "gpt-4o-mini-tts", voice: "alloy", cap: 4000 },
        { id: "elevenlabs", available: state !== "unconfigured", keyPath: "$CONFIG/elevenlabs-api-key", model: "eleven_v4_turbo", voice: state === "selected-unknown" || state === "alert-voice-not-found" ? "unknown-voice" : "voice-0", voiceLockedByEnv: state === "locked", cap: 4000 },
        { id: "soniox", available: false, keyPath: "$CONFIG/soniox-api-key", model: "tts-rt-v2", voice: "Adrian", cap: 4000 },
        { id: "fishaudio", available: true, keyPath: "$CONFIG/fishaudio-api-key", model: "s2.1-pro", voice: "public-jarvis", cap: 4000 },
      ] });
      try {
        await page.route("**/api/tts/backend", async (route) => {
          if (route.request().method() === "POST") saves.push(route.request().postDataJSON());
          await route.fulfill({ json: speech() });
        });
        await page.route("**/api/tts/voices?*", async (route) => {
          listCalls++;
          if (state === "loading") await new Promise<void>((resolve) => { release = resolve; });
          if (state === "failed") { await route.fulfill({ status: 502, json: { error: "Missing voices_read permission", code: "provider-refused" } }); return; }
          const fish = state === "fish-jarvis";
          await route.fulfill({ json: { backend: fish ? "fishaudio" : "elevenlabs", voices: fish ? [{ id: "public-jarvis", name: "Jarvis", own: false }] : voices(), truncated: false, selected: { id: fish ? "public-jarvis" : state === "selected-unknown" ? "unknown-voice" : "voice-0", name: fish ? "Jarvis" : state === "selected-unknown" ? null : state === "long-selected-name" ? longVoiceName : "Delegatus", known: state !== "selected-unknown" } } });
        });
        await page.route("**/api/tts", async (route) => {
          if (route.request().method() !== "POST") { await route.fallback(); return; }
          synthesisCalls++; expect(route.request().postDataJSON().mode).toBe("pcm");
          await route.fulfill({ status: 422, json: { error: "Unknown voice", code: "voice-not-found", voice: "unknown-voice" } });
        });
        for (const next of states) {
          state = next; const beforeCalls = listCalls; const beforeSaves = saves.length;
          await page.reload();
          const control = page.locator(mobile ? "[data-mobile-message-actions] [data-tts-trigger]" : "[data-kanban-reader=conversation_export-impl] [data-tts-message] [data-tts-trigger]").last();
          await control.waitFor({ timeout: 20000 });
          await page.waitForFunction(() => [...document.querySelectorAll("[data-tts-trigger]")].some((node) => !(node as HTMLButtonElement).disabled));
          const prefix = `${mobile ? "phone" : "desktop"}-${width}-${locale}-${scheme}-${state}`;
          if (state === "alert-voice-not-found") {
            await control.click(); const alert = page.locator("[data-tts-alert]"); await alert.waitFor();
            const reading = await alert.evaluate((node) => ({ text: node.textContent, wordBreak: getComputedStyle(node).wordBreak, sideways: node.scrollWidth > node.clientWidth }));
            expect(reading.text).toContain("unknown-voice"); expect(reading.wordBreak).not.toBe("break-all"); expect(reading.sideways).toBe(false); expect(synthesisCalls).toBe(1);
            await page.screenshot({ path: path.join(out, `${prefix}.png`) });
            await alert.screenshot({ path: path.join(out, `${prefix}-detail.png`) });
            readings.push({ width, height, locale, scheme, state, reading }); continue;
          }
          await control.click({ button: "right" }); const menu = page.locator("[data-tts-menu]"); await menu.waitFor();
          const group = menu.locator("[data-tts-voice-group]"); const input = group.locator("input");
          if (state === "loading") await group.getByText(locale === "en" ? "Loading voices…" : "Завантаження голосів…", { exact: true }).waitFor();
          else if (state === "failed") await group.getByRole("alert").waitFor();
          else if (state === "locked") await group.locator("[data-tts-voice-locked]").waitFor();
          else if (state !== "unconfigured") await group.locator("[data-tts-voice]").first().waitFor();
          if (state === "filtered") await input.fill("Narrator 1");
          if (state === "typed-unlisted") await input.fill("typed-voice-id");
          await group.scrollIntoViewIfNeeded();
          if (["typed-unlisted", "selected-unknown", "failed"].includes(state)) await group.locator(state === "typed-unlisted" ? "[data-tts-typed]" : "[role=alert]").scrollIntoViewIfNeeded();
          const reading = await menu.evaluate((node) => {
            const box = node.getBoundingClientRect(); const input = node.querySelector("input");
            const rows = [...node.querySelectorAll("[data-tts-voice]")].map((row) => { const r = row.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; });
            const summary = node.querySelector<HTMLElement>("[data-tts-summary]");
            const providerVoice = node.querySelector<HTMLElement>('[data-tts-provider][aria-checked="true"] [data-tts-provider-voice]');
            const selectedVoice = node.querySelector<HTMLElement>('[data-tts-voice][aria-checked="true"] span.min-w-0.flex-1');
            const textFits = (element: HTMLElement | null) => element ? element.scrollWidth <= element.clientWidth + 1 : false;
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, background: getComputedStyle(node).backgroundColor, sideways: node.scrollWidth > node.clientWidth, inputHeight: input?.getBoundingClientRect().height ?? null, inputFont: input ? getComputedStyle(input).fontSize : null, placeholder: input?.placeholder ?? null, placeholderColor: input ? getComputedStyle(input, "::placeholder").color : null, textColor: input ? getComputedStyle(input).color : null, providerRows: [...node.querySelectorAll("[data-tts-provider]")].map((row) => row.textContent ?? ""), lockedRows: node.querySelectorAll("[data-tts-voice-locked]").length, retry: (() => { const retry = [...node.querySelectorAll<HTMLElement>("[role=alert] button")][0]; const alert = retry?.closest("[role=alert]"); if (!retry || !alert) return null; const range = document.createRange(); range.selectNodeContents(alert.firstChild!); return { textLeft: range.getBoundingClientRect().left, buttonLeft: retry.getBoundingClientRect().left, buttonHeight: retry.getBoundingClientRect().height }; })(), rows, more: node.querySelector("[data-tts-voice-more]")?.textContent, summaryText: summary?.textContent, providerVoiceText: providerVoice?.textContent, selectedVoiceText: selectedVoice?.textContent, summaryFits: textFits(summary), providerVoiceFits: textFits(providerVoice), selectedVoiceFits: textFits(selectedVoice) };
          });
          expect(reading.left).toBeGreaterThanOrEqual(0); expect(reading.right).toBeLessThanOrEqual(width); expect(reading.top).toBeGreaterThanOrEqual(0); expect(reading.bottom).toBeLessThanOrEqual(height);
          expect(reading.sideways).toBe(false); expect(reading.background).not.toBe("rgba(0, 0, 0, 0)"); expect(reading.rows.length).toBeLessThanOrEqual(6);
          for (const row of reading.rows) { expect(row.top).toBeGreaterThanOrEqual(reading.top); expect(row.bottom).toBeLessThanOrEqual(reading.bottom); }
          for (let i = 1; i < reading.rows.length; i++) expect(reading.rows[i]!.top).toBeGreaterThanOrEqual(reading.rows[i - 1]!.bottom);
          if (state !== "locked") {
            expect(reading.placeholder).toBe(locale === "en" ? "Voice name or id" : "Назва або id голосу");
            expect(reading.placeholderColor).not.toBe(reading.textColor);
          }
          if (state === "failed") {
            expect(reading.retry).not.toBeNull();
            expect(Math.abs(reading.retry!.buttonLeft - reading.retry!.textLeft)).toBeLessThanOrEqual(1);
            if (mobile) expect(reading.retry!.buttonHeight).toBeGreaterThanOrEqual(44); else expect(reading.retry!.buttonHeight).toBeLessThan(36);
          }
          if (state === "locked") { expect(reading.inputHeight).toBeNull(); expect(reading.rows.length).toBe(0); expect(reading.more).toBeUndefined(); expect(reading.lockedRows).toBe(1); expect(await menu.textContent()).not.toMatch(/type to narrow|уточніть пошук/); }
          if (state !== "locked" && mobile) { expect(reading.inputHeight).toBeGreaterThanOrEqual(44); expect(reading.inputFont).toBe("16px"); for (const row of reading.rows) expect(row.height).toBeGreaterThanOrEqual(44); }
          if (state === "loaded") expect(reading.more).toContain("6");
          if (state === "long-selected-name") {
            expect(reading.summaryText).toContain(longVoiceName);
            expect(reading.providerVoiceText).not.toContain(longVoiceName);
            expect(reading.selectedVoiceText).toContain(longVoiceName);
            expect(reading.summaryFits).toBe(true);
            expect(reading.providerVoiceFits).toBe(true);
            expect(reading.selectedVoiceFits).toBe(true);
            const provider = menu.locator('[data-tts-provider][aria-checked="true"]');
            await provider.scrollIntoViewIfNeeded();
            const providerReachable = await provider.isVisible();
            expect(providerReachable).toBe(true);
            await input.scrollIntoViewIfNeeded();
            const voiceInputReachable = await input.isVisible();
            expect(voiceInputReachable).toBe(true);
            controlsReachable = { provider: providerReachable, voiceInput: voiceInputReachable };
          }
          if (state === "unconfigured") expect(listCalls).toBe(beforeCalls);
          if (state === "locked") expect(await input.count()).toBe(0);
          if (state === "fish-jarvis") { expect(await menu.textContent()).toContain("s2.1-pro · Jarvis"); expect(reading.providerRows.join(" ")).not.toContain("voice-0"); }
          if (state === "loaded") expect(reading.providerRows.join(" ")).not.toContain("Delegatus ·");
          if (state === "selected-unknown") expect(await group.getByRole("alert").textContent()).toContain("unknown-voice");
          await page.screenshot({ path: path.join(out, `${prefix}.png`) });
          await menu.screenshot({ path: path.join(out, `${prefix}-detail.png`) });
          if (state === "filtered") { await group.locator("[data-tts-voice]").first().click(); await menu.waitFor({ state: "hidden" }); expect(saves.slice(beforeSaves)).toEqual([{ backend: "elevenlabs", voice: "voice-1" }]); }
          if (state === "typed-unlisted") { await input.press("Enter"); await menu.waitFor({ state: "hidden" }); expect(saves.slice(beforeSaves)).toEqual([{ backend: "elevenlabs", voice: "typed-voice-id" }]); }
          release?.(); release = undefined;
          readings.push({ width, height, locale, scheme, state, reading, ...(controlsReachable ? { controlsReachable } : {}) });
        }
        expect(pageErrors).toEqual([]);
      } finally { release?.(); await context.close(); }
    }
    fs.mkdirSync("evidence/read-aloud-voice", { recursive: true });
    fs.writeFileSync(`evidence/read-aloud-voice/${mobile ? "phone" : "desktop"}.json`, JSON.stringify({ readings }, null, 2) + "\n");
  } finally { server.stop(); }
}

/* The pane ring as it was drawn before it moved onto the compositor: a
   registered angle animated on a conic gradient. Kept here only as the
   reference the new ring is compared against, pixel for pixel. */
const LEGACY_RING_CSS = `
@property --legacy-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
.legacy-ring::before {
  content: ""; pointer-events: none; position: absolute; inset: -2px; z-index: 1; border-radius: 12px; padding: 2px;
  background: conic-gradient(from var(--legacy-angle), transparent 0deg 30deg, var(--pane-glow) 100deg, transparent 170deg 210deg, var(--pane-glow) 280deg, transparent 350deg 360deg);
  -webkit-mask: linear-gradient(black 0 0) content-box, linear-gradient(black 0 0); -webkit-mask-composite: xor;
  mask: linear-gradient(black 0 0) content-box, linear-gradient(black 0 0); mask-composite: exclude;
}`;

type RingReading = { width: number; height: number; scheme: string; failures: string[]; [key: string]: unknown };

/** The attention cues of a conversation waiting for the operator, shared by
    the board and phone drivers. Over the fixture's waiting conversation:
    the ring is a compositor animation (transform only, the 3.4s lap), it
    turns, it matches the previous drawing pixel for pixel at five angles in
    the pane's own size and in both themes, reduced motion stills it at the
    angle the old ring started from, and the ring and the halos that grow a
    shadow hold their frame while the composer has the focus and resume when it
    loses it. */
export async function captureAttentionRing(browser: Browser, base: string, out: string, phone: boolean) {
  fs.mkdirSync(out, { recursive: true });
  const readings: RingReading[] = [];
  const widths = phone ? [390, 430] : [1440, 900];
  const ANGLES = [0, 45, 135, 225, 300];
  const LAP_S = 3.4;
  for (const width of widths) for (const scheme of ["light", "dark"] as const) {
    const height = phone ? 844 : 900;
    const failures: string[] = [];
    const label = `${phone ? "phone" : "desktop"}-${width}-${scheme}`;
    const { context, page, pageErrors } = await openFixture(browser, `${base}#c=conversation_links-impl`, { width, height }, scheme, "en", "no-preference", phone);
    try {
      await page.addStyleTag({ content: "[data-attention-toast] { display: none !important; }" });
      await page.waitForSelector(".pane-attention-ring .pane-attention-comets");
      const motion = await page.evaluate(async () => {
        const comets = document.querySelector<HTMLElement>(".pane-attention-comets")!;
        const ring = comets.parentElement!;
        const animation = document.getAnimations().find((candidate) => (candidate as CSSAnimation).animationName === "pane-orbit") as CSSAnimation | undefined;
        const keyframes = animation ? (animation.effect as KeyframeEffect).getKeyframes() : [];
        const properties = new Set(keyframes.flatMap((frame) => Object.keys(frame).filter((key) => !["offset", "easing", "composite", "computedOffset"].includes(key))));
        const timing = animation?.effect?.getComputedTiming();
        const before = getComputedStyle(comets).transform;
        await new Promise((resolve) => setTimeout(resolve, 600));
        const after = getComputedStyle(comets).transform;
        const frame = ring.getBoundingClientRect();
        const pane = ring.parentElement!.querySelector("section")!.getBoundingClientRect();
        return {
          target: animation ? (animation.effect as KeyframeEffect).target === comets : false,
          properties: [...properties], duration: timing?.duration, iterations: timing?.iterations, direction: timing?.direction, playState: animation?.playState,
          turned: before !== after,
          ringOutset: { left: pane.left - frame.left, top: pane.top - frame.top, right: frame.right - pane.right, bottom: frame.bottom - pane.bottom },
          ringSize: { width: Math.round(frame.width), height: Math.round(frame.height) },
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
          colour: getComputedStyle(ring.parentElement!).getPropertyValue("--pane-glow").trim(),
        };
      });
      if (!motion.target) failures.push("pane-orbit does not animate the comets element");
      if (motion.properties.join() !== "transform") failures.push(`pane-orbit animates ${motion.properties.join(",") || "nothing"}, not transform alone`);
      if (motion.duration !== 3400 || motion.iterations !== Infinity || motion.playState !== "running") failures.push(`lap ${motion.duration} x ${motion.iterations} ${motion.playState}`);
      if (!motion.turned) failures.push("the comets did not turn in 600 ms");
      for (const [edge, value] of Object.entries(motion.ringOutset)) if (Math.abs(value - 2) > 1) failures.push(`the ring sits ${value}px off the card's ${edge} edge, not 2`);
      if (motion.overflowX > 0) failures.push(`the page overflows sideways by ${motion.overflowX}px`);

      /* Pixel comparison with the previous drawing, at the pane's own size. */
      const size = motion.ringSize;
      const box = { width: Math.min(size.width - 4, width - 40), height: Math.min(size.height - 4, 420) };
      await page.addStyleTag({ content: LEGACY_RING_CSS });
      const shot = async (variant: "legacy" | "current", angle: number) => {
        await page.evaluate(({ variant, angle, box, lap }) => {
          document.getElementById("ring-probe")?.remove();
          const probe = document.createElement("div");
          probe.id = "ring-probe";
          probe.style.cssText = `position:fixed;left:0;top:0;width:${box.width + 24}px;height:${box.height + 24}px;background:#fff;z-index:2147483647;`;
          const card = document.createElement("div");
          card.style.cssText = `position:absolute;left:12px;top:12px;width:${box.width}px;height:${box.height}px;--pane-glow:var(--color-warning);`;
          if (variant === "legacy") {
            /* The registered angle does not inherit: it is set on the pseudo-element itself, as its keyframes did. */
            card.classList.add("legacy-ring");
            const rule = document.createElement("style");
            rule.textContent = `#ring-probe .legacy-ring::before { --legacy-angle: ${angle}deg; }`;
            probe.append(rule);
          } else {
            card.innerHTML = '<span class="pane-attention-ring"><span class="pane-attention-comets"></span></span>';
            const comets = card.querySelector<HTMLElement>(".pane-attention-comets")!;
            comets.style.animationPlayState = "paused";
            comets.style.animationDelay = `${-(angle / 360) * lap}s`;
          }
          probe.append(card);
          document.body.append(probe);
        }, { variant, angle, box, lap: LAP_S });
        await page.waitForTimeout(120);
        return page.screenshot({ clip: { x: 0, y: 0, width: box.width + 24, height: box.height + 24 } });
      };
      const comparisons: { angle: number; ringPixels: number; differing: number; share: number; maxChannelDifference: number }[] = [];
      for (const angle of ANGLES) {
        const legacy = await sharp(await shot("legacy", angle)).raw().toBuffer({ resolveWithObject: true });
        const current = await sharp(await shot("current", angle)).raw().toBuffer({ resolveWithObject: true });
        if (angle === 45 || angle === 225) {
          fs.writeFileSync(path.join(out, `${label}-${angle}-legacy.png`), await sharp(legacy.data, { raw: legacy.info }).png().toBuffer());
          fs.writeFileSync(path.join(out, `${label}-${angle}-current.png`), await sharp(current.data, { raw: current.info }).png().toBuffer());
        }
        const channels = legacy.info.channels;
        let ringPixels = 0, differing = 0, maxChannelDifference = 0;
        for (let at = 0; at < legacy.data.length; at += channels) {
          const lit = legacy.data[at]! < 250 || legacy.data[at + 1]! < 250 || legacy.data[at + 2]! < 250 || current.data[at]! < 250 || current.data[at + 1]! < 250 || current.data[at + 2]! < 250;
          if (!lit) continue;
          ringPixels += 1;
          const difference = Math.max(Math.abs(legacy.data[at]! - current.data[at]!), Math.abs(legacy.data[at + 1]! - current.data[at + 1]!), Math.abs(legacy.data[at + 2]! - current.data[at + 2]!));
          maxChannelDifference = Math.max(maxChannelDifference, difference);
          if (difference > 48) differing += 1;
        }
        const share = ringPixels ? differing / ringPixels : 1;
        comparisons.push({ angle, ringPixels, differing, share: Number(share.toFixed(4)), maxChannelDifference });
        if (ringPixels < 200) failures.push(`angle ${angle}: only ${ringPixels} ring pixels drawn`);
        if (share > 0.02) failures.push(`angle ${angle}: ${(share * 100).toFixed(1)}% of the ring's pixels differ from the previous drawing`);
      }
      await page.evaluate(() => document.getElementById("ring-probe")?.remove());

      /* The shadow-growing halos hold while the composer has the focus. */
      const halo = await page.evaluate(async () => {
        const badge = document.createElement("span");
        badge.className = "card-status-attention";
        badge.style.cssText = "position:fixed;left:0;bottom:0;width:20px;height:20px;border-radius:10px;";
        document.body.append(badge);
        /* The standing liveness motion of a board: a running agent's glyph (an SVG group the main thread animates) and a pulsing status dot. */
        const live = document.createElement("div");
        live.style.cssText = "position:fixed;left:30px;bottom:0;width:20px;height:20px;";
        live.innerHTML = '<span class="mglyph" data-live="1"><svg viewBox="0 0 16 16"><g class="mg-turn"><circle cx="8" cy="3" r="2" /></g></svg></span><span class="animate-pulse" style="display:block;width:6px;height:6px;"></span>';
        document.body.append(live);
        const field = document.querySelector<HTMLTextAreaElement>("textarea[data-composer-field]");
        const comets = document.querySelector(".pane-attention-comets")!;
        const state = () => getComputedStyle(badge).animationPlayState;
        const turning = () => getComputedStyle(comets).animationPlayState;
        const glyph = () => getComputedStyle(live.querySelector(".mg-turn")!).animationPlayState;
        const dot = () => getComputedStyle(live.querySelector(".animate-pulse")!).animationPlayState;
        const reading = { running: state(), ring: turning(), glyph: glyph(), dot: dot(), field: Boolean(field) } as Record<string, unknown>;
        field?.focus();
        reading.focused = state();
        reading.ringFocused = turning();
        reading.glyphFocused = glyph();
        reading.dotFocused = dot();
        reading.rootMarked = document.documentElement.hasAttribute("data-composer-focused");
        field?.blur();
        reading.blurred = state();
        reading.ringBlurred = turning();
        reading.glyphBlurred = glyph();
        reading.dotBlurred = dot();
        badge.remove();
        live.remove();
        return reading;
      });
      if (halo.running !== "running" || halo.focused !== "paused" || halo.blurred !== "running" || halo.ring !== "running" || halo.ringFocused !== "paused" || halo.ringBlurred !== "running" || halo.glyph !== "running" || halo.glyphFocused !== "paused" || halo.glyphBlurred !== "running" || halo.dot !== "running" || halo.dotFocused !== "paused" || halo.dotBlurred !== "running" || !halo.field || !halo.rootMarked) failures.push(`pause while the composer has the focus: ${JSON.stringify(halo)}`);
      await page.screenshot({ path: path.join(out, `${label}.png`) });
      if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(" | ")}`);
      readings.push({ width, height, scheme, failures, motion, comparisons, halo });
    } finally { await context.close(); }

    /* Reduced motion: the ring stays, still, where the old one began. */
    const calm = await openFixture(browser, `${base}#c=conversation_links-impl`, { width, height }, scheme, "en", "reduce", phone);
    try {
      await calm.page.waitForSelector(".pane-attention-ring .pane-attention-comets");
      const still = await calm.page.evaluate(() => {
        const comets = document.querySelector<HTMLElement>(".pane-attention-comets")!;
        return { animations: document.getAnimations().filter((candidate) => (candidate as CSSAnimation).animationName === "pane-orbit").length, transform: getComputedStyle(comets).transform };
      });
      const reading = readings.at(-1)!;
      reading.reduced = still;
      if (still.animations !== 0 || (still.transform !== "none" && still.transform !== "matrix(1, 0, 0, 1, 0, 0)")) reading.failures.push(`reduced motion leaves ${JSON.stringify(still)}`);
    } finally { await calm.context.close(); }
  }
  const failures = readings.flatMap((reading) => reading.failures.map((failure) => `${phone ? "phone" : "desktop"} ${reading.width} ${reading.scheme}: ${failure}`));
  return { failures, readings };
}

/** The existing Telegram settings panel, used by both browser evidence drivers. */
export async function captureTelegramMultiBot(browser: Browser, base: string, out: string, phone: boolean) {
  const readings: unknown[] = [];
  const viewports = phone ? [{ width: 390, height: 844 }] : [{ width: 1440, height: 900 }, { width: 1000, height: 700 }];
  for (const { width, height } of viewports) {
    for (const lang of ["en", "uk"] as const) for (const scheme of ["light", "dark"] as const) {
      for (const scene of ["multi-one", "multi-kicked", "multi-refused", "multi-ready"]) {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
        try {
          await context.addInitScript(({ lang, scheme }) => { localStorage.setItem("llv_lang", lang); localStorage.setItem("llv_theme", scheme); }, { lang, scheme });
          const page = await context.newPage();
          await page.goto(`${base}/?bot=${scene}#p=atlas`);
          if (phone) {
            await page.locator('[data-mobile2-open="menu"]').first().click();
            await page.locator('[data-mobile2-menu-row="accounts"]').click();
            await page.locator("[data-mobile2-telegram] button").first().click();
          } else {
            const footer = page.locator("[data-rail-footer]").first();
            await footer.waitFor();
            if (await footer.getAttribute("data-rail-footer") === "folded") await page.click("[data-rail-footer-toggle]");
            await page.locator(`button[aria-label="${lang === "uk" ? "Підключення Telegram" : "Telegram connection"}"]`).click();
          }
          const panel = page.locator(`[role="dialog"][aria-label="Telegram"] section[aria-label="${lang === "uk" ? "Бот" : "Bot"}"]`);
          await panel.waitFor();
          const add = panel.locator("details").filter({ has: page.locator("summary", { hasText: lang === "uk" ? "Додати ще одного бота" : "Add another bot" }) });
          const row = panel.locator("li").filter({ hasText: "Team Reports" }).first();
          await row.waitFor();
          await row.scrollIntoViewIfNeeded();
          if (scene === "multi-kicked") {
            const states = await row.locator("[data-telegram-bot-posting-state]").allTextContents();
            const removed = lang === "uk" ? "видалено з чату" : "removed from the chat";
            const mayPost = lang === "uk" ? "Агентам можна писати" : "Agents may post";
            const frame = `${phone ? "phone" : "desktop"}-${width}-${lang}-${scheme}`;
            if (states.length !== 2 || !states[0]?.includes(removed) || !states[1]?.includes(mayPost)) {
              throw new Error(`${frame}: bot posting states are not visible in words: ${JSON.stringify(states)}`);
            }
            const overflow = await row.evaluate(el => el.scrollWidth > el.clientWidth
              || [...el.querySelectorAll<HTMLElement>("[data-telegram-bot-posting-state]")].some(state => state.getBoundingClientRect().right > el.getBoundingClientRect().right + 1));
            if (overflow) throw new Error(`${frame}: bot posting states overflow the chat row`);
          }
          if (scene === "multi-refused" && !await row.locator('[data-telegram-delivery="refused"]').isVisible()) throw new Error("refused chat is hidden");
          const key = `${phone ? "phone" : "desktop"}-${width}-${lang}-${scheme}-${scene}`;
          const frames: string[] = [];
          const capture = async (suffix = "") => {
            const name = `${key}${suffix}.png`;
            await page.screenshot({ path: path.join(out, name) });
            frames.push(name);
          };
          const before = await panel.evaluate(el => ({ panelWidth: el.getBoundingClientRect().width, overflow: el.scrollWidth - el.clientWidth,
            controls: [...el.querySelectorAll<HTMLElement>("button,input,select")].map(c => ({ label: c.getAttribute("aria-label"), disabled: (c as HTMLButtonElement).disabled })) }));
          if (before.overflow > 1) throw new Error(`${key}: panel overflows horizontally`);
          const clipping = await row.evaluate(el => {
            const card = el.getBoundingClientRect();
            const dialog = el.closest('[role="dialog"]')!.getBoundingClientRect();
            return card.top < dialog.top || card.bottom > dialog.bottom || card.left < dialog.left || card.right > dialog.right;
          });
          if (clipping) throw new Error(`${key}: chat card is clipped`);
          await capture();
          if (scene === "multi-ready") {
            await row.locator("select").selectOption("release_fixture_bot");
            await page.waitForFunction(() => (document.querySelector('select[aria-label$=": Team Reports"]') as HTMLSelectElement)?.value === "release_fixture_bot");
            const remove = panel.getByRole("button", { name: lang === "uk" ? "Видалити" : "Remove", exact: true }).first();
            await remove.click();
            const confirm = panel.getByRole("button", { name: lang === "uk" ? "Підтвердити" : "Confirm", exact: true });
            await confirm.locator("..").scrollIntoViewIfNeeded();
            const confirmationOverflows = await confirm.evaluate(el => [...el.parentElement!.children].some(child => child.scrollWidth > child.clientWidth + 1));
            if (confirmationOverflows) throw new Error(`${key}: remove confirmation overflows`);
            await capture("-remove");
            await confirm.click();
            await page.waitForFunction(() => (window as unknown as { evidence: { botPosts: Array<{action: string}> } }).evidence.botPosts.some(p => p.action === "remove_bot"));
          }
          if (scene === "multi-one") {
            await add.locator("summary").click();
            await add.scrollIntoViewIfNeeded();
            await capture("-add");
            await add.locator('input[type="password"]').fill("12345:" + "not-a-real-token-".repeat(2) + "fake");
            await add.locator('button[type="submit"]').click();
            await page.waitForFunction(() => (window as unknown as { evidence: { botPosts: Array<{action: string}> } }).evidence.botPosts.some(p => p.action === "add_bot"));
          }
          const actions = await page.evaluate(() => (window as unknown as { evidence: { botPosts: Array<{action: string}> } }).evidence.botPosts.map(p => p.action));
          readings.push({ key, width, height, ...before, actions, frames });
        } finally { await context.close(); }
      }
    }
  }
  return readings;
}

/** Production setup hosts, including the failed attempt and its successful retry. */
export async function captureProjectSetupHosts(browser: Browser, base: string, out: string,
  hosts: readonly ("placeholder" | "verdict" | "mobile")[], widths: readonly number[]) {
  const readings: unknown[] = [];
  for (const host of hosts) for (const lang of ["en", "uk"] as const) for (const theme of ["light", "dark"] as const) for (const width of widths) {
    const { context, page, pageErrors } = await openFixture(browser,
      `${base}?case=project-setup&host=${host}&lang=${lang}`, { width, height: 900 }, theme, lang, "reduce", host === "mobile");
    try {
      const results = page.locator("[data-stage-setup]");
      await results.first().waitFor();
      if (await results.count() !== 2) throw new Error(`${host}: expected failed setup and passed retry`);
      // Each host opens at its ordinary initial scroll, with results collapsed.
      for (let index = 0; index < 2; index++) {
        const result = results.nth(index);
        if (await result.getAttribute("open") !== null) throw new Error("setup unexpectedly opens expanded");
        const text = await result.locator("summary").innerText();
        const n = host === "verdict" ? 2 - index : index + 1;
        if (!text.includes(translate(lang, "projectSetup.attempt", { stage: "build", n }))) throw new Error("missing stage/attempt label");
        const state = n === 1 ? "failed" : "passed";
        if (!text.includes(translate(lang, `projectSetup.${state}`))) throw new Error("wrong setup state");
        await result.locator("summary").click();
        await result.scrollIntoViewIfNeeded();
        const shown = await result.innerText();
        for (const value of ["scripts/setup.sh", "pipeline-checkout/web", "Workspace ready", n === 1 ? "Dependency unavailable" : "Preparing dependencies"])
          if (!shown.includes(value)) throw new Error(`${host}: missing output ${value}`);
        const geometry = await result.evaluate(element => {
          const clipped: string[] = [], covered: string[] = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const node = walker.currentNode;
            if (!node.textContent?.trim()) continue;
            const range = document.createRange(); range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              let left = 0, top = 0, right = innerWidth, bottom = innerHeight;
              for (let parent = node.parentElement; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent), box = parent.getBoundingClientRect();
                if (/hidden|auto|scroll|clip/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
                if (/hidden|auto|scroll|clip/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
              }
              if (rect.left < left - 1 || rect.right > right + 1 || rect.top < top - 1 || rect.bottom > bottom + 1) clipped.push(node.textContent!);
              const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
              if (!hit || !element.contains(hit)) covered.push(node.textContent!);
            }
          }
          return { clipped, covered, documentOverflow: document.documentElement.scrollWidth > innerWidth, scroll: window.scrollY, focus: document.activeElement?.tagName };
        });
        if (geometry.clipped.length || geometry.covered.length || geometry.documentOverflow) throw new Error(`${host}/${lang}/${theme}/${width}/${n}: ${JSON.stringify(geometry)}`);
        const frame = `${host}-${lang}-${theme}-${width}-attempt-${n}.png`;
        await page.screenshot({ path: path.join(out, frame) });
        readings.push({ host, lang, theme, width, attempt: n, state, frame, geometry, pageErrors });
        await result.locator("summary").click();
        if (pageErrors.length) throw new Error(JSON.stringify(pageErrors));
      }
    } finally { await context.close(); }
  }
  const sources = ["src/components/kanban/kanbanBoard.browser.test.tsx", "src/components/mobile/issue1671Evidence.browser.test.tsx", "src/components/conversation/conversationWindowEvidence.fixture.tsx", "src/components/kanban/issue1695BrowserHarness.ts",
    "src/components/pipelines/StageSetupResult.tsx", "src/components/pipelines/StagePlaceholderPane.tsx", "src/components/pipelines/VerdictPopover.tsx",
    "src/components/mobile/MobilePipelineScreen.tsx", "src/lib/i18n/en.ts", "src/lib/i18n/uk.ts"];
  return { capturedAt: new Date().toISOString(), sourceDigests: Object.fromEntries(sources.map(file =>
    [file, createHash("sha256").update(fs.readFileSync(file)).digest("hex")])), readings };
}
