import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import type { Browser } from "playwright-core";
import postcss from "postcss";

import { taskIconNodes } from "@/lib/tasks/taskIconNodes";

/* The rendered-evidence harness shared by the browser drivers: a fixture
   module bundled for the browser and served with the production stylesheet on
   an ephemeral loopback port. `entry` defaults to the kanban board's fixture,
   so every #1695 caller is unchanged; another surface's driver passes its own.
   It also answers `/api/task-icons` the way the Viewer does (#2102), so a
   fixture draws lucide's real icons. */

export async function serveEvidenceFixture(
  outDir: string,
  entryFixture = "src/components/kanban/issue1695Evidence.fixture.tsx",
  responses: Record<string, unknown> = {},
): Promise<{ base: string; stop: () => void }> {
  /* Bundled in a separate process: inside the `bun test` process,
     `Bun.build` resolves the `@/` alias for some module graphs and not for
     others, and the fixture's graph is one of the others. The builder stubs
     server actions the way Next does for the client bundle (#2009). */
  const bundle = path.join(outDir, "bundle");
  const build = Bun.spawnSync([
    process.execPath, path.resolve("src/components/kanban/buildEvidenceFixture.ts"), path.resolve(entryFixture), bundle,
  ], { stdout: "pipe", stderr: "pipe" });
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
        const control = page.locator(mobile ? '[data-mobile2-bar] [data-tts-header]' : '[data-kanban-reader="conversation_export-impl"] [data-tts-header]');
        await control.waitFor({ timeout: 20000 });
        await page.waitForFunction((mobile) => !!document.querySelector(mobile ? '[data-mobile2-bar] [data-tts-header]:enabled' : '[data-kanban-reader="conversation_export-impl"] [data-tts-header]:enabled'), mobile);
        const prefix = `${mobile ? "phone" : "desktop"}-${width}-${scheme}`;
        const measure = async () => control.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const header = node.closest("header, .conv-head, [data-orchestrator-incumbent]")!;
          const title = header.querySelector("[data-mobile2-chat-title], [data-pane-title-override], .ch-title");
          const titleRect = title?.getBoundingClientRect();
          return { x: rect.x, right: rect.right, width: rect.width, height: rect.height, barHeight: header.getBoundingClientRect().height,
            titleOverlap: !!titleRect && rect.left < titleRect.right && rect.right > titleRect.left && rect.top < titleRect.bottom && rect.bottom > titleRect.top };
        });
        const idle = await measure();
        expect(idle.width).toBeGreaterThan(0); expect(idle.right).toBeLessThanOrEqual(width); expect(idle.titleOverlap).toBe(false);
        if (mobile) { expect(idle.width).toBe(44); expect(idle.height).toBe(44); expect(idle.barHeight).toBe(52); }
        await page.screenshot({ path: path.join(out, `${prefix}-idle.png`) });
        await control.click();
        await page.waitForFunction(() => document.querySelector('[data-tts-header][data-tts-phase="loading"]'));
        await page.screenshot({ path: path.join(out, `${prefix}-loading.png`) });
        expect(await control.getAttribute("aria-busy")).toBe("true");
        await page.waitForFunction(() => document.querySelector('[data-tts-header][data-tts-phase="playing"]'));
        await page.screenshot({ path: path.join(out, `${prefix}-playing.png`) });
        expect((await measure()).barHeight).toBe(idle.barHeight);
        await control.click(); expect(await control.getAttribute("data-tts-phase")).toBe("idle");
        // The row and header use the same session and stop surface.
        const row = page.locator(mobile ? '[data-log-feed-scroller] [data-tts-trigger]' : '[data-kanban-reader="conversation_export-impl"] [data-log-feed-scroller] [data-tts-trigger]').first();
        await row.click(); await page.waitForFunction(() => document.querySelector('[data-tts-header][data-tts-phase="playing"]'));
        await control.click(); expect(await row.getAttribute("data-tts-phase")).toBe("idle");
        if (!mobile) {
          await control.click(); await page.waitForFunction(() => document.querySelector('[data-tts-header][data-tts-phase="playing"]'));
          await page.locator('[data-reader-full-toggle="conversation_export-impl"]').click();
          const full = page.locator('[data-kanban-reader="conversation_export-impl"] [data-tts-header]');
          expect(await full.getAttribute("data-tts-phase")).toBe("playing");
          await page.screenshot({ path: path.join(out, `${prefix}-full-window-playing.png`) });
          await full.click(); await page.locator('[data-reader-full-toggle="conversation_export-impl"]').click();
          const incumbent = page.locator('[data-orchestrator-incumbent]');
          await incumbent.scrollIntoViewIfNeeded();
          const seat = incumbent.locator('[data-tts-header]'); await seat.waitFor();
          await page.waitForFunction(() => document.querySelector('[data-orchestrator-incumbent] [data-tts-header]:enabled'));
          const seatRect = await seat.boundingBox(); expect(seatRect!.width).toBeGreaterThan(0);
          await page.screenshot({ path: path.join(out, `${prefix}-orchestrator.png`) });
          await control.scrollIntoViewIfNeeded();
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
    if (!mobile) {
      for (const scheme of ["light", "dark"] as const) {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
        try {
          await context.addInitScript(() => { localStorage.setItem("llv_lang", "en"); localStorage.setItem("llvOrchestratorPanelWidth", "360"); });
          const page = await context.newPage(); await page.goto(`${server.base}?scenario=fast-tts`);
          await page.locator('[data-view-tab="list"]').click();
          const toggle = page.locator('[data-orchestrator-toggle]'); if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
          const dock = page.locator('[data-orchestrator-dock]'); await dock.waitFor();
          const grip = dock.locator('[data-orchestrator-dock-resize]');
          const box = await grip.boundingBox();
          await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down(); await page.mouse.move(248 + 360, box!.y + box!.height / 2); await page.mouse.up();
          const reports = dock.locator('[data-report-log-toggle="open"]'); if (await reports.count()) await reports.click();
          const control = dock.locator('[data-tts-header]'); await control.waitFor();
          await control.click(); await page.waitForFunction(() => document.querySelector('[data-orchestrator-dock] [data-tts-header][data-tts-phase="playing"]'));
          const bounds = await control.boundingBox(); const dockBounds = await dock.boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(dockBounds!.x); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(dockBounds!.x + dockBounds!.width);
          expect(dockBounds!.width).toBe(360);
          await page.screenshot({ path: path.join(out, `desktop-1440-${scheme}-orchestrator-narrow-dock-playing.png`) });
          await control.click();
          readings.push({ scheme, narrowDockWidth: dockBounds!.width, control: bounds });
        } finally { await context.close(); }
      }
    }
    if (mobile) {
      const { context, page } = await openFixture(browser, `${server.base}?fast-tts=1&seatnoise=ii&runtime=structured#c=conversation_running`, { width: 390, height: 844 }, "dark", "uk", "reduce", true);
      try {
        await page.locator('[data-tts-header]:enabled').waitFor();
        expect(await page.locator('[data-mobile2-bar] [data-mobile2-open="reports"]').count()).toBe(0);
        const title = await page.locator('[data-mobile2-title]').boundingBox(); expect(title!.width).toBeGreaterThanOrEqual(190);
        await page.screenshot({ path: path.join(out, "phone-390-dark-attention-reports-overflow.png") });
        await page.locator('[data-mobile2-open="menu"]').click();
        const speechRow = page.locator('[data-mobile2-menu-row="speech"]'); await speechRow.waitFor();
        expect(await page.locator('[data-mobile2-menu-row="reports"]').count()).toBe(1);
        await page.screenshot({ path: path.join(out, "phone-390-dark-reports-menu.png") });
        await speechRow.click(); await page.locator('[data-tts-menu]').waitFor();
        await page.keyboard.press("Escape");
        await page.setViewportSize({ width: 375, height: 844 });
        await page.waitForFunction(() => !document.querySelector('[data-mobile2-bar] [data-mobile2-open="attention"]'));
        expect(await page.locator('[data-mobile2-bar] [data-mobile2-open="attention"]').count()).toBe(0);
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
        const control = page.locator('[data-tts-header]:enabled'); await control.waitFor();
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
        await control.click(); await page.waitForFunction(() => document.querySelector('[data-tts-header][data-tts-phase="playing"]'));
        await page.waitForTimeout(2000);
        await page.evaluate(() => { const until = performance.now() + 500; while (performance.now() < until) { /* stall UI across the queued join */ } });
        await page.waitForFunction(() => document.querySelector('[data-tts-header][data-tts-phase="idle"]'), undefined, { timeout: 15000 });
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
        await control.click(); await page.waitForFunction(() => document.querySelector('[data-tts-header][data-tts-phase="playing"]'));
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
