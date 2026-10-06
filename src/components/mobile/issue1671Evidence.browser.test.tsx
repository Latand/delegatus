import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";

import { AgentRegistry, setAgentRegistryForTests } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { deliverConversationMessage } from "@/lib/delivery";
import { agentMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { claudeMessageProvenance } from "@/lib/runtime/claudeMessageProvenance";
import { deliveredMessageOccurrences } from "@/lib/runtime/deliveredMessageOccurrences";
import type { FileEntry } from "@/lib/types";
import { captureSeatMandateHandover, openFixture, serveEvidenceFixture } from "@/components/kanban/issue1695BrowserHarness";
import { playPath, recordDrag } from "@/components/kanban/dragFrameMeter";
import { measureStageChain, stageChainFailures, type StageChainLane } from "@/components/pipelines/stageChainMeasure";
import { translate } from "@/lib/i18n";
import { FAKE_SAFETY_COMMAND, FAKE_SAFETY_REASON } from "@/lib/runtime/fixtures/fakeClaudePermissionCli";
import { suggestTaskIcon } from "@/lib/tasks/taskIconSuggest";
import { RuntimeJournal } from "@/runtime-host/journal";
import { runtimeScope } from "@/lib/runtime/contracts";

/*
 * The phone's browser evidence driver: the real Viewer at phone width, in
 * both colour schemes, against the production stylesheet
 * (`issue1671Evidence.fixture.tsx`), one case per issue:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "<case>"
 *
 * happy-dom has no compositor, so what only a browser can settle is settled
 * here, with real touch input where a gesture is the question — CDP
 * `Input.dispatchTouchEvent`, so the page's `touch-action` meets Chromium's
 * own gesture recognizer.
 *
 * #1671's case drove the board's swipe tray and its inline «All
 * conversations». Both left the board with #2072 slice 4 (the column pager
 * owns the sideways swipe, and history leaves the work surface); its readings
 * stay in `evidence/issue-1671/geometry.json`, what a row can have done to it
 * is now its long-press sheet, and the #2072 slice 4 cases below drive that
 * board with real touches.
 */

const browserTest = process.env.LLV_SWIPE_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1671");
/** The fixture's running conversation, under its managed account's home. */
const runningPath = (account: string) => `/state/agent-log-viewer/shared/accounts/claude/${account}/projects/atlas/running.jsonl`;
const RUNNING_PATH = runningPath("spare");
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 430, height: 932 }] as const;
const SCHEMES = ["light", "dark"] as const;

describe("shared memory settings", () => {
  browserTest("project switch and explanation render in both languages at desktop and phone widths", async () => {
    const out = path.resolve(".artifacts/shared-memory"); fs.mkdirSync(out, { recursive: true });
    let enabled = true;
    const server = await serveEvidenceFixture(out, "src/components/memory/memoryEvidence.fixture.tsx", {
      "/api/memory/settings": async (request: Request) => {
        if (request.method === "PUT") enabled = (await request.json()).enabled;
        return Response.json({ enabled, reasons: enabled ? [] : ["projectOff"], keySource: "file", capUsd: 1, spentUsd: .002, month: "2026-10",
          counts: { decisions: 2, delivered: 1, prepared: 1, noCandidates: 0, noMatches: 1, skipped: 3, failed: 0 } });
      },
      "/api/asks-you/key": { present: true, source: "file" },
      "/api/telemetry": { enabled: false, locked: false, noticeDismissed: true },
    });
    const launched = await chromium.launchServer({ executablePath: process.env.CHROME_BIN, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    const pid = launched.process().pid;
    fs.writeFileSync(path.join(out, "browser-process.json"), JSON.stringify({ pid, closed: false }));
    const browser = await chromium.connect(launched.wsEndpoint());
    const evidence = [];
    try {
      for (const locale of ["en", "uk"] as const) for (const width of [1440, 390]) {
        enabled = true;
        const { page, context, pageErrors } = await openFixture(browser, server.base + "#p=atlas", { width, height: 900 }, "light", locale, "reduce", width === 390);
        try {
          const offers = page.locator("[data-memory-offer]"); await offers.nth(1).waitFor();
          const offer = offers.first(), shortOffer = offers.nth(1);
          expect(await shortOffer.evaluate(el => el.tagName)).toBe("P");
          expect(await shortOffer.locator("summary").count()).toBe(0);
          /* The folded line keeps the bubble's trailing edge and measure, and on the phone its target is 44 px
             and clear of the copy control above it. */
          const edges = await page.evaluate(() => {
            const box = (el: Element | null) => el?.getBoundingClientRect();
            const bubble = box(document.querySelector("[data-user-bubble]")), summary = box(document.querySelector("[data-memory-offer] summary"));
            const actions = box(document.querySelector("[data-mobile-message-actions] button"));
            return { bubbleRight: bubble!.right, summaryLeft: summary!.left, summaryRight: summary!.right, summaryTop: summary!.top, summaryHeight: summary!.height, actionsBottom: actions?.bottom ?? 0, row: document.querySelector("[data-memory-offer]")!.parentElement!.getBoundingClientRect().width };
          });
          expect(Math.abs(edges.summaryRight - edges.bubbleRight)).toBeLessThanOrEqual(1);
          expect(edges.summaryLeft).toBeGreaterThanOrEqual(edges.summaryRight - edges.row * (width === 390 ? .86 : .75) - 1);
          if (width === 390) {
            expect(edges.summaryHeight).toBeGreaterThanOrEqual(44);
            expect(edges.summaryTop).toBeGreaterThanOrEqual(edges.actionsBottom - 1);
            const top = await page.evaluate(() => { const r = document.querySelector("[data-memory-offer] summary")!.getBoundingClientRect(); return document.elementFromPoint(r.right - 4, r.top + .5)?.closest("summary") !== null; });
            expect(top).toBe(true);
          } else {
            const offerGeometry = await offer.locator("summary").evaluate(el => ({ height: el.getBoundingClientRect().height, line: Number.parseFloat(getComputedStyle(el).lineHeight) }));
            expect(offerGeometry.height).toBeLessThanOrEqual(offerGeometry.line + 1);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await page.screenshot({ path: path.join(out, `offer-${locale}-${width}.png`) });
          await offer.locator("summary").click();
          /* Opened, the same line carries every title once: nothing is repeated under it. */
          expect(await offer.locator("p").count()).toBe(0);
          const opened = await offer.innerText();
          for (let i = 1; i <= 15; i++) expect(opened.match(new RegExp(`constraint ${i}(?!\\d)`, "g"))).toHaveLength(1);
          await page.screenshot({ path: path.join(out, `offer-open-${locale}-${width}.png`) });
          await page.evaluate(() => window.dispatchEvent(new Event("delegatus:open-settings")));
          const setting = page.locator("[data-memory-setting]"); await setting.waitFor();
          const control = setting.getByRole("switch"); await page.waitForFunction(() => (document.querySelector("[data-memory-setting] input") as HTMLInputElement)?.checked === true); await expect(control.isChecked()).resolves.toBe(true);
          await control.click(); await page.waitForFunction(() => !(document.querySelector("[data-memory-setting] input") as HTMLInputElement)?.checked);
          const geometry = await setting.evaluate(el => ({ width: el.getBoundingClientRect().width, scroll: el.scrollWidth, client: el.clientWidth, text: el.textContent }));
          expect(geometry.scroll).toBeLessThanOrEqual(geometry.client + 1);
          expect(pageErrors).toEqual([]);
          await page.screenshot({ path: path.join(out, `${locale}-${width}.png`) });
          evidence.push({ locale, width, fits: geometry.scroll <= geometry.client + 1, toggled: !enabled, pageErrors });
        } finally { await context.close(); }
      }
      fs.mkdirSync("evidence/shared-memory", { recursive: true });
      fs.writeFileSync("evidence/shared-memory/settings.json", JSON.stringify(evidence, null, 2) + "\n");
    } finally {
      await browser.close(); await launched.close(); server.stop();
      fs.writeFileSync(path.join(out, "browser-process.json"), JSON.stringify({ pid, closed: true }));
    }
  }, 90000);

  browserTest("status, shared key and ledger stay readable in en and uk at 1440 and 390", async () => {
    const { NextRequest } = await import("next/server");
    const memory = await import("@/app/api/memory/settings/route");
    const keyRoute = await import("@/app/api/asks-you/key/route");
    const { setSharedMemoryEnabled } = await import("@/lib/memory/settings");
    const { memoryIndex } = await import("@/lib/memory/service");
    const { writeAsksYouSettings } = await import("@/lib/asks/settings");
    const { mutateOperatorAsks } = await import("@/lib/asks/store");
    const { asksYouSettingView } = await import("@/lib/asks/view");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-memory-browser-"));
    const previous = { ...process.env };
    process.env.LLV_STATE_DIR = path.join(root, "state");
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.PORT;
    delete process.env.LLV_STAGING;
    const out = path.resolve(".artifacts/shared-memory-settings"); fs.mkdirSync(out, { recursive: true });
    let failKeyWrite = false;
    const server = await serveEvidenceFixture(out, undefined, {
      "/api/telemetry": { enabled: false, locked: false, noticeDismissed: true },
      "/api/memory/settings": (request: Request) => request.method === "PUT" ? memory.PUT(new NextRequest(request)) : memory.GET(new NextRequest(request)),
      "/api/asks-you/key": (request: Request) => request.method === "PUT"
        ? failKeyWrite ? Response.json({ error: "write_failed" }, { status: 500 }) : keyRoute.PUT(new NextRequest(request))
        : keyRoute.GET(),
      "/api/asks-you": () => Response.json(asksYouSettingView()),
    });
    // Record the owned browser PID and close precisely this launch through its server.
    let launched: Awaited<ReturnType<typeof chromium.launchServer>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.connect>> | undefined;
    let browserPid: number | undefined;
    const cases: unknown[] = [];
    try {
      launched = await chromium.launchServer({ executablePath: process.env.CHROME_BIN, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
      browserPid = launched.process().pid;
      fs.writeFileSync(path.join(out, "browser-process.json"), JSON.stringify({ pid: browserPid, closed: false }));
      browser = await chromium.connect(launched.wsEndpoint());
      for (const lang of ["en", "uk"] as const) for (const width of [1440, 390]) {
        setSharedMemoryEnabled("atlas", true);
        writeAsksYouSettings({ capUsd: 1 });
        delete process.env.OPENROUTER_API_KEY;
        process.env.PORT = "9876";
        fs.mkdirSync(process.env.LLV_STATE_DIR!, { recursive: true });
        fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "viewer-release.json"), JSON.stringify({ endpoint: "http://127.0.0.1:9875" }));
        const { context, page, pageErrors } = await openFixture(browser, `${server.base}?scenario=memory-settings`, { width, height: 900 }, "light", lang, "reduce", width === 390);
        try {
          await page.evaluate(() => window.dispatchEvent(new Event("delegatus:open-settings")));
          const dialog = page.locator("[data-telemetry-settings]");
          await dialog.waitFor();
          await page.locator("[data-memory-status]").waitFor();
          await page.locator("[data-provider-key] input").waitFor();
          const measure = async (state: string) => {
            await dialog.evaluate(node => { node.scrollTop = 0; });
            const geometry = await dialog.evaluate(node => {
              const box = node.getBoundingClientRect();
              const rows = [...node.querySelectorAll<HTMLElement>("[data-memory-setting], [data-provider-key]")].map(row => {
                const r = row.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, overflow: row.scrollWidth - row.clientWidth };
              });
              const controls = [...node.querySelectorAll<HTMLElement>("input, button")].map(control => {
                const r = control.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
              });
              const elements = [...node.querySelectorAll<HTMLElement>("[data-memory-setting] p, [data-memory-setting] label, [data-memory-setting] input, [data-provider-key] p, [data-provider-key] label, [data-provider-key] input, [data-provider-key] button")];
              const overlaps = elements.flatMap((a, i) => elements.slice(i + 1).filter(b => {
                if (a.contains(b) || b.contains(a)) return false;
                const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
                return Math.min(ar.right, br.right) - Math.max(ar.left, br.left) > 1
                  && Math.min(ar.bottom, br.bottom) - Math.max(ar.top, br.top) > 1;
              }).map(b => ({ first: a.tagName, second: b.tagName })));
              const memoryError = node.querySelector<HTMLElement>("[data-memory-setting] [role=alert]");
              const errorStyle = memoryError ? getComputedStyle(memoryError) : null;
              return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
                overflow: node.scrollWidth - node.clientWidth, scrollHeight: node.scrollHeight, height: node.clientHeight, rows, controls,
                status: node.querySelector("[data-memory-status]")?.textContent,
                counts: node.querySelector("[data-memory-counts]")?.textContent,
                overlaps,
                memoryError: memoryError ? { text: memoryError.textContent, fontSize: errorStyle!.fontSize, lineHeight: errorStyle!.lineHeight,
                  gap: memoryError.getBoundingClientRect().top - memoryError.previousElementSibling!.getBoundingClientRect().bottom } : null,
                keyError: node.querySelector("[data-provider-key] [role=alert]")?.textContent };
            });
            expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(width);
            expect(geometry.top).toBeGreaterThanOrEqual(0); expect(geometry.bottom).toBeLessThanOrEqual(900);
            expect(geometry.overflow).toBeLessThanOrEqual(1);
            expect(geometry.rows[0].bottom).toBeLessThanOrEqual(geometry.rows[1].top);
            expect(geometry.rows.every(row => row.overflow <= 1)).toBe(true);
            expect(geometry.controls.every(control => control.left >= geometry.left && control.right <= geometry.right)).toBe(true);
            expect(geometry.overlaps).toEqual([]);
            if (geometry.memoryError) {
              expect(geometry.memoryError.fontSize).toBe("13px");
              expect(geometry.memoryError.gap).toBe(8);
            }
            cases.push({ lang, width, state, ...geometry, pageErrors });
            await page.screenshot({ path: path.join(out, `${lang}-${width}-${state}.png`) });
            await page.locator("[data-provider-key]").scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(out, `${lang}-${width}-${state}-key.png`) });
          };
          expect(await page.locator("[data-memory-status]").textContent()).toContain(translate(lang, "memory.status.notOwner"));
          expect(await page.locator("[data-memory-status]").textContent()).toContain(translate(lang, "memory.status.noKey"));
          await measure("missing-key");
          const invalid = "fixture\u200Bkey";
          await page.locator("[data-provider-key] input").fill(invalid);
          await page.locator("[data-provider-key] button").click();
          await page.getByText(translate(lang, "providerKey.invalid"), { exact: true }).waitFor();
          expect(await page.locator("[data-provider-key] input").inputValue()).toBe("");
          expect(await dialog.textContent()).not.toContain(invalid);
          await measure("invalid-key");
          failKeyWrite = true;
          await page.locator("[data-provider-key] input").fill("fixture-browser-key");
          await page.locator("[data-provider-key] button").click();
          await page.getByText(translate(lang, "providerKey.failed"), { exact: true }).waitFor();
          expect(await page.locator("[data-provider-key] input").inputValue()).toBe("");
          expect(await dialog.textContent()).not.toContain("fixture-browser-key");
          await measure("write-failed");
          failKeyWrite = false;
          // No file key is seeded; the only secret sent is this fake fixture.
          await page.locator("[data-provider-key] input").fill("fixture-browser-key");
          await page.locator("[data-provider-key] button").click();
          await page.getByText(translate(lang, "providerKey.saved"), { exact: true }).waitFor();
          expect(await page.locator("[data-provider-key] input").inputValue()).toBe("");
          await measure("inactive");
          delete process.env.PORT;
          memoryIndex().recordInjectionActivity("decisions");
          memoryIndex().recordInjectionActivity("noMatches");
          await page.evaluate(() => window.dispatchEvent(new Event("delegatus:provider-key-changed")));
          await page.waitForFunction(text => document.querySelector("[data-memory-status]")?.textContent === text, translate(lang, "memory.status.ready"));
          await measure("ready");
          mutateOperatorAsks(file => { file.spend.usd = 1; });
          await page.evaluate(() => window.dispatchEvent(new Event("delegatus:provider-key-changed")));
          await page.waitForFunction(text => document.querySelector("[data-memory-status]")?.textContent === text, translate(lang, "memory.status.capped"));
          await measure("capped");
          await page.locator("[data-memory-setting] [role=switch]").click();
          await page.waitForFunction(text => document.querySelector("[data-memory-status]")?.textContent?.includes(text), translate(lang, "memory.status.projectOff"));
          await measure("off");
          process.env.OPENROUTER_API_KEY = "test-env";
          await page.reload();
          await page.evaluate(() => window.dispatchEvent(new Event("delegatus:open-settings")));
          await page.getByText(translate(lang, "providerKey.env"), { exact: true }).waitFor();
          expect(await page.locator("[data-provider-key] input").count()).toBe(0);
          expect(await page.locator("[data-provider-key]").textContent()).not.toContain(translate(lang, "providerKey.shared"));
          await measure("environment");
          process.env.LLV_STAGING = "1";
          for (const source of ["env", "file"] as const) {
            if (source === "file") delete process.env.OPENROUTER_API_KEY;
            await page.reload();
            await page.evaluate(() => window.dispatchEvent(new Event("delegatus:open-settings")));
            await page.getByText(translate(lang, "providerKey.staging"), { exact: true }).waitFor();
            expect(await page.locator("[data-provider-key] form").count()).toBe(0);
            expect(await page.locator("[data-provider-key] input").count()).toBe(0);
            expect(await page.locator("[data-provider-key]").textContent()).not.toContain(translate(lang, "providerKey.shared"));
            await measure(`staging-${source}`);
          }
          const { openRouterKeyPath } = await import("@/lib/asks/settings");
          fs.rmSync(openRouterKeyPath(), { force: true });
          await page.reload();
          await page.evaluate(() => window.dispatchEvent(new Event("delegatus:open-settings")));
          await page.getByText(translate(lang, "providerKey.staging"), { exact: true }).waitFor();
          await page.waitForFunction(text => document.querySelector("[data-memory-status]")?.textContent?.includes(text), translate(lang, "memory.status.noKeyStaging"));
          expect(await page.locator("[data-memory-status]").textContent()).not.toContain(translate(lang, "memory.status.noKey"));
          expect(await page.locator("[data-provider-key] input").count()).toBe(0);
          expect(await page.locator("[data-provider-key]").textContent()).not.toContain(translate(lang, "providerKey.shared"));
          await measure("staging-missing-key");
          delete process.env.LLV_STAGING;
          await page.reload();
          await page.evaluate(() => window.dispatchEvent(new Event("delegatus:open-settings")));
          await page.locator("[data-provider-key] input").waitFor();
          const stateRoot = process.env.LLV_STATE_DIR!;
          const spendFile = path.join(stateRoot, "operator-asks.json");
          const spendBefore = fs.readFileSync(spendFile, "utf8");
          const pendingDirectory = path.join(stateRoot, "memory-injection-pending");
          for (const broken of ["spend", "pending"] as const) {
            if (broken === "spend") fs.writeFileSync(spendFile, "broken");
            else {
              fs.mkdirSync(pendingDirectory, { recursive: true });
              fs.writeFileSync(path.join(pendingDirectory, "a".repeat(64) + ".json"), "{}");
            }
            await page.evaluate(() => window.dispatchEvent(new Event("delegatus:provider-key-changed")));
            await page.waitForFunction(text => document.querySelector("[data-memory-status]")?.textContent === text, translate(lang, "memory.status.failed"));
            const control = page.locator("[data-memory-setting] [role=switch]");
            expect(await control.isEnabled()).toBe(true);
            const wasEnabled = await control.isChecked();
            await control.click();
            await page.waitForFunction(enabled => {
              const input = document.querySelector<HTMLInputElement>("[data-memory-setting] input");
              return input && !input.disabled && input.checked === enabled;
            }, !wasEnabled);
            expect(await control.isChecked()).toBe(!wasEnabled);
            expect(await page.locator("[data-memory-counts]").count()).toBe(0);
            expect(await page.locator("[data-memory-setting]").textContent()).not.toContain("$");
            await measure(`unavailable-${broken}`);
            if (broken === "spend") fs.writeFileSync(spendFile, spendBefore);
            else fs.rmSync(pendingDirectory, { recursive: true });
          }
          const settingFile = path.join(stateRoot, "shared-memory-settings.json");
          const settingBefore = fs.readFileSync(settingFile, "utf8");
          // Refresh the restored ledger before exercising a failed setting write.
          await page.evaluate(() => window.dispatchEvent(new Event("delegatus:provider-key-changed")));
          await page.locator("[data-memory-counts]").waitFor();
          const statusBefore = await page.locator("[data-memory-status]").textContent();
          const countsBefore = await page.locator("[data-memory-counts]").textContent();
          fs.writeFileSync(settingFile, "broken");
          await page.locator("[data-memory-setting] [role=switch]").click();
          await page.getByText(translate(lang, "memory.save.failed"), { exact: true }).waitFor();
          expect(await page.locator("[data-memory-setting] [role=switch]").isEnabled()).toBe(true);
          expect(await page.locator("[data-memory-status]").textContent()).toBe(statusBefore);
          expect(await page.locator("[data-memory-counts]").textContent()).toBe(countsBefore);
          await measure("memory-write-failed");
          fs.writeFileSync(settingFile, settingBefore);
          expect(pageErrors).toEqual([]);
        } finally { await context.close(); }
        // The next language/viewport starts with no file key.
        const { openRouterKeyPath } = await import("@/lib/asks/settings");
        fs.rmSync(openRouterKeyPath(), { force: true });
        mutateOperatorAsks(file => { file.spend.usd = 0; });
      }
      fs.mkdirSync("evidence/shared-memory-settings", { recursive: true });
      fs.writeFileSync("evidence/shared-memory-settings/geometry.json", JSON.stringify({ driver: "src/components/mobile/issue1671Evidence.browser.test.tsx", cases }, null, 2) + "\n");
    } finally {
      await browser?.close(); await launched?.close(); server.stop();
      fs.writeFileSync(path.join(out, "browser-process.json"), JSON.stringify({ pid: browserPid, closed: true }));
      memoryIndex().close();
      for (const name of ["LLV_STATE_DIR", "XDG_CONFIG_HOME", "OPENROUTER_API_KEY", "PORT", "LLV_STAGING"]) {
        if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

});

describe("runtime idle performance", () => {
  browserTest("limits keep the phone stream joined without snapshot refetches", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-phone-perf-"));
    const journal = new RuntimeJournal(path.join(directory, "journal.sqlite"));
    let interval: ReturnType<typeof setInterval> | null = null;
    let stopFixture = () => {};
    let browser: Awaited<ReturnType<typeof launchChromium>> | null = null;
    const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
    try {
      const scope = runtimeScope("session", "conversation_running");
      for (let i = 0; i < 120; i++) {
        const sessionScope = i === 0 ? scope : runtimeScope("session", `conversation-perf-${i}`);
        journal.append({ scope: sessionScope, kind: "session-status", payload: { host: "hosted", turn: "running", activeTurnId: "perf-turn", artifactPath: i === 0 ? RUNNING_PATH : `/sessions/perf-${i}.jsonl` } });
        journal.append({ scope: sessionScope, kind: "delta", payload: { turnId: "perf-turn", text: "Measured idle runtime state. ".repeat(170) } });
      }
      const limits = () => journal.append({ scope, kind: "limits", payload: { snapshot: { remaining: 80 } } });
      limits();
      const encode = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
      let reads = 0;
      interval = setInterval(() => {
        const bytes = encode(limits());
        for (const client of clients) client.enqueue(bytes);
      }, 1000);
      const snapshotBytes = Buffer.byteLength(JSON.stringify(journal.snapshot()));
      expect(snapshotBytes).toBeGreaterThanOrEqual(1_200_000);
      expect(snapshotBytes).toBeLessThanOrEqual(1_500_000);
      const { base, stop } = await serveFixture({
        "/api/runtime/snapshot": () => { reads++; return Response.json({ ...journal.snapshot(), structuredHostsEnabled: true }); },
        "/api/runtime/stream": (request: Request) => {
          let controller: ReadableStreamDefaultController<Uint8Array>;
          const body = new ReadableStream<Uint8Array>({
            start(next) {
              controller = next;
              clients.add(next);
              const after = Number(new URL(request.url).searchParams.get("after"));
              for (const event of journal.replay(after).events) next.enqueue(encode(event));
            },
            cancel() { clients.delete(controller); },
          });
          request.signal.addEventListener("abort", () => { clients.delete(controller); }, { once: true });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        },
      });
      stopFixture = stop;
      browser = await launchChromium();
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      await context.addInitScript(() => localStorage.setItem("llv_lang", "uk"));
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.addInitScript(() => {
        const tasks: Array<{ start: number; duration: number }> = [];
        Object.assign(window, { runtimePerfTasks: tasks });
        new PerformanceObserver(list => {
          for (const entry of list.getEntries()) tasks.push({ start: entry.startTime, duration: entry.duration });
        }).observe({ type: "longtask", buffered: true });
      });
      await page.goto(`${base}/?runtime=perf`);
      await page.locator("[data-phone-card]").first().waitFor();
      // Same TTI definition as the production audit: last long task before 2s quiet.
      let interactiveMs: number | null = null;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const reading = await page.evaluate(() => {
          const tasks = (window as typeof window & { runtimePerfTasks: Array<{ start: number; duration: number }> }).runtimePerfTasks;
          const last = Math.max(0, ...tasks.map(task => task.start + task.duration));
          return { last, quiet: performance.now() - last >= 2000 };
        });
        if (reading.quiet) { interactiveMs = Math.round(reading.last); break; }
        await page.waitForTimeout(250);
      }
      const before = reads;
      const frames = await page.evaluate(async () => {
        const start = performance.now();
        let count = 0;
        return new Promise<{ count: number; durationMs: number; fps: number }>(resolve => {
          const frame = () => {
            count++;
            const durationMs = performance.now() - start;
            if (durationMs >= 60_000) resolve({ count, durationMs: Math.round(durationMs), fps: Number((count * 1000 / durationMs).toFixed(1)) });
            else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
      });
      const result = { snapshotBytes, cpuThrottle: 4, viewport: "390x844", locale: "uk", interactiveMs, idleSnapshotFetches: reads - before, ...frames };
      fs.mkdirSync("evidence/runtime-idle", { recursive: true });
      const label = process.env.LLV_RUNTIME_PERF_LABEL === "before" ? "before" : "after";
      fs.writeFileSync(`evidence/runtime-idle/${label}.json`, JSON.stringify(result, null, 2) + "\n");
      console.log("runtime idle performance", JSON.stringify(result));
      await context.close();
      expect(result.idleSnapshotFetches).toBe(0);
      expect(interactiveMs).not.toBeNull();
    } finally {
      await browser?.close();
      stopFixture();
      if (interval) clearInterval(interval);
      clients.clear();
      journal.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("self-update reload notice", () => {
  browserTest("a phone page open across a release switch offers a visible reload button", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      try {
        await context.addInitScript(() => localStorage.setItem("llv_lang", "uk"));
        const page = await context.newPage();
        await page.goto(`${base}/?self-update-reload=1`);
        await page.waitForFunction(() => (window as typeof window & { evidence?: { presenceReplies?: number } }).evidence?.presenceReplies);
        await page.keyboard.press("Shift");
        const notice = page.locator("[data-release-reload]");
        await notice.waitFor({ timeout: 10_000 });
        expect(await notice.innerText()).toContain("Тепер веб працює на bbbbbbb");
        const button = notice.getByRole("button", { name: "Перезавантажити" });
        const box = await button.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.height).toBeGreaterThanOrEqual(32);
        expect(box!.x + box!.width).toBeLessThanOrEqual(390);
      } finally { await context.close(); }
    } finally { await browser.close(); stop(); }
  }, 30_000);
});

browserTest("linked installs: this install renders at 390 and desktop widths in en and uk", async () => {
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const out = path.resolve(".artifacts/linked-installs");
  fs.mkdirSync(out, { recursive: true });
  const readings: Array<{ width: number; locale: string; mode: string; state: string; overflow: boolean }> = [];
  try {
    for (const mode of ["safe", "unsafe", "keyoff", "lan-dns"] as const) for (const locale of ["en", "uk"] as const) for (const width of [390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark" });
      try {
        await context.addInitScript((lang) => localStorage.setItem("llv_lang", lang), locale);
        const page = await context.newPage();
        await page.goto(`${base}/?linked=${mode}`);
        await page.evaluate(() => window.dispatchEvent(new Event("delegatus:open-linked-settings")));
        const expected = mode === "unsafe" ? "needs-remote-entry" : mode === "keyoff" ? "needs-access-key" : "ok";
        await page.locator(`[data-linked-state="${expected}"]`).waitFor();
        const dialog = page.locator("[data-linked-settings]");
        const overflow = await dialog.evaluate((element) => element.scrollWidth > window.innerWidth);
        const state = await page.locator(`[data-linked-state="${expected}"]`).innerText();
        expect(overflow).toBe(false);
        const savedAddress = mode === "lan-dns" ? "http://board.internal.test:8897" : "https://delegatus.example.com";
        expect(await dialog.locator('input[type="url"]').inputValue()).toBe(savedAddress);
        const warning = dialog.locator("[data-linked-http-warning]");
        if (mode === "lan-dns") {
          expect(await warning.isVisible()).toBe(true);
          expect(await warning.innerText()).toBe(locale === "uk"
            ? "Ця LAN-адреса HTTP не шифрує дані. Будь-хто в цій мережі може прочитати передане."
            : "This LAN HTTP address is unencrypted. Anyone on this network can read what is sent.");
        } else expect(await warning.count()).toBe(0);
        expect(state.length).toBeGreaterThan(0);
        if (mode === "unsafe") expect((await dialog.innerText())).not.toContain("127.0.0.1:8898");
        if (mode === "keyoff") expect(await dialog.getByRole("button", { name: locale === "uk" ? "Увімкнути ключ доступу" : "Turn on the access key" }).count()).toBe(1);
        await page.screenshot({ path: path.join(out, `${mode}-${width}-${locale}.png`), fullPage: true });
        readings.push({ width, locale, mode, state, overflow });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); stop(); }
  fs.mkdirSync("evidence/linked-installs", { recursive: true });
  fs.writeFileSync("evidence/linked-installs/this-install.json", `${JSON.stringify({ readings }, null, 2)}\n`);
}, 120_000);

browserTest("linked installs: a failed Settings read keeps the dialog usable", async () => {
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}/?linked=error`);
    await page.evaluate(() => window.dispatchEvent(new Event("delegatus:open-linked-settings")));
    await page.locator('[data-linked-state="unavailable"]').waitFor();
    expect(await page.locator("[data-linked-settings]").count()).toBe(1);
    expect(await page.locator('[data-linked-settings] button').count()).toBeGreaterThan(0);
  } finally { await browser.close(); stop(); }
}, 30_000);

/*
 * The external relay (docs/design/relay.md §B.9): its settings at phone and
 * desktop widths in en and uk over the fixture's `?relay=` scenes (a relay at
 * work beside a paused one, a refused credential beside an unreachable
 * service, a pairing waiting on the owner in the service, one waiting on the
 * operator here, one the service declined), each opened the way the operator
 * opens it — the rail's ⋯ menu at desktop width, the menu sheet on the phone
 * — and the setup guide's optional step, which lets a pairing start only
 * while an account of the chosen engine is signed in. Frames go to
 * `.artifacts/external-relay`, readings to
 * `evidence/external-relay/settings.json`.
 */
browserTest("external relay: settings and the setup guide's step at 390 and desktop widths in en and uk", async () => {
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const out = path.resolve(".artifacts/external-relay");
  fs.mkdirSync(out, { recursive: true });
  const readings: Record<string, unknown>[] = [];
  const failures: string[] = [];
  try {
    for (const locale of ["en", "uk"] as const) for (const width of [390, 1440]) {
      const phone = width === 390;
      const open = async (scene: string) => {
        const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: "dark", ...(phone ? { hasTouch: true, isMobile: true } : {}) });
        await context.addInitScript((lang) => localStorage.setItem("llv_lang", lang), locale);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${base}/?relay=${scene}`);
        return { context, page, errors };
      };
      for (const scene of ["paired", "troubled", "code", "confirm", "ended"] as const) {
        const label = `settings-${scene}-${width}-${locale}`;
        const { context, page, errors } = await open(scene);
        try {
          /* The entry row itself: the phone's menu sheet, the desktop rail's ⋯ menu. */
          if (phone) await page.locator('[data-mobile2-open="menu"]').click();
          else await page.locator("[data-rail-menu]").click();
          const entry = page.locator(phone ? '[data-mobile2-menu-row="external-relay"]' : "[data-rail-menu-external-relay]");
          await entry.waitFor();
          const row = await entry.evaluate((element) => {
            const box = element.getBoundingClientRect();
            return { text: (element as HTMLElement).innerText.trim(), width: Math.round(box.width), height: Math.round(box.height) };
          });
          await entry.click();
          const dialog = page.locator("[data-external-relay-settings]");
          await dialog.waitFor();
          const ready = scene === "paired" || scene === "troubled" ? "[data-external-relay=relay-1]" : scene === "code" ? "[data-external-relay-code]" : scene === "confirm" ? "[data-external-relay-owner]" : '[data-external-relay-pairing="denied"]';
          await page.locator(ready).waitFor();
          const reading = await dialog.evaluate((element) => {
            const body = element.querySelector<HTMLElement>(".overflow-y-auto")!;
            const controls = Array.from(element.querySelectorAll<HTMLElement>("button, select, input")).filter((control) => control.getClientRects().length > 0 && !(control instanceof HTMLInputElement && control.type === "checkbox"));
            return {
              overflow: element.scrollWidth > window.innerWidth || body.scrollWidth > body.clientWidth,
              minControlHeight: Math.min(...controls.map((control) => control.getBoundingClientRect().height)),
              states: Array.from(element.querySelectorAll("[data-external-relay-state]")).map((node) => node.getAttribute("data-external-relay-state")),
              stateLines: Array.from(element.querySelectorAll<HTMLElement>("[data-external-relay-state]")).map((node) => ({
                state: node.getAttribute("data-external-relay-state"),
                text: node.textContent,
                tone: node.className.includes("text-danger") ? "danger" : node.className.includes("text-warning") ? "warning" : "plain",
                color: getComputedStyle(node).color,
                background: getComputedStyle(node).backgroundColor,
              })),
              pairedAs: Array.from(element.querySelectorAll("[data-external-relay-paired-at]")).map((node) => node.textContent),
              pairing: element.querySelector("[data-external-relay-pairing]")?.getAttribute("data-external-relay-pairing") ?? null,
              pairingText: (element.querySelector("[data-external-relay-pairing]") as HTMLElement | null)?.innerText ?? null,
              lastOutcome: element.querySelector("[data-external-relay-last-outcome]")?.textContent ?? null,
              lastProgress: element.querySelector("[data-external-relay-last-progress]")?.textContent ?? null,
              targets: Array.from(element.querySelectorAll("[data-external-relay-target]")).map((row) => ({
                id: row.getAttribute("data-external-relay-target"),
                settings: Array.from(row.querySelectorAll("select")).map((select) => (select as HTMLSelectElement).value),
                settingsText: Array.from(row.querySelectorAll("select")).map((select) => (select as HTMLSelectElement).selectedOptions[0]?.textContent ?? null),
                answeredHere: (row.querySelector("[data-external-relay-answered-by]") as HTMLInputElement | null)?.checked ?? null,
                switchDisabled: (row.querySelector("[data-external-relay-answered-by]") as HTMLInputElement | null)?.disabled ?? null,
                noAccount: row.querySelector("[data-external-relay-no-account]") !== null,
              })),
              code: element.querySelector("[data-external-relay-code]")?.textContent ?? null,
              owner: element.querySelector("[data-external-relay-owner]")?.textContent ?? null,
            };
          });
          await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true });
          readings.push({ label, entry: row, ...reading });
          const entryText = locale === "uk" ? "Зовнішній ретранслятор" : "External relay";
          if (row.text !== entryText) failures.push(`${label}: the entry row reads ${JSON.stringify(row.text)}`);
          if (phone && row.height < 44) failures.push(`${label}: the menu sheet row is ${row.height}px tall`);
          if (reading.overflow) failures.push(`${label}: the dialog scrolls sideways`);
          const times = [reading.lastOutcome, reading.lastProgress, ...reading.pairedAs].filter(Boolean).join(" ");
          if (locale === "uk" && /AM|PM/.test(times)) failures.push(`${label}: Ukrainian times read ${JSON.stringify(times)}`);
          if (phone && reading.minControlHeight < 44) failures.push(`${label}: a control is ${reading.minControlHeight}px tall`);
          if (scene === "paired") {
            if (JSON.stringify(reading.states) !== JSON.stringify(["polling", "paused"])) failures.push(`${label}: poller states ${JSON.stringify(reading.states)}`);
            const [first, second, third] = reading.targets;
            if (JSON.stringify(first?.settings) !== JSON.stringify(["claude", "opus", "low", "2"]) || first?.answeredHere !== true) failures.push(`${label}: the first target reads ${JSON.stringify(first)}`);
            const effortText = locale === "uk" ? "низькі" : "low";
            if (first?.settingsText?.[2] !== effortText) failures.push(`${label}: the first target's effort reads ${JSON.stringify(first?.settingsText?.[2])}`);
            if (!second?.noAccount || !second.switchDisabled) failures.push(`${label}: a Codex target without a Codex account can be switched on`);
            if (!third?.switchDisabled) failures.push(`${label}: a target with no engine can be switched on`);
            if (!reading.lastProgress?.includes("Reading the last messages in the thread")) failures.push(`${label}: last progress reads ${JSON.stringify(reading.lastProgress)}`);
            if (locale === "en" && !reading.lastOutcome?.startsWith("Answered")) failures.push(`${label}: last outcome reads ${JSON.stringify(reading.lastOutcome)}`);
          }
          if (scene === "troubled") {
            const tones = reading.stateLines.map((line) => `${line.state}:${line.tone}`);
            if (JSON.stringify(tones) !== JSON.stringify(["credential_rejected:danger", "unreachable:warning"])) failures.push(`${label}: poller lines ${JSON.stringify(tones)}`);
            const [refused, unreachable] = reading.stateLines;
            if (!refused || !unreachable || refused.color === unreachable.color || refused.background === unreachable.background) failures.push(`${label}: the danger and warning lines render alike`);
          }
          if (scene === "ended") {
            if (reading.pairing !== "denied") failures.push(`${label}: the ended pairing reads ${JSON.stringify(reading.pairing)}`);
            if (!reading.pairingText?.includes("The owner declined this install in the relay service.")) failures.push(`${label}: the service's reason is missing from ${JSON.stringify(reading.pairingText)}`);
          }
          if (scene === "code" && reading.code !== "K7QM-9XTD") failures.push(`${label}: the code reads ${JSON.stringify(reading.code)}`);
          if (scene === "confirm" && !reading.owner?.includes("Person A (@person_a)")) failures.push(`${label}: the identity reads ${JSON.stringify(reading.owner)}`);
          if (errors.length) failures.push(`${label}: page errors ${errors.join(" | ")}`);
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally { await context.close(); }
      }
      /* The setup guide's step: Claude is signed in in the fixture, Codex is not. */
      const label = `guide-step-${width}-${locale}`;
      const { context, page, errors } = await open("none");
      try {
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("llv:open-onboarding", { detail: { mode: "guide", step: "relay" } })));
        const step = page.locator("[data-onboarding-relay]");
        await step.waitFor();
        await page.locator("[data-onboarding-relay-account]").waitFor();
        const read = () => page.evaluate(() => ({
          engine: document.querySelector('[data-onboarding-relay-engine][aria-checked="true"]')?.getAttribute("data-onboarding-relay-engine") ?? null,
          account: document.querySelector("[data-onboarding-relay-account]")?.getAttribute("data-onboarding-relay-account") ?? null,
          pairDisabled: (document.querySelector("[data-external-relay-connect-known]") as HTMLButtonElement | null)?.disabled ?? null,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          minControlHeight: Math.min(...Array.from(document.querySelectorAll<HTMLElement>("[data-onboarding-relay] button, [data-onboarding-relay] input"))
            .filter((control) => control.getClientRects().length > 0).map((control) => control.getBoundingClientRect().height)),
        }));
        const signedIn = await read();
        await page.screenshot({ path: path.join(out, `${label}-claude.png`) });
        await page.locator("[data-onboarding-relay-engine=codex]").click();
        await page.locator('[data-onboarding-relay-account="signed-out"]').waitFor();
        const signedOut = await read();
        await page.screenshot({ path: path.join(out, `${label}-codex.png`) });
        readings.push({ label, signedIn, signedOut });
        if (signedIn.engine !== "claude" || signedIn.account !== "signed-in" || signedIn.pairDisabled !== false) failures.push(`${label}: with Claude signed in the step reads ${JSON.stringify(signedIn)}`);
        if (signedOut.account !== "signed-out" || signedOut.pairDisabled !== true) failures.push(`${label}: with no Codex account the step reads ${JSON.stringify(signedOut)}`);
        if (signedIn.overflow || signedOut.overflow) failures.push(`${label}: the guide scrolls sideways`);
        if (phone && Math.min(signedIn.minControlHeight, signedOut.minControlHeight) < 44) failures.push(`${label}: a control in the step is under 44px tall`);
        if (errors.length) failures.push(`${label}: page errors ${errors.join(" | ")}`);
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); stop(); }
  fs.mkdirSync("evidence/external-relay", { recursive: true });
  fs.writeFileSync("evidence/external-relay/settings.json", `${JSON.stringify({ readings, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

type Point = [number, number];
interface Rect { x: number; y: number; width: number; height: number }

const pause = (page: Page, ms = 300) => page.waitForTimeout(ms);
const along = (from: Point, to: Point, steps = 12): Point[] =>
  Array.from({ length: steps + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]);

async function touch(cdp: CDPSession, points: Point[], stepMs = 16): Promise<void> {
  const [first, ...rest] = points;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: first![0], y: first![1] }] });
  for (const [x, y] of rest) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

const rectOf = (page: Page, selector: string) => page.evaluate((sel): Rect | null => {
  const element = document.querySelector(sel);
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}, selector);

async function centre(page: Page, selector: string): Promise<Point> {
  await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "center" }), selector);
  await pause(page, 250);
  const box = await rectOf(page, selector);
  if (!box) throw new Error(`nothing at ${selector}`);
  return [box.x + box.width / 2, box.y + box.height / 2];
}

/* A tap where the target already is. Scrolling first would be the operator
   moving the list, which puts an open tray away before the tap lands. */
async function tap(page: Page, cdp: CDPSession, selector: string): Promise<void> {
  const box = await rectOf(page, selector);
  if (!box) throw new Error(`nothing to tap at ${selector}`);
  await touch(cdp, [[box.x + box.width / 2, box.y + box.height / 2]]);
}

/** The fixture page, bundled and served: one setup every case below runs on.
    The shared harness builds it the way the Viewer's client bundle sees it,
    with server actions stubbed (#2009); a plain browser build pulls their
    Node-only bodies in and fails before any case runs. */
async function serveFixture(responses: Record<string, unknown> = {}): Promise<{ base: string; stop: () => void }> {
  fs.mkdirSync(OUT, { recursive: true });
  const { base, stop } = await serveEvidenceFixture(OUT, "src/components/mobile/issue1671Evidence.fixture.tsx", responses);
  return { base: base.replace(/\/$/, ""), stop };
}

/** Admit the sender's message through the production delivery boundary. The
 * engine stub writes its Claude transcript row; the real registry projection
 * supplies the browser's provenance endpoint. */
async function admittedAgentEvidence(): Promise<{ feed: string; provenance: unknown; senderConversationId: string }> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agent-label-evidence-"));
  const previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = sandbox;
  const registry = new AgentRegistry(path.join(sandbox, "registry.json"));
  setAgentRegistryForTests(registry);
  try {
    const senderPath = path.join(sandbox, "wardrobe-agent", "sender.jsonl");
    registry.reconcileConversations([{
      engine: "codex", path: senderPath, accountId: "default",
      launchProfile: emptyLaunchProfile({ cwd: path.dirname(senderPath), project: "wardrobe-agent" }),
      turn: { state: "idle", source: "empty", terminalAt: null }, observedAt: new Date().toISOString(),
    }]);
    const sender = registry.conversationForPath(senderPath)!;
    const recipient = registry.ensureConversation("claude", RUNNING_PATH, "default");
    const origin = agentMessageOrigin(registry.readOnlySnapshot(), sender.id, "orchestrator");
    const text = "The review found one issue. I am sending the handoff to this seat.";
    let engineInput = "";
    const outcome = await deliverConversationMessage({
      pid: 1, path: RUNNING_PATH, conversationId: recipient.id, text, images: [],
      clientMessageId: "agent-label-evidence-delivery", origin,
    }, {
      recover: async () => null,
      pathAllowed: () => true,
      listFiles: async () => [{ root: "claude-projects", path: RUNNING_PATH, project: "wardrobe-agent", mtime: 0, size: 0 } as FileEntry],
      resumeSpecFor: (() => ({ command: "resume", transcript: RUNNING_PATH, launchProfile: emptyLaunchProfile() })) as never,
      deliver: async ({ payload }: { payload: string }) => {
        engineInput = payload;
        return { ok: true as const, outcome: "resumed" as const, target: "%7" };
      },
    });
    if (!outcome.ok || engineInput !== text) throw new Error("agent evidence delivery did not settle");
    const delivery = Object.values(registry.readOnlySnapshot().heldDeliveries).find((row) => row.clientMessageId === "agent-label-evidence-delivery");
    if (!delivery?.deliveredAt) throw new Error("agent evidence has no durable settlement");
    const feed = [
      { type: "user", uuid: "evidence-operator-turn", timestamp: new Date(Date.parse(delivery.deliveredAt) - 120_000).toISOString(),
        sessionId: "conversation_running", message: { role: "user", content: "Please check the last review result." } },
      { type: "user", uuid: "evidence-agent-delivery", timestamp: delivery.deliveredAt, sessionId: "conversation_running",
        promptSource: "sdk", message: { role: "user", content: [{ type: "text", text: engineInput }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    const provenance = { messages: claudeMessageProvenance(RUNNING_PATH), occurrences: deliveredMessageOccurrences(RUNNING_PATH),
      submissions: {}, senders: {} };
    if (!provenance.occurrences.some((row) => row.origin === "agent" && row.senderConversationId === sender.id)) {
      throw new Error("agent evidence lost its server-attributed sender");
    }
    return { feed, provenance, senderConversationId: sender.id };
  } finally {
    setAgentRegistryForTests(null);
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

const launchChromium = () => chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });

describe("close-card receipt Reopen", () => {
  browserTest("restores root and manual cards at 390 in en and uk across the next board refresh", async () => {
    const out = path.resolve(".artifacts/phone-reopen");
    fs.mkdirSync(out, { recursive: true });
    const { base, stop } = await serveFixture();
    /* Own the browser server and retain its PID; closing this handle stops only
       the process this case launched, even if another browser is on the host. */
    const browserServer = await chromium.launchServer({ headless: true, args: ["--no-sandbox"], executablePath: process.env.CHROME_BIN });
    fs.writeFileSync(path.join(out, "browser.pid"), `${browserServer.process().pid}\n`);
    const browser = await chromium.connect(browserServer.wsEndpoint());
    const readings = [];
    try {
      for (const locale of ["en", "uk"] as const) for (const kind of ["root", "manual"] as const) {
        const target = kind === "root" ? RUNNING_PATH : "/repo/done-0.jsonl";
        const id = kind === "root" ? "conversation_running" : "conversation_done-0";
        const key = `${locale}-${kind}-390`;
        const { page, context, pageErrors } = await openFixture(browser, `${base}?reopen=${kind}#c=${id}`, { width: 390, height: 844 }, "dark", locale, "reduce", true);
        try {
          await page.locator('[data-testid="mobile-chat-shell"]').waitFor();
          const beforeWrites = await page.evaluate(() => (window as unknown as { evidence: { boardMutations: unknown[] } }).evidence.boardMutations.length);
          await page.locator('[data-mobile2-open="menu"]').first().click();
          await page.locator('[data-mobile2-menu-section="end"]').click();
          await page.locator('[data-mobile2-menu-row="close"]').click();
          await page.waitForFunction((path) => {
            const e = (window as unknown as { evidence: { boardSnapshot(): { prefs: { hidden: string[] } }; boardMutations: Array<{ kind: string; path?: string }> } }).evidence;
            return e.boardSnapshot().prefs.hidden.includes(path) && e.boardMutations.some(m => m.kind === "close" && m.path === path);
          }, target);
          const reopen = page.locator('[data-mobile2-receipt-undo="reopen"]');
          const receipt = await reopen.evaluate(el => {
            const r = el.getBoundingClientRect();
            return { text: el.textContent?.trim(), x: r.x, right: r.right, width: r.width, height: r.height };
          });
          expect(receipt.text).toBe(translate(locale, "mobile2.receipt.reopen"));
          expect(receipt.x).toBeGreaterThanOrEqual(0);
          expect(receipt.right).toBeLessThanOrEqual(390);
          expect(receipt.width).toBeGreaterThanOrEqual(44);
          expect(receipt.height).toBeGreaterThanOrEqual(44);
          await page.screenshot({ path: path.join(out, `${key}-closed.png`) });
          await reopen.click();
          await page.waitForFunction((path) => {
            const e = (window as unknown as { evidence: { boardSnapshot(): { prefs: { hidden: string[] } }; boardMutations: Array<{ kind: string; path?: string }> } }).evidence;
            return !e.boardSnapshot().prefs.hidden.includes(path) && e.boardMutations.some(m => m.kind === "restore" && m.path === path);
          }, target);
          /* Closing the focused card returns the phone to its board. */
          await page.locator('[data-phone-kanban-tab="inbox"]').click();
          const row = page.locator(`[data-phone-card-agent="${target}"]`);
          await row.waitFor();
          await row.scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(out, `${key}-restored.png`) });
          const beforeReads = await page.evaluate(() => {
            const e = (window as unknown as { evidence: { boardReads: number; advanceBoardRevision(): void } }).evidence;
            e.advanceBoardRevision();
            return e.boardReads;
          });
          await page.waitForFunction((before) => (window as unknown as { evidence: { boardReads: number } }).evidence.boardReads > before, beforeReads, { timeout: 15000 });
          /* Give the fetched snapshot its render before judging membership. */
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          expect(await row.isVisible()).toBe(true);
          await row.scrollIntoViewIfNeeded();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          expect(pageErrors).toEqual([]);
          await page.screenshot({ path: path.join(out, `${key}-refreshed.png`) });
          const writes = await page.evaluate(({ path, start }) => (window as unknown as { evidence: { boardMutations: Array<{ kind: string; path?: string; placement?: string }> } }).evidence.boardMutations.slice(start).filter(m => m.path === path && (m.kind === "close" || m.kind === "restore")), { path: target, start: beforeWrites });
          expect(writes.map(m => m.kind)).toEqual(["close", "restore"]);
          if (kind === "manual") expect(writes[1]?.placement).toBe("manual");
          readings.push({ locale, kind, viewport: { width: 390, height: 844 }, receipt, writes, restoredAfterRefresh: true, pageErrors });
        } finally { await context.close(); }
      }
      fs.mkdirSync("evidence/phone-reopen", { recursive: true });
      fs.writeFileSync("evidence/phone-reopen/receipt.json", JSON.stringify(readings, null, 2) + "\n");
    } finally { await browser.close(); await browserServer.close(); stop(); }
  }, 90000);
});

browserTest("agent-delivered seat message keeps its author at desktop and phone widths in both languages", async () => {
  const evidence = await admittedAgentEvidence();
  const { base, stop } = await serveFixture({ "/evidence/agent-message-label": evidence });
  const browser = await launchChromium();
  const out = path.join(os.homedir(), "Pictures/delegatus-review/agent-message-label");
  fs.mkdirSync(out, { recursive: true });
  try {
    for (const locale of ["en", "uk"] as const) {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: "dark",
          ...(width === 390 ? { hasTouch: true, isMobile: true } : {}) });
        try {
          await context.addInitScript((lang) => localStorage.setItem("llv_lang", lang), locale);
          const page = await context.newPage();
          await page.goto(`${base}/?agent-label=1#c=conversation_running`);
          await page.waitForSelector("[data-agent-author]", { timeout: 15_000 });
          await page.waitForSelector("[data-user-bubble]", { timeout: 15_000 });
          const label = await page.locator("[data-agent-author]").first().innerText();
          const roleLabel = locale === "uk" ? "Агент · Оркестратор" : "Agent · Orchestrator";
          if (!label.includes(roleLabel) || !label.includes("wardrobe-agent")) throw new Error(`agent label missing: ${label}`);
          const projectName = page.locator("[data-agent-project]").first();
          if (await projectName.textContent() !== " · wardrobe-agent") throw new Error("sender project name changed");
          if (await projectName.evaluate((element) => getComputedStyle(element).whiteSpace) !== "nowrap") throw new Error("sender project name can split across lines");
          const link = await page.locator("[data-agent-author] a").first().getAttribute("href");
          if (link !== `#c=${evidence.senderConversationId}`) throw new Error(`sender link missing: ${link}`);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
          if (overflow) throw new Error(`horizontal overflow at ${width}px`);
          if ((await page.locator("body").innerText()).includes("NaN")) throw new Error("invalid relative age rendered");
          await page.screenshot({ path: path.join(out, `${width}-${locale}.png`), fullPage: true });
          if (width === 1440) {
            await page.keyboard.press("Escape");
            await page.waitForSelector("[data-agent-author]");
            await page.screenshot({ path: path.join(out, `${width}-${locale}-dock.png`), fullPage: true });
          }
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); stop(); }
}, 120_000);

browserTest("composer queue: a lost seat read drains once on the phone and survives reload", async () => {
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const out = path.resolve(".artifacts/composer-queue");
  fs.mkdirSync(out, { recursive: true });
  const results = [];
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, colorScheme: "dark" });
      try {
        const page = await context.newPage();
        await page.goto(`${base}/?runtime=structured&queue-recovery=1#c=conversation_running`);
        const input = page.locator("textarea:visible").first();
        await input.fill("First message awaiting its seat read.");
        await input.press("Enter");
        await page.waitForSelector("[data-outbox-entry]", { timeout: 5_000 });
        await input.fill("Keep this original message.");
        await input.press("Enter");
        await page.waitForSelector('[data-outbox-state="queued"]');
        const key = await page.locator('[data-outbox-state="queued"]').getAttribute("data-outbox-entry");
        await page.screenshot({ path: path.join(out, `${viewport.width}-waiting.png`) });
        // Each serial entry reaches the production 15 s bound. The second row
        // stays visibly Queued on the unfixed composer, with no server operation.
        await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("evidence-queue-sends") ?? "[]").length === 2, undefined, { timeout: 40_000 });
        await page.waitForFunction(() => document.querySelectorAll('[data-outbox-state="delivered"]').length === 2);
        await page.screenshot({ path: path.join(out, `${viewport.width}-delivered.png`) });
        const sends = await page.evaluate(() => JSON.parse(sessionStorage.getItem("evidence-queue-sends") ?? "[]"));
        if (sends[1]?.idempotencyKey !== key || sends[1]?.text !== "Keep this original message."
          || sends[0]?.idempotencyKey === key) throw new Error("the original submission changed");
        await page.reload();
        await page.waitForSelector("textarea");
        await page.waitForTimeout(500);
        const count = await page.evaluate(() => JSON.parse(sessionStorage.getItem("evidence-queue-sends") ?? "[]").length);
        if (count !== 2) throw new Error("reload dispatched again");
        results.push({ viewport, posts: count, originalKeyPreserved: true, originalTextPreserved: true });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); stop(); }
  const evidence = path.resolve("evidence/composer-queue");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "recovery.json"), JSON.stringify(results, null, 2) + "\n");
}, 90_000);

/*
 * The microphone hint: on a phone whose browser will ask for the microphone
 * again although this device already allowed it, the composer carries one row
 * naming the setting that ends the question.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "microphone hint"
 *
 * Chromium stands in for Edge on an iPhone, the operator's browser: the user
 * agent is Edge's and the Permissions API answers "prompt", which is what a
 * WebKit view reports when it will ask. Readings go to
 * `evidence/mic-permission-hint/phone.json`; frames to
 * `.artifacts/mic-permission-hint/`, which is not committed.
 */
const MIC_HINT_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/138.0.0.0 Mobile/15E148 Safari/604.1";

browserTest("microphone hint: the record button with and without the hint at 390, en and uk, dark", async () => {
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const out = path.resolve(".artifacts/mic-permission-hint");
  fs.mkdirSync(out, { recursive: true });
  const readings: unknown[] = [];
  const failures: string[] = [];
  const viewport = { width: 390, height: 844 };
  const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  try {
    for (const locale of ["en", "uk"] as const) {
      const mic = `button[aria-label="${translate(locale, "mic.dictate")}"]`;
      const surfaces = { hint: "[data-mic-permission-hint]", unit: '[data-testid="composer-input-unit"]', send: "[data-mobile2-send]", mic };
      /* The visible composer's parts, and what a tap at the middle of each
         control would land on. */
      const read = (page: Page) => page.evaluate((selectors) => {
        const visible = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)].find((element) => element.getClientRects().length > 0) ?? null;
        const rect = (element: HTMLElement | null) => {
          if (!element) return null;
          const r = element.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        const reachable = (element: HTMLElement | null) => {
          if (!element) return false;
          const r = element.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return Boolean(hit && (hit === element || element.contains(hit)));
        };
        const hint = visible(selectors.hint);
        const unit = visible(selectors.unit);
        const send = visible(selectors.send);
        const micButton = visible(selectors.mic);
        const textarea = visible("textarea");
        return {
          hint: rect(hint), hintText: hint?.textContent ?? null, hintCount: document.querySelectorAll(selectors.hint).length,
          /* The text itself: the row's own scroll size counts the dismiss
             button's enlarged touch target. */
          hintCut: [...(hint?.querySelectorAll("span") ?? [])].some((text) => text.scrollWidth > text.clientWidth || text.scrollHeight > text.clientHeight),
          /* What a finger reaches: a walk from the button's centre, one pixel
             at a time, for as long as the point still lands on the button. The
             accessory region is a scrollport and clips whatever leaves it, so
             the style's own numbers overstate the target. */
          dismissTarget: (() => {
            const button = hint?.querySelector<HTMLElement>("[data-mic-permission-hint-dismiss]");
            if (!button) return null;
            const r = button.getBoundingClientRect();
            const cx = r.x + r.width / 2;
            const cy = r.y + r.height / 2;
            const lands = (x: number, y: number) => {
              const hit = document.elementFromPoint(x, y);
              return Boolean(hit && (hit === button || button.contains(hit)));
            };
            const reach = (dx: number, dy: number) => {
              let steps = 0;
              while (steps < 100 && lands(cx + dx * (steps + 1), cy + dy * (steps + 1))) steps += 1;
              return steps;
            };
            if (!lands(cx, cy)) return { width: 0, height: 0 };
            return { width: reach(-1, 0) + reach(1, 0) + 1, height: reach(0, -1) + reach(0, 1) + 1 };
          })(),
          unit: rect(unit), send: rect(send), mic: rect(micButton), textarea: rect(textarea),
          sendReachable: reachable(send), micReachable: reachable(micButton), textareaReachable: reachable(textarea),
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      }, surfaces);
      for (const scene of ["plain", "hint"] as const) {
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, colorScheme: "dark", userAgent: MIC_HINT_UA });
        try {
          await context.addInitScript(({ lang, granted }) => {
            localStorage.setItem("llv_lang", lang);
            if (granted) localStorage.setItem("llv_mic_granted", "1");
            Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: async () => ({ state: "prompt" }) } });
          }, { lang: locale, granted: scene === "hint" });
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await page.goto(`${base}/?runtime=structured#c=conversation_running`);
          await page.waitForSelector("textarea", { timeout: 15_000 });
          if (scene === "hint") await page.waitForSelector(surfaces.hint, { timeout: 5_000 });
          await pause(page, 600);
          const reading = await read(page);
          await page.screenshot({ path: path.join(out, `390-${locale}-${scene}.png`) });
          const at = `${locale} ${scene}`;
          if (!reading.unit || !reading.send || !reading.mic || !reading.textarea) { failures.push(`${at}: the composer is not whole`); continue; }
          if (reading.overflow) failures.push(`${at}: the page overflows sideways`);
          if (!reading.sendReachable || !reading.micReachable || !reading.textareaReachable) failures.push(`${at}: a composer control is covered`);
          if (scene === "plain") {
            if (reading.hintCount !== 0) failures.push(`${at}: a hint with no prior grant`);
            readings.push({ locale, scene, ...reading });
            continue;
          }
          if (!reading.hint || reading.hintCount !== 1) { failures.push(`${at}: expected one visible hint, found ${reading.hintCount}`); continue; }
          if (reading.hintText !== translate(locale, "mic.hint.iosOtherBrowser")) failures.push(`${at}: hint text is ${reading.hintText}`);
          if (reading.hintCut) failures.push(`${at}: the hint's text is cut`);
          if (!reading.dismissTarget || reading.dismissTarget.width < 44 || reading.dismissTarget.height < 44) failures.push(`${at}: the dismiss target is under 44 px`);
          if (reading.hint.x < 0 || reading.hint.x + reading.hint.width > viewport.width) failures.push(`${at}: the hint leaves the viewport`);
          if (reading.hint.y + reading.hint.height > reading.unit.y) failures.push(`${at}: the hint reaches into the input unit`);
          for (const [name, box] of [["send", reading.send], ["mic", reading.mic], ["textarea", reading.textarea]] as const) {
            if (overlaps(reading.hint, box)) failures.push(`${at}: the hint covers ${name}`);
          }
          /* Shown once per device: being on screen settles it, with no touch. */
          const reload = async () => {
            await page.reload();
            await page.waitForSelector("textarea", { timeout: 15_000 });
            await pause(page, 1_000);
            return read(page);
          };
          const seen = await page.evaluate(() => localStorage.getItem("llv_mic_hint_seen"));
          if (seen !== "1") failures.push(`${at}: the shown hint was not kept for the device`);
          const untouched: number[] = [];
          for (let load = 0; load < 3; load += 1) untouched.push((await reload()).hintCount);
          if (untouched.some((count) => count !== 0)) failures.push(`${at}: the hint came back on a reload nobody dismissed it before (${untouched.join(", ")})`);
          await page.screenshot({ path: path.join(out, `390-${locale}-untouched-reload.png`) });
          /* A device that has not seen it yet: a touch on the dismiss control
             removes the row at once, and it stays away after a reload. */
          await page.evaluate(() => localStorage.removeItem("llv_mic_hint_seen"));
          if ((await reload()).hintCount !== 1) { failures.push(`${at}: no hint to dismiss`); continue; }
          await tap(page, cdp, "[data-mic-permission-hint-dismiss]");
          await page.waitForSelector(surfaces.hint, { state: "detached", timeout: 3_000 });
          const after = await reload();
          if (after.hintCount !== 0) failures.push(`${at}: the hint came back after a dismissal and a reload`);
          await page.screenshot({ path: path.join(out, `390-${locale}-dismissed-reload.png`) });
          readings.push({ locale, scene, ...reading, shownKept: seen === "1", hintsAfterUntouchedReloads: untouched, hintsAfterDismissedReload: after.hintCount });
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); stop(); }
  const evidence = path.resolve("evidence/mic-permission-hint");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, "phone.json"), `${JSON.stringify({ viewport, scheme: "dark", browser: "Edge on iOS (user agent)", readings, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 180_000);

/*
 * #1795 — the runtime pill's sheet, on the same real Viewer, at the two phone
 * surfaces the operator reached it from and at a desktop viewport:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1795"
 *
 * happy-dom lays nothing out, so the defect the operator photographed — the
 * sheet rendered INSIDE the conversation pane, its grab bar, title and most of
 * the Model group above the visible area, the feed's down button floating over
 * it — is a browser question. Each surface records the chain of ancestors that
 * establish a containing block for `position: fixed` between the pill and the
 * document, then measures the open sheet against the viewport, hit-tests the
 * controls that were unreachable, re-taps the row the conversation already
 * runs on, and reads the account the surface names. The desktop case is here
 * rather than in a driver of its own because it is the same control: the
 * popover the sheet is the phone's face of.
 *
 * Readings go to `evidence/issue-1795/runtime-sheet.json`; frames to
 * `.artifacts/issue-1795/`, which is not committed.
 */
const SHEET_OUT = path.resolve(".artifacts/issue-1795");
/* Both phone widths, the short one the critique rendered at, and a 15-character
   account id — the width that took the model and its tier down with it. */
const SHEET_CASES = [
  { viewport: { width: 390, height: 844 }, account: "spare" },
  { viewport: { width: 430, height: 932 }, account: "spare" },
  { viewport: { width: 390, height: 600 }, account: "spare" },
  { viewport: { width: 390, height: 844 }, account: "review-relief-2" },
] as const;
const SHEET_EVIDENCE = path.resolve("evidence/issue-1795");

interface Containing { tag: string; marks: string[]; reasons: string[]; rect: Rect }

/** Every ancestor of `selector` that makes `position: fixed` resolve against
    itself instead of the viewport, nearest first. */
const containingBlocks = (page: Page, selector: string) => page.evaluate((sel): Containing[] => {
  const chain: Containing[] = [];
  const start = document.querySelector(sel);
  for (let node = start?.parentElement ?? null; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const reasons: string[] = [];
    if (style.transform !== "none") reasons.push(`transform: ${style.transform}`);
    if (style.perspective !== "none") reasons.push(`perspective: ${style.perspective}`);
    if (style.filter !== "none") reasons.push(`filter: ${style.filter}`);
    if (style.backdropFilter && style.backdropFilter !== "none") reasons.push(`backdrop-filter: ${style.backdropFilter}`);
    if (/paint|layout|strict|content/.test(style.contain ?? "")) reasons.push(`contain: ${style.contain}`);
    if ((style.containerType ?? "normal") !== "normal") reasons.push(`container-type: ${style.containerType}`);
    if ((style.contentVisibility ?? "visible") !== "visible") reasons.push(`content-visibility: ${style.contentVisibility}`);
    if (/transform|filter|perspective|contain/.test(style.willChange ?? "")) reasons.push(`will-change: ${style.willChange}`);
    if (!reasons.length) continue;
    const box = node.getBoundingClientRect();
    chain.push({
      tag: node.tagName.toLowerCase(),
      marks: [...node.attributes].map((attribute) => attribute.name).filter((name) => name.startsWith("data-")),
      reasons,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
  }
  return chain;
}, selector);

/** What the operator can actually see and hit: the box, whether it is inside
    the viewport, and what the topmost element at its centre belongs to. */
const reachable = (page: Page, selector: string, within: string) => page.evaluate(([sel, root]): null | (Rect & { inside: boolean; hitOwn: boolean }) => {
  const element = document.querySelector(sel!);
  const container = document.querySelector(root!);
  if (!element || !container) return null;
  const box = element.getBoundingClientRect();
  const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return {
    x: box.x, y: box.y, width: box.width, height: box.height,
    inside: box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight + 0.5 && box.right <= innerWidth + 0.5,
    hitOwn: top !== null && (container.contains(top) || element.contains(top) || element === top),
  };
}, [selector, within] as const);

/** The switcher row that opens the board lane's review round, whose pane the
    deck mounts on its own perspective stage. */
const REVIEW_ROW_PREFIX = translate("en", "mobile2.chat.reviewOf", { title: "" }).trim();

/** What the bar's meta line actually says, cell by cell, and whether any cell
    is showing less than its text — the line the account was crowding out. */
const headerReading = (page: Page) => page.evaluate(() => {
  const cell = (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      text: element.textContent ?? "",
      width: Math.round(box.width * 10) / 10,
      /* Chromium rounds a truncating box down by up to a pixel. */
      cut: element.scrollWidth > element.clientWidth + 1,
    };
  };
  const line = document.querySelector("[data-mobile2-chat-state]")?.parentElement ?? null;
  return {
    line: line ? { width: Math.round(line.getBoundingClientRect().width * 10) / 10, text: line.textContent ?? "" } : null,
    state: cell("[data-mobile2-chat-state]"),
    model: cell("[data-mobile2-chat-model]"),
    account: cell("[data-mobile2-chat-account]"),
    title: cell("[data-mobile2-title-text]"),
  };
});

async function sheetSurface(
  context: BrowserContext,
  base: string,
  surface: "pane-on-board" | "conversation-view" | "round-deck-on-board",
  account = "spare",
) {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const cdp = await context.newCDPSession(page);
  const shot = (name: string) => page.screenshot({ path: path.join(SHEET_OUT, `${surface}-${name}.png`) });
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  const recorded = () => page.evaluate(() => structuredClone((window as unknown as { evidence: { runtimeRequests: unknown[]; accountSelects: unknown[] } }).evidence));

  if (surface === "pane-on-board" || surface === "round-deck-on-board") {
    /* Exactly the operator's route: the board, then the conversation opened
       from it, which the board mounts inside its own shell. */
    await page.goto(`${base}/?account=${account}${surface === "round-deck-on-board" ? "&deck=1" : ""}#p=atlas`);
    const row = `[data-mobile2-board] [data-mobile2-swipe-row="conversation:${runningPath(account)}"]`;
    await page.waitForSelector(row, { timeout: 20_000 });
    await pause(page, 600);
    /* The row is below the fold under ten parked lanes: scroll to it, then tap
       where it now is. */
    await touch(cdp, [await centre(page, row)]);
    if (surface === "round-deck-on-board") {
      /* …and from there into the lane's review round, through the bar's own
         switcher. THIS is the pane the operator photographed: the round deck
         lays its front card on a perspective stage, and a perspective is a
         containing block for every `fixed` descendant under it. */
      await pause(page, 800);
      await touch(cdp, [await centre(page, "[data-mobile2-chat-title]")]);
      await pause(page, 800);
      const at = await page.evaluate((prefix) => {
        const row = [...document.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").startsWith(prefix!));
        if (!row) return null;
        const box = row.getBoundingClientRect();
        return [box.x + box.width / 2, box.y + box.height / 2] as [number, number];
      }, REVIEW_ROW_PREFIX);
      if (!at) throw new Error("no review round in the switcher");
      await touch(cdp, [at]);
      await pause(page, 900);
    }
  } else {
    /* The conversation on its own, deep-linked, with no board under it. */
    await page.goto(`${base}/?account=${account}#c=conversation_running`);
  }
  await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
  await pause(page, 600);

  /* What `fixed` is measured against here, with the sheet still closed. */
  const ancestors = await containingBlocks(page, "[data-runtime-pill]");
  /* …and what the bar says while nothing covers it. */
  const header = await headerReading(page);
  await shot("header");
  check("the header names the state, the model with its tier, and the account", Boolean(header.state && header.model && header.account));
  check("the state phrase is whole", header.state?.cut === false);
  check("the model and its tier are whole", header.model?.cut === false);
  check("the account the conversation runs on is the one it names", (header.account?.text ?? "").includes(account));
  /* An ordinary account id has to be READABLE, not merely present in the DOM:
     `@ spare` rendered as `@ s…` and the first evidence pass called that a pass
     because it read textContent (#1795, second critique). */
  if (account.length <= 8) check("the account is shown whole, not cut to a letter", header.account?.cut === false);
  /* A long one yields, and still shows more than an ellipsis. */
  else check("a long account id still shows its head", (header.account?.width ?? 0) >= 60);
  await tap(page, cdp, "[data-runtime-pill]");
  await pause(page, 400);
  await shot("sheet");

  const geometry = await page.evaluate(() => {
    const sheet = document.querySelector("[data-runtime-sheet]");
    const backdrop = sheet?.parentElement ?? null;
    if (!sheet || !backdrop) return null;
    const box = backdrop.getBoundingClientRect();
    const card = sheet.getBoundingClientRect();
    return {
      portalledToBody: backdrop.parentElement === document.body,
      backdrop: { x: box.x, y: box.y, width: box.width, height: box.height },
      card: { x: card.x, y: card.y, width: card.width, height: card.height },
      viewport: { width: innerWidth, height: innerHeight },
      coversViewport: box.top <= 0.5 && box.left <= 0.5 && box.width >= innerWidth - 0.5 && box.height >= innerHeight - 0.5,
      scrollsInsideItself: sheet.scrollHeight <= sheet.clientHeight || getComputedStyle(sheet).overflowY === "auto",
    };
  });
  /* The feed behind it: rows the sheet has to cover, and the down button that
     floated over the sheet in the operator's screenshot. */
  const behind = await page.evaluate(() => {
    const feed = document.querySelector("[data-log-feed-scroller]");
    return {
      /* The scroller's own count of transcript lines it holds. */
      feedLines: Number(feed?.getAttribute("data-tail-line-count") ?? "0"),
      feedScrollable: feed ? feed.scrollHeight > feed.clientHeight + 1 : false,
      downButton: document.querySelectorAll("[data-feed-jump], [data-log-feed-down]").length,
    };
  });
  const title = await reachable(page, "[data-runtime-sheet] h2", "[data-runtime-sheet]");
  const close = await reachable(page, "[data-runtime-sheet-close]", "[data-runtime-sheet]");
  const accounts = await reachable(page, "[data-runtime-sheet-accounts]", "[data-runtime-sheet]");
  const firstModelRow = await reachable(page, "[data-runtime-sheet] [role=\"radiogroup\"] [data-runtime-sheet-row]", "[data-runtime-sheet]");
  const accountRows = await page.evaluate(() => [...document.querySelectorAll("[data-runtime-sheet-account]")].map((row) => ({
    id: row.getAttribute("data-runtime-sheet-account"),
    state: row.getAttribute("data-runtime-account-state"),
    next: row.getAttribute("data-runtime-account-next"),
    disabled: (row as HTMLButtonElement).disabled,
  })));
  const namesAccount = await page.evaluate(() => document.querySelector("[data-runtime-sheet-account-current]")?.textContent ?? "");

  if (surface === "round-deck-on-board") {
    /* The surface only means something while the pane it opens in still has
       the containing block that clipped the sheet. */
    check("the round deck still lays its pane on a containing block", ancestors.some((node) => node.reasons.some((reason) => reason.startsWith("perspective"))));
  }
  check("the sheet is portalled to the document body", geometry?.portalledToBody === true);
  check("the sheet covers the whole viewport from this surface", geometry?.coversViewport === true);
  check("the sheet scrolls inside itself", geometry?.scrollsInsideItself === true);
  check("its title is on screen and nothing floats over it", Boolean(title?.inside && title.hitOwn));
  check("its close control is on screen and hittable", Boolean(close?.inside && close.hitOwn));
  check("the account group is on screen", Boolean(accounts?.inside && accounts.hitOwn));
  check("the first model row is on screen", Boolean(firstModelRow?.inside && firstModelRow.hitOwn));
  /* The feed behind the sheet is a real one, so the hit tests above are taken
     over transcript rows rather than an empty pane. */
  check("the transcript behind the sheet has content", behind.feedLines > 0);
  /* Scroll the sheet's own groups to the bottom: the title and the way out are
     a sticky row, so neither leaves with them. */
  await page.evaluate(() => {
    const sheet = document.querySelector("[data-runtime-sheet]");
    if (sheet) sheet.scrollTop = sheet.scrollHeight;
  });
  await pause(page, 300);
  const scrolledTitle = await reachable(page, "[data-runtime-sheet] h2", "[data-runtime-sheet]");
  const scrolledClose = await reachable(page, "[data-runtime-sheet-close]", "[data-runtime-sheet]");
  await shot("scrolled");
  check("the title stays in the sheet after its groups are scrolled", Boolean(scrolledTitle?.inside && scrolledTitle.hitOwn));
  check("the close control stays in the sheet after its groups are scrolled", Boolean(scrolledClose?.inside && scrolledClose.hitOwn));
  check("the account the conversation runs on is named", namesAccount.includes(account));
  check("the account it runs on is the marked row, and holds the next message until another is picked",
    accountRows.some((row) => row.id === account && row.state === "current" && row.next === "true" && row.disabled));
  check("another authenticated account is a one-tap select", accountRows.some((row) => row.id === "relief" && row.state === "ready" && !row.disabled));
  check("a signed-out account keeps its sign-in row", accountRows.some((row) => row.id === "dormant" && row.state === "needs-sign-in"));

  /* Re-tap the reasoning tier the conversation already runs on. */
  const checkedTier = "[data-runtime-sheet-row][aria-checked=\"true\"]";
  const beforeReselect = await recorded();
  await tap(page, cdp, checkedTier);
  await pause(page, 500);
  const afterReselect = await recorded();
  const sheetGone = await page.evaluate(() => document.querySelector("[data-runtime-sheet]") === null);
  check("re-selecting what it already runs on sends no reconfigure", afterReselect.runtimeRequests.length === beforeReselect.runtimeRequests.length);
  check("re-selecting what it already runs on closes the sheet", sheetGone);

  /* …and a row that IS a change still goes out, so the guard is equality. */
  await tap(page, cdp, "[data-runtime-pill]");
  await pause(page, 400);
  const changed = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-runtime-sheet-row]")] as HTMLButtonElement[];
    const row = rows.find((candidate) => candidate.getAttribute("aria-checked") === "false");
    row?.setAttribute("data-evidence-change", "1");
    return row?.textContent ?? "";
  });
  await tap(page, cdp, "[data-evidence-change]");
  await pause(page, 600);
  const afterChange = await recorded();
  check("a real change still sends its reconfigure", afterChange.runtimeRequests.length > afterReselect.runtimeRequests.length);
  await shot("after-change");

  /* Picking another account has to SHOW: one select leaves, and the mark for
     where the next message goes moves onto the row that was tapped, while the
     row naming where the conversation RUNS stays where it was (critique P1). */
  const readyRow = "[data-runtime-sheet-account][data-runtime-account-state=\"ready\"]";
  const pickedId = await page.evaluate((sel) => document.querySelector(sel!)?.getAttribute("data-runtime-sheet-account") ?? "", readyRow);
  await touch(cdp, [await centre(page, readyRow)]);
  await pause(page, 700);
  const afterPick = await recorded();
  const picked = await page.evaluate(() => ({
    rows: [...document.querySelectorAll("[data-runtime-sheet-account]")].map((row) => ({
      id: row.getAttribute("data-runtime-sheet-account"),
      state: row.getAttribute("data-runtime-account-state"),
      next: row.getAttribute("data-runtime-account-next"),
      disabled: (row as HTMLButtonElement).disabled,
    })),
    head: document.querySelector("[data-runtime-sheet-account-current]")?.textContent ?? "",
  }));
  await shot("after-account-pick");
  check("picking an account sends exactly one select", afterPick.accountSelects.length === 1);
  check("the picked account is marked as the one the next message uses",
    picked.rows.some((row) => row.id === pickedId && row.next === "true" && row.disabled));
  check("no other row claims the next message",
    picked.rows.filter((row) => row.next === "true").length === 1);
  check("the account the conversation runs on still says so",
    picked.head.includes(account) && picked.rows.some((row) => row.state === "current"));

  check("no page errors", pageErrors.length === 0);

  await page.close();
  return {
    surface, account, viewportAccountPick: { pickedId, ...picked, selects: afterPick.accountSelects },
    ancestors, header, behind, geometry, title, close, scrolledTitle, scrolledClose, accounts, firstModelRow, accountRows, namesAccount,
    changedTo: changed, pageErrors, failures,
  };
}

async function popoverSurface(context: BrowserContext, base: string) {
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const failures: string[] = [];
  const check = (label: string, ok: boolean) => { if (!ok) failures.push(label); };
  await page.goto(`${base}/#c=conversation_running`);
  await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
  await pause(page, 600);
  const ancestors = await containingBlocks(page, "[data-runtime-pill]");
  /* The desktop board is taller than the window; bring the pane's composer row
     into view before clicking where it now is. */
  await page.evaluate(() => document.querySelector("[data-runtime-pill]")?.scrollIntoView({ block: "center", inline: "center" }));
  await pause(page, 500);
  await page.mouse.click(...(await page.evaluate(() => {
    const box = document.querySelector("[data-runtime-pill]")!.getBoundingClientRect();
    return [box.x + box.width / 2, box.y + box.height / 2] as [number, number];
  })));
  await pause(page, 400);
  await page.screenshot({ path: path.join(SHEET_OUT, "desktop-popover.png") });
  const namesAccount = await page.evaluate(() => document.querySelector("[data-runtime-popover-account]")?.textContent ?? "");
  const popover = await reachable(page, "[data-runtime-popover]", "[data-runtime-popover]");
  check("the popover is open and on screen", Boolean(popover?.inside && popover.hitOwn));
  check("the popover names the account the conversation runs on", namesAccount.includes("spare"));
  check("no page errors", pageErrors.length === 0);
  await page.close();
  return { surface: "desktop-popover", ancestors, popover, namesAccount, pageErrors, failures };
}

browserTest("#1795: the runtime sheet covers the phone from every surface, closes, ignores a re-tap, and names the account", async () => {
  fs.mkdirSync(SHEET_OUT, { recursive: true });
  fs.mkdirSync(SHEET_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: { surface: string; failures: string[]; pageErrors: string[] }[] = [];
  try {
    for (const { viewport, account } of SHEET_CASES) {
      for (const surface of ["pane-on-board", "round-deck-on-board", "conversation-view"] as const) {
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
        try {
          const result = await sheetSurface(context, fixtureBase, surface, account);
          results.push({ viewport, ...result });
          if (result.failures.length) failures.push({ surface: `${viewport.width}x${viewport.height}-${account}-${surface}`, failures: result.failures, pageErrors: result.pageErrors });
        } finally {
          await context.close();
        }
      }
    }
    const desktop = await browser.newContext({ viewport: { width: 1_280, height: 900 }, colorScheme: "dark" });
    try {
      const result = await popoverSurface(desktop, fixtureBase);
      results.push({ viewport: { width: 1_280, height: 900 }, ...result });
      if (result.failures.length) failures.push({ surface: "1280-popover", failures: result.failures, pageErrors: result.pageErrors });
    } finally {
      await desktop.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(SHEET_EVIDENCE, "runtime-sheet.json"), `${JSON.stringify(results, null, 2)}\n`);
  if (failures.length) throw new Error(JSON.stringify(failures, null, 2));
}, 300_000);

/*
 * #1846 — a pick on the phone, on the same real Viewer with the running conversation on a structured host
 * (`&runtime=structured`), in English and Ukrainian, with short ids and with two long ones:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1846"
 *
 * The sheet's row for another account is tapped and the sheet closed; the title line must then name the
 * account the next message goes to whole, the running account yielding first, and the model with its tier
 * stays whole on the line under it. The pick sends the conversation's reconfigure and never an engine select.
 *
 * Readings go to `evidence/issue-1846/phone-header.json`; frames to `.artifacts/issue-1846/`.
 */
const PICK_OUT = path.resolve(".artifacts/issue-1846");
const PICK_EVIDENCE = path.resolve("evidence/issue-1846");
const PICK_CASES = [
  { account: "spare", next: "relief" },
  { account: "review-relief-2", next: "production-backup-7" },
] as const;

browserTest("#1846: a pick on the phone names the next account whole on the title line", async () => {
  fs.mkdirSync(PICK_OUT, { recursive: true });
  fs.mkdirSync(PICK_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const { account, next } of PICK_CASES) {
        const viewport = { width: 390, height: 844 };
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        const key = `${lang}-${account}-${next}`;
        const fail = (label: string) => failures.push(`${key}: ${label}`);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const cdp = await context.newCDPSession(page);
          await page.goto(`${fixtureBase}/?account=${account}&next=${next}&runtime=structured#c=conversation_running`);
          await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
          await pause(page, 800);
          const before = await headerReading(page);
          await tap(page, cdp, "[data-runtime-pill]");
          await page.waitForSelector(`[data-runtime-sheet-account="${next}"]`, { timeout: 10_000 });
          await pause(page, 300);
          await tap(page, cdp, `[data-runtime-sheet-account="${next}"]`);
          await pause(page, 100);
          const sheetLine = await page.evaluate(() => document.querySelector("[data-runtime-sheet-account-current]")?.textContent ?? "");
          await page.screenshot({ path: path.join(PICK_OUT, `phone-${key}-sheet.png`) });
          await tap(page, cdp, "[data-runtime-sheet-close]");
          await pause(page, 400);
          const after = await headerReading(page);
          const parts = await page.evaluate(() => {
            const cell = (selector: string) => {
              const element = document.querySelector(selector);
              if (!element) return null;
              const box = element.getBoundingClientRect();
              /* The text's own width, unrounded: scrollWidth rounds, and hid a cut of under a pixel that still drew an ellipsis. */
              const range = document.createRange();
              range.selectNodeContents(element);
              const need = range.getBoundingClientRect().width;
              const tag = document.querySelector("[data-mobile2-chat-account]")!.getBoundingClientRect();
              return {
                text: element.textContent ?? "",
                width: Math.round(box.width * 10) / 10,
                need: Math.round(need * 10) / 10,
                cut: need > box.width + 0.1,
                /* On the tag's one line, or wrapped below it where the tag clips it. */
                shown: box.top >= tag.top - 0.5 && box.bottom <= tag.bottom + 0.5 && box.width > 0,
              };
            };
            return { runs: cell("[data-mobile2-chat-account-runs]"), to: cell("[data-mobile2-chat-account-to]") };
          });
          await page.screenshot({ path: path.join(PICK_OUT, `phone-${key}-header.png`) });
          const sent = await page.evaluate(() => {
            const evidence = (window as unknown as { evidence: { runtimeRequests: Array<Record<string, unknown>>; accountSelects: unknown[] } }).evidence;
            return { reconfigures: evidence.runtimeRequests.map((body) => body.accountId ?? null), selects: evidence.accountSelects.length };
          });
          results.push({ key, lang, viewport, account, next, before, sheetLine, after, parts, sent, pageErrors });
          if (!sheetLine.includes(account) || !sheetLine.includes(next)) fail(`the sheet names both accounts: ${sheetLine}`);
          if (parts.to?.text !== `→ ${next}`) fail(`the title line names the next account: ${JSON.stringify(parts.to)}`);
          /* The title keeps at least 6rem (critique round 4), so a next id longer than the room left draws its head
             and yields its tail; one that fits is whole. */
          if (parts.to?.shown !== true) fail(`the next account is on the line: ${JSON.stringify(parts.to)}`);
          if (next.length <= 8 && parts.to?.cut !== false) fail(`a short next account is whole: ${JSON.stringify(parts.to)}`);
          if (parts.to?.cut && parts.to.width < 80) fail(`the next account shows a readable head: ${JSON.stringify(parts.to)}`);
          if ((after.title?.width ?? 0) < 95.5) fail(`the title keeps its 6rem: ${JSON.stringify(after.title)}`);
          /* The running account is either whole beside it or not drawn at all — never a sliver. */
          if (parts.runs?.shown && parts.runs.cut) fail(`the running account shows cut: ${JSON.stringify(parts.runs)}`);
          if (account.length <= 8 && !parts.runs?.shown) fail(`short ids both fit: ${JSON.stringify(parts.runs)}`);
          if (after.model?.cut !== false) fail(`the model and its tier are whole: ${JSON.stringify(after.model)}`);
          if (JSON.stringify(sent.reconfigures) !== JSON.stringify([next]) || sent.selects !== 0) fail(`requests ${JSON.stringify(sent)}`);
          if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(PICK_EVIDENCE, "phone-header.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #1846 at 1280x900 on the deck surface this fixture offers (`&deck=1`, the running conversation as a review
 * round), in English and Ukrainian, with short ids and with two long ones:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1846 desktop"
 *
 * The pick is made in the runtime pill's Account panel. On a desktop board the conversation opens in a
 * kanban reader, which replaces the conversation pane's own header, so the pane's «@ A → B» badge is not
 * mounted; the reading records that, and reads the header chip the reader does draw, and the pill's mark,
 * for what each draws against its text.
 *
 * Readings go to `evidence/issue-1846/desktop-deck.json`; frames to `.artifacts/issue-1846/`.
 */
browserTest("#1846 desktop: the deck surface's account chip at 1280 px names the pick whole", async () => {
  fs.mkdirSync(PICK_OUT, { recursive: true });
  fs.mkdirSync(PICK_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const reading = (page: Page, selector: string) => page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const overflowing = [element, ...element.querySelectorAll<HTMLElement>("*")]
      .filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => ({ text: node.textContent ?? "", width: node.clientWidth, need: node.scrollWidth }));
    const pane = element.closest("[data-kanban-reader]")?.getBoundingClientRect() ?? null;
    return {
      text: element.textContent?.replace(/\s+/g, " ").trim() ?? "",
      width: Math.round(box.width * 10) / 10,
      paneWidth: pane ? Math.round(pane.width * 10) / 10 : null,
      insidePane: pane ? box.left >= pane.left - 0.5 && box.right <= pane.right + 0.5 : null,
      overflowing,
    };
  }, selector);
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const { account, next } of PICK_CASES) {
        const viewport = { width: 1_280, height: 900 };
        const context = await browser.newContext({ viewport, colorScheme: "dark" });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        const key = `desktop-${lang}-${account}-${next}`;
        const fail = (label: string) => failures.push(`${key}: ${label}`);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${fixtureBase}/?account=${account}&next=${next}&runtime=structured&deck=1#c=conversation_running`);
          await page.waitForSelector("[data-runtime-pill]", { timeout: 20_000 });
          await pause(page, 800);
          const before = await reading(page, "[data-kanban-reader] [data-account-trigger]");
          await page.locator("[data-runtime-pill]").first().evaluate((element) => { element.scrollIntoView({ block: "center" }); (element as HTMLElement).click(); });
          await page.waitForSelector('[data-runtime-row="submenu"][data-runtime-value="account"]', { timeout: 5_000 });
          /* Clicked in the page: the reader's composer sits under the portalled popover's hit box in this frame. */
          await page.locator('[data-runtime-row="submenu"][data-runtime-value="account"]').evaluate((element) => (element as HTMLElement).click());
          await page.waitForSelector(`[data-runtime-row="account"][data-runtime-value="account-${next}"]`, { timeout: 5_000 });
          await page.locator(`[data-runtime-row="account"][data-runtime-value="account-${next}"]`).evaluate((element) => (element as HTMLElement).click());
          await pause(page, 400);
          const chip = await reading(page, "[data-kanban-reader] [data-account-trigger]");
          const mark = await reading(page, "[data-runtime-pill-next-account]");
          const paneBadges = await page.evaluate(() => document.querySelectorAll("[data-conversation-account-chip]").length);
          await page.screenshot({ path: path.join(PICK_OUT, `${key}.png`) });
          /* The narrow pane: the same reader held to 426 px, the width a board column gives its reader. */
          await page.evaluate(() => {
            const pane = document.querySelector<HTMLElement>("[data-kanban-reader]");
            if (pane) { pane.style.width = "426px"; pane.style.maxWidth = "426px"; }
          });
          await pause(page, 200);
          const narrow = await reading(page, "[data-kanban-reader] [data-account-trigger]");
          await page.screenshot({ path: path.join(PICK_OUT, `${key}-narrow.png`) });
          const sent = await page.evaluate(() => {
            const evidence = (window as unknown as { evidence: { runtimeRequests: Array<Record<string, unknown>>; accountSelects: unknown[] } }).evidence;
            return { reconfigures: evidence.runtimeRequests.map((body) => body.accountId ?? null), selects: evidence.accountSelects.length };
          });
          results.push({ key, lang, viewport, account, next, before, chip, narrow, mark, paneBadges, sent, pageErrors });
          if (narrow?.paneWidth !== 426) fail(`the narrow pane is 426 px: ${JSON.stringify(narrow)}`);
          if (narrow?.insidePane === false) fail(`in the narrow pane the chip leaves it: ${JSON.stringify(narrow)}`);
          if (!chip?.text.includes(next)) fail(`the reader's header chip names the next account: ${JSON.stringify(chip)}`);
          if (chip?.insidePane === false) fail(`the chip leaves its pane: ${JSON.stringify(chip)}`);
          if (!mark?.text.includes(next)) fail(`the pill carries the pick: ${JSON.stringify(mark)}`);
          if (JSON.stringify(sent.reconfigures) !== JSON.stringify([next]) || sent.selects !== 0) fail(`requests ${JSON.stringify(sent)}`);
          if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(PICK_EVIDENCE, "desktop-deck.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #1865 at 390x844, in English and Ukrainian, light and dark, on the lane the
 * fixture adds for it (`?stages=1`): design and critique share the architect
 * preset, and the lane is parked on critique's second attempt.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1865"
 *
 * The queue row is the pipeline card (#2072 slice 3): its chain names the stage
 * by the name the stage list gives it, its reason line says what the stage
 * returned, and neither names the preset. The lane's screen titles each stage
 * row by that name, with the attempt once the stage ran twice, and the preset
 * leads the row's meta line instead. Neither title is cut. The card's reason
 * line is painted whole with its age after it, however many lines that takes;
 * each stage row's meta line keeps its verdict and findings count whole
 * (the preset truncates first), and the effort ladder ends before the meta
 * line begins — both of which the Ukrainian row once failed.
 *
 * Readings go to `evidence/issue-1865/phone.json`; frames to `.artifacts/issue-1865/`.
 */
const LABELS_OUT = path.resolve(".artifacts/issue-1865");
const LABELS_EVIDENCE = path.resolve("evidence/issue-1865");

browserTest("#1865: the phone names a stage and its attempt in the queue row and on the lane's stage rows", async () => {
  fs.mkdirSync(LABELS_OUT, { recursive: true });
  fs.mkdirSync(LABELS_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const ROW = '[data-mobile2-row="pipeline"][data-mobile2-pipeline-row$="lane-labels"]';
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const scheme of SCHEMES) {
        const viewport = { width: 390, height: 844 };
        const key = `${lang}-${scheme}`;
        const fail = (label: string) => failures.push(`${key}: ${label}`);
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: scheme });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          const cdp = await context.newCDPSession(page);
          await page.goto(`${fixtureBase}/?stages=1#p=atlas`);
          await page.waitForSelector(ROW, { timeout: 20_000 });
          await pause(page, 600);
          const queueRow = await page.evaluate((selector) => document.querySelector(selector)?.textContent ?? "", ROW);
          /* The reason line and its age, painted inside the block's column. */
          const queueMeta = await page.evaluate((selector) => {
            const reason = document.querySelector<HTMLElement>(`${selector} [data-pipeline-reason]`);
            const column = reason?.closest(".pblock")?.getBoundingClientRect();
            const box = reason?.getBoundingClientRect();
            const range = document.createRange();
            if (reason) range.selectNodeContents(reason);
            const ink = range.getBoundingClientRect();
            return {
              text: reason?.textContent ?? "",
              chain: [...document.querySelectorAll(`${selector} .pb-pill[data-stage] .pb-name`)].map((name) => name.textContent),
              lines: box && reason ? Math.round(box.height / parseFloat(getComputedStyle(reason).lineHeight || "16")) : 0,
              columnRight: column ? Math.round(column.right * 10) / 10 : 0,
              inkRight: Math.round(ink.right * 10) / 10,
              clipped: !reason || reason.scrollWidth > reason.clientWidth + 0.5 || (column ? ink.right > column.right + 0.5 : true),
            };
          }, ROW);
          if (queueMeta.clipped) fail(`the queue row's reason line is clipped: ${JSON.stringify(queueMeta)}`);
          if (!/ · \d/.test(queueMeta.text)) fail(`the queue row's reason line carries no age: ${JSON.stringify(queueMeta)}`);
          await page.screenshot({ path: path.join(LABELS_OUT, `phone-${key}-queue.png`) });
          const expectedQueue = translate(lang, "pipelineBlock.reason.failed", { stage: "Critique" });
          if (!queueMeta.text.startsWith(expectedQueue)) fail(`the queue row's reason reads ${JSON.stringify(queueMeta.text)}, expected it to begin ${JSON.stringify(expectedQueue)}`);
          if (!queueMeta.chain.includes("Critique")) fail(`the queue row's chain does not name Critique: ${JSON.stringify(queueMeta.chain)}`);
          const preset = translate(lang, "roleCopy.architect.name");
          if (queueRow.toLocaleLowerCase().includes(preset.toLocaleLowerCase())) fail(`the queue row names the preset: ${JSON.stringify(queueRow)}`);

          await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: "center" }), ROW);
          await pause(page, 250);
          await tap(page, cdp, ROW);
          await page.waitForSelector('[data-mobile2-screen="pipeline"] [data-mobile2-stage="critique"]', { timeout: 10_000 });
          await pause(page, 500);
          const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-mobile2-screen="pipeline"] [data-mobile2-stage]')].map((row) => {
            const title = row.querySelector<HTMLElement>("[data-mobile2-stage-title]");
            const meta = row.querySelector<HTMLElement>("[data-mobile2-stage-meta]");
            const range = document.createRange();
            if (title) range.selectNodeContents(title);
            const need = title ? range.getBoundingClientRect().width : 0;
            const box = title?.getBoundingClientRect();
            /* The meta line: the part after the preset must be whole, and the
               identity's ink must end before the meta line's begins. */
            const rest = meta?.lastElementChild as HTMLElement | null | undefined;
            const identity = meta?.previousElementSibling as HTMLElement | null | undefined;
            const identityInk = identity ? (() => {
              const r = document.createRange();
              r.selectNodeContents(identity);
              return Math.max(r.getBoundingClientRect().right, ...[...identity.querySelectorAll("*")].map((el) => el.getBoundingClientRect().right));
            })() : 0;
            const metaLeft = meta?.getBoundingClientRect().left ?? 0;
            return {
              stage: row.dataset.mobile2Stage ?? "",
              title: title?.textContent ?? "",
              meta: meta?.textContent ?? "",
              metaRestWhole: !!rest && rest.scrollWidth <= rest.clientWidth + 0.5,
              identityWidth: identity ? Math.round(identity.getBoundingClientRect().width * 10) / 10 : 0,
              identityGap: Math.round((metaLeft - identityInk) * 10) / 10,
              width: box ? Math.round(box.width * 10) / 10 : 0,
              need: Math.round(need * 10) / 10,
              cut: box ? need > box.width + 0.1 : true,
            };
          }));
          await page.screenshot({ path: path.join(LABELS_OUT, `phone-${key}-stages.png`) });
          results.push({ key, lang, scheme, viewport, queueRow, queueMeta, rows, pageErrors });
          const byStage = new Map(rows.map((row) => [row.stage, row] as const));
          const expected = { design: "Design · 2", critique: "Critique · 2" } as const;
          for (const [stage, title] of Object.entries(expected)) {
            const row = byStage.get(stage);
            if (row?.title !== title) fail(`the ${stage} row is titled ${JSON.stringify(row?.title)}, expected ${JSON.stringify(title)}`);
            if (row?.cut !== false) fail(`the ${stage} row's title is cut: ${JSON.stringify(row)}`);
            if (!row?.meta.startsWith(`${preset} · `)) fail(`the ${stage} row's meta does not lead with the preset: ${JSON.stringify(row?.meta)}`);
          }
          for (const row of rows) {
            if (!row.metaRestWhole) fail(`the ${row.stage} row's verdict or findings count is cut: ${JSON.stringify(row)}`);
            if (row.identityGap < 0) fail(`the ${row.stage} row's effort ladder runs into its meta line: ${JSON.stringify(row)}`);
          }
          const critiqueMeta = byStage.get("critique")?.meta ?? "";
          const findings = translate(lang, "pipelineVerdict.findings", { count: 2 });
          if (!critiqueMeta.endsWith(findings)) fail(`the critique row's meta does not end with its findings count: ${JSON.stringify(critiqueMeta)}`);
          if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(LABELS_EVIDENCE, "phone.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #1978 at 390x844 in both colour schemes, and at 1280x960 for the desktop's
 * copy controls, on the conversation the fixture gives a shell call and an
 * assigned task (`?toolcard=1`):
 *
 *   LLV_SWIPE_BROWSER_TEST=1 bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#1978"
 *
 * Everything is read as ink, the client rects of text clipped by every
 * overflow ancestor, because box-only overlap checks have passed over real
 * overlaps in this repository:
 *
 *   - the command's and the output's copy controls neither touch nor overlap,
 *     no glyph of the card sits under either, and no call's copy control
 *     hangs past its call into the next one; the desktop keeps its small
 *     22 px controls;
 *   - with the task strip right above the feed, the first visible feed row
 *     starts at or below the strip's bottom edge, and while following the tail no glyph line or control straddles its
 *     top edge, including after the card opens. Released phone rests are
 *     asserted across long results, drags, control overhangs and remounts.
 *     The long-history case below separately asserts reader stability through
 *     prepends and late layout, which never arm gesture-end alignment.
 *
 * Readings go to `evidence/issue-1978/phone.json`; frames to `.artifacts/issue-1978/`.
 */
const EDGE_OUT = path.resolve(".artifacts/issue-1978");
const EDGE_EVIDENCE = path.resolve("evidence/issue-1978");

interface InkReading {
  command: Rect | null;
  output: Rect | null;
  controlsOverlap: number;
  controlsGap: number | null;
  inkUnderControls: string[];
  stripBottom: number | null;
  feedTop: number;
  cutLines: Array<{ text: string; top: number; bottom: number }>;
  firstRow: { key: string; top: number; bottom: number } | null;
  slivers: Array<{ key: string; top: number; bottom: number }>;
  overhangs: Array<{ label: string; by: number }>;
  tail: { spacer: number | null; fromBottom: number };
}

/* Runs in the page. The ink walk is the test's own: every text node under the
   feed, never the product's sampled probe. */
const readInk = (page: Page) => page.evaluate((): InkReading => {
  interface Box { l: number; t: number; r: number; b: number }
  const box = (element: Element): Box => {
    const r = element.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const area = (a: Box, b: Box) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  /* From the element holding the text itself: a capped output clips its own
     overflowing lines. */
  const clip = (element: Element, stop: Element | null = null): Box => {
    let out: Box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    for (let parent: Element | null = element; parent && parent !== stop; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const p = box(parent);
        out = { l: Math.max(out.l, p.l), t: Math.max(out.t, p.t), r: Math.min(out.r, p.r), b: Math.min(out.b, p.b) };
      }
    }
    return out;
  };
  /* `full` is a line clipped only by the containers inside the feed (a long
     output scrolls in its own capped box): a line the feed's edge cuts is
     found by it, and text clipped out of sight never is. */
  const ink = (root: Element) => {
    const feedElement = document.querySelector("[data-log-feed-scroller]");
    const out: Array<{ text: string; full: Box; seen: Box | null }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !node.parentElement) continue;
      if (getComputedStyle(node.parentElement).visibility === "hidden") continue;
      const c = clip(node.parentElement);
      const inside = clip(node.parentElement, feedElement);
      range.selectNodeContents(node);
      for (const q of range.getClientRects()) {
        if (q.width <= 0 || q.height <= 0) continue;
        const full = { l: Math.max(q.left, inside.l), t: Math.max(q.top, inside.t), r: Math.min(q.right, inside.r), b: Math.min(q.bottom, inside.b) };
        if (full.r <= full.l || full.b <= full.t) continue;
        const seen = { l: Math.max(full.l, c.l), t: Math.max(full.t, c.t), r: Math.min(full.r, c.r), b: Math.min(full.b, c.b) };
        out.push({ text: node.textContent.trim().slice(0, 48), full, seen: seen.r > seen.l && seen.b > seen.t ? seen : null });
      }
    }
    return out;
  };
  const feed = document.querySelector("[data-log-feed-scroller]")!;
  const feedBox = box(feed);
  const edge = feedBox.t + feed.clientTop;
  /* The command's control sits in the card's readable body (the sunken
     well): in the command block for a mouse, and at the end of the meta row
     over the command for a finger (#2148). The output's control is the
     body's other one. */
  const command = document.querySelector('[aria-label="Copy command"]');
  const body = command?.closest(".bg-sunken") ?? null;
  const output = body?.querySelector('[aria-label="Copy output"]') ?? null;
  const controls = [command, output].filter((element): element is Element => !!element);
  const under = body ? ink(body).filter((line) => line.seen && controls.some((control) => area(line.seen!, box(control)) > 0.25)).map((line) => line.text) : [];
  const strip = document.querySelector("[data-task-relations]");
  const rect = (element: Element | null): Rect | null => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  return {
    command: rect(command ?? null),
    output: rect(output),
    controlsOverlap: command && output ? area(box(command), box(output)) : 0,
    controlsGap: command && output ? box(output).t - box(command).b : null,
    inkUnderControls: under,
    stripBottom: strip ? box(strip).b : null,
    feedTop: edge,
    cutLines: [
      ...ink(feed),
      /* A control sliced by the edge is a cut row as much as a line is. */
      ...[...feed.querySelectorAll("button")].map((control) => ({ text: `<${control.tagName.toLowerCase()} ${control.getAttribute("aria-label") ?? ""}>`, full: box(control) })),
    ].filter((line) => line.full.t < edge - 0.5 && line.full.b > edge + 0.5 && line.full.r > feedBox.l && line.full.l < feedBox.r)
      .map((line) => ({ text: line.text, top: line.full.t, bottom: line.full.b })),
    tail: (() => {
      const spacer = feed.querySelector<HTMLElement>("[data-feed-tail-spacer]");
      return { spacer: spacer?.getBoundingClientRect().height ?? null, fromBottom: feed.scrollHeight - feed.clientHeight - feed.scrollTop };
    })(),
    /* Every copy control of a run's calls stays inside its own call: one that
       hangs past the call's box lands on the next call's header. */
    overhangs: [...feed.querySelectorAll<HTMLElement>("li button[aria-label^='Copy']")]
      .map((control) => ({ label: control.getAttribute("aria-label") ?? "", by: box(control).b - box(control.closest("li")!).b }))
      .filter((control) => control.by > 0.5),
    /* A row of any size left showing only its frame (a card's bottom border
       and padding) under the edge reads as a cut row too. */
    slivers: [...feed.querySelectorAll<HTMLElement>("[data-feed-key], li, [data-tool-row]")]
      .filter((row) => box(row).t < edge && box(row).b > edge + 1 && box(row).b - edge <= 16)
      .map((row) => ({ key: row.dataset.feedKey ?? row.tagName.toLowerCase(), top: box(row).t, bottom: box(row).b })),
    firstRow: (() => {
      /* A row is a feed row or a row inside one (a run's numbered call, a
         bullet, a tool line), outer before inner; the first visible one that
         fits in three quarters of the feed is the one that must start whole.
         Scroll offsets are whole CSS pixels and rows lay out on half ones, so
         a predecessor can show a sliver of up to one pixel under the edge;
         visible means showing more than that. */
      const fit = feed.clientHeight * 0.75;
      const row = [...feed.querySelectorAll<HTMLElement>("[data-feed-key], li, [data-tool-row]")]
        .find((candidate) => box(candidate).b > edge + 1 && box(candidate).b - box(candidate).t <= fit);
      return row ? { key: row.dataset.feedKey ?? `${row.tagName.toLowerCase()}: ${(row.textContent ?? "").slice(0, 40)}`, top: box(row).t, bottom: box(row).b } : null;
    })(),
  };
});

/* The feed at rest: its scroll position unchanged across 400 ms, so momentum
   and any settling move have run out before anything is read. */
async function feedAtRest(page: Page): Promise<void> {
  let last = Number.NaN;
  let still = 0;
  for (let i = 0; i < 60 && still < 4; i += 1) {
    await pause(page, 100);
    const top = await page.evaluate(() => document.querySelector("[data-log-feed-scroller]")?.scrollTop ?? 0);
    still = top === last ? still + 1 : 0;
    last = top;
  }
  if (still < 4) throw new Error("the feed never came to rest");
}

browserTest("#1978: copy controls stay apart and followed content and released phone rests clear the task strip", async () => {
  fs.mkdirSync(EDGE_OUT, { recursive: true });
  fs.mkdirSync(EDGE_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = [
    { viewport: { width: 390, height: 844 }, scheme: "dark" },
    { viewport: { width: 390, height: 844 }, scheme: "light" },
    { viewport: { width: 1280, height: 960 }, scheme: "dark" },
  ] as const;
  try {
    for (const { viewport, scheme } of cases) {
      const phone = viewport.width < 640;
      const key = `${viewport.width}-${scheme}`;
      const fail = (label: string) => failures.push(`${key}: ${label}`);
      const context = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone, deviceScaleFactor: 2, colorScheme: scheme });
      await context.addInitScript(() => { localStorage.setItem("llv_lang", "en"); });
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await page.goto(`${fixtureBase}/?toolcard=1#f=${encodeURIComponent(RUNNING_PATH)}`);
        await page.waitForSelector("[data-log-feed-scroller]", { timeout: 20_000 });
        await page.getByText("The projection replays every band", { exact: false }).first().waitFor({ timeout: 20_000 });
        await pause(page, 900);
        const readings: Record<string, InkReading> = {};
        await feedAtRest(page);
        readings.following = await readInk(page);

        /* Open the run from its line, as the operator does: the phone folds
           it to one line, the desktop shows it as a group. */
        if (phone) {
          const r = await page.locator("[data-mobile-run-fold]").last().boundingBox();
          if (!r) throw new Error("the run's line is not on screen");
          await touch(cdp, [[r.x + r.width / 2, r.y + r.height / 2]]);
        } else if (!(await page.locator('[aria-label="Copy command"]').count())) {
          await page.locator("[data-log-feed-scroller] summary").last().click();
        }
        await page.waitForSelector('[aria-label="Copy command"]', { timeout: 5_000 });
        await pause(page, 900);
        await feedAtRest(page);
        readings.opened = await readInk(page);
        await page.screenshot({ path: path.join(EDGE_OUT, `${key}-opened.png`) });

        if (phone) {
          /* A call taller than the screen: open the long result in full, then
             wheel its first lines under the strip at a sweep of offsets. Its
             lines and its copy control meet the edge together there, where
             clearing one used to cut the other and the feed stepped between
             two positions forever. Every stop must come to rest clean. */
          await page.locator("[data-log-feed-scroller] li", { hasText: "bands.ts" }).getByText("show all output").first().tap();
          await feedAtRest(page);
          await page.mouse.move(viewport.width / 2, viewport.height / 2);
          for (const offset of [2, 7, 13, 19, 26, 34, 43, 55]) {
            const delta = await page.evaluate((into) => {
              const feed = document.querySelector("[data-log-feed-scroller]")!;
              const long = [...feed.querySelectorAll("li pre")].find((pre) => pre.textContent?.includes("band(0)"));
              if (!long) throw new Error("the long result is not open");
              return long.getBoundingClientRect().top - (feed.getBoundingClientRect().top + feed.clientTop) + into;
            }, offset);
            await page.mouse.wheel(0, delta);
            await feedAtRest(page);
            readings[`long-${offset}`] = await readInk(page);
          }
          await page.screenshot({ path: path.join(EDGE_OUT, `${key}-long.png`) });

          /* Bring the card to the top edge, then leave the tail by drags of
             uneven lengths; each rest is read once the feed has settled. */
          for (const distance of [137, 211, 173]) {
            const feed = await rectOf(page, "[data-log-feed-scroller]");
            const x = feed!.x + feed!.width / 2;
            const y = feed!.y + feed!.height / 2;
            await touch(cdp, along([x, y - distance / 2], [x, y + distance / 2]), 24);
            await pause(page, 1_200);
            await feedAtRest(page);
            readings[`rest-${distance}`] = await readInk(page);
          }
          // A phone action's negative margin can leave its control under the
          // edge after the enclosing message has gone. Exercise that narrow
          // overhang with a real wheel settle, rather than relying on a drag
          // landing on its fractional boundary by chance.
          await page.evaluate(() => {
            const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
            const control = feed.querySelector<HTMLElement>('[aria-label="Copy message (Markdown)"]')!;
            feed.scrollTop += control.getBoundingClientRect().bottom
              - (feed.getBoundingClientRect().top + feed.clientTop) - 2.75;
          });
          await pause(page, 400);
          await page.mouse.wheel(0, 2);
          await feedAtRest(page);
          readings["rest-control-overhang"] = await readInk(page);
          await page.screenshot({ path: path.join(EDGE_OUT, `${key}-rest.png`) });
          /* Close to the board and come back to the conversation through
             history: the feed comes back where it was left and still rests
             on a row. */
          await page.evaluate(() => { location.hash = "#p=atlas"; });
          await pause(page, 900);
          await page.goBack();
          await page.getByText("The projection replays every band", { exact: false }).first().waitFor({ timeout: 10_000 });
          await pause(page, 1_200);
          await feedAtRest(page);
          readings.reopened = await readInk(page);
          await page.screenshot({ path: path.join(EDGE_OUT, `${key}-reopened.png`) });
        }

        results.push({ key, viewport, scheme, readings, pageErrors });
        const opened = readings.opened!;
        if (!opened.command || !opened.output) fail(`the card shows both copy controls: ${JSON.stringify(opened)}`);
        if (opened.controlsOverlap > 0) fail(`the copy controls overlap by ${opened.controlsOverlap} px²`);
        if (opened.controlsGap !== null && opened.controlsGap <= 0) fail(`the copy controls touch: the output's starts ${opened.controlsGap} px below the command's`);
        if (opened.inkUnderControls.length) fail(`text under a copy control: ${JSON.stringify(opened.inkUnderControls)}`);
        /* Phone only: the desktop's 22 px control overhangs a one-line output
           by ~2.6 px today, and the desktop keeps its present look. */
        if (phone && opened.overhangs.length) fail(`copy controls hang past their call: ${JSON.stringify(opened.overhangs)}`);
        const size = phone ? 44 : 22;
        for (const control of [opened.command, opened.output]) {
          if (control && (Math.abs(control.width - size) > 0.5 || Math.abs(control.height - size) > 0.5)) fail(`a copy control is ${control.width}x${control.height}, expected ${size}`);
        }
        if (phone) {
          for (const [moment, reading] of Object.entries(readings)) {
            if (reading.stripBottom === null) fail(`${moment}: no task strip above the feed`);
            else if (reading.feedTop < reading.stripBottom - 0.5) fail(`${moment}: the feed starts above the strip's bottom edge`);
            if (reading.cutLines.length) fail(`${moment}: lines cut by the feed's top edge: ${JSON.stringify(reading.cutLines)}`);
            if (reading.slivers.length) fail(`${moment}: rows showing only a sliver under the edge: ${JSON.stringify(reading.slivers)}`);
            if (!reading.firstRow) fail(`${moment}: no feed row on screen`);
            else if (reading.stripBottom !== null && reading.firstRow.top < reading.stripBottom) fail(`${moment}: the first visible row starts at ${reading.firstRow.top}, above the strip's bottom ${reading.stripBottom}: ${JSON.stringify(reading.firstRow)}`);
          }
        }
        if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(EDGE_EVIDENCE, "phone.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #2072 slice 2, the jump strip: a conversation away from its tail, at the
 * pages Safari leaves on a 390 × 844 and a 430 × 932 phone, in both languages
 * and both schemes (the desktop reader's strip is held by the DOM test in
 * `LogFeed.mobileChrome.dom.test.tsx`). The «down» control used to float
 * over the feed's bottom edge, where a line of text always sat once the reader
 * had left the tail. It is now a 44 px row of its own between the feed and the
 * composer:
 *
 *   - the feed's viewport ends at the strip's top edge, and no text's ink,
 *     clipped by its overflow ancestors, reaches the strip or its control;
 *   - the strip is 44 px tall, its target at least 44 × 44 around a 32 px
 *     pill, and it lies wholly above the composer and inside the page;
 *   - the feed's scroll offset is the same before and after the strip
 *     appears, so the line being read at the top does not move;
 *   - a tap returns to the tail and the strip leaves with it.
 *
 * A conversation with two or more of the operator's own messages also has the
 * step row there (docs/design/own-message-steps.md), and then the control is a
 * cell of that row, so the phone spends one row under the feed: the same
 * gates hold for that row, 45 px with its border, and its control says «down»
 * by its name alone.
 *
 * Readings go to `evidence/issue-2072/jump-strip.json`; frames to `.artifacts/jump-strip/`.
 */
const JUMP_OUT = path.resolve(".artifacts/jump-strip");
const JUMP_EVIDENCE = path.resolve("evidence/issue-2072");

interface JumpReading {
  /** The control shares the own-message step row. */
  shared: boolean;
  strip: Rect | null;
  control: Rect | null;
  pill: Rect | null;
  feed: Rect;
  composerTop: number | null;
  inkOnStrip: string[];
  controlsCrossing: string[];
  overflowX: number;
  label: string;
}

/* Runs in the page; the ink walk is the test's own. */
const readJump = (page: Page) => page.evaluate((): JumpReading => {
  interface Box { l: number; t: number; r: number; b: number }
  const box = (element: Element): Box => {
    const r = element.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const rect = (element: Element | null): Rect | null => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const meets = (a: Box, b: Box) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 0.5 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 0.5;
  const clip = (element: Element): Box => {
    let out: Box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const p = box(parent);
        out = { l: Math.max(out.l, p.l), t: Math.max(out.t, p.t), r: Math.min(out.r, p.r), b: Math.min(out.b, p.b) };
      }
    }
    return out;
  };
  const pillAt = document.querySelector("[data-feed-jump-pill]");
  const strip = pillAt?.closest("[data-feed-jump-strip], [data-own-steps]") ?? null;
  const control = pillAt?.closest("button") ?? null;
  const feed = document.querySelector("[data-log-feed-scroller]")!;
  /* Every text outside the strip, as the ink it paints. */
  const inkOnStrip: string[] = [];
  if (strip) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim() || !node.parentElement || strip.contains(node)) continue;
      if (getComputedStyle(node.parentElement).visibility === "hidden") continue;
      const c = clip(node.parentElement);
      range.selectNodeContents(node);
      for (const q of range.getClientRects()) {
        const seen = { l: Math.max(q.left, c.l), t: Math.max(q.top, c.t), r: Math.min(q.right, c.r), b: Math.min(q.bottom, c.b) };
        if (seen.r - seen.l <= 0.5 || seen.b - seen.t <= 0.5) continue;
        if (meets(seen, box(strip))) inkOnStrip.push(node.textContent.trim().slice(0, 48));
      }
    }
  }
  const controlsCrossing = control
    ? [...document.querySelectorAll("button, a[href], textarea, input")]
      .filter((other) => other !== control && !control.contains(other) && !other.contains(control))
      /* A row's control scrolled past the feed's end is clipped by the feed,
         so what can cross is the part its overflow ancestors show. */
      .filter((other) => {
        if (!other.getClientRects().length) return false;
        const b = box(other);
        const c = clip(other);
        const seen = { l: Math.max(b.l, c.l), t: Math.max(b.t, c.t), r: Math.min(b.r, c.r), b: Math.min(b.b, c.b) };
        return seen.r > seen.l && seen.b > seen.t && meets(seen, box(control));
      })
      .map((other) => other.getAttribute("aria-label") ?? other.tagName.toLowerCase())
    : [];
  const composer = document.querySelector("textarea");
  return {
    shared: Boolean(strip?.matches("[data-own-steps]")),
    strip: rect(strip),
    control: rect(control),
    pill: rect(pillAt),
    feed: rect(feed)!,
    composerTop: composer ? box(composer.parentElement ?? composer).t : null,
    inkOnStrip,
    controlsCrossing,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
    label: control?.textContent?.trim() ?? "",
  };
});

browserTest("#2072: away from the tail, the jump control is a row of its own and never covers text", async () => {
  fs.mkdirSync(JUMP_OUT, { recursive: true });
  fs.mkdirSync(JUMP_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = (["en", "uk"] as const).flatMap((lang) => [
    { viewport: { width: 390, height: 667 }, scheme: "dark", lang },
    { viewport: { width: 390, height: 667 }, scheme: "light", lang },
    { viewport: { width: 430, height: 735 }, scheme: "dark", lang },
  ] as const);
  try {
    for (const { viewport, scheme, lang } of cases) {
      const key = `${viewport.width}x${viewport.height}-${scheme}-${lang}`;
      const fail = (label: string) => failures.push(`${key}: ${label}`);
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/#f=${encodeURIComponent(RUNNING_PATH)}`);
        await page.waitForSelector('[data-log-feed-scroller] [data-feed-state="items"]', { timeout: 20_000 });
        await pause(page, 900);
        await feedAtRest(page);
        const following = await readJump(page);
        if (following.strip) fail("a strip while following the tail");

        /* Leave the tail as a wheel does: the input marks the scroll as the
           reader's, then the offset moves. The offset is read again once the
           strip has laid out, before any settle can run. */
        const anchoring = await page.evaluate(async () => {
          const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
          const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const firstRow = () => [...feed.querySelectorAll<HTMLElement>("[data-feed-key]")]
            .find((row) => row.getBoundingClientRect().bottom > feed.getBoundingClientRect().top + 1);
          feed.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -360 }));
          feed.scrollTop -= 360;
          const before = feed.scrollTop;
          const row = firstRow();
          const rowTop = row?.getBoundingClientRect().top ?? null;
          for (let i = 0; i < 30 && !document.querySelector("[data-feed-jump-pill]"); i += 1) await frame();
          await frame();
          await frame();
          return {
            mounted: Boolean(document.querySelector("[data-feed-jump-pill]")),
            before,
            after: feed.scrollTop,
            rowMoved: row && rowTop !== null ? row.getBoundingClientRect().top - rowTop : null,
          };
        });
        if (!anchoring.mounted) fail("no jump strip once away from the tail");
        if (anchoring.after !== anchoring.before) fail(`the feed moved when the strip appeared: ${anchoring.before} → ${anchoring.after}`);
        if (anchoring.rowMoved !== null && Math.abs(anchoring.rowMoved) > 0.5) fail(`the line being read moved by ${anchoring.rowMoved} px when the strip appeared`);

        await feedAtRest(page);
        const away = await readJump(page);
        await page.screenshot({ path: path.join(JUMP_OUT, `${key}.png`) });
        const { strip, control, pill, feed } = away;
        if (!strip || !control || !pill) fail(`strip, control and pill: ${JSON.stringify({ strip, control, pill })}`);
        else {
          const tall = away.shared ? 45 : 44;
          if (Math.abs(strip.height - tall) > 0.5) fail(`the strip is ${strip.height} px tall, expected ${tall}`);
          if (control.width < 44 - 0.5 || control.height < 44 - 0.5) fail(`the control's target is ${control.width}x${control.height}`);
          if (Math.abs(pill.height - 32) > 0.5) fail(`the pill is ${pill.height} px tall, expected 32`);
          if (feed.y + feed.height > strip.y + 0.5) fail(`the feed ends at ${feed.y + feed.height}, below the strip's top ${strip.y}`);
          if (strip.y < 0 || strip.y + strip.height > viewport.height + 0.5) fail(`the strip is outside the page: ${JSON.stringify(strip)}`);
          if (away.composerTop !== null && strip.y + strip.height > away.composerTop + 0.5) fail(`the strip reaches into the composer at ${away.composerTop}`);
        }
        if (away.inkOnStrip.length) fail(`text under the strip: ${JSON.stringify(away.inkOnStrip)}`);
        if (away.controlsCrossing.length) fail(`controls crossing the jump control: ${JSON.stringify(away.controlsCrossing)}`);
        if (away.overflowX > 0.5) fail(`the page overflows sideways by ${away.overflowX} px`);
        const word = translate(lang, "feed.down");
        if (away.shared ? !/^\d*$/.test(away.label) : !away.label.includes(word) && !/\d/.test(away.label)) fail(`the control reads «${away.label}», expected «${word}» or a count`);

        await page.locator("button:has([data-feed-jump-pill])").click();
        await pause(page, 600);
        await feedAtRest(page);
        const back = await page.evaluate(() => {
          const feed = document.querySelector("[data-log-feed-scroller]")!;
          return { strip: Boolean(document.querySelector("[data-feed-jump-pill]")), fromBottom: feed.scrollHeight - feed.clientHeight - feed.scrollTop };
        });
        if (back.strip) fail("the strip stayed after returning to the tail");
        if (back.fromBottom > 60) fail(`the tap left the feed ${back.fromBottom} px from the tail`);
        if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
        results.push({ key, viewport, scheme, lang, following: following.strip, anchoring, away, back });
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(JUMP_EVIDENCE, "jump-strip.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #2072 slice 4 — the phone's status columns (docs/design/phone-kanban.md
 * §3.2–§3.4, §3.9, §5), on the same real Viewer over the fixture's `?kanban=1`
 * scene, at the page iOS Safari leaves at 390 × 844 and 430 × 932, in en and
 * uk, dark and light:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2072 slice 4"
 *
 * Each column is opened from its tab and measured where it rests. Gates: no
 * sideways overflow; every visible control at least 44 × 44 and no two
 * crossing; the ink of each text (the union of its client rects, clipped by
 * its overflow ancestors) meets no other text's ink and no control it is not
 * inside; card titles two lines at most; tab labels whole; the dock inside
 * the page; each card's stage chain one line with its current stage whole;
 * no card age reads like a clock; what a tab's ⚠n counts is its first n
 * cards. Frames go to `LLV_KANBAN_FRAMES` (default `.artifacts/phone-kanban-s4`,
 * not committed); readings to `evidence/issue-2072/columns.json`.
 */
const COLUMNS_OUT = path.resolve(process.env.LLV_KANBAN_FRAMES || ".artifacts/phone-kanban-s4");
const COLUMNS_EVIDENCE = path.resolve("evidence/issue-2072");
const COLUMN_ORDER = ["inbox", "assigned", "blocked", "done"] as const;

interface ColumnReading {
  active: string | null;
  pagerAligned: number;
  overflowX: number;
  columnOverflowX: number;
  cards: Array<{ key: string; height: number; titleLines: number; needs: boolean }>;
  smallControls: Array<{ label: string; width: number; height: number }>;
  crossingControls: string[];
  inkOverlaps: string[];
  inkOnControls: string[];
  truncatedTabs: string[];
  chainOverflow: string[];
  cutCurrentStage: string[];
  clockAges: string[];
  dock: Rect | null;
  tabs: Array<{ status: string; count: string | null; working: string | null; needs: string | null }>;
  pinnedFirst: boolean;
  empty: boolean;
  more: string | null;
}

/* Runs in the page; the ink walk is the test's own. */
const readColumn = (page: Page) => page.evaluate((): ColumnReading => {
  interface Box { l: number; t: number; r: number; b: number }
  const box = (element: Element): Box => {
    const r = element.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const clip = (element: Element): Box => {
    let out: Box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const p = box(parent);
        out = { l: Math.max(out.l, p.l), t: Math.max(out.t, p.t), r: Math.min(out.r, p.r), b: Math.min(out.b, p.b) };
      }
    }
    return { l: Math.max(out.l, 0), t: Math.max(out.t, 0), r: Math.min(out.r, innerWidth), b: Math.min(out.b, innerHeight) };
  };
  const board = document.querySelector<HTMLElement>("[data-phone-kanban]")!;
  const active = board.getAttribute("data-phone-kanban-active");
  const pager = board.querySelector<HTMLElement>("[data-phone-kanban-pager]")!;
  const column = board.querySelector<HTMLElement>(`[data-phone-kanban-column="${active}"]`)!;
  /* What is on screen: the tab strip and the column at rest. */
  const scope = [board.querySelector("[data-phone-kanban-tabs]")!, column];
  const visible = (element: Element) => {
    const r = element.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const c = clip(element);
    return Math.min(r.right, c.r) - Math.max(r.left, c.l) > 1 && Math.min(r.bottom, c.b) - Math.max(r.top, c.t) > 1;
  };
  const controls = scope.flatMap((root) => [...root.querySelectorAll<HTMLElement>("button, a[href]")]).filter(visible);
  const label = (element: Element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 60);
  /* A control as the operator can see and tap it: its box clipped by its
     overflow ancestors, so a card scrolled under the tab strip is only the
     part the column still shows. */
  const shown = (element: Element): Box => {
    const r = box(element);
    const c = clip(element.parentElement ?? element);
    return { l: Math.max(r.l, c.l), t: Math.max(r.t, c.t), r: Math.min(r.r, c.r), b: Math.min(r.b, c.b) };
  };
  /* Controls whose target the operator can reach whole: cut by the column's
     edge is scrolling, not a small target, so only whole ones are sized. */
  const whole = (element: Element) => {
    const r = box(element);
    const c = clip(element.parentElement ?? element);
    return r.t >= c.t - 0.5 && r.b <= c.b + 0.5;
  };
  const smallControls = controls.filter(whole).map((element) => ({ label: label(element), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }))
    .filter((control) => control.width < 43.5 || control.height < 43.5);
  const crossingControls: string[] = [];
  controls.forEach((a, i) => controls.slice(i + 1).forEach((b) => {
    if (a.contains(b) || b.contains(a)) return;
    if (overlap(shown(a), shown(b)) > 0.5) crossingControls.push(`${label(a)} × ${label(b)}`);
  }));
  /* Ink: every text node in scope, as the rects it paints, clipped. */
  const inks: Array<{ node: Node; text: string; rect: Box; control: Element | null }> = [];
  const range = document.createRange();
  for (const root of scope) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || !parent) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || parent.closest(".sr-only")) continue;
      const c = clip(parent);
      range.selectNodeContents(node);
      for (const q of range.getClientRects()) {
        const rect = { l: Math.max(q.left, c.l), t: Math.max(q.top, c.t), r: Math.min(q.right, c.r), b: Math.min(q.bottom, c.b) };
        if (rect.r - rect.l <= 0.5 || rect.b - rect.t <= 0.5) continue;
        inks.push({ node, text: node.textContent.trim().slice(0, 40), rect, control: parent.closest("button, a[href]") });
      }
    }
  }
  const inkOverlaps: string[] = [];
  inks.forEach((a, i) => inks.slice(i + 1).forEach((b) => {
    if (a.node === b.node) return;
    if (overlap(a.rect, b.rect) > 1) inkOverlaps.push(`«${a.text}» × «${b.text}»`);
  }));
  const inkOnControls: string[] = [];
  for (const ink of inks) {
    for (const control of controls) {
      if (ink.control === control || control.contains(ink.node) || (ink.control && ink.control.contains(control))) continue;
      if (overlap(ink.rect, shown(control)) > 1) inkOnControls.push(`«${ink.text}» on ${label(control)}`);
    }
  }
  const cards = [...column.querySelectorAll<HTMLElement>("[data-phone-card]")];
  const cardReadings = cards.map((card) => {
    const title = card.querySelector<HTMLElement>("[data-phone-card-title]")!;
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight) || 16;
    return { key: card.getAttribute("data-phone-card") ?? "", height: card.getBoundingClientRect().height, titleLines: Math.round(title.getBoundingClientRect().height / lineHeight), needs: card.getAttribute("data-needs") === "1" };
  });
  const needsCount = Number(board.querySelector(`[data-phone-kanban-tab="${active}"] [data-phone-tab-needs]`)?.getAttribute("data-phone-tab-needs") ?? "0");
  const firstNeeds = cardReadings.slice(0, needsCount).every((card) => card.needs) && cardReadings.slice(needsCount).every((card) => !card.needs);
  const chainOverflow = [...column.querySelectorAll<HTMLElement>('[data-density="card"] .pb-pills.fold')]
    .filter((pills) => pills.scrollWidth > pills.clientWidth + 0.5)
    .map((pills) => pills.closest("[data-phone-card]")?.getAttribute("data-phone-card") ?? "");
  const cutCurrentStage = [...column.querySelectorAll<HTMLElement>('[data-density="card"] .pb-pill:is(.tone-active, .tone-review, .tone-needs) .pb-name')]
    .filter((name) => name.scrollWidth > name.clientWidth + 0.5)
    .map((name) => name.textContent ?? "");
  const clockAges = [...column.querySelectorAll<HTMLElement>("[data-phone-card] span")]
    .map((span) => (span.childElementCount ? "" : (span.textContent ?? "").trim()))
    .filter((text) => /^\d{1,2}:\d{2}$/.test(text));
  const truncatedTabs = [...board.querySelectorAll<HTMLElement>("[data-phone-tab-label]")]
    .filter((labelElement) => labelElement.scrollWidth > labelElement.clientWidth + 0.5 || box(labelElement).l < box(labelElement.closest("button")!).l - 0.5 || box(labelElement).r > box(labelElement.closest("button")!).r + 0.5)
    .map((labelElement) => labelElement.textContent ?? "");
  const dockElement = document.querySelector("[data-mobile2-dock]");
  const dockRect = dockElement?.getBoundingClientRect() ?? null;
  return {
    active,
    pagerAligned: pager.scrollLeft - COLUMN_INDEX(active) * pager.clientWidth,
    overflowX: document.documentElement.scrollWidth - innerWidth,
    columnOverflowX: column.scrollWidth - column.clientWidth,
    cards: cardReadings,
    smallControls,
    crossingControls,
    inkOverlaps,
    inkOnControls,
    truncatedTabs,
    chainOverflow,
    cutCurrentStage,
    clockAges,
    dock: dockRect ? { x: dockRect.x, y: dockRect.y, width: dockRect.width, height: dockRect.height } : null,
    tabs: [...board.querySelectorAll("[data-phone-kanban-tab]")].map((tab) => ({
      status: tab.getAttribute("data-phone-kanban-tab") ?? "",
      count: tab.querySelector("[data-phone-tab-count]")?.textContent ?? null,
      working: tab.querySelector("[data-phone-tab-working]")?.textContent ?? null,
      needs: tab.querySelector("[data-phone-tab-needs]")?.textContent ?? null,
    })),
    pinnedFirst: firstNeeds,
    empty: Boolean(column.querySelector("[data-phone-kanban-empty]")),
    more: column.querySelector("[data-phone-kanban-more]")?.textContent ?? null,
  };
  function COLUMN_INDEX(status: string | null): number {
    return ["inbox", "assigned", "blocked", "done"].indexOf(status ?? "");
  }
});

/* The pager at rest: its offset unchanged across 300 ms. */
async function pagerAtRest(page: Page): Promise<void> {
  let last = Number.NaN;
  let still = 0;
  for (let i = 0; i < 60 && still < 3; i += 1) {
    await pause(page, 100);
    const left = await page.evaluate(() => document.querySelector("[data-phone-kanban-pager]")?.scrollLeft ?? 0);
    still = left === last ? still + 1 : 0;
    last = left;
  }
  if (still < 3) throw new Error("the pager never came to rest");
}

browserTest("#2072 slice 4: the phone's status columns, each column at rest, in en and uk, dark and light", async () => {
  fs.mkdirSync(COLUMNS_OUT, { recursive: true });
  fs.mkdirSync(COLUMNS_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = ([{ width: 390, height: 667 }, { width: 430, height: 735 }] as const).flatMap((viewport) =>
    (["en", "uk"] as const).flatMap((lang) => (["dark", "light"] as const).map((scheme) => ({ viewport, lang, scheme }))));
  try {
    for (const { viewport, lang, scheme } of cases) {
      const key = `${viewport.width}-${lang}-${scheme}`;
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/?kanban=1#p=atlas`);
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
        await page.waitForSelector('[data-mobile2-seat-card][data-mobile2-seat-state="live"]', { timeout: 20_000 }).catch(() => {});
        await pause(page, 800);
        for (const status of COLUMN_ORDER) {
          await page.locator(`[data-phone-kanban-tab="${status}"]`).click();
          await page.waitForFunction((wanted) => document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active") === wanted, status);
          await pagerAtRest(page);
          /* The column from its top to its end, a screen at a time: every
             gate holds at each stop, so a card low in the column is measured
             where the operator would read it. */
          for (let stop = 0; stop < 8; stop += 1) {
          const fail = (label: string) => failures.push(`${key} ${status} @${stop}: ${label}`);
          const reading = await readColumn(page);
          await page.screenshot({ path: path.join(COLUMNS_OUT, `${viewport.width}-${lang}-${scheme}-${status}${stop ? `-${stop}` : ""}.png`) });
          if (Math.abs(reading.pagerAligned) > 1) fail(`the pager rests ${reading.pagerAligned} px off its column`);
          if (reading.overflowX > 0.5) fail(`the page overflows sideways by ${reading.overflowX} px`);
          if (reading.columnOverflowX > 0.5) fail(`the column overflows sideways by ${reading.columnOverflowX} px`);
          if (reading.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(reading.smallControls)}`);
          if (reading.crossingControls.length) fail(`controls crossing: ${JSON.stringify(reading.crossingControls)}`);
          if (reading.inkOverlaps.length) fail(`text over text: ${JSON.stringify(reading.inkOverlaps.slice(0, 6))}`);
          if (reading.inkOnControls.length) fail(`text over a control: ${JSON.stringify(reading.inkOnControls.slice(0, 6))}`);
          if (reading.truncatedTabs.length) fail(`tab labels cut: ${JSON.stringify(reading.truncatedTabs)}`);
          if (reading.chainOverflow.length) fail(`chains off their line: ${JSON.stringify(reading.chainOverflow)}`);
          if (reading.cutCurrentStage.length) fail(`current stage names cut: ${JSON.stringify(reading.cutCurrentStage)}`);
          if (reading.clockAges.length) fail(`ages that read as clocks: ${JSON.stringify(reading.clockAges)}`);
          const tall = reading.cards.filter((card) => card.titleLines > 2);
          if (tall.length) fail(`titles over two lines: ${JSON.stringify(tall)}`);
          if (!reading.pinnedFirst) fail("what the tab's ⚠ counts is not the column's first cards");
          if (!reading.dock || reading.dock.y < 0 || reading.dock.y + reading.dock.height > viewport.height + 0.5) fail(`the dock is not inside the page: ${JSON.stringify(reading.dock)}`);
          if (status === "blocked" && !reading.empty) fail("Blocked, which holds nothing, does not say so");
          if (status === "done" && !reading.more) fail("Done shows no «Show more» past its window");
          if (status !== "blocked" && reading.empty) fail("a column with work says it is empty");
          /* The running card with a one-line title (§5): at most 74 px. */
          const favicon = reading.cards.find((card) => card.key === "task:t-favicon");
          if (favicon && favicon.titleLines === 1 && favicon.height > 74.5) fail(`a running card with a one-line title is ${favicon.height} px tall`);
          results.push({ key, status, stop, viewport, lang, scheme, ...reading });
          const moved = await page.evaluate((wanted) => {
            const column = document.querySelector<HTMLElement>(`[data-phone-kanban-column="${wanted}"]`)!;
            const before = column.scrollTop;
            column.scrollTop = before + Math.round(column.clientHeight * 0.85);
            return column.scrollTop !== before;
          }, status);
          if (!moved) break;
          await pause(page, 350);
          }
        }
        if (pageErrors.length) failures.push(`${key}: page errors ${pageErrors.join(" | ")}`);
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(COLUMNS_EVIDENCE, "columns.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * #2072 slice 4 — the columns under real touches (phone-kanban §3.3, §3.7,
 * §3.8): a sideways swipe over the column area moves the pager one column and
 * the tabs follow; a vertical drag scrolls that column alone, keeps the tab
 * and opens nothing; a held finger on a card opens the card's sheet and not
 * the task under it; Move to moves the card on the tap, writes one guarded
 * PATCH, and says so in a receipt with Undo; a tap opens the task.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2072 slice 4 touch"
 */
browserTest("#2072 slice 4 touch: the pager swipes, a column scrolls alone, a held card opens its sheet and Move to lands", async () => {
  fs.mkdirSync(COLUMNS_OUT, { recursive: true });
  fs.mkdirSync(COLUMNS_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = [
    { viewport: { width: 390, height: 667 }, lang: "en", scheme: "dark" },
    { viewport: { width: 430, height: 735 }, lang: "uk", scheme: "light" },
  ] as const;
  try {
    for (const { viewport, lang, scheme } of cases) {
      const key = `${viewport.width}-${lang}-${scheme}`;
      const fail = (label: string) => failures.push(`${key}: ${label}`);
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await page.goto(`${fixtureBase}/?kanban=1#p=atlas`);
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
        await pause(page, 800);
        const active = () => page.evaluate(() => document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active") ?? null);
        const column = await rectOf(page, '[data-phone-kanban-column="assigned"]');
        if (!column) throw new Error("no Assigned column");
        const midY = column.y + Math.min(column.height / 2, 160);
        const opened = { start: await active() };

        /* Sideways: Assigned → Blocked, and back. */
        await touch(cdp, along([viewport.width - 30, midY], [40, midY + 4], 14), 16);
        await pagerAtRest(page);
        const afterLeft = await active();
        await touch(cdp, along([40, midY], [viewport.width - 30, midY + 4], 14), 16);
        await pagerAtRest(page);
        const afterRight = await active();
        if (opened.start !== "assigned") fail(`the board opened on ${opened.start}`);
        if (afterLeft !== "blocked") fail(`a swipe left from Assigned landed on ${afterLeft}`);
        if (afterRight !== "assigned") fail(`a swipe right from Blocked landed on ${afterRight}`);
        const tabSelected = await page.evaluate(() => document.querySelector('[data-phone-kanban-tab="assigned"]')?.getAttribute("aria-selected"));
        if (tabSelected !== "true") fail("the tabs did not follow the pager");

        /* Vertical: the column scrolls, the tab and the stack stay. */
        const scrollBefore = await page.evaluate(() => document.querySelector('[data-phone-kanban-column="assigned"]')!.scrollTop);
        await touch(cdp, along([viewport.width / 2, midY + 120], [viewport.width / 2 + 3, midY - 120], 14), 16);
        await pause(page, 600);
        const vertical = await page.evaluate(() => ({
          scrollTop: document.querySelector('[data-phone-kanban-column="assigned"]')!.scrollTop,
          active: document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active"),
          sheet: Boolean(document.querySelector("[data-mobile2-sheet]")),
        }));
        if (!(vertical.scrollTop > scrollBefore + 40)) fail(`a vertical drag scrolled the column by ${vertical.scrollTop - scrollBefore} px`);
        if (vertical.active !== "assigned") fail(`a vertical drag changed the column to ${vertical.active}`);
        if (vertical.sheet) fail("a vertical drag opened a sheet");
        await page.evaluate(() => { document.querySelector('[data-phone-kanban-column="assigned"]')!.scrollTop = 0; });
        await pause(page, 300);

        /* A held finger: the sheet, not the task. */
        const card = '[data-phone-card="task:t-favicon"]';
        const cardBox = await rectOf(page, card);
        if (!cardBox) throw new Error("no favicon card");
        const held: Point = [cardBox.x + cardBox.width / 2, cardBox.y + 18];
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: held[0], y: held[1] }] });
        await pause(page, 700);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await pause(page, 500);
        const sheet = await page.evaluate(() => ({
          open: Boolean(document.querySelector('[data-mobile2-sheet="card"]')),
          actions: [...document.querySelectorAll("[data-phone-card-sheet] [data-phone-card-action]")].map((row) => row.getAttribute("data-phone-card-action")),
          smallest: Math.min(...[...document.querySelectorAll<HTMLElement>("[data-phone-card-sheet] [data-phone-card-action]")].map((row) => row.getBoundingClientRect().height)),
        }));
        await page.screenshot({ path: path.join(COLUMNS_OUT, `${key}-card-sheet.png`) });
        if (!sheet.open) fail("a held finger on a card opened no sheet");
        if (sheet.actions.join(",") !== "move-inbox,move-blocked,move-done,hide,open-agent") fail(`the card sheet offers ${sheet.actions.join(",")}`);
        if (sheet.smallest < 43.5) fail(`a sheet row is ${sheet.smallest} px tall`);

        /* Move to Blocked: on the tap, one guarded PATCH, a receipt with Undo. */
        await tap(page, cdp, '[data-phone-card-action="move-blocked"]');
        await pause(page, 150);
        const moved = await page.evaluate(() => ({
          inBlocked: Boolean(document.querySelector('[data-phone-kanban-column="blocked"] [data-phone-card="task:t-favicon"]')),
          inAssigned: Boolean(document.querySelector('[data-phone-kanban-column="assigned"] [data-phone-card="task:t-favicon"]')),
          blockedCount: document.querySelector('[data-phone-kanban-tab="blocked"] [data-phone-tab-count]')?.textContent ?? null,
          receipt: document.querySelector("[data-mobile2-receipt]")?.textContent ?? "",
          undo: Boolean(document.querySelector('[data-mobile2-receipt-undo="undo"]')),
        }));
        await page.screenshot({ path: path.join(COLUMNS_OUT, `${key}-moved.png`) });
        await page.waitForFunction(() => (window as unknown as { evidence: { taskPatches: unknown[] } }).evidence.taskPatches.length >= 1, undefined, { timeout: 5_000 }).catch(() => undefined);
        const patches = await page.evaluate(() => structuredClone((window as unknown as { evidence: { taskPatches: Array<{ id: string; body: Record<string, unknown> }> } }).evidence.taskPatches));
        if (!moved.inBlocked || moved.inAssigned) fail(`the card did not move on the tap: ${JSON.stringify(moved)}`);
        if (moved.blockedCount !== "1") fail(`Blocked counts ${moved.blockedCount}`);
        if (!moved.receipt.includes(translate(lang, "mobile2.kanban.moved", { column: translate(lang, "kanban.status.blocked") }))) fail(`the receipt reads «${moved.receipt}»`);
        if (!moved.undo) fail("the receipt carries no Undo");
        if (patches.length !== 1 || patches[0]!.id !== "t-favicon" || patches[0]!.body.status !== "blocked" || typeof patches[0]!.body.expectedRevision !== "string") fail(`the writes were ${JSON.stringify(patches)}`);

        /* Undo moves it back through the same queue. */
        await tap(page, cdp, '[data-mobile2-receipt-undo="undo"]');
        await page.waitForFunction(() => Boolean(document.querySelector('[data-phone-kanban-column="assigned"] [data-phone-card="task:t-favicon"]')), undefined, { timeout: 5_000 }).catch(() => fail("Undo did not bring the card back"));
        await page.waitForFunction(() => (window as unknown as { evidence: { taskPatches: unknown[] } }).evidence.taskPatches.length >= 2, undefined, { timeout: 5_000 }).catch(() => fail("Undo sent no write"));

        /* A tap opens the task. */
        await pause(page, 400);
        await tap(page, cdp, card);
        await pause(page, 500);
        const taskOpen = await page.evaluate(() => Boolean(document.querySelector('[data-mobile2-task="t-favicon"] [data-phone-task-body="t-favicon"]')));
        if (!taskOpen) fail("a tap on a card did not open its task screen");
        if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
        results.push({ key, viewport, lang, scheme, opened, afterLeft, afterRight, vertical: { ...vertical, before: scrollBefore }, sheet, moved, patches, taskOpen });
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(COLUMNS_EVIDENCE, "columns-touch.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #2072 slice 5 — the task screen (phone-kanban §3.5), opened from its card
 * the way the operator opens it: a task with one pipeline, one with seven
 * (three completed, folded), one with agents and no pipeline, and one whose
 * pipeline waits on a decision, at 390 × 667 and 430 × 735 (the page Safari
 * leaves), in en and uk, dark. At every scroll stop: no sideways overflow, no
 * text over text or over a control (the ink walk of the columns' case), every
 * whole control at least 44 × 44 counting the reach a pill or a chip draws
 * past its box, no two controls crossing, and the bottom bar inside the page.
 * The 390 frames, and the whole scroll of each, are the review's pictures.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2072 slice 5"
 */
const TASK_OUT = path.resolve(process.env.LLV_TASK_FRAMES || ".artifacts/phone-kanban-s5");
const TASK_CASES = [
  { key: "one-pipeline", task: "t-favicon" },
  { key: "many", task: "t-many" },
  { key: "agents", task: "t-long" },
  { key: "decision", task: "t-data" },
] as const;

interface TaskReading {
  overflowX: number;
  bodyOverflowX: number;
  smallControls: Array<{ label: string; width: number; height: number }>;
  crossingControls: string[];
  inkOverlaps: string[];
  inkOnControls: string[];
  dock: Rect | null;
  lanes: string[];
  scrollHeight: number;
  clientHeight: number;
}

const readTaskScreen = (page: Page) => page.evaluate((): TaskReading => {
  interface Box { l: number; t: number; r: number; b: number }
  const box = (element: Element): Box => {
    const r = element.getBoundingClientRect();
    return { l: r.left, t: r.top, r: r.right, b: r.bottom };
  };
  const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
  const clip = (element: Element): Box => {
    let out: Box = { l: -Infinity, t: -Infinity, r: Infinity, b: Infinity };
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
        const p = box(parent);
        out = { l: Math.max(out.l, p.l), t: Math.max(out.t, p.t), r: Math.min(out.r, p.r), b: Math.min(out.b, p.b) };
      }
    }
    return { l: Math.max(out.l, 0), t: Math.max(out.t, 0), r: Math.min(out.r, innerWidth), b: Math.min(out.b, innerHeight) };
  };
  const screen = document.querySelector<HTMLElement>("[data-mobile2-task]")!;
  const body = screen.querySelector<HTMLElement>("[data-phone-task-body]")!;
  const scope = [screen.querySelector("[data-mobile2-bar]")!, body, screen.querySelector("[data-mobile2-dock]")].filter((element): element is Element => Boolean(element));
  /* A swipe row's tray waits under its card at opacity 0 until a swipe
     reveals it: nothing there is on screen. */
  const transparent = (element: Element) => {
    for (let node: Element | null = element; node; node = node.parentElement) if (getComputedStyle(node).opacity === "0") return true;
    return false;
  };
  const visible = (element: Element) => {
    const r = element.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || transparent(element)) return false;
    const c = clip(element);
    return Math.min(r.right, c.r) - Math.max(r.left, c.l) > 1 && Math.min(r.bottom, c.b) - Math.max(r.top, c.t) > 1;
  };
  const controls = scope.flatMap((root) => [...root.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")]).filter(visible);
  const label = (element: Element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 60);
  const shown = (element: Element): Box => {
    const r = box(element);
    const c = clip(element.parentElement ?? element);
    return { l: Math.max(r.l, c.l), t: Math.max(r.t, c.t), r: Math.min(r.r, c.r), b: Math.min(r.b, c.b) };
  };
  const whole = (element: Element) => {
    const r = box(element);
    const c = clip(element.parentElement ?? element);
    return r.t >= c.t - 0.5 && r.b <= c.b + 0.5;
  };
  /* The target a finger has: the box, grown by a positioned ::after reach. */
  const target = (element: Element) => {
    const r = element.getBoundingClientRect();
    const after = getComputedStyle(element, "::after");
    if (after.content === "none" || after.position !== "absolute") return { width: r.width, height: r.height };
    const px = (value: string) => (value.endsWith("px") ? parseFloat(value) : 0);
    return { width: r.width - Math.min(0, px(after.left)) - Math.min(0, px(after.right)), height: r.height - Math.min(0, px(after.top)) - Math.min(0, px(after.bottom)) };
  };
  const smallControls = controls.filter(whole).map((element) => ({ label: label(element), ...target(element) }))
    .filter((control) => control.width < 43.5 || control.height < 43.5);
  const crossingControls: string[] = [];
  controls.forEach((a, i) => controls.slice(i + 1).forEach((b) => {
    if (a.contains(b) || b.contains(a)) return;
    if (overlap(shown(a), shown(b)) > 0.5) crossingControls.push(`${label(a)} × ${label(b)}`);
  }));
  const inks: Array<{ node: Node; text: string; rect: Box; control: Element | null }> = [];
  const range = document.createRange();
  for (const root of scope) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.textContent?.trim() || !parent) continue;
      const style = getComputedStyle(parent);
      if (style.visibility === "hidden" || parent.closest(".sr-only") || transparent(parent)) continue;
      const c = clip(parent);
      range.selectNodeContents(node);
      for (const q of range.getClientRects()) {
        const rect = { l: Math.max(q.left, c.l), t: Math.max(q.top, c.t), r: Math.min(q.right, c.r), b: Math.min(q.bottom, c.b) };
        if (rect.r - rect.l <= 0.5 || rect.b - rect.t <= 0.5) continue;
        inks.push({ node, text: node.textContent.trim().slice(0, 40), rect, control: parent.closest("button, a[href]") });
      }
    }
  }
  const inkOverlaps: string[] = [];
  inks.forEach((a, i) => inks.slice(i + 1).forEach((b) => {
    if (a.node === b.node) return;
    if (overlap(a.rect, b.rect) > 1) inkOverlaps.push(`«${a.text}» × «${b.text}»`);
  }));
  const inkOnControls: string[] = [];
  for (const ink of inks) {
    for (const control of controls) {
      if (ink.control === control || control.contains(ink.node) || (ink.control && ink.control.contains(control))) continue;
      if (overlap(ink.rect, shown(control)) > 1) inkOnControls.push(`«${ink.text}» on ${label(control)}`);
    }
  }
  const dockElement = screen.querySelector("[data-mobile2-dock]");
  const dockRect = dockElement?.getBoundingClientRect() ?? null;
  return {
    overflowX: document.documentElement.scrollWidth - innerWidth,
    bodyOverflowX: body.scrollWidth - body.clientWidth,
    smallControls,
    crossingControls,
    inkOverlaps,
    inkOnControls,
    dock: dockRect ? { x: dockRect.x, y: dockRect.y, width: dockRect.width, height: dockRect.height } : null,
    lanes: [...body.querySelectorAll("[data-phone-task-lane]")].map((lane) => lane.getAttribute("data-phone-task-lane") ?? ""),
    scrollHeight: body.scrollHeight,
    clientHeight: body.clientHeight,
  };
});

browserTest("#2072 slice 5: the task screen, opened from its card, in en and uk at 390 and 430, holds its ink, targets and bar", async () => {
  fs.mkdirSync(TASK_OUT, { recursive: true });
  fs.mkdirSync(COLUMNS_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = ([{ width: 390, height: 667 }, { width: 430, height: 735 }] as const).flatMap((viewport) =>
    (["en", "uk"] as const).flatMap((lang) => TASK_CASES.map((entry) => ({ viewport, lang, ...entry }))));
  try {
    for (const { viewport, lang, key: scene, task } of cases) {
      const key = `${scene}-${viewport.width}-${lang}`;
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: "dark" });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/?kanban=1#p=atlas`);
        await page.waitForSelector(`[data-phone-card="task:${task}"]`, { timeout: 20_000 });
        await pause(page, 600);
        await page.locator(`[data-phone-card="task:${task}"]`).click();
        await page.waitForSelector(`[data-mobile2-task="${task}"] [data-phone-task-body="${task}"]`, { timeout: 10_000 });
        /* A finger lifts; the driver's pointer would stay and hover the row under it. */
        await page.mouse.move(0, 0);
        await pause(page, 600);
        if (scene === "many") {
          await page.locator("[data-phone-task-ended]").click();
          await pause(page, 300);
          await page.evaluate(() => { document.querySelector("[data-phone-task-body]")!.scrollTop = 0; });
          await pause(page, 200);
        }
        for (let stop = 0; stop < 12; stop += 1) {
          const fail = (label: string) => failures.push(`${key} @${stop}: ${label}`);
          const reading = await readTaskScreen(page);
          await page.screenshot({ path: path.join(TASK_OUT, `task-${key}${stop ? `-${stop}` : ""}.png`) });
          if (reading.overflowX > 0.5) fail(`the page overflows sideways by ${reading.overflowX} px`);
          if (reading.bodyOverflowX > 0.5) fail(`the body overflows sideways by ${reading.bodyOverflowX} px`);
          if (reading.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(reading.smallControls)}`);
          if (reading.crossingControls.length) fail(`controls crossing: ${JSON.stringify(reading.crossingControls)}`);
          if (reading.inkOverlaps.length) fail(`text over text: ${JSON.stringify(reading.inkOverlaps.slice(0, 6))}`);
          if (reading.inkOnControls.length) fail(`text over a control: ${JSON.stringify(reading.inkOnControls.slice(0, 6))}`);
          if (!reading.dock || reading.dock.y < 0 || reading.dock.y + reading.dock.height > viewport.height + 0.5) fail(`the bottom bar is not inside the page: ${JSON.stringify(reading.dock)}`);
          if (stop === 0 && scene === "many" && reading.lanes.length !== 7) fail(`the task with seven pipelines draws ${reading.lanes.length}`);
          if (stop === 0 && scene === "decision" && reading.lanes[0] !== "lane-decision") fail(`the lane that needs a decision is not first: ${reading.lanes.join(",")}`);
          results.push({ key, stop, viewport, lang, ...reading });
          const moved = await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>("[data-phone-task-body]")!;
            const before = body.scrollTop;
            body.scrollTop = before + Math.round(body.clientHeight * 0.85);
            return body.scrollTop !== before;
          });
          if (!moved) break;
          await pause(page, 250);
        }
        /* The whole scroll in one frame, at 390: the page grown to hold it. */
        if (viewport.width === 390) {
          const { scrollHeight, clientHeight } = await page.evaluate(() => {
            const body = document.querySelector<HTMLElement>("[data-phone-task-body]")!;
            body.scrollTop = 0;
            return { scrollHeight: body.scrollHeight, clientHeight: body.clientHeight };
          });
          await page.setViewportSize({ width: viewport.width, height: viewport.height + Math.max(0, scrollHeight - clientHeight) });
          await pause(page, 400);
          await page.screenshot({ path: path.join(TASK_OUT, `task-${scene}-390-full-${lang}.png`) });
          await page.setViewportSize(viewport);
        }
        if (pageErrors.length) failures.push(`${key}: page errors ${pageErrors.join(" | ")}`);
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(COLUMNS_EVIDENCE, "task-screen.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * #2098 — the Overview on the phone is the phone kanban over every project
 * (docs/design/phone-kanban.md §3; issue #2098). The fixture's board spread
 * over three projects (`?overview=1`), at 390 × 667 and 430 × 735, en and uk,
 * dark. Each tab at rest carries the columns' gates (no sideways overflow,
 * whole controls at least 44 × 44 and none crossing, the ink of every text
 * meeting no other ink and no control, titles two lines at most, tab labels
 * whole, chains on one line, no clock-like ages, the pin first), and the
 * Overview's own: every card names its project by its display name and no
 * key shows, and nothing of the desktop board is on the page. A card opens
 * its task screen (the slice 5 gates) and ‹ lands on the column it left; a
 * row no task owns opens its conversation full screen, its feed the screen's
 * width and inside no card. Frames go to `LLV_OVERVIEW_FRAMES` (default
 * `.artifacts/phone-overview`, not committed); readings to
 * `evidence/issue-2098/overview.json`.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2098"
 */
const OVERVIEW_OUT = path.resolve(process.env.LLV_OVERVIEW_FRAMES || ".artifacts/phone-overview");
const OVERVIEW_EVIDENCE = path.resolve("evidence/issue-2098");
const OVERVIEW_NAMES = ["delegatus", "forge-api", "atlas-docs"];

const readOverviewCards = (page: Page) => page.evaluate(() => {
  const board = document.querySelector<HTMLElement>("[data-phone-kanban]")!;
  const column = board.querySelector<HTMLElement>(`[data-phone-kanban-column="${board.getAttribute("data-phone-kanban-active")}"]`)!;
  return {
    projects: [...column.querySelectorAll<HTMLElement>("[data-phone-card]")].map((card) => card.querySelector("[data-phone-card-project]")?.textContent ?? null),
    keyShown: /repo-[0-9a-f]{8,}/.test(board.textContent ?? ""),
    desktop: [...document.querySelectorAll("[data-kanban-board], [data-kanban-search], [data-hidden-pill], [data-kanban-reader]")].length,
  };
});

const readConversationScreen = (page: Page) => page.evaluate(() => {
  const screen = document.querySelector<HTMLElement>('[data-mobile2-screen="chat"]');
  const feed = screen?.querySelector<HTMLElement>("[data-feed-state]") ?? null;
  const rect = feed?.getBoundingClientRect() ?? null;
  return {
    open: Boolean(screen),
    back: Boolean(screen?.querySelector("[data-mobile2-back]")),
    board: Boolean(document.querySelector("[data-phone-kanban]")),
    feedWidth: rect?.width ?? 0,
    feedInCard: Boolean(feed?.closest("[data-phone-card], [data-kanban-card]")),
    overflowX: document.documentElement.scrollWidth - innerWidth,
    /* The screen reaches the page's bottom: a band under it is a keyboard
       inset nobody opened. */
    bandBelow: innerHeight - (screen?.getBoundingClientRect().bottom ?? 0),
    innerHeight,
  };
});

browserTest("#2098: the phone's Overview is the phone kanban over three projects, and what a card opens opens full screen", async () => {
  fs.mkdirSync(OVERVIEW_OUT, { recursive: true });
  fs.mkdirSync(OVERVIEW_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = ([{ width: 390, height: 667 }, { width: 430, height: 735 }] as const).flatMap((viewport) =>
    (["en", "uk"] as const).map((lang) => ({ viewport, lang })));
  try {
    for (const { viewport, lang } of cases) {
      const key = `${viewport.width}-${lang}`;
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: "dark" });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/?overview=1`);
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
        await pause(page, 800);
        /* The bar's ⚠ and the tabs' ⚠ marks are one list: every project's
           asking conversations and parked lanes. */
        const queue = await page.evaluate(() => ({
          badge: Number(document.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") ?? "0"),
          marks: [...document.querySelectorAll("[data-phone-tab-needs]")].reduce((sum, mark) => sum + Number(mark.textContent), 0),
        }));
        if (queue.badge !== queue.marks) failures.push(`${key}: the ⚠ badge counts ${queue.badge}, the tabs mark ${queue.marks}`);
        results.push({ key, viewport, lang, queue });
        for (const status of COLUMN_ORDER) {
          await page.locator(`[data-phone-kanban-tab="${status}"]`).click();
          await page.waitForFunction((wanted) => document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active") === wanted, status);
          await pagerAtRest(page);
          await page.mouse.move(0, 0);
          for (let stop = 0; stop < 8; stop += 1) {
            const fail = (label: string) => failures.push(`${key} ${status} @${stop}: ${label}`);
            const reading = await readColumn(page);
            const cards = await readOverviewCards(page);
            await page.screenshot({ path: path.join(OVERVIEW_OUT, `overview-${key}-${status}${stop ? `-${stop}` : ""}.png`) });
            if (Math.abs(reading.pagerAligned) > 1) fail(`the pager rests ${reading.pagerAligned} px off its column`);
            if (reading.overflowX > 0.5) fail(`the page overflows sideways by ${reading.overflowX} px`);
            if (reading.columnOverflowX > 0.5) fail(`the column overflows sideways by ${reading.columnOverflowX} px`);
            if (reading.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(reading.smallControls)}`);
            if (reading.crossingControls.length) fail(`controls crossing: ${JSON.stringify(reading.crossingControls)}`);
            if (reading.inkOverlaps.length) fail(`text over text: ${JSON.stringify(reading.inkOverlaps.slice(0, 6))}`);
            if (reading.inkOnControls.length) fail(`text over a control: ${JSON.stringify(reading.inkOnControls.slice(0, 6))}`);
            if (reading.truncatedTabs.length) fail(`tab labels cut: ${JSON.stringify(reading.truncatedTabs)}`);
            if (reading.chainOverflow.length) fail(`chains off their line: ${JSON.stringify(reading.chainOverflow)}`);
            if (reading.cutCurrentStage.length) fail(`current stage names cut: ${JSON.stringify(reading.cutCurrentStage)}`);
            if (reading.clockAges.length) fail(`ages that read as clocks: ${JSON.stringify(reading.clockAges)}`);
            const tall = reading.cards.filter((card) => card.titleLines > 2);
            if (tall.length) fail(`titles over two lines: ${JSON.stringify(tall)}`);
            if (!reading.pinnedFirst) fail("what the tab's ⚠ counts is not the column's first cards");
            const unnamed = cards.projects.filter((name) => !name || !OVERVIEW_NAMES.includes(name));
            if (unnamed.length) fail(`cards that do not name their project: ${JSON.stringify(unnamed)}`);
            if (cards.keyShown) fail("a project key is on the board");
            if (cards.desktop) fail(`${cards.desktop} pieces of the desktop board are on the phone`);
            if ((status === "inbox" || status === "assigned") && reading.empty) fail(`${status} holds live work and says it is empty`);
            results.push({ key, status, stop, viewport, lang, ...reading, overview: cards });
            const moved = await page.evaluate((wanted) => {
              const column = document.querySelector<HTMLElement>(`[data-phone-kanban-column="${wanted}"]`)!;
              const before = column.scrollTop;
              column.scrollTop = before + Math.round(column.clientHeight * 0.85);
              return column.scrollTop !== before;
            }, status);
            if (!moved) break;
            await pause(page, 350);
          }
          await page.evaluate((wanted) => { document.querySelector<HTMLElement>(`[data-phone-kanban-column="${wanted}"]`)!.scrollTop = 0; }, status);
        }

        /* A card opens its task over the Overview; ‹ lands on the column. */
        await page.locator('[data-phone-kanban-tab="assigned"]').click();
        await pagerAtRest(page);
        await page.locator('[data-phone-card="task:t-favicon"]').click();
        await page.waitForSelector('[data-mobile2-task="t-favicon"] [data-phone-task-body="t-favicon"]', { timeout: 10_000 });
        await page.mouse.move(0, 0);
        await pause(page, 600);
        const task = await readTaskScreen(page);
        await page.screenshot({ path: path.join(OVERVIEW_OUT, `overview-${key}-task.png`) });
        const taskFail = (label: string) => failures.push(`${key} task: ${label}`);
        if (task.overflowX > 0.5) taskFail(`the page overflows sideways by ${task.overflowX} px`);
        if (task.smallControls.length) taskFail(`controls under 44 px: ${JSON.stringify(task.smallControls)}`);
        if (task.crossingControls.length) taskFail(`controls crossing: ${JSON.stringify(task.crossingControls)}`);
        if (task.inkOverlaps.length) taskFail(`text over text: ${JSON.stringify(task.inkOverlaps.slice(0, 6))}`);
        if (task.inkOnControls.length) taskFail(`text over a control: ${JSON.stringify(task.inkOnControls.slice(0, 6))}`);
        /* The task's agent row opens its conversation over the Overview, and
           the Overview stays the scope: the same ⚠, nothing stored as the
           project to reopen. */
        const scope = () => page.evaluate(() => ({
          badge: document.querySelector("[data-mobile2-attention-count]")?.getAttribute("data-mobile2-attention-count") ?? null,
          stored: localStorage.getItem("llvProject"),
        }));
        const beforeAgent = await scope();
        await page.locator("[data-phone-task-agent] button").first().click();
        await page.waitForSelector('[data-mobile2-screen="chat"]', { timeout: 10_000 });
        await pause(page, 900);
        const afterAgent = await scope();
        if (afterAgent.badge !== beforeAgent.badge || afterAgent.stored !== "__overview__") taskFail(`an agent row changed the scope: ${JSON.stringify({ beforeAgent, afterAgent })}`);
        await page.locator("[data-mobile2-back]").first().click();
        await page.waitForSelector('[data-mobile2-task="t-favicon"] [data-phone-task-body="t-favicon"]', { timeout: 10_000 });
        await page.locator("[data-mobile2-back]").first().click();
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 10_000 });
        const backOn = await page.evaluate(() => document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active"));
        if (backOn !== "assigned") taskFail(`‹ from the task landed on ${backOn}`);

        /* A row no task owns opens its conversation full screen. */
        await page.locator('[data-phone-kanban-tab="inbox"]').click();
        await pagerAtRest(page);
        const row = page.locator(`[data-phone-card-agent="${RUNNING_PATH}"]`);
        await row.scrollIntoViewIfNeeded();
        await row.click();
        await page.waitForSelector('[data-mobile2-screen="chat"] [data-feed-state]', { timeout: 10_000 });
        await page.mouse.move(0, 0);
        await pause(page, 900);
        const conversation = await readConversationScreen(page);
        await page.screenshot({ path: path.join(OVERVIEW_OUT, `overview-${key}-conversation.png`) });
        const chatFail = (label: string) => failures.push(`${key} conversation: ${label}`);
        if (!conversation.open || !conversation.back) chatFail(`the conversation is not a screen with ‹: ${JSON.stringify(conversation)}`);
        if (conversation.board) chatFail("the Overview's board is still drawn beside the conversation");
        if (conversation.feedInCard) chatFail("the feed is drawn inside a card");
        if (conversation.feedWidth < viewport.width - 24) chatFail(`the feed is ${conversation.feedWidth} px wide on a ${viewport.width} px page`);
        if (conversation.overflowX > 0.5) chatFail(`the page overflows sideways by ${conversation.overflowX} px`);
        if (conversation.bandBelow > 0.5 || conversation.innerHeight !== viewport.height) chatFail(`${conversation.bandBelow} px of empty band under the conversation (innerHeight ${conversation.innerHeight})`);
        await page.locator("[data-mobile2-back]").first().click();
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 10_000 });

        /* A search result lands through the hash, as the search palette sends
           it: over the Overview too, and ‹ comes back to the Overview. */
        const beforeSearch = await scope();
        await page.evaluate((transcript) => { location.hash = "#f=" + encodeURIComponent(transcript); }, RUNNING_PATH);
        await page.waitForSelector('[data-mobile2-screen="chat"] [data-feed-state]', { timeout: 10_000 });
        await pause(page, 900);
        const afterSearch = { ...(await scope()), band: (await readConversationScreen(page)).bandBelow };
        if (afterSearch.badge !== beforeSearch.badge || afterSearch.stored !== "__overview__" || afterSearch.band > 0.5) chatFail(`a search result changed the scope or left a band: ${JSON.stringify({ beforeSearch, afterSearch })}`);
        await page.locator("[data-mobile2-back]").first().click();
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 10_000 });
        const searchBack = await page.evaluate(() => ({ hash: location.hash, board: Boolean(document.querySelector("[data-phone-kanban]")) }));
        if (searchBack.hash || !searchBack.board) chatFail(`‹ from a search result landed on ${JSON.stringify(searchBack)}`);

        /* ⋯ › Hidden tasks, over the Overview. */
        await page.locator('[data-mobile2-open="menu"]').click();
        await page.locator('[data-mobile2-open="hidden"]').click();
        await page.waitForSelector("[data-phone-hidden-sheet]", { timeout: 5_000 });
        await pause(page, 500);
        const hidden = await page.evaluate(() => [...document.querySelectorAll("[data-phone-hidden-row]")].map((row) => row.getAttribute("data-phone-hidden-row")));
        await page.screenshot({ path: path.join(OVERVIEW_OUT, `overview-${key}-hidden.png`) });
        if (hidden.join(",") !== "t-seat,t-quota") failures.push(`${key} hidden: the sheet lists ${hidden.join(",")}`);
        if (pageErrors.length) failures.push(`${key}: page errors ${pageErrors.join(" | ")}`);
        results.push({ key, viewport, lang, task, agentScope: { beforeAgent, afterAgent }, backOn, conversation, searchScope: { beforeSearch, afterSearch, searchBack }, hidden });
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(OVERVIEW_EVIDENCE, "overview.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * The Telegram bot account's setup panel (docs/design/telegram-bot-account.md)
 * — not connected, connected with chats, and reading blocked by a webhook — on
 * the phone (menu › Accounts › Telegram) at 390 and 430 in both schemes, and
 * on the desktop from the rail footer at 1440. The connected scene also runs
 * in Ukrainian at 390 and at a 1280 desktop, and the chat the operator chose
 * for a project's reports must name that project; so does `refused`, the chat
 * a project chose with posting switched off since, whose line says so:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "telegram bot"
 *
 * Frames go to `$LLV_TELEGRAM_BOT_OUT` (default `.artifacts/telegram-bot`),
 * readings to `evidence/telegram-bot/panel.json`. A case fails on horizontal
 * overflow, a control cut by the panel's edge, two text boxes overlapping, a
 * phone target under 44 px, or, on the phone, a sheet narrower than the screen
 * or with no scrim behind it.
 */
const BOT_OUT = path.resolve(process.env.LLV_TELEGRAM_BOT_OUT ?? ".artifacts/telegram-bot");
const BOT_EVIDENCE = path.resolve("evidence/telegram-bot");
const BOT_SCENES = ["none", "chats", "webhook"] as const;

async function readTelegramPanel(page: Page, phone: boolean) {
  return page.evaluate((isPhone) => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Telegram"]');
    if (!dialog) return null;
    const box = dialog.getBoundingClientRect();
    const failures: string[] = [];
    if (dialog.scrollWidth > dialog.clientWidth + 1) failures.push(`horizontal overflow ${dialog.scrollWidth} > ${dialog.clientWidth}`);
    if (box.left < -0.5 || box.right > window.innerWidth + 0.5) failures.push(`panel leaves the viewport: ${box.left}..${box.right}`);
    /* On the phone the sheet spans the screen over a dimming scrim, so none
       of the Accounts list shows beside it. */
    const scrim = document.querySelector<HTMLElement>("[data-telegram-scrim]");
    const scrimColor = scrim ? getComputedStyle(scrim).backgroundColor : null;
    if (isPhone && (box.left > 0.5 || box.right < window.innerWidth - 0.5)) failures.push(`the sheet leaves the screen's sides uncovered: ${box.left}..${box.right} of ${window.innerWidth}`);
    if (isPhone && (!scrimColor || scrimColor === "rgba(0, 0, 0, 0)" || scrimColor === "transparent")) failures.push(`no scrim behind the sheet (${scrimColor})`);
    const controls = [...dialog.querySelectorAll<HTMLElement>("button, input, summary")]
      .filter((element) => element.getClientRects().length > 0 && !(element.closest("details:not([open])") && !element.closest("summary")));
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      const name = control.getAttribute("aria-label") ?? control.textContent?.trim().slice(0, 40) ?? control.tagName;
      if (rect.left < box.left - 0.5 || rect.right > box.right + 0.5) failures.push(`control cut by the panel edge: ${name}`);
      if (isPhone && rect.height < 43.5) failures.push(`phone target under 44 px: ${name} (${rect.height})`);
    }
    /* Ink, not boxes: the union of each text leaf's own line rects. */
    /* A closed <details> keeps boxes for what it hides; that is not ink. */
    const hidden = (element: Element) => {
      const details = element.closest("details:not([open])");
      return details !== null && !element.closest("summary");
    };
    const leaves = [...dialog.querySelectorAll<HTMLElement>("span, p, label, h3, h4, summary, li")]
      .filter((element) => element.childElementCount === 0 && (element.textContent ?? "").trim() !== "" && element.getClientRects().length > 0 && !hidden(element));
    /* A range's rects run past an ellipsis and out of a clipped box
       (a truncated title, an sr-only line); the part a box with overflow
       other than visible cuts off is not ink. */
    const clipOf = (element: HTMLElement) => {
      let clip = { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
      for (let node: HTMLElement | null = element; node && node !== dialog; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.overflowX === "visible" && style.overflowY === "visible") continue;
        const r = node.getBoundingClientRect();
        clip = { left: Math.max(clip.left, r.left), top: Math.max(clip.top, r.top), right: Math.min(clip.right, r.right), bottom: Math.min(clip.bottom, r.bottom) };
      }
      return clip;
    };
    const inkOf = (element: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const clip = clipOf(element);
      return [...range.getClientRects()]
        .map((r) => ({ left: Math.max(r.left, clip.left), top: Math.max(r.top, clip.top), right: Math.min(r.right, clip.right), bottom: Math.min(r.bottom, clip.bottom) }))
        .filter((r) => r.right - r.left > 1 && r.bottom - r.top > 1);
    };
    const inks = leaves.map((element) => ({ element, rects: inkOf(element) }));
    let overlaps = 0;
    for (let a = 0; a < inks.length; a += 1) {
      for (let b = a + 1; b < inks.length; b += 1) {
        if (inks[a]!.element.contains(inks[b]!.element) || inks[b]!.element.contains(inks[a]!.element)) continue;
        const hit = inks[a]!.rects.some((r1) => inks[b]!.rects.some((r2) =>
          Math.min(r1.right, r2.right) - Math.max(r1.left, r2.left) > 1 && Math.min(r1.bottom, r2.bottom) - Math.max(r1.top, r2.top) > 1));
        if (hit) {
          overlaps += 1;
          failures.push(`text overlaps: "${inks[a]!.element.textContent?.slice(0, 30)}" / "${inks[b]!.element.textContent?.slice(0, 30)}"`);
        }
      }
    }
    return {
      panel: { left: box.left, top: box.top, width: box.width, height: box.height, scrollHeight: dialog.scrollHeight },
      scrim: scrimColor,
      botSectionHeight: dialog.querySelector('section[aria-label="Bot"], section[aria-label="Бот"]')?.getBoundingClientRect().height ?? null,
      controls: controls.length,
      textLeaves: leaves.length,
      overlaps,
      failures,
    };
  }, phone);
}

async function openTelegramPanel(page: Page, phone: boolean, lang: "en" | "uk" = "en"): Promise<void> {
  if (phone) {
    await page.locator('[data-mobile2-open="menu"]').first().click();
    await page.locator('[data-mobile2-menu-row="accounts"]').click();
    await page.waitForSelector("[data-mobile2-telegram] button", { timeout: 10_000 });
    await page.locator("[data-mobile2-telegram] button").first().click();
  } else {
    const footer = page.locator("[data-rail-footer]").first();
    await footer.waitFor({ timeout: 10_000 });
    if (await footer.getAttribute("data-rail-footer") === "folded") await page.click("[data-rail-footer-toggle]");
    await page.locator(`button[aria-label="${lang === "uk" ? "Підключення Telegram" : "Telegram connection"}"]`).click();
  }
  await page.waitForSelector(`[role="dialog"][aria-label="Telegram"] section[aria-label="${lang === "uk" ? "Бот" : "Bot"}"]`, { timeout: 10_000 });
  await pause(page, 500);
}

browserTest("telegram bot: the setup panel on the phone and the desktop holds its width, controls and ink", async () => {
  fs.mkdirSync(BOT_OUT, { recursive: true });
  fs.mkdirSync(BOT_EVIDENCE, { recursive: true });
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = [
    ...VIEWPORTS.flatMap((viewport) => SCHEMES.map((scheme) => ({ viewport, scheme, phone: true }))),
    { viewport: { width: 1_440, height: 900 }, scheme: "light" as const, phone: false },
    { viewport: { width: 1_440, height: 900 }, scheme: "dark" as const, phone: false },
  ].map((entry): { viewport: { width: number; height: number }; scheme: "light" | "dark"; phone: boolean; lang: "en" | "uk"; scenes: readonly string[] } => ({ ...entry, lang: "en", scenes: BOT_SCENES }));
  cases.push(
    { viewport: { width: 390, height: 844 }, scheme: "light", phone: true, lang: "uk", scenes: ["chats", "refused"] },
    { viewport: { width: 1_280, height: 800 }, scheme: "light", phone: false, lang: "uk", scenes: ["chats", "refused"] },
  );
  try {
    for (const { viewport, scheme, phone, lang, scenes } of cases) {
      for (const scene of scenes) {
        const key = `${phone ? "phone" : "desktop"}-${viewport.width}-${scheme}-${scene}${lang === "en" ? "" : `-${lang}`}`;
        const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
        try {
          await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${base}/?bot=${scene}`);
          await openTelegramPanel(page, phone, lang);
          const top = await readTelegramPanel(page, phone);
          const reportsLine = await page.locator('[role="dialog"][aria-label="Telegram"] [data-telegram-chat-reports]').allTextContents();
          await page.screenshot({ path: path.join(BOT_OUT, `${key}.png`) });
          const expectedReports = scene === "chats" || scene === "webhook" ? [lang === "uk" ? "Звіти оркестратора: Atlas" : "Orchestrator reports: Atlas"]
            : scene === "refused" ? [lang === "uk" ? "Звіти оркестратора: Atlas. Дописи сюди зараз відхиляються, тож звіти лишаються лише в журналі: увімкніть дописи або оберіть інший чат" : "Orchestrator reports: Atlas. Posts are refused here now, so they reach the log only: switch posting on or pick another chat"]
            : [];
          if (JSON.stringify(reportsLine) !== JSON.stringify(expectedReports)) failures.push(`${key}: the chat's reports line reads ${JSON.stringify(reportsLine)}`);
          /* The panel scrolls inside itself; the second frame is its end. */
          await page.evaluate(() => {
            const dialog = document.querySelector('[role="dialog"][aria-label="Telegram"]');
            dialog?.querySelectorAll("details").forEach((details) => { (details as HTMLDetailsElement).open = true; });
            dialog?.scrollTo({ top: dialog.scrollHeight });
          });
          await pause(page, 300);
          const end = await readTelegramPanel(page, phone);
          await page.screenshot({ path: path.join(BOT_OUT, `${key}-end.png`) });
          if (!top || !end) failures.push(`${key}: the panel did not open`);
          for (const reading of [top, end]) for (const failure of reading?.failures ?? []) failures.push(`${key}: ${failure}`);
          if (pageErrors.length) failures.push(`${key}: page errors ${pageErrors.join(" | ")}`);
          results.push({ key, viewport, scheme, lang, scene, reportsLine, top, end });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(BOT_EVIDENCE, "panel.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * The chat row's posting switch: one tap allows a chat with no alias under
 * the one its title suggests; an alias typed into a chat that suggests none
 * rides with the tap on the switch; and a rename of an allowed chat followed
 * by switching it off is one save. The field's blur between them used to
 * save first, disable the switch, and swallow the tap. Each case must end on
 * the switch's new state after exactly one POST, by touch on the phone and by
 * mouse on the desktop:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "telegram bot switch"
 */
browserTest("telegram bot switch: one tap allows a chat, and a typed alias rides with the tap", async () => {
  fs.mkdirSync(BOT_OUT, { recursive: true });
  fs.mkdirSync(BOT_EVIDENCE, { recursive: true });
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const surfaces = [
    { name: "phone-390", viewport: { width: 390, height: 844 }, phone: true },
    { name: "desktop-1440", viewport: { width: 1_440, height: 900 }, phone: false },
  ];
  const steps = [
    { scene: "typed", title: "Реліз", fill: "release", expect: { chatId: "-1000000000505", alias: "release", postAllowed: true } },
    { scene: "chats", title: "Person A", fill: null, expect: { chatId: "700000303", alias: "person-a", postAllowed: true } },
    { scene: "chats", title: "Team Reports", fill: "team-weekly", expect: { chatId: "-1000000000101", alias: "team-weekly", postAllowed: false } },
  ] as const;
  try {
    for (const surface of surfaces) {
      for (const step of steps) {
        const key = `${surface.name}-${step.scene}-${step.expect.alias}`;
        const context = await browser.newContext({ viewport: surface.viewport, colorScheme: "light", deviceScaleFactor: 2, ...(surface.phone ? { hasTouch: true, isMobile: true } : {}) });
        try {
          const page = await context.newPage();
          await page.goto(`${base}/?bot=${step.scene}`);
          await openTelegramPanel(page, surface.phone);
          const field = page.locator(`input[aria-label="Alias agents use: ${step.title}"]`);
          const toggle = page.locator(`[role="switch"][aria-label="Agents may post: ${step.title}"]`);
          if (step.fill !== null) await field.fill(step.fill);
          if (surface.phone) await toggle.tap();
          else await toggle.click();
          const wanted = String(step.expect.postAllowed);
          await page.waitForFunction(({ title, value }) => document.querySelector(`[role="switch"][aria-label="Agents may post: ${title}"]`)?.getAttribute("aria-checked") === value, { title: step.title, value: wanted }, { timeout: 5_000 })
            .catch(() => failures.push(`${key}: the switch did not end ${wanted}`));
          await pause(page, 300);
          const posts = await page.evaluate(() => structuredClone((window as unknown as { evidence: { botPosts: Array<Record<string, unknown>> } }).evidence.botPosts));
          const checked = await toggle.getAttribute("aria-checked");
          const expected = { action: "chat", ...step.expect };
          if (posts.length !== 1 || JSON.stringify(posts[0]) !== JSON.stringify(expected)) {
            failures.push(`${key}: expected exactly one POST ${JSON.stringify(expected)}, saw ${JSON.stringify(posts)}`);
          }
          await page.screenshot({ path: path.join(BOT_OUT, `${key}-after-tap.png`) });
          results.push({ key, surface: surface.name, scene: step.scene, title: step.title, filled: step.fill, checked, posts });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(BOT_EVIDENCE, "switch.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * docs/design/needs-attention.md — why a phone card needs the operator, its
 * Dismiss, and an agent's request_attention that moves nothing, on the real
 * Viewer over the fixture's `?needs=1` scene at 390 × 844:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable LLV_NEEDS_PHASE=after \
 *     LLV_NEEDS_FRAMES=<dir> bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "needs attention"
 *
 * The same case renders the scene on a checkout without the change
 * (`LLV_NEEDS_PHASE=before`), which records frames and readings and gates
 * nothing, so the two phases are the before and after of one scene. Frames go
 * to `LLV_NEEDS_FRAMES` (default `.artifacts/needs-attention`, not committed);
 * the after readings to `evidence/needs-attention/phone.json`.
 */
const NEEDS_PHASE = process.env.LLV_NEEDS_PHASE === "before" ? "before" : "after";
const NEEDS_OUT = path.resolve(process.env.LLV_NEEDS_FRAMES || ".artifacts/needs-attention");
const NEEDS_EVIDENCE = path.resolve("evidence/needs-attention");
const NEEDS_READER = "/state/agent-log-viewer/shared/accounts/claude/spare/projects/atlas/running.jsonl";

/** What one column shows about what needs the operator, card by card. */
const needsReading = (page: Page, status: string) => page.evaluate((wanted) => {
  const column = document.querySelector<HTMLElement>(`[data-phone-kanban-column="${wanted}"]`)!;
  const rect = (element: Element | null) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const cross = (a: DOMRect, b: DOMRect) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return {
    tabNeeds: document.querySelector(`[data-phone-kanban-tab="${wanted}"] [data-phone-tab-needs]`)?.textContent ?? null,
    cards: [...column.querySelectorAll<HTMLElement>("[data-phone-card]")].map((card) => {
      const frame = card.closest("[data-phone-card-frame]");
      const dismiss = frame?.querySelector("[data-phone-card-dismiss]") ?? null;
      const undo = frame?.querySelector("[data-phone-card-undo]") ?? null;
      const inks = [...card.querySelectorAll("[data-phone-card-title], [data-phone-card-badge]")].map((node) => node.getBoundingClientRect());
      const control = (dismiss ?? undo)?.getBoundingClientRect() ?? null;
      return {
        key: card.getAttribute("data-phone-card"),
        title: card.querySelector("[data-phone-card-title]")?.textContent ?? "",
        needs: card.getAttribute("data-needs") === "1",
        edge: card.closest("[data-phone-card-frame]") ? frame?.className.includes("inset_3px") ?? false : card.getAttribute("data-edge"),
        badge: card.querySelector("[data-phone-card-badge]")?.textContent ?? null,
        state: card.querySelector("[data-phone-card-state]")?.textContent ?? null,
        cleared: card.querySelector("[data-phone-card-cleared]")?.textContent ?? null,
        dismiss: rect(dismiss),
        undo: rect(undo),
        /* The card's own button and its control are side by side, never on
           top of each other, and the control covers none of the card's text. */
        controlCrossesCard: control ? cross(control, card.getBoundingClientRect()) > 0.5 : false,
        controlOnText: control ? inks.some((ink) => cross(control, ink) > 0.5) : false,
      };
    }),
  };
}, status);

/** Where the operator is: the screen on top and how far its feed is scrolled. */
const whereAmI = (page: Page) => page.evaluate(() => {
  const screens = [...document.querySelectorAll<HTMLElement>("[data-mobile2-screen]")];
  const top = screens.at(-1) ?? null;
  const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]");
  return {
    screen: top?.getAttribute("data-mobile2-screen") ?? null,
    conversation: top?.getAttribute("data-mobile2-conversation") ?? null,
    feedScrollTop: feed ? Math.round(feed.scrollTop) : null,
    banner: document.querySelectorAll("[data-mobile2-banner]").length,
    badge: document.querySelector("[data-mobile2-open='attention']")?.getAttribute("aria-label") ?? null,
    dot: document.querySelectorAll("[data-mobile2-notice-dot]").length,
    hash: location.hash,
  };
});

browserTest("needs attention: why a phone card needs the operator, its Dismiss, and a request that moves nothing", async () => {
  fs.mkdirSync(NEEDS_OUT, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const readings: Record<string, unknown> = { phase: NEEDS_PHASE };
  const failures: string[] = [];
  const fail = (label: string) => failures.push(label);
  const after = NEEDS_PHASE === "after";
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(NEEDS_OUT, `${NEEDS_PHASE}-${name}.png`) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: "light" });
    await context.addInitScript(() => { localStorage.setItem("llv_lang", "en"); });
    try {
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(`${fixtureBase}/?kanban=1&needs=1&notice=1#p=atlas`);
      await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
      await pause(page, 900);

      /* Assigned: a card for each reason that still asks, then the rest. */
      await page.locator('[data-phone-kanban-tab="assigned"]').click();
      await pagerAtRest(page);
      await shot(page, "assigned");
      const assigned = await needsReading(page, "assigned");
      readings.assigned = assigned;
      const geometry = await readColumn(page);
      readings.assignedGeometry = { smallControls: geometry.smallControls, crossingControls: geometry.crossingControls, inkOverlaps: geometry.inkOverlaps, inkOnControls: geometry.inkOnControls, pinnedFirst: geometry.pinnedFirst };
      /* The card someone cleared, scrolled to where the operator reads it. */
      await page.evaluate(() => document.querySelector('[data-phone-card="task:t-cleared"]')?.scrollIntoView({ block: "center" }));
      await pause(page, 400);
      await shot(page, "assigned-cleared");

      /* Inbox: the question, then what no task owns, stalled and walled among it. */
      await page.locator('[data-phone-kanban-tab="inbox"]').click();
      await pagerAtRest(page);
      await shot(page, "inbox");
      const inbox = await needsReading(page, "inbox");
      readings.inbox = inbox;
      await page.evaluate(() => document.querySelector('[data-phone-kanban-column="inbox"] [data-phone-kanban-unlinked]')?.scrollIntoView({ block: "start" }));
      await pause(page, 400);
      await shot(page, "inbox-loose");

      if (after) {
        const byKey = new Map(assigned.cards.map((card) => [card.key, card] as const));
        const expectBadge = (key: string, words: RegExp) => {
          const card = byKey.get(key);
          if (!card?.needs) fail(`${key} is not pinned as needing the operator`);
          else if (!words.test(card.badge ?? "")) fail(`${key} names «${card.badge}», wanted ${words}`);
          if (card && (!card.dismiss || card.dismiss.width < 44 || card.dismiss.height < 44)) fail(`${key} has no 44 × 44 Dismiss: ${JSON.stringify(card.dismiss)}`);
          if (card?.controlCrossesCard || card?.controlOnText) fail(`${key}'s Dismiss sits over the card`);
        };
        expectBadge("task:t-data", /^needs a decision · /);
        expectBadge("task:t-copilot", /^review budget spent · /);
        expectBadge("task:t-prompt", /^permission prompt$/);
        expectBadge("task:t-owed", /^message not delivered$/);
        const cleared = byKey.get("task:t-cleared");
        if (!cleared || cleared.needs || !/^Cleared · orchestrator · /.test(cleared.cleared ?? "")) fail(`the cleared card reads ${JSON.stringify(cleared)}`);
        if (cleared && (!cleared.undo || cleared.undo.height < 44)) fail("the cleared card has no 44 px Undo");
        if (geometry.crossingControls.length) fail(`controls crossing: ${JSON.stringify(geometry.crossingControls)}`);
        if (geometry.inkOverlaps.length) fail(`text over text: ${JSON.stringify(geometry.inkOverlaps.slice(0, 6))}`);
        if (geometry.inkOnControls.length) fail(`text over a control: ${JSON.stringify(geometry.inkOnControls.slice(0, 6))}`);
        if (geometry.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(geometry.smallControls)}`);
        const loose = inbox.cards.filter((card) => card.key !== "task:t-systemd" && card.state);
        if (!loose.some((card) => /resets/.test(card.state ?? ""))) fail("the walled row does not say when it resets");
        if (!loose.some((card) => /^stalled/i.test(card.state ?? ""))) fail("a stalled row lost its word");
        if (inbox.cards.some((card) => card.state && card.needs)) fail("a stalled or walled row is pinned as needing the operator");

        /* One tap on Dismiss: the card clears on the tap and says who cleared it. */
        await page.locator('[data-phone-kanban-tab="assigned"]').click();
        await pagerAtRest(page);
        await page.evaluate(() => document.querySelector('[data-phone-kanban-column="assigned"]')!.scrollTop = 0);
        await pause(page, 300);
        await page.locator('[data-phone-card-dismiss="task:t-prompt"]').click();
        await pause(page, 900);
        await shot(page, "dismissed");
        const dismissedReading = await needsReading(page, "assigned");
        readings.dismissed = dismissedReading;
        readings.dismissals = await page.evaluate(() => (window as unknown as { evidence: { dismissals: unknown[] } }).evidence.dismissals);
        const prompt = dismissedReading.cards.find((card) => card.key === "task:t-prompt");
        if (!prompt || prompt.needs || !/^Cleared · you · /.test(prompt.cleared ?? "")) fail(`the dismissed card reads ${JSON.stringify(prompt)}`);
      }

      /* The operator reads a conversation; the orchestrator asks for them. */
      await page.locator('[data-phone-kanban-tab="inbox"]').click();
      await pagerAtRest(page);
      await page.locator(`[data-phone-card-agent="${NEEDS_READER}"]`).first().scrollIntoViewIfNeeded();
      await page.locator(`[data-phone-card-agent="${NEEDS_READER}"]`).first().click();
      await page.waitForSelector('[data-mobile2-screen="chat"]', { timeout: 10_000 });
      await pause(page, 1_200);
      await page.evaluate(() => {
        const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]");
        if (feed) feed.scrollTop = Math.max(0, feed.scrollHeight - feed.clientHeight - 360);
      });
      await pause(page, 500);
      const before = await whereAmI(page);
      await shot(page, "chat-before-notice");
      await page.evaluate(() => {
        (window as unknown as { evidence: { noticeOn: boolean } }).evidence.noticeOn = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await pause(page, 1_500);
      const arrived = await whereAmI(page);
      await shot(page, "chat-notice");
      readings.chat = { before, arrived };
      if (before.screen !== arrived.screen || before.conversation !== arrived.conversation || before.hash !== arrived.hash) fail(`the screen moved: ${JSON.stringify({ before, arrived })}`);
      if (before.feedScrollTop !== arrived.feedScrollTop) fail(`the feed moved from ${before.feedScrollTop} to ${arrived.feedScrollTop}`);
      if (arrived.banner > before.banner) fail("a banner was put above the conversation");
      if (after && arrived.dot !== 1) fail(`the badge's dot is ${arrived.dot}, wanted one`);

      /* The ⚠ sheet: the request as a row, above the queue. */
      const badge = page.locator("[data-mobile2-open='attention']");
      if (await badge.count()) {
        await badge.click();
        await pause(page, 700);
        await shot(page, "sheet-notice");
        readings.sheet = await page.evaluate(() => ({
          notices: [...document.querySelectorAll("[data-mobile2-notice-row]")].map((row) => row.textContent ?? ""),
          queue: [...document.querySelectorAll("[data-attention-row]")].map((row) => row.textContent ?? ""),
          dotAfterOpen: document.querySelectorAll("[data-mobile2-notice-dot]").length,
        }));
        const sheet = readings.sheet as { notices: string[]; dotAfterOpen: number };
        if (after && sheet.notices.length !== 1) fail(`the sheet lists ${sheet.notices.length} notices`);
        if (after && sheet.dotAfterOpen !== 0) fail("the dot stays lit after the sheet showed the notice");
      } else if (after) {
        fail("no ⚠ badge to open");
      }
      if (pageErrors.length) fail(`page errors: ${pageErrors.join(" | ")}`);
      await page.close();
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
    stop();
  }
  readings.failures = failures;
  fs.writeFileSync(path.join(NEEDS_OUT, `readings-${NEEDS_PHASE}.json`), `${JSON.stringify(readings, null, 2)}\n`);
  if (after) {
    fs.mkdirSync(NEEDS_EVIDENCE, { recursive: true });
    fs.writeFileSync(path.join(NEEDS_EVIDENCE, "phone.json"), `${JSON.stringify(readings, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }
}, 300_000);

/*
 * #2105 — Back and screen history on the phone follow the path the operator
 * took. The kanban fixture (`?kanban=1`) at 390 × 844, dark, touch. Every
 * phone screen and every sheet over one is one history entry; the browser's
 * Back (which is what iOS's edge swipe sends) and the bar's ‹ each pop exactly
 * one, and the screen they land on is the one the operator came from, with
 * its scroll and its column. Walks:
 *
 *   report    board → the orchestrator → Back → a task → its agent → Back ends
 *             on the task (the operator's report: it ended on the orchestrator)
 *   path      board → task → pipeline → conversation → Back ×3, each screen in
 *             turn, the task's scroll and the board's column and offset kept
 *   sheets    the same path with a sheet opened at each step and closed by
 *             Back, which stays on the screen; a sheet closed by its × leaves
 *             no entry behind
 *   deeplink  a link that lands through the hash, an in-app link and a
 *             tapped notification's hand-off, each from the task screen:
 *             Back returns to the task
 *   predecessor  a ⋯ row that opens the round before this conversation
 *             takes the menu's entry; one Back returns under it, no menu
 *   reload    a reload on the task, the pipeline and the conversation keeps
 *             the screen, and Back still goes where it went before
 *   reload-sheets  a reload with a card, lane or stage sheet open drops the
 *             sheet and its entry, so one Back leaves the screen; the ⋯ menu,
 *             which needs no choice, comes back and Back closes it
 *   overview-reload  the same reloads over the phone's Overview, where each
 *             screen is drawn by its own project: the screen waits for its
 *             data, and the history does not grow
 *   link-project, link-overview  a link in a conversation to another
 *             project's task, then to its lane: one entry each, and one Back
 *             returns to the conversation
 *
 * Frames go to `LLV_PHONE_BACK_FRAMES` (default `.artifacts/phone-back`, not
 * committed), prefixed by `LLV_PHONE_BACK_PREFIX` so a run on the code before
 * the change can be kept beside a run after it; readings go to
 * `evidence/issue-2105/history.json`.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2105"
 */
const PHONE_BACK_OUT = path.resolve(process.env.LLV_PHONE_BACK_FRAMES || ".artifacts/phone-back");
const PHONE_BACK_PREFIX = process.env.LLV_PHONE_BACK_PREFIX || "after";
const PHONE_BACK_EVIDENCE = path.resolve("evidence/issue-2105");

interface PhonePlace { screen: string | null; id: string | null; sheet: string | null; column: string | null; hash: string; historyLength: number }
interface PhoneExpect { screen: string; id?: string; sheet?: string | null }

const readPhonePlace = (page: Page) => page.evaluate((): PhonePlace => {
  const shells = [...document.querySelectorAll<HTMLElement>("[data-mobile2-screen]")];
  const top = shells[shells.length - 1] ?? null;
  return {
    screen: top?.getAttribute("data-mobile2-screen") ?? null,
    id: top?.getAttribute("data-mobile2-conversation") ?? top?.getAttribute("data-mobile2-task") ?? top?.getAttribute("data-mobile2-pipeline") ?? null,
    sheet: document.querySelector("[data-mobile2-sheet]")?.getAttribute("data-mobile2-sheet") ?? null,
    column: document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active") ?? null,
    hash: location.hash,
    historyLength: history.length,
  };
});

/** The id a conversation screen names itself by: the fixture's conversation id. */
const conversationOf = (transcript: string | null) => (transcript ? `conversation_${transcript.split("/").pop()!.replace(".jsonl", "")}` : undefined);

const placeMatches = (place: PhonePlace, want: PhoneExpect) =>
  place.screen === want.screen && (want.id === undefined || place.id === want.id) && (want.sheet === undefined || place.sheet === want.sheet);

browserTest("#2105: Back and the phone's screen history follow the path the operator took", async () => {
  fs.mkdirSync(PHONE_BACK_OUT, { recursive: true });
  fs.mkdirSync(PHONE_BACK_EVIDENCE, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const failures: string[] = [];
  const results: unknown[] = [];
  const viewport = { width: 390, height: 844 };
  const walk = async (name: string, run: (ctx: {
    page: Page;
    step: (label: string, act: () => Promise<unknown>, want: PhoneExpect) => Promise<PhonePlace>;
    back: (label: string, want: PhoneExpect, how?: "browser" | "chevron") => Promise<PhonePlace>;
    fail: (text: string) => void;
  }) => Promise<void>) => {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const steps: unknown[] = [];
    let n = 0;
    const fail = (text: string) => failures.push(`${name}: ${text}`);
    /* One step: act, wait for the screen it should land on, then wait again
       and read once more, so a screen that something pushes a moment later —
       the orchestrator the report names — is caught rather than missed. */
    const step = async (label: string, act: () => Promise<unknown>, want: PhoneExpect) => {
      n += 1;
      await act();
      await page.waitForFunction(({ screen, id, sheet }) => {
        const shells = [...document.querySelectorAll<HTMLElement>("[data-mobile2-screen]")];
        const top = shells[shells.length - 1] ?? null;
        const openSheet = document.querySelector("[data-mobile2-sheet]")?.getAttribute("data-mobile2-sheet") ?? null;
        const topId = top?.getAttribute("data-mobile2-conversation") ?? top?.getAttribute("data-mobile2-task") ?? top?.getAttribute("data-mobile2-pipeline") ?? null;
        return top?.getAttribute("data-mobile2-screen") === screen && (id === undefined || topId === id) && (sheet === undefined || openSheet === sheet);
      }, want, { timeout: 8_000 }).catch(() => undefined);
      await pause(page, 1_200);
      const place = await readPhonePlace(page);
      await page.screenshot({ path: path.join(PHONE_BACK_OUT, `${PHONE_BACK_PREFIX}-${name}-${String(n).padStart(2, "0")}-${label}.png`) });
      steps.push({ n, label, want, place });
      if (!placeMatches(place, want)) fail(`step ${n} (${label}) wanted ${JSON.stringify(want)}, landed on ${JSON.stringify(place)}`);
      return place;
    };
    const back = (label: string, want: PhoneExpect, how: "browser" | "chevron" = "browser") =>
      step(label, () => (how === "chevron" ? page.locator("[data-mobile2-back]").first().click() : page.goBack({ waitUntil: "commit" }).catch(() => null)), want);
    try {
      await run({ page, step, back, fail });
      if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
    } catch (error) {
      fail(`threw ${(error as Error).message.split("\n")[0]}`);
    } finally {
      results.push({ walk: name, steps });
      await context.close();
    }
  };
  const board = `${fixtureBase}/?kanban=1#p=atlas`;
  const boardShown = (page: Page) => page.waitForSelector('[data-phone-card="task:t-many"]', { timeout: 20_000 });
  try {
    await walk("report", async ({ page, step, back }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      const seat = await step("orchestrator", () => page.locator("[data-mobile2-seat-open]").click(), { screen: "chat", sheet: null });
      await back("back-to-board", { screen: "board", sheet: null });
      await step("task", () => page.locator('[data-phone-card="task:t-long"]').click(), { screen: "task", id: "t-long", sheet: null });
      const agent = conversationOf(await page.locator("[data-phone-task-agent]").first().getAttribute("data-phone-task-agent"));
      await step("agent", () => page.locator("[data-phone-task-agent] button").first().click(), { screen: "chat", id: agent, sheet: null });
      const landed = await back("back-to-task", { screen: "task", id: "t-long", sheet: null });
      if (landed.screen === "chat" && landed.id === seat.id) failures.push("report: Back from the agent opened the orchestrator conversation");
      await back("back-to-board-again", { screen: "board", sheet: null });
    });

    await walk("path", async ({ page, step, back, fail }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      /* Bring the task's card into view in its column, so the column has an offset to keep. */
      const offset = await page.evaluate(() => {
        const card = document.querySelector<HTMLElement>('[data-phone-card="task:t-many"]')!;
        card.scrollIntoView({ block: "center" });
        const column = card.closest<HTMLElement>("[data-phone-kanban-column]")!;
        return { column: column.getAttribute("data-phone-kanban-column"), top: column.scrollTop };
      });
      await pause(page, 400);
      await step("task", () => page.locator('[data-phone-card="task:t-many"]').click(), { screen: "task", id: "t-many", sheet: null });
      await page.locator("[data-phone-task-ended]").click().catch(() => undefined);
      await pause(page, 300);
      /* Where the task screen was when it was left: the driver's click scrolls
         its target into view first, so the page keeps the last offset itself. */
      await page.evaluate(() => {
        const body = document.querySelector<HTMLElement>("[data-phone-task-body]")!;
        /* A detached scroller reports a last scroll to 0 on its way out. */
        const record = () => { if (body.isConnected) (window as unknown as { taskScroll: number }).taskScroll = body.scrollTop; };
        body.addEventListener("scroll", record, { passive: true });
        body.scrollTop = Math.round(body.scrollHeight / 3);
        record();
      });
      await pause(page, 400);
      await step("pipeline", () => page.locator('[data-phone-task-lane="lane-many-review"] [data-open-stages]').click(), { screen: "pipeline", id: "lane-many-review", sheet: null });
      const taskScroll = await page.evaluate(() => (window as unknown as { taskScroll: number }).taskScroll);
      if (taskScroll < 40) fail(`the task screen was left at scroll ${taskScroll}, too close to the top to show a restore`);
      await step("conversation", () => page.locator('[data-mobile2-pipeline="lane-many-review"] [data-stage-open="build"]').first().click(), { screen: "chat", sheet: null });
      await back("back-to-pipeline", { screen: "pipeline", id: "lane-many-review", sheet: null });
      await back("back-to-task", { screen: "task", id: "t-many", sheet: null }, "chevron");
      const restored = await page.evaluate(() => document.querySelector<HTMLElement>("[data-phone-task-body]")?.scrollTop ?? -1);
      if (Math.abs(restored - taskScroll) > 2) fail(`the task screen came back at scroll ${restored}, left at ${taskScroll}`);
      await back("back-to-board", { screen: "board", sheet: null });
      const column = await page.evaluate((status) => {
        const board = document.querySelector<HTMLElement>("[data-phone-kanban]")!;
        return { active: board.getAttribute("data-phone-kanban-active"), top: board.querySelector<HTMLElement>(`[data-phone-kanban-column="${status}"]`)?.scrollTop ?? -1 };
      }, offset.column);
      if (column.active !== offset.column || Math.abs(column.top - offset.top) > 2) fail(`the board came back on ${JSON.stringify(column)}, left on ${JSON.stringify(offset)}`);
    });

    await walk("sheets", async ({ page, step, back, fail }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      const boardHash = await page.evaluate(() => location.hash);
      await step("board-menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "board", sheet: "menu" });
      await back("board-menu-back", { screen: "board", sheet: null });
      await step("card-sheet", () => page.locator('[data-phone-card="task:t-many"]').click({ button: "right" }), { screen: "board", sheet: "card" });
      await back("card-sheet-back", { screen: "board", sheet: null });
      await step("tasks-menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "board", sheet: "menu" });
      await step("tasks-sheet", () => page.locator('[data-mobile2-menu-row="tasks"]').click(), { screen: "board", sheet: "tasks" });
      await back("tasks-sheet-back", { screen: "board", sheet: null });
      /* Closed by its own ×, a sheet takes its entry with it: the next Back leaves the screen. */
      await step("menu-closed-by-x", async () => {
        await page.locator('[data-mobile2-open="menu"]').first().click();
        await page.waitForSelector('[data-mobile2-sheet="menu"]');
        await page.locator("[data-mobile2-close]").click();
      }, { screen: "board", sheet: null });
      if ((await page.evaluate(() => location.hash)) !== boardHash) fail("a sheet on the board moved the URL");
      await step("task", () => page.locator('[data-phone-card="task:t-many"]').click(), { screen: "task", id: "t-many", sheet: null });
      await step("status-sheet", () => page.locator("[data-phone-task-status-pill]").first().click(), { screen: "task", id: "t-many", sheet: "status" });
      await back("status-sheet-back", { screen: "task", id: "t-many", sheet: null });
      await step("task-menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "task", id: "t-many", sheet: "menu" });
      await back("task-menu-back", { screen: "task", id: "t-many", sheet: null });
      await step("pipeline", () => page.locator('[data-phone-task-lane="lane-many-review"] [data-open-stages]').click(), { screen: "pipeline", id: "lane-many-review", sheet: null });
      await step("pipeline-menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "pipeline", id: "lane-many-review", sheet: "menu" });
      await back("pipeline-menu-back", { screen: "pipeline", id: "lane-many-review", sheet: null });
      const chat = await step("conversation", () => page.locator('[data-mobile2-pipeline="lane-many-review"] [data-stage-open="build"]').first().click(), { screen: "chat", sheet: null });
      await step("conversation-menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "chat", id: chat.id ?? undefined, sheet: "menu" });
      await back("conversation-menu-back", { screen: "chat", id: chat.id ?? undefined, sheet: null });
      await back("back-to-pipeline", { screen: "pipeline", id: "lane-many-review", sheet: null });
      await back("back-to-task", { screen: "task", id: "t-many", sheet: null });
      await back("back-to-board", { screen: "board", sheet: null });
    });

    await walk("deeplink", async ({ page, step, back }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      await step("task", () => page.locator('[data-phone-card="task:t-long"]').click(), { screen: "task", id: "t-long", sheet: null });
      const id = conversationOf(await page.locator("[data-phone-task-agent]").first().getAttribute("data-phone-task-agent"))!;
      /* A notification or a link the Viewer does not intercept lands through the hash. */
      await step("hash-link", () => page.evaluate((conversation) => { location.hash = "#c=" + encodeURIComponent(conversation); }, id), { screen: "chat", id, sheet: null });
      await back("hash-link-back", { screen: "task", id: "t-long", sheet: null });
      /* A link in a message: the Viewer opens a target it knows in place. */
      await step("message-link", () => page.evaluate((conversation) => {
        const anchor = document.createElement("a");
        anchor.href = "#c=" + encodeURIComponent(conversation);
        anchor.textContent = "Open conversation";
        anchor.setAttribute("data-evidence-link", "");
        document.querySelector("[data-phone-task-body]")!.prepend(anchor);
        anchor.click();
      }, id), { screen: "chat", id, sheet: null });
      await back("message-link-back", { screen: "task", id: "t-long", sheet: null });
      /* A tapped notification: the service worker hands its link to the tab
         (the message `public/question-push-sw.js` sends), and the tab opens it
         as one entry and answers, so the worker does not navigate it too. */
      let taken = false;
      await step("notification", async () => {
        taken = await page.evaluate((conversation) => new Promise<boolean>((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => resolve(true);
          setTimeout(() => resolve(false), 2_000);
          navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
            data: { type: "delegatus:open-url", url: "/#c=" + encodeURIComponent(conversation) + "#question" },
            ports: [channel.port2],
          }));
        }), id);
      }, { screen: "chat", id, sheet: null });
      if (!taken) failures.push("deeplink: the tab did not answer the notification's hand-off");
      await back("notification-back", { screen: "task", id: "t-long", sheet: null });
      /* A link whose conversation never opens leaves the task on screen over
         an entry the store did not write; ‹ still lands on the board, and the
         history agrees: Forward comes back to the task. */
      await step("dead-link", () => page.evaluate(() => { location.hash = "#c=conversation_never_opened"; }), { screen: "task", id: "t-long", sheet: null });
      await back("dead-link-chevron", { screen: "board", sheet: null }, "chevron");
      await step("forward-to-task", () => page.goForward({ waitUntil: "commit" }).catch(() => null), { screen: "task", id: "t-long", sheet: null });
      await back("back-to-board", { screen: "board", sheet: null });
    });

    /* A ⋯ row that opens another conversation (the round before this one)
       takes the menu's entry: one Back returns to the conversation the menu
       was opened over, with no menu. */
    await walk("predecessor", async ({ page, step, back, fail }) => {
      await step("board", async () => {
        await page.goto(`${fixtureBase}/?kanban=1&rounds=1#p=atlas`);
        await boardShown(page);
        await page.locator('[data-phone-kanban-tab="inbox"]').click();
        await page.waitForSelector('[data-phone-card="task:t-systemd"]', { timeout: 10_000 });
      }, { screen: "board", sheet: null });
      await step("task", () => page.locator('[data-phone-card="task:t-systemd"]').click(), { screen: "task", id: "t-systemd", sheet: null });
      const agent = conversationOf(await page.locator("[data-phone-task-agent]").first().getAttribute("data-phone-task-agent"));
      await step("conversation", () => page.locator("[data-phone-task-agent] button").first().click(), { screen: "chat", id: agent, sheet: null });
      await step("menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "chat", id: agent, sheet: "menu" });
      const length = await page.evaluate(() => history.length);
      await page.locator('[data-mobile2-menu-section="manage"]').click();
      const round = await page.locator('[data-mobile2-menu-row="predecessor"]').getAttribute("data-continues-conversation");
      await step("round-before", () => page.locator('[data-mobile2-menu-row="predecessor"]').click(), { screen: "chat", id: round ?? undefined, sheet: null });
      const after = await page.evaluate(() => history.length);
      if (after !== length) fail(`opening the round from the menu left the history at ${after} entries, ${length} with the menu open`);
      await back("round-back", { screen: "chat", id: agent, sheet: null });
      await back("back-to-task", { screen: "task", id: "t-systemd", sheet: null });
    });

    await walk("reload", async ({ page, step, back }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      await step("task", () => page.locator('[data-phone-card="task:t-many"]').click(), { screen: "task", id: "t-many", sheet: null });
      await step("task-reload", () => page.reload(), { screen: "task", id: "t-many", sheet: null });
      await step("pipeline", () => page.locator('[data-phone-task-lane="lane-many-review"] [data-open-stages]').click(), { screen: "pipeline", id: "lane-many-review", sheet: null });
      await step("pipeline-reload", () => page.reload(), { screen: "pipeline", id: "lane-many-review", sheet: null });
      const chat = await step("conversation", () => page.locator('[data-mobile2-pipeline="lane-many-review"] [data-stage-open="build"]').first().click(), { screen: "chat", sheet: null });
      await step("conversation-reload", () => page.reload(), { screen: "chat", id: chat.id ?? undefined, sheet: null });
      await back("back-to-pipeline", { screen: "pipeline", id: "lane-many-review", sheet: null });
      await back("back-to-task", { screen: "task", id: "t-many", sheet: null });
      await back("back-to-board", { screen: "board", sheet: null });
    });

    /* A reload with a sheet open. A sheet that shows what its screen chose to
       open it on (a card's actions, a lane's menu, a stage's settings) cannot
       come back without that choice: it closes and takes its entry, so the
       next Back leaves the screen. A sheet that needs no choice (⋯) comes
       back, and Back closes it. */
    const sheetEntry = (page: Page) => page.evaluate(() => (history.state as { mobile2?: { sheet?: string | null } } | null)?.mobile2?.sheet ?? null);
    await walk("reload-sheets", async ({ page, step, back, fail }) => {
      await step("board", async () => { await page.goto(board); await boardShown(page); }, { screen: "board", sheet: null });
      await step("card-sheet", () => page.locator('[data-phone-card="task:t-many"]').click({ button: "right" }), { screen: "board", sheet: "card" });
      await step("card-sheet-reload", () => page.reload(), { screen: "board", sheet: null });
      if ((await sheetEntry(page)) !== null) fail(`after a reload the card sheet's entry is still the tab's: ${await sheetEntry(page)}`);
      await step("task", () => page.locator('[data-phone-card="task:t-many"]').click(), { screen: "task", id: "t-many", sheet: null });
      await step("lane-sheet", () => page.locator('[data-phone-task-lane="lane-many-pill"] [data-pipeline-menu]').click(), { screen: "task", id: "t-many", sheet: "lane" });
      await step("lane-sheet-reload", () => page.reload(), { screen: "task", id: "t-many", sheet: null });
      if ((await sheetEntry(page)) !== null) fail(`after a reload the lane sheet's entry is still the tab's: ${await sheetEntry(page)}`);
      await step("pipeline", () => page.locator('[data-phone-task-lane="lane-many-pill"] [data-open-stages]').click(), { screen: "pipeline", id: "lane-many-pill", sheet: null });
      await step("stage-sheet", () => page.locator("[data-stage-configure]").first().click(), { screen: "pipeline", id: "lane-many-pill", sheet: "stage" });
      await step("stage-sheet-reload", () => page.reload(), { screen: "pipeline", id: "lane-many-pill", sheet: null });
      if ((await sheetEntry(page)) !== null) fail(`after a reload the stage sheet's entry is still the tab's: ${await sheetEntry(page)}`);
      await back("pipeline-back", { screen: "task", id: "t-many", sheet: null });
      await step("menu", () => page.locator('[data-mobile2-open="menu"]').first().click(), { screen: "task", id: "t-many", sheet: "menu" });
      await step("menu-reload", () => page.reload(), { screen: "task", id: "t-many", sheet: "menu" });
      await back("menu-back", { screen: "task", id: "t-many", sheet: null });
      await back("task-back", { screen: "board", sheet: null });
    });

    /* Over the Overview a screen is drawn by its own project's dashboard, and
       a reload brings the stack back before any answer names that project:
       the screen waits for its data rather than going home, and nothing is
       pushed again. */
    const overview = `${fixtureBase}/?overview=1`;
    const overviewShown = async (page: Page) => {
      await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
      await page.locator('[data-phone-kanban-tab="assigned"]').click();
      await page.waitForSelector('[data-phone-card="task:t-favicon"]', { timeout: 10_000 });
    };
    const entries = (page: Page) => page.evaluate(() => history.length);
    await walk("overview-reload", async ({ page, step, back, fail }) => {
      await step("overview", async () => { await page.goto(overview); await overviewShown(page); }, { screen: "board", sheet: null });
      await step("task", () => page.locator('[data-phone-card="task:t-favicon"]').click(), { screen: "task", id: "t-favicon", sheet: null });
      let length = await entries(page);
      await step("task-reload", () => page.reload(), { screen: "task", id: "t-favicon", sheet: null });
      if ((await entries(page)) !== length) fail(`a reload on the task grew the history from ${length} to ${await entries(page)}`);
      await step("pipeline", () => page.locator('[data-phone-task-lane="lane-favicon"] [data-open-stages]').click(), { screen: "pipeline", id: "lane-favicon", sheet: null });
      length = await entries(page);
      await step("pipeline-reload", () => page.reload(), { screen: "pipeline", id: "lane-favicon", sheet: null });
      if ((await entries(page)) !== length) fail(`a reload on the pipeline grew the history from ${length} to ${await entries(page)}`);
      const chat = await step("conversation", () => page.locator('[data-mobile2-pipeline="lane-favicon"] [data-stage-open="implement"]').first().click(), { screen: "chat", sheet: null });
      length = await entries(page);
      await step("conversation-reload", () => page.reload(), { screen: "chat", id: chat.id ?? undefined, sheet: null });
      if ((await entries(page)) !== length) fail(`a reload on the conversation grew the history from ${length} to ${await entries(page)}`);
      await back("back-to-pipeline", { screen: "pipeline", id: "lane-favicon", sheet: null });
      await back("back-to-task", { screen: "task", id: "t-favicon", sheet: null });
      await back("back-to-overview", { screen: "board", sheet: null });
    });

    /* A link in a message to another project's task or lane (the MCP call
       card's chip) writes one entry, over the conversation it was read in, and
       one Back returns there — on a project's board and over the Overview. */
    const delegatus = `repo-${"a1b2".repeat(4)}`;
    const link = (page: Page, kind: "task" | "pipeline", id: string) =>
      page.evaluate(({ kind, id }) => { window.dispatchEvent(new CustomEvent("llv:mcp-navigate", { detail: { kind, id } })); }, { kind, id });
    for (const [name, url] of [["link-project", `${fixtureBase}/?overview=1#p=${delegatus}`], ["link-overview", overview]] as const) {
      await walk(name, async ({ page, step, back, fail }) => {
        await step("board", async () => { await page.goto(url); await overviewShown(page); }, { screen: "board", sheet: null });
        await step("task", () => page.locator('[data-phone-card="task:t-favicon"]').click(), { screen: "task", id: "t-favicon", sheet: null });
        const chat = await step("conversation", () => page.locator('[data-phone-task-lane="lane-favicon"] button[data-stage="implement"]').first().click(), { screen: "chat", sheet: null });
        let length = await entries(page);
        await step("task-link", () => link(page, "task", "t-many"), { screen: "task", id: "t-many", sheet: null });
        if ((await entries(page)) !== length + 1) fail(`a task link wrote ${(await entries(page)) - length} entries`);
        await back("task-link-back", { screen: "chat", id: chat.id ?? undefined, sheet: null });
        length = await entries(page);
        await step("pipeline-link", () => link(page, "pipeline", "lane-many-review"), { screen: "pipeline", id: "lane-many-review", sheet: null });
        if ((await entries(page)) !== length) fail(`a pipeline link after Back grew the history from ${length} to ${await entries(page)}`);
        await back("pipeline-link-back", { screen: "chat", id: chat.id ?? undefined, sheet: null });
        await back("back-to-task", { screen: "task", id: "t-favicon", sheet: null });
      });
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(PHONE_BACK_EVIDENCE, `history-${PHONE_BACK_PREFIX}.json`), `${JSON.stringify({ viewport, results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * #2190: the phone's task cards draw the task's icon before the title, tinted
 * with the task's colour, in the neutral tone when the task has none, and not
 * at all when the task has no icon; the title wraps under itself. The
 * `?icons=1` scene dresses the kanban scene's tasks every one of those ways;
 * Inbox, Assigned and Done at 390, dark and light:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable LLV_ICON_PHASE=after \
 *     LLV_ICON_FRAMES=<dir> bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2190"
 *
 * `LLV_ICON_PHASE=before` records frames and readings without the gates, for
 * the tree before the change. Readings go to `evidence/task-icons/phone-<phase>.json`.
 */
const ICON_PHASE = process.env.LLV_ICON_PHASE === "before" ? "before" : "after";
const ICON_OUT = path.resolve(process.env.LLV_ICON_FRAMES || ".artifacts/phone-card-icons");
/** The scene's colours (`issue1671Evidence.fixture.tsx`, `ICONS_SCENE`), as the board draws them. */
const ICON_TINTS: Record<string, string> = {
  "t-systemd": "rgb(224, 122, 95)", "t-attention": "rgb(138, 99, 210)", "t-tray": "rgb(217, 164, 0)", "t-data": "rgb(61, 127, 214)",
  "t-copilot": "rgb(138, 99, 210)", "t-upload": "rgb(124, 179, 66)", "t-long": "rgb(214, 79, 138)", "t-uk": "rgb(26, 158, 143)",
  "t-done-0": "rgb(123, 138, 153)", "t-done-1": "rgb(224, 122, 95)",
};
/** The scene's tasks with a chosen icon; the rest draw what their title suggests, or nothing. */
const ICON_STORED = new Set(["t-systemd", "t-quota", "t-data", "t-favicon", "t-upload", "t-done-1", "t-done-3"]);

browserTest("#2190: phone task cards carry the task's icon in the card's colour", async () => {
  fs.mkdirSync(ICON_OUT, { recursive: true });
  fs.mkdirSync("evidence/task-icons", { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const frames: unknown[] = [];
  const failures: string[] = [];
  try {
    for (const scheme of ["dark", "light"] as const) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
      await context.addInitScript(() => { localStorage.setItem("llv_lang", "en"); });
      try {
        const page = await context.newPage();
        await page.goto(`${fixtureBase}/?icons=1#p=atlas`);
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
        await pause(page, 800);
        for (const status of ["inbox", "assigned", "done"] as const) {
          await page.locator(`[data-phone-kanban-tab="${status}"]`).click();
          await page.waitForFunction((wanted) => document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active") === wanted, status);
          await pagerAtRest(page);
          /* The icons load after the card draws (`taskIconLoader`). */
          await pause(page, 600);
          const key = `390-${scheme}-${status}`;
          await page.screenshot({ path: path.join(ICON_OUT, `${ICON_PHASE}-${key}.png`) });
          const cards = await page.evaluate((wanted) => {
            const column = document.querySelector(`[data-phone-kanban-column="${wanted}"]`)!;
            return [...column.querySelectorAll<HTMLElement>('[data-phone-card-kind="task"]')].map((card) => {
              const title = card.querySelector<HTMLElement>("[data-phone-card-title]")!;
              const icon = card.querySelector<HTMLElement>("[data-task-icon]");
              const range = document.createRange();
              range.selectNodeContents(title);
              const lines = [...range.getClientRects()].filter((rect) => rect.width > 0.5);
              const lineLefts = [...new Set(lines.map((rect) => Math.round(rect.left * 2) / 2))];
              const cardBox = card.getBoundingClientRect();
              const iconBox = icon?.getBoundingClientRect() ?? null;
              const firstLine = lines[0] ?? null;
              return {
                task: (card.getAttribute("data-phone-card") ?? "").replace(/^task:/, ""),
                titleText: title.textContent ?? "",
                edge: card.getAttribute("data-edge") ?? card.closest("[data-phone-card-frame]")?.querySelector("[data-edge]")?.getAttribute("data-edge") ?? null,
                icon: icon?.getAttribute("data-task-icon") ?? null,
                /* The glyph itself, not only the box it will fill. */
                glyph: Boolean(icon?.querySelector("svg")),
                iconSource: icon?.getAttribute("data-icon-source") ?? null,
                iconColour: icon ? getComputedStyle(icon).color : null,
                iconBox: iconBox ? { x: iconBox.x, y: iconBox.y, width: iconBox.width, height: iconBox.height } : null,
                /* The icon's middle against the first title line's middle. */
                iconOffFirstLine: iconBox && firstLine ? (iconBox.top + iconBox.height / 2) - (firstLine.top + firstLine.height / 2) : null,
                titleInset: title.getBoundingClientRect().left - (cardBox.left + parseFloat(getComputedStyle(card).paddingLeft)),
                titleLeftOfIcon: iconBox ? title.getBoundingClientRect().left - iconBox.right : null,
                lineLefts,
                titleLines: lines.length,
              };
            });
          }, status);
          frames.push({ key, phase: ICON_PHASE, cards });
          if (ICON_PHASE === "before") continue;
          for (const card of cards) {
            const fail = (text: string) => failures.push(`${key} ${card.task}: ${text}`);
            if (!ICON_STORED.has(card.task) && suggestTaskIcon(card.titleText) === null) {
              if (card.icon) fail(`a task with no icon draws ${card.icon}`);
              if (Math.abs(card.titleInset) > 0.5) fail(`the title of an icon-less card starts ${card.titleInset} px off the card's content edge`);
              continue;
            }
            if (!card.icon || !card.glyph) { fail(`no icon drawn before the title (${card.icon ?? "no box"})`); continue; }
            const tint = ICON_TINTS[card.task];
            if (tint && card.iconColour !== tint) fail(`icon drawn ${card.iconColour}, its colour is ${tint}`);
            if (!tint && Object.values(ICON_TINTS).includes(card.iconColour ?? "")) fail(`an uncoloured task's icon is tinted ${card.iconColour}`);
            if (card.lineLefts.length !== 1) fail(`the title's lines start at ${JSON.stringify(card.lineLefts)}, not under each other`);
            if ((card.titleLeftOfIcon ?? 0) < 4) fail(`the title starts ${card.titleLeftOfIcon} px after the icon`);
            if (Math.abs(card.iconOffFirstLine ?? 99) > 1.5) fail(`the icon sits ${card.iconOffFirstLine} px off the first title line`);
          }
        }
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join("evidence/task-icons", `phone-${ICON_PHASE}.json`), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #2187 — a lane parked on a review says why in one line and answers in
 * plain words (docs/design/merge-policy-and-task-finishing.md §3.4), on the
 * phone's task screen at 390 × 844, en and uk, dark and light: one task per
 * row of the table (`?review-stops=1`). Each lane draws the table's reason
 * line and its two answers in the table's words, 44 px tall, with no label cut
 * by its button, plus the task screen's own gates (no sideways overflow, no
 * text over text or a control, no small or crossing control).
 *
 *   REVIEW_STOPS_STAMP=after REVIEW_STOPS_PNG_DIR=… LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2187"
 *
 * `REVIEW_STOPS_STAMP=before` only records, which is how the merge base was
 * drawn; the desktop board's half of the issue is the kanban driver's case.
 */
const REVIEW_STOPS = [
  { task: "t-stop-fix", kind: "stop-after-fix", reason: "pipelineBlock.stop.afterFix", answers: [["accept-head", "pipelineBlock.answer.acceptAsIs"], ["continue-review", "pipelineBlock.answer.reviewAgain"]] },
  { task: "t-stop-park", kind: "park", reason: "pipelineBlock.stop.park", answers: [["skip-stage", "pipelineBlock.answer.acceptWithoutReview"], ["retry-stage", "pipelineBlock.answer.reviewAgain"]] },
  { task: "t-stop-once", kind: "once", reason: "pipelineBlock.stop.once", answers: [["skip-stage", "pipelineBlock.answer.acceptWithoutReview"], ["retry-stage", "pipelineBlock.answer.reviewAgain"]] },
  { task: "t-stop-legacy", kind: "legacy", reason: "pipelineBlock.stop.legacy", answers: [["skip-stage", "pipelineBlock.answer.acceptWithoutReview"], ["retry-stage", "pipelineBlock.answer.reviewAgain"]] },
] as const;

browserTest("#2187: each row of §3.4's table draws its reason and plain answers on the phone's task screen at 390, en and uk, uncut and apart", async () => {
  const stamp = process.env.REVIEW_STOPS_STAMP === "before" ? "before" : "after";
  const out = path.resolve(process.env.REVIEW_STOPS_PNG_DIR ?? ".artifacts/review-stops");
  const evidence = path.resolve("evidence/review-stops");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const viewport = { width: 390, height: 844 };
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const scheme of ["dark", "light"] as const) {
        for (const lane of REVIEW_STOPS) {
          const key = `${lane.kind}-390-${lang}-${scheme}`;
          const fail = (text: string) => failures.push(`${key}: ${text}`);
          const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
          await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
          try {
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => pageErrors.push(error.message));
            await page.goto(`${fixtureBase}/?kanban=1&review-stops=1#p=atlas`);
            await page.waitForSelector(`[data-phone-card="task:${lane.task}"]`, { timeout: 20_000 });
            await pause(page, 600);
            await page.locator(`[data-phone-card="task:${lane.task}"]`).click();
            await page.waitForSelector(`[data-mobile2-task="${lane.task}"] [data-phone-task-body="${lane.task}"]`, { timeout: 10_000 });
            await page.mouse.move(0, 0);
            await pause(page, 600);
            await page.screenshot({ path: path.join(out, `${stamp}-phone-${key}.png`) });
            const screen = await readTaskScreen(page);
            const drawn = await page.evaluate(() => {
              const answer = document.querySelector("[data-phone-task-body] .pb-answer");
              const reason = answer?.querySelector("[data-review-stop]") ?? answer?.querySelector(".stage-report, .review-heads") ?? null;
              const buttons = [...(answer?.querySelectorAll<HTMLElement>("[data-answer-action]") ?? [])];
              const cut = buttons.flatMap((button) => {
                const frame = button.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(button);
                const ink = [...range.getClientRects()].filter((rect) => rect.width * rect.height > 0.5);
                const outside = ink.some((rect) => rect.left < frame.left - 0.5 || rect.right > frame.right + 0.5 || rect.top < frame.top - 0.5 || rect.bottom > frame.bottom + 0.5);
                return button.scrollWidth > button.clientWidth + 1 || outside ? [(button.textContent ?? "").trim()] : [];
              });
              return {
                kind: reason?.getAttribute("data-review-stop") ?? null,
                reason: reason?.textContent?.trim() ?? null,
                answers: buttons.map((button) => [button.getAttribute("data-answer-action") ?? "", (button.textContent ?? "").trim()]),
                heights: buttons.map((button) => Math.round(button.getBoundingClientRect().height)),
                findings: [...(answer?.querySelectorAll(".stage-findings li .text") ?? [])].map((item) => (item.textContent ?? "").trim()),
                cut,
              };
            });
            results.push({ key, stamp, ...drawn, screen });
            const t = (name: string, params?: Record<string, string | number>) => translate(lang, name as never, params);
            if (drawn.kind !== lane.kind) fail(`drawn as ${drawn.kind}`);
            if (lane.kind === "once") {
              const [lead, trail] = t(lane.reason, { stage: "\u0000" }).split("\u0000");
              if (!drawn.reason?.startsWith(lead!) || !drawn.reason.endsWith(trail!)) fail(`reason ${JSON.stringify(drawn.reason)}`);
            } else if (drawn.reason !== t(lane.reason, lane.kind === "park" ? { count: 3 } : undefined)) fail(`reason ${JSON.stringify(drawn.reason)}`);
            const want = lane.answers.map(([action, name]) => [action, t(name)]);
            if (JSON.stringify(drawn.answers) !== JSON.stringify(want)) fail(`answers ${JSON.stringify(drawn.answers)}, expected ${JSON.stringify(want)}`);
            if (drawn.heights.some((height) => height < 44)) fail(`answers shorter than 44 px: ${drawn.heights.join(", ")}`);
            if (drawn.cut.length) fail(`labels cut by their button: ${drawn.cut.join(" | ")}`);
            if (lane.kind === "legacy" && drawn.findings.some((text) => /round limit reached/.test(text))) fail("the flow's own detail is still listed as a finding");
            if (screen.overflowX > 0.5 || screen.bodyOverflowX > 0.5) fail(`overflows sideways by ${Math.max(screen.overflowX, screen.bodyOverflowX)} px`);
            if (screen.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(screen.smallControls)}`);
            if (screen.crossingControls.length) fail(`controls crossing: ${JSON.stringify(screen.crossingControls)}`);
            if (screen.inkOverlaps.length) fail(`text over text: ${JSON.stringify(screen.inkOverlaps.slice(0, 6))}`);
            if (screen.inkOnControls.length) fail(`text over a control: ${JSON.stringify(screen.inkOnControls.slice(0, 6))}`);
            if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
            await page.close();
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(evidence, `phone-${stamp}.json`), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (stamp === "after" && failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * #2187 — a completed lane's automatic merge and the project's merge setting
 * (docs/design/merge-policy-and-task-finishing.md §4.6, §6) on the phone at
 * 390 × 844, en and uk, dark and light: one task per merge state
 * (`?merge-states=1`) on its task screen — the word after "done", the line
 * under the chain, a stopped merge's reason and its two 44 px answers — and
 * the ⋯ sheet's "Merge when the review passes" row, on and then off by its own
 * 44 px switch. The task screen's own gates hold too: no sideways overflow, no
 * text over text or a control, no small or crossing control.
 *
 *   MERGE_STATES_PNG_DIR=… LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2187: a completed lane"
 */
const MERGE_STATE_TASKS = [
  { task: "t-merge-wait", word: "waiting", note: "waiting" },
  { task: "t-merge-update", word: "updating", note: "waiting" },
  { task: "t-merge-stop", word: "stopped", note: null },
  { task: "t-merge-done", word: "merged", note: "merged" },
] as const;

browserTest("#2187: a completed lane says where its merge stands on the phone at 390, en and uk, and the ⋯ sheet carries the setting row", async () => {
  const out = path.resolve(process.env.MERGE_STATES_PNG_DIR ?? ".artifacts/merge-states");
  const evidence = path.resolve("evidence/merge-states");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const viewport = { width: 390, height: 844 };
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const scheme of ["dark", "light"] as const) {
        const t = (name: string, params?: Record<string, string | number>) => translate(lang, name as never, params);
        for (const lane of MERGE_STATE_TASKS) {
          const key = `${lane.word}-390-${lang}-${scheme}`;
          const fail = (text: string) => failures.push(`${key}: ${text}`);
          const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
          await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
          try {
            const page = await context.newPage();
            const pageErrors: string[] = [];
            page.on("pageerror", (error) => pageErrors.push(error.message));
            await page.goto(`${fixtureBase}/?kanban=1&merge-states=1#p=atlas`);
            await page.waitForSelector(`[data-phone-card="task:${lane.task}"]`, { timeout: 20_000 });
            await pause(page, 600);
            await page.locator(`[data-phone-card="task:${lane.task}"]`).click();
            await page.waitForSelector(`[data-mobile2-task="${lane.task}"] [data-phone-task-body="${lane.task}"]`, { timeout: 10_000 });
            /* A merged lane is finished and folds with the others; a merge
               still moving or stopped stays out of the fold. */
            const folded = await page.locator("[data-phone-task-ended]").count();
            if (lane.word === "merged") {
              if (!folded) fail("the merged lane is not folded with the finished ones");
              else await page.locator("[data-phone-task-ended]").click();
            } else if (folded) fail("an unsettled merge is folded away");
            await page.mouse.move(0, 0);
            await pause(page, 600);
            await page.screenshot({ path: path.join(out, `phone-${key}.png`) });
            const screen = await readTaskScreen(page);
            const drawn = await page.evaluate(() => {
              const body = document.querySelector("[data-phone-task-body]");
              const words = [...(body?.querySelectorAll(".pb-merge") ?? [])];
              const note = body?.querySelector("[data-merge-note]") ?? null;
              const answer = body?.querySelector(".pb-answer[data-answer=\"merge\"]") ?? null;
              const buttons = [...(answer?.querySelectorAll<HTMLElement>("[data-answer-action]") ?? [])];
              const cut = buttons.flatMap((button) => (button.scrollWidth > button.clientWidth + 1 ? [(button.textContent ?? "").trim()] : []));
              return {
                words: words.map((word) => [word.getAttribute("data-merge-state"), (word.textContent ?? "").trim()]),
                note: note?.getAttribute("data-merge-note") ?? null,
                noteText: note?.textContent?.trim() ?? null,
                reason: answer?.querySelector("[data-merge-stop]")?.textContent?.trim() ?? null,
                answers: buttons.map((button) => [button.getAttribute("data-answer-action") ?? "", (button.textContent ?? "").trim()]),
                heights: buttons.map((button) => Math.round(button.getBoundingClientRect().height)),
                cut,
              };
            });
            results.push({ key, ...drawn, screen });
            if (!drawn.words.length || drawn.words.some(([state]) => state !== lane.word)) fail(`merge word ${JSON.stringify(drawn.words)}`);
            const text = drawn.words[0]?.[1] ?? "";
            if (lane.word === "waiting") {
              const [lead] = t("pipelineBlock.merge.waiting", { age: "\u0000" }).split("\u0000");
              if (!text.startsWith(lead!) || text === lead) fail(`word ${JSON.stringify(text)}`);
            } else if (text !== t(`pipelineBlock.merge.${lane.word}`)) fail(`word ${JSON.stringify(text)}`);
            if (drawn.note !== lane.note) fail(`note ${drawn.note}`);
            if (lane.note === "waiting" && drawn.noteText !== t("pipelineBlock.merge.waitingHint")) fail(`note ${JSON.stringify(drawn.noteText)}`);
            if (lane.note === "merged" && drawn.noteText !== t("pipelineBlock.merge.byDelegatus")) fail(`note ${JSON.stringify(drawn.noteText)}`);
            if (lane.word === "stopped") {
              const want = t("pipelineBlock.merge.reason", { reason: t("pipelineBlock.mergeReason.check", { name: "privacy-publication" }) });
              if (drawn.reason !== want) fail(`reason ${JSON.stringify(drawn.reason)}, expected ${JSON.stringify(want)}`);
              const answers = [["dismiss", t("pipelineBlock.answer.leaveOpen")], ["retry-merge", t("pipelineBlock.answer.retryMerge")]];
              if (JSON.stringify(drawn.answers) !== JSON.stringify(answers)) fail(`answers ${JSON.stringify(drawn.answers)}`);
              if (drawn.heights.some((height) => height < 44)) fail(`answers shorter than 44 px: ${drawn.heights.join(", ")}`);
            } else if (drawn.answers.length) fail(`answers on a merge that asks nothing: ${JSON.stringify(drawn.answers)}`);
            if (drawn.cut.length) fail(`labels cut by their button: ${drawn.cut.join(" | ")}`);
            if (screen.overflowX > 0.5 || screen.bodyOverflowX > 0.5) fail(`overflows sideways by ${Math.max(screen.overflowX, screen.bodyOverflowX)} px`);
            if (screen.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(screen.smallControls)}`);
            if (screen.crossingControls.length) fail(`controls crossing: ${JSON.stringify(screen.crossingControls)}`);
            if (screen.inkOverlaps.length) fail(`text over text: ${JSON.stringify(screen.inkOverlaps.slice(0, 6))}`);
            if (screen.inkOnControls.length) fail(`text over a control: ${JSON.stringify(screen.inkOnControls.slice(0, 6))}`);
            if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
            await page.close();
          } finally {
            await context.close();
          }
        }
        /* The ⋯ sheet: the setting row on, then off by its own switch. */
        const key = `menu-390-${lang}-${scheme}`;
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        try {
          const page = await context.newPage();
          await page.goto(`${fixtureBase}/?kanban=1&merge-states=1#p=atlas`);
          await page.waitForSelector('[data-mobile2-open="menu"]', { timeout: 20_000 });
          await pause(page, 600);
          await page.locator('[data-mobile2-open="menu"]').first().click();
          await page.waitForSelector('[data-mobile2-sheet="menu"] [data-merge-on-review]', { timeout: 10_000 });
          await page.waitForFunction(() => !document.querySelector("[data-merge-on-review-switch]")?.hasAttribute("disabled"), undefined, { timeout: 10_000 });
          const row = page.locator("[data-merge-on-review]");
          await row.scrollIntoViewIfNeeded();
          await pause(page, 400);
          const readRow = () => page.evaluate(() => {
            const element = document.querySelector("[data-merge-on-review]")!;
            const toggle = element.querySelector<HTMLElement>("[data-merge-on-review-switch]")!;
            const label = element.querySelector("span.flex-1")!;
            const a = label.getBoundingClientRect();
            const b = toggle.getBoundingClientRect();
            return {
              state: element.getAttribute("data-merge-on-review"),
              label: label.textContent?.trim() ?? "",
              hint: element.querySelector('[role="status"]')?.textContent?.trim() ?? "",
              switchSize: [Math.round(b.width), Math.round(b.height)],
              labelMeetsSwitch: Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5,
              inside: b.right <= window.innerWidth && a.left >= 0,
            };
          });
          await page.screenshot({ path: path.join(out, `phone-${key}-on.png`) });
          const on = await readRow();
          await page.locator("[data-merge-on-review-switch]").click();
          await page.waitForFunction(() => document.querySelector("[data-merge-on-review]")?.getAttribute("data-merge-on-review") === "off", undefined, { timeout: 10_000 });
          await page.waitForFunction(() => !document.querySelector("[data-merge-on-review-switch]")?.hasAttribute("disabled"), undefined, { timeout: 10_000 });
          await pause(page, 300);
          await page.screenshot({ path: path.join(out, `phone-${key}-off.png`) });
          const off = await readRow();
          results.push({ key, on, off });
          const fail = (text: string) => failures.push(`${key}: ${text}`);
          if (on.state !== "on" || on.label !== t("projectSettings.mergeOnReview") || on.hint !== t("projectSettings.mergeOnReview.on")) fail(`on ${JSON.stringify(on)}`);
          if (off.state !== "off" || off.hint !== t("projectSettings.mergeOnReview.off")) fail(`off ${JSON.stringify(off)}`);
          for (const entry of [on, off]) {
            if (entry.switchSize[1]! < 44 || entry.switchSize[0]! < 44) fail(`switch under 44 px: ${entry.switchSize.join("×")}`);
            if (entry.labelMeetsSwitch || !entry.inside) fail(`geometry ${JSON.stringify(entry)}`);
          }
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(evidence, "phone.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * #2187 §5.3, §6 (mockups P3, P4): a pipeline that finishes its task, on the
 * phone's task screen at 390, en and uk (`?task-finish=1`). The task whose
 * marked lane merged while a second lane still runs says "Done waits for 1
 * more pipeline" under its title and "finishes the task once 1 other pipeline
 * ends" on the lane; that lane's ⋯ sheet carries "Finishes the task", checked,
 * with the count in warning ink, on a 44 px row. A Done task's lane says
 * "finished the task"; a running marked lane says "finishes the task" before
 * its PR chip, and its toggle sends link-task. The task screen's own gates
 * hold: no sideways overflow, no text over text or a control, no small or
 * crossing control.
 *
 *   TASK_FINISH_PNG_DIR=… LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2187: a pipeline that finishes"
 */
browserTest("#2187: a pipeline that finishes its task says so on the phone at 390, en and uk, with the wait and the sheet's count", async () => {
  const out = path.resolve(process.env.TASK_FINISH_PNG_DIR ?? ".artifacts/task-finish");
  const evidence = path.resolve("evidence/task-finish");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const viewport = { width: 390, height: 844 };
  const gates = (screen: TaskReading, fail: (text: string) => void) => {
    if (screen.overflowX > 0.5 || screen.bodyOverflowX > 0.5) fail(`overflows sideways by ${Math.max(screen.overflowX, screen.bodyOverflowX)} px`);
    if (screen.smallControls.length) fail(`controls under 44 px: ${JSON.stringify(screen.smallControls)}`);
    if (screen.crossingControls.length) fail(`controls crossing: ${JSON.stringify(screen.crossingControls)}`);
    if (screen.inkOverlaps.length) fail(`text over text: ${JSON.stringify(screen.inkOverlaps.slice(0, 6))}`);
    if (screen.inkOnControls.length) fail(`text over a control: ${JSON.stringify(screen.inkOnControls.slice(0, 6))}`);
  };
  const readFinish = () => {
    const body = document.querySelector("[data-phone-task-body]");
    return {
      taskWait: body?.querySelector("[data-task-finish-wait]")?.textContent?.trim() ?? null,
      laneWaits: [...(body?.querySelectorAll('p[data-pipeline-finish="waits"]') ?? [])].map((node) => node.textContent?.trim() ?? ""),
      flags: [...(body?.querySelectorAll<HTMLElement>("span[data-pipeline-finish]") ?? [])].map((node) => ({
        pipeline: node.getAttribute("data-pipeline-finish-for"), state: node.getAttribute("data-pipeline-finish"), text: node.textContent?.trim() ?? "",
        beforeLinks: Boolean(node.nextElementSibling?.classList.contains("pb-links")), color: getComputedStyle(node).color,
      })),
    };
  };
  const readSheetRow = () => {
    const row = document.querySelector<HTMLElement>('[data-phone-task-lane-action="finishes-task"]');
    if (!row) return null;
    const spans = [...row.querySelectorAll<HTMLElement>("span.flex-col > span")];
    const box = row.getBoundingClientRect();
    return {
      checked: row.getAttribute("aria-checked"), role: row.getAttribute("role"), lines: spans.map((span) => span.textContent?.trim() ?? ""),
      warnColor: spans[2] ? getComputedStyle(spans[2]).color : null, hintColor: spans[1] ? getComputedStyle(spans[1]).color : null,
      height: Math.round(box.height), inside: box.left >= 0 && box.right <= window.innerWidth + 0.5,
      cut: spans.some((span) => span.scrollWidth > span.clientWidth + 1),
    };
  };
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const scheme of ["dark", "light"] as const) {
        const t = (name: string, params?: Record<string, string | number>) => translate(lang, name as never, params);
        const open = async (task: string) => {
          const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
          await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${fixtureBase}/?kanban=1&task-finish=1#p=atlas`);
          await page.waitForSelector(`[data-phone-card="task:${task}"]`, { timeout: 20_000 });
          await pause(page, 600);
          await page.locator(`[data-phone-card="task:${task}"]`).click();
          await page.waitForSelector(`[data-mobile2-task="${task}"] [data-phone-task-body="${task}"]`, { timeout: 10_000 });
          if (await page.locator("[data-phone-task-ended]").count()) await page.locator("[data-phone-task-ended]").click();
          await page.mouse.move(0, 0);
          await pause(page, 600);
          return { context, page, pageErrors };
        };
        /* P4: the wait, on the task and on its marked lane, and the lane's sheet. */
        {
          const key = `hold-390-${lang}-${scheme}`;
          const fail = (text: string) => failures.push(`${key}: ${text}`);
          const { context, page, pageErrors } = await open("t-finish-hold");
          try {
            await page.screenshot({ path: path.join(out, `phone-${key}.png`) });
            const drawn = await page.evaluate(readFinish);
            const screen = await readTaskScreen(page);
            if (drawn.taskWait !== t("pipelineBlock.finish.cardWaits", { count: 1 })) fail(`task wait ${JSON.stringify(drawn.taskWait)}`);
            if (JSON.stringify(drawn.laneWaits) !== JSON.stringify([t("pipelineBlock.finish.waits", { count: 1 })])) fail(`lane wait ${JSON.stringify(drawn.laneWaits)}`);
            if (drawn.flags.length) fail(`a waiting lane draws a flag ${JSON.stringify(drawn.flags)}`);
            gates(screen, fail);
            await page.locator('[data-phone-task-lane="lane-finish-hold"] [data-pipeline-menu]').click();
            await page.waitForSelector('[data-phone-task-lane-action="finishes-task"]', { timeout: 10_000 });
            await pause(page, 500);
            await page.screenshot({ path: path.join(out, `phone-${key}-sheet.png`) });
            const sheet = await page.evaluate(readSheetRow);
            const want = [t("pipelineBlock.finish.menu"), t("pipelineBlock.finish.menuWhy"), t("pipelineBlock.finish.menuOpen", { count: 1 })];
            if (!sheet || sheet.checked !== "true" || sheet.role !== "menuitemcheckbox" || JSON.stringify(sheet.lines) !== JSON.stringify(want)) fail(`sheet row ${JSON.stringify(sheet)}`);
            if (sheet && (sheet.height < 44 || !sheet.inside || sheet.cut)) fail(`sheet row geometry ${JSON.stringify(sheet)}`);
            if (sheet && sheet.warnColor === sheet.hintColor) fail(`the count is not in warning ink: ${sheet.warnColor}`);
            if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
            results.push({ key, ...drawn, sheet, screen });
          } finally {
            await context.close();
          }
        }
        /* P3: the Done task its marked lane finished. */
        {
          const key = `done-390-${lang}-${scheme}`;
          const fail = (text: string) => failures.push(`${key}: ${text}`);
          const { context, page, pageErrors } = await open("t-finish-done");
          try {
            await page.screenshot({ path: path.join(out, `phone-${key}.png`) });
            const drawn = await page.evaluate(readFinish);
            const screen = await readTaskScreen(page);
            if (JSON.stringify(drawn.flags.map((flag) => [flag.state, flag.text])) !== JSON.stringify([["finished", t("pipelineBlock.finish.done")]])) fail(`flags ${JSON.stringify(drawn.flags)}`);
            if (drawn.taskWait !== null || drawn.laneWaits.length) fail(`waits on a finished task ${JSON.stringify(drawn)}`);
            gates(screen, fail);
            if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
            results.push({ key, ...drawn, screen });
          } finally {
            await context.close();
          }
        }
        /* The running marked lane: the flag before the PR chip, and the toggle. */
        {
          const key = `marked-390-${lang}-${scheme}`;
          const fail = (text: string) => failures.push(`${key}: ${text}`);
          const { context, page, pageErrors } = await open("t-finish-marked");
          try {
            await page.screenshot({ path: path.join(out, `phone-${key}.png`) });
            const drawn = await page.evaluate(readFinish);
            const screen = await readTaskScreen(page);
            if (JSON.stringify(drawn.flags.map((flag) => [flag.pipeline, flag.state, flag.text, flag.beforeLinks])) !== JSON.stringify([["lane-finish-marked", "marked", t("pipelineBlock.finish.marked"), true]])) fail(`flags ${JSON.stringify(drawn.flags)}`);
            gates(screen, fail);
            await page.locator('[data-phone-task-lane="lane-finish-marked"] [data-pipeline-menu]').click();
            await page.waitForSelector('[data-phone-task-lane-action="finishes-task"]', { timeout: 10_000 });
            await pause(page, 500);
            await page.screenshot({ path: path.join(out, `phone-${key}-sheet.png`) });
            const sheet = await page.evaluate(readSheetRow);
            /* No other lane on this task is open, so the sheet names no count. */
            if (!sheet || sheet.checked !== "true" || sheet.lines.length !== 2) fail(`sheet row ${JSON.stringify(sheet)}`);
            let patches: unknown = null;
            if (scheme === "light") {
              await page.locator('[data-phone-task-lane-action="finishes-task"]').click();
              await page.waitForFunction(() => !document.querySelector('[data-phone-task-body] span[data-pipeline-finish]'), undefined, { timeout: 10_000 }).catch(() => fail("the flag stayed after clearing it"));
              patches = await page.evaluate(() => (window as unknown as { evidence?: { pipelinePatches: Array<Record<string, unknown>> } }).evidence?.pipelinePatches ?? null);
              const sent = (patches as Array<Record<string, unknown>> | null) ?? [];
              if (!sent.some((entry) => entry.id === "lane-finish-marked" && entry.action === "link-task" && entry.taskId === "t-finish-marked" && entry.finishes === false)) fail(`the toggle sent ${JSON.stringify(patches)}`);
            }
            if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
            results.push({ key, ...drawn, sheet, patches, screen });
          } finally {
            await context.close();
          }
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(evidence, "phone.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * #2166 slice 1 (docs/design/orchestrator-first-onboarding.md §3.5–3.7) on the
 * phone at 390 × 844, en and uk, over the fixture's `?seatless=` scenes:
 *
 *   - a seatless board whose Inbox is empty (`donly`) and the board right after
 *     its seat was created (`seatonly`): the empty Inbox's New task is bordered
 *     with one plus, and names the orchestrator in its text;
 *   - the create draft the seat invitation opens: the plain sentence, one Runs
 *     on card, the rules folded, the manual way last, none of the runbook
 *     words, on the sheet's one 12 px inset;
 *   - the Overview of an install with no seat (`&overview=1`), which leads with
 *     its band above the tabs.
 *
 * `LLV_2166_BEFORE=1` records the same frames from a checkout without the
 * change and gates nothing. Frames go to `LLV_2166_OUT`, outside the repository;
 * readings to `evidence/orchestrator-first/slice1-phone(-before).json`.
 */
browserTest("#2166 slice 1: the phone's seatless board, its create draft and the Overview's band at 390", async () => {
  const BEFORE = process.env.LLV_2166_BEFORE === "1";
  const out = path.resolve(process.env.LLV_2166_OUT ?? ".artifacts/orchestrator-first");
  const tag = BEFORE ? "before" : "after";
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync("evidence/orchestrator-first", { recursive: true });
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const readings: Record<string, unknown> = {};
  const failures: string[] = [];
  const near = (a: number | null | undefined, b: number, tolerance = 1) => a != null && Math.abs(a - b) <= tolerance;
  const open = async (lang: "en" | "uk", query: string) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "light" });
    await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/${query}`);
    return { context, page, errors };
  };
  try {
    for (const lang of ["en", "uk"] as const) {
      const suffix = lang === "uk" ? "-uk" : "";
      /* The two boards, on their Inbox. */
      for (const [scene, name] of [["donly", "seatless-empty-inbox"], ["seatonly", "seat-just-created"]] as const) {
        const label = `phone-board-${name}-390${suffix}`;
        const { context, page, errors } = await open(lang, `?kanban=1&seatless=${scene}#p=atlas`);
        try {
          await page.waitForSelector("[data-phone-kanban]", { timeout: 20_000 });
          await page.locator('[data-phone-kanban-tab="inbox"]').click();
          await pagerAtRest(page);
          await pause(page, 500);
          const reading = await page.evaluate(() => {
            const inbox = document.querySelector<HTMLElement>('[data-phone-kanban-empty-action="inbox"]');
            return {
              inboxText: document.querySelector<HTMLElement>('[data-phone-kanban-empty="inbox"]')?.innerText ?? null,
              newTask: inbox ? { text: inbox.innerText, fill: getComputedStyle(inbox).backgroundColor, border: getComputedStyle(inbox).borderTopWidth, icons: inbox.querySelectorAll("svg").length } : null,
              seat: document.querySelector("[data-mobile2-seat-card]")?.getAttribute("data-mobile2-seat-state") ?? null,
            };
          });
          await page.screenshot({ path: path.join(out, `${label}-${tag}.png`) });
          readings[label] = reading;
          if (!BEFORE) {
            if (!reading.newTask) failures.push(`${label}: no New task on the empty Inbox`);
            else {
              if (reading.newTask.text.includes("+")) failures.push(`${label}: New task reads ${JSON.stringify(reading.newTask.text)}`);
              if (reading.newTask.border === "0px") failures.push(`${label}: New task is not bordered`);
              if (reading.newTask.icons !== 1) failures.push(`${label}: New task draws ${reading.newTask.icons} icons`);
            }
            if (lang === "en" && !reading.inboxText?.includes("The orchestrator adds a task here for each thing you ask.")) failures.push(`${label}: the empty Inbox reads ${JSON.stringify(reading.inboxText)}`);
          }
          if (errors.length) failures.push(`${label}: page errors ${errors.join(" | ")}`);
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await context.close();
        }
      }

      /* The create draft the seat invitation opens. */
      {
        const label = `board-draft-390${suffix}`;
        const { context, page, errors } = await open(lang, "?kanban=1&seatless=donly#p=atlas");
        try {
          await page.waitForSelector("[data-mobile2-seat-open]", { timeout: 20_000 });
          await page.locator("[data-mobile2-seat-open]").first().click();
          await page.waitForSelector('[data-orchestrator-sheet-mode="create"]', { timeout: 10_000 });
          await pause(page, 600);
          const reading = await page.evaluate(() => {
            const sheet = document.querySelector<HTMLElement>('[data-testid="mobile-orchestrator-sheet"]')!;
            const body = sheet.querySelector<HTMLElement>("header + div")!;
            const bodyBox = body.getBoundingClientRect();
            const style = getComputedStyle(body);
            const copy = sheet.cloneNode(true) as HTMLElement;
            copy.querySelectorAll("textarea").forEach((field) => field.remove());
            const lefts = [...body.children].map((child) => Math.round(child.getBoundingClientRect().left - bodyBox.left));
            const footer = sheet.lastElementChild as HTMLElement;
            const footerStyle = getComputedStyle(footer);
            return {
              words: copy.textContent ?? "",
              padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
              childLefts: lefts,
              footerPadding: [footerStyle.paddingTop, footerStyle.paddingRight, footerStyle.paddingBottom, footerStyle.paddingLeft],
              folded: Boolean(sheet.querySelector("[data-orchestrator-mandate-fold]")),
              mandateShown: Boolean(sheet.querySelector("[data-orchestrator-mandate]")),
              radios: sheet.querySelectorAll('[role="radio"]').length,
              runsOn: sheet.querySelector("[data-orchestrator-runs-on-value]")?.textContent ?? null,
              clipped: [...sheet.querySelectorAll<HTMLElement>("p, span, button")].filter((node) => node.offsetParent && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow !== "visible" && !node.closest("header")).map((node) => node.textContent?.slice(0, 40) ?? ""),
            };
          });
          await page.screenshot({ path: path.join(out, `${label}-${tag}.png`) });
          readings[label] = reading;
          if (!BEFORE) {
            if (/#\d/.test(reading.words)) failures.push(`${label}: the draft names an issue number`);
            for (const word of ["MCP", "deploy", "APPROVE", "lanes"]) if (reading.words.includes(word)) failures.push(`${label}: the draft says «${word}»`);
            if (!reading.folded || reading.mandateShown) failures.push(`${label}: the rules are not folded`);
            if (reading.radios) failures.push(`${label}: the pickers stand open`);
            if (!reading.padding.every((value) => value === "12px")) failures.push(`${label}: body padding ${reading.padding.join(" ")}`);
            if (!reading.footerPadding.every((value) => value === "12px")) failures.push(`${label}: footer padding ${reading.footerPadding.join(" ")}`);
            if (new Set(reading.childLefts.map((left) => (left <= 12 ? 12 : left))).size !== 1) failures.push(`${label}: the body's rows start on ${JSON.stringify(reading.childLefts)}`);
            if (reading.clipped.length) failures.push(`${label}: text cut off: ${JSON.stringify(reading.clipped)}`);
          }
          if (errors.length) failures.push(`${label}: page errors ${errors.join(" | ")}`);
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await context.close();
        }
      }

      /* The Overview of an install with no seat. */
      {
        const label = `overview-band-390${suffix}`;
        const { context, page, errors } = await open(lang, "?overview=1&seatless=donly");
        try {
          await page.waitForSelector("[data-phone-kanban]", { timeout: 20_000 });
          if (!BEFORE) await page.waitForSelector("[data-overview-orchestrator-band]", { timeout: 15_000 });
          await pause(page, 600);
          const reading = await page.evaluate(() => {
            const band = document.querySelector<HTMLElement>("[data-overview-orchestrator-band]");
            if (!band) return null;
            const box = band.getBoundingClientRect();
            const button = band.querySelector<HTMLElement>("[data-overview-orchestrator-create]")!.getBoundingClientRect();
            const tabs = document.querySelector<HTMLElement>("[data-phone-kanban-tab]")?.getBoundingClientRect() ?? null;
            const style = getComputedStyle(band);
            return {
              left: box.left, right: innerWidth - box.right, top: box.top,
              padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
              button: { left: button.left - box.left, right: box.right - button.right, height: button.height, bottomGap: box.bottom - button.bottom },
              aboveTabs: tabs ? tabs.top >= box.bottom - 1 : null,
            };
          });
          await page.screenshot({ path: path.join(out, `${label}-${tag}.png`) });
          readings[label] = reading;
          if (!BEFORE) {
            if (!reading) throw new Error("no band on an install with no seat");
            if (!reading.padding.every((value) => value === "12px")) failures.push(`${label}: band padding ${reading.padding.join(" ")}`);
            if (!near(reading.left, reading.right)) failures.push(`${label}: the band sits ${reading.left} from the left and ${reading.right} from the right`);
            if (!near(reading.button.left, 12) || !near(reading.button.right, 12) || !near(reading.button.bottomGap, 12)) failures.push(`${label}: the button's insets ${JSON.stringify(reading.button)}`);
            if (reading.button.height < 44) failures.push(`${label}: the button is ${reading.button.height} px tall`);
            if (reading.aboveTabs !== true) failures.push(`${label}: the band is not above the tabs`);
          }
          if (errors.length) failures.push(`${label}: page errors ${errors.join(" | ")}`);
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join("evidence/orchestrator-first", BEFORE ? "slice1-phone-before.json" : "slice1-phone.json"), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
  if (failures.length && !BEFORE) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #2166 slice 3 (docs/design/orchestrator-first-onboarding.md §3.8) on the
 * phone at 390 × 844: the interface walk over the board right after its seat
 * was created (`?seatless=seatonly`), on an install whose marker never ran it
 * (`&walk=1`).
 *
 *   - It starts by itself on stop 1, the board dock; stop 2 is the column
 *     tabs; stop 3 is the bar's Needs-you slot, which the shell draws
 *     empty-outlined while the stop shows because the badge hides at zero.
 *   - Each spotlight covers its anchor inside the window, and the popover is
 *     the window's width less 12 px on each side, wholly on screen, with Skip's
 *     label ending as far from the right edge as the title starts from the
 *     left, and the mark, title, body and dots on one left edge.
 *   - "Give it the first task" opens the seat's conversation; a reload does not
 *     start the walk again, and the board menu's "Interface walk" row does.
 *
 * Frames go to `LLV_2166_OUT`, outside the repository; readings to
 * `evidence/orchestrator-first/slice3-phone.json`.
 */
browserTest("#2166 slice 3: the phone's interface walk at 390", async () => {
  const out = path.resolve(process.env.LLV_2166_OUT ?? ".artifacts/orchestrator-first");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync("evidence/orchestrator-first", { recursive: true });
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const readings: Record<string, unknown> = {};
  const failures: string[] = [];
  const near = (a: number | null | undefined, b: number | null | undefined, tolerance = 1) => a != null && b != null && Math.abs(a - b) <= tolerance;
  const read = (page: Page) => page.evaluate(() => {
    const round = (value: number) => Math.round(value * 10) / 10;
    const box = (node: Element | null | undefined) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { left: round(rect.left), top: round(rect.top), right: round(rect.right), bottom: round(rect.bottom) };
    };
    const ink = (node: Element | null) => {
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      return rects.length ? { left: Math.min(...rects.map((rect) => rect.left)), right: Math.max(...rects.map((rect) => rect.right)) } : null;
    };
    const pop = document.querySelector<HTMLElement>("[data-walk-popover]");
    if (!pop) return null;
    const stopNumber = Number(pop.dataset.walkPopover);
    const key = stopNumber === 1 ? "seat" : stopNumber === 2 ? "board" : "needs";
    const anchor = [...document.querySelectorAll<HTMLElement>(`[data-walk-anchor="${key}"]`)].find((node) => node.getBoundingClientRect().width > 0) ?? null;
    const popBox = pop.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(pop).borderLeftWidth) || 0;
    const from = (left: number | undefined) => (left == null ? null : round(left - popBox.left - border));
    return {
      stop: stopNumber,
      anchor: box(anchor),
      anchorKind: anchor?.hasAttribute("data-mobile2-board-dock") ? "dock" : anchor?.hasAttribute("data-phone-kanban-tabs") ? "tabs" : anchor?.closest("[data-mobile2-bar]") ? "bar-slot" : anchor ? "other" : null,
      emptySlot: stopNumber === 3 ? Boolean(anchor && !anchor.matches("button")) : null,
      spotlight: box(document.querySelector("[data-walk-spotlight]")),
      popover: box(pop),
      viewport: { width: innerWidth, height: innerHeight },
      insets: {
        mark: from(pop.querySelector("[data-walk-mark]")?.getBoundingClientRect().left),
        title: from(ink(pop.querySelector("[data-walk-title]"))?.left),
        body: from(ink(pop.querySelector("[data-walk-body]"))?.left),
        dots: from(pop.querySelector("[data-walk-dots]")?.getBoundingClientRect().left),
        skipFromRight: (() => { const value = ink(pop.querySelector("[data-walk-skip-label]")); return value ? round(popBox.right - border - value.right) : null; })(),
      },
      text: pop.innerText,
    };
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${base}/?kanban=1&seatless=seatonly&walk=1#p=atlas`);
    await page.waitForSelector("[data-phone-kanban]", { timeout: 20_000 });
    await page.waitForSelector('[data-walk-popover="1"]', { state: "visible", timeout: 20_000 });
    for (const stopNumber of [1, 2, 3] as const) {
      const label = `walk-${stopNumber}-390`;
      await page.waitForSelector(`[data-walk-popover="${stopNumber}"]`, { state: "visible", timeout: 10_000 });
      await pause(page, 600);
      const reading = await read(page);
      await page.screenshot({ path: path.join(out, `${label}-after.png`) });
      readings[label] = reading;
      if (!reading) { failures.push(`${label}: no popover`); break; }
      const { anchor, spotlight, popover, viewport, insets } = reading;
      const expected = stopNumber === 1 ? "dock" : stopNumber === 2 ? "tabs" : "bar-slot";
      if (reading.anchorKind !== expected) failures.push(`${label}: points at ${reading.anchorKind}, not the ${expected}`);
      if (stopNumber === 3 && !reading.emptySlot) failures.push(`${label}: the bar draws no empty Needs-you slot`);
      if (!anchor || !spotlight) failures.push(`${label}: no anchor or no spotlight`);
      else {
        const seen = { left: Math.max(anchor.left, 0), top: Math.max(anchor.top, 0), right: Math.min(anchor.right, viewport.width), bottom: Math.min(anchor.bottom, viewport.height) };
        if (spotlight.left > seen.left + 0.5 || spotlight.top > seen.top + 0.5 || spotlight.right < seen.right - 0.5 || spotlight.bottom < seen.bottom - 0.5) failures.push(`${label}: the spotlight ${JSON.stringify(spotlight)} does not cover ${JSON.stringify(seen)}`);
        if (spotlight.left < -0.5 || spotlight.top < -0.5 || spotlight.right > viewport.width + 0.5 || spotlight.bottom > viewport.height + 0.5) failures.push(`${label}: the spotlight leaves the window`);
      }
      if (!popover || popover.left < 0 || popover.top < 0 || popover.right > viewport.width || popover.bottom > viewport.height) failures.push(`${label}: the popover ${JSON.stringify(popover)} leaves the window`);
      if (popover && (!near(popover.left, 12) || !near(viewport.width - popover.right, 12))) failures.push(`${label}: the popover sits ${popover.left} / ${popover ? viewport.width - popover.right : null} from the edges`);
      for (const [name, left] of [["title", insets.title], ["body", insets.body], ["dots", insets.dots]] as const) {
        if (!near(left, insets.mark)) failures.push(`${label}: ${name} starts at ${left}, the mark at ${insets.mark}`);
      }
      if (!near(insets.skipFromRight, insets.title)) failures.push(`${label}: Skip ends ${insets.skipFromRight} from the right, the title starts ${insets.title} from the left`);
      await page.locator("[data-walk-primary]").click();
    }
    await page.waitForSelector("[data-walk-popover]", { state: "detached", timeout: 5_000 });
    await pause(page, 800);
    const opened = await page.evaluate(() => ({
      screen: document.querySelector("[data-mobile2-screen]:not([data-mobile2-screen=\"board\"])")?.getAttribute("data-mobile2-screen") ?? null,
      sheet: Boolean(document.querySelector('[data-testid="mobile-orchestrator-sheet"]')),
    }));
    readings.firstTask = opened;
    if (opened.screen !== "chat" && !opened.sheet) failures.push(`"Give it the first task" opened ${JSON.stringify(opened)}`);
    await page.screenshot({ path: path.join(out, "walk-first-task-390-after.png") });

    /* A reload: done stays done. The menu row starts it again. */
    await page.goto(`${base}/?kanban=1&seatless=seatonly&walk=1#p=atlas`);
    await page.waitForSelector("[data-phone-kanban]", { timeout: 20_000 });
    await pause(page, 3_000);
    if (await page.locator("[data-walk-popover]").count()) failures.push("the walk started again after a reload");
    await page.screenshot({ path: path.join(out, "walk-before-390.png") });
    await page.locator('[data-mobile2-open="menu"]').first().click();
    await page.waitForSelector('[data-testid="menu-interface-walk"]', { state: "visible", timeout: 5_000 });
    /* The sheet opens at its top, below the fold of the onboarding rows; the render shows the new row. */
    await page.locator('[data-testid="menu-interface-walk"]').evaluate((row) => row.scrollIntoView({ block: "center" }));
    await pause(page, 400);
    readings.menuRowOnScreen = await page.locator('[data-testid="menu-interface-walk"]').evaluate((row) => {
      const box = row.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    });
    if (!readings.menuRowOnScreen) failures.push("the Interface walk row is off screen in the menu render");
    await page.screenshot({ path: path.join(out, "menu-walk-390-after.png") });
    await page.locator('[data-testid="menu-interface-walk"]').click();
    await page.waitForSelector('[data-walk-popover="1"]', { state: "visible", timeout: 10_000 });
    await page.locator("[data-walk-skip]").click();
    await page.waitForSelector("[data-walk-popover]", { state: "detached", timeout: 5_000 });
    readings.written = await page.evaluate(() => sessionStorage.getItem("evidence-walk"));
    if (readings.written !== "skipped") failures.push(`Skip left the marker at ${JSON.stringify(readings.written)}`);
    if (errors.length) failures.push(`page errors ${errors.join(" | ")}`);
  } catch (error) {
    failures.push(error instanceof Error ? error.message.split("\n")[0]! : String(error));
  } finally {
    await context.close();
    await browser.close();
    stop();
  }
  fs.writeFileSync("evidence/orchestrator-first/slice3-phone.json", `${JSON.stringify({ readings, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * #2146 — the orchestrator's report log on the phone at 390 × 844, en and uk,
 * dark and light: one tap from the seat's conversation (the bar's report log
 * button, 44 px) opens its own screen — this project's bridge reports, newest
 * first, each a local time, a class word and the body as written, links on
 * `#123` and the board's card ids, «new» on what arrived since the last look,
 * and «Show older» under the page. The ⋯ sheet carries "Bridge reports" on and
 * then off by its own 44 px switch, and off, the screen is one line with the
 * switch. No sideways overflow, no text over text or a control.
 *
 *   REPORT_LOG_PNG_DIR=… LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "#2146"
 */
browserTest("#2146: the seat's report log is one tap from its conversation on the phone at 390, en and uk, and the ⋯ sheet switches it off", async () => {
  const out = path.resolve(process.env.REPORT_LOG_PNG_DIR ?? ".artifacts/report-log");
  const evidence = path.resolve("evidence/orchestrator-report-log");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const viewport = { width: 390, height: 844 };
  const readLog = (page: Page) => page.evaluate(() => {
    const log = document.querySelector("[data-report-log]");
    const scroller = log?.querySelector(".overflow-y-auto") as HTMLElement | null;
    const rows = [...(log?.querySelectorAll("[data-report-entry]") ?? [])];
    const older = log?.querySelector<HTMLElement>("[data-report-log-older]") ?? null;
    /* The ink of every text on screen in the log, to find text over text. */
    const ink: Array<{ text: string; el: Element; r: { l: number; t: number; r: number; b: number } }> = [];
    if (log) {
      const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.nodeValue?.trim() || !node.parentElement) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width * rect.height < 1 || rect.bottom < 0 || rect.top > innerHeight) continue;
          ink.push({ text: node.nodeValue.trim().slice(0, 30), el: node.parentElement, r: { l: rect.left, t: rect.top, r: rect.right, b: rect.bottom } });
        }
      }
    }
    const overlaps: string[] = [];
    for (let i = 0; i < ink.length; i++) {
      for (let j = i + 1; j < ink.length; j++) {
        const a = ink[i]!;
        const b = ink[j]!;
        if (a.el === b.el) continue;
        const area = Math.max(0, Math.min(a.r.r, b.r.r) - Math.max(a.r.l, b.r.l)) * Math.max(0, Math.min(a.r.b, b.r.b) - Math.max(a.r.t, b.r.t));
        if (area > 1) overlaps.push(`${a.text} | ${b.text}`);
      }
    }
    return {
      pageSideways: document.documentElement.scrollWidth - innerWidth,
      overlaps: overlaps.slice(0, 6),
      screen: document.querySelector("[data-mobile2-screen]")?.getAttribute("data-mobile2-screen") ?? null,
      entries: rows.length,
      classes: [...new Set(rows.map((row) => row.getAttribute("data-report-class")))],
      fresh: rows.filter((row) => row.hasAttribute("data-report-new")).length,
      github: log?.querySelectorAll("[data-report-link=github]").length ?? 0,
      cards: log?.querySelectorAll("[data-report-link=card]").length ?? 0,
      olderHeight: older ? Math.round(older.getBoundingClientRect().height) : null,
      sideways: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
      off: log?.querySelector("[data-report-log-off] p")?.textContent ?? null,
      offSwitch: log?.querySelector("[data-report-log-off] [data-bridge-reports-switch]")?.getAttribute("aria-checked") ?? null,
    };
  });
  try {
    for (const lang of ["en", "uk"] as const) {
      for (const scheme of ["dark", "light"] as const) {
        const t = (name: string, params?: Record<string, string | number>) => translate(lang, name as never, params);
        const key = `390-${lang}-${scheme}`;
        const fail = (text: string) => failures.push(`${key}: ${text}`);
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${fixtureBase}/?kanban=1#p=atlas`);
          await page.waitForSelector("[data-mobile2-seat-open]", { timeout: 20_000 });
          await pause(page, 600);
          await page.locator("[data-mobile2-seat-open]").click();
          await page.waitForSelector('[data-mobile2-open="reports"]', { timeout: 10_000 });
          await pause(page, 600);
          await page.screenshot({ path: path.join(out, `phone-chat-${key}.png`) });
          const button = await rectOf(page, '[data-mobile2-open="reports"]');
          if (!button || button.width < 44 || button.height < 44) fail(`the report log button is ${JSON.stringify(button)}`);
          /* One tap opens it; the operator last looked three reports ago. */
          await page.locator('[data-mobile2-open="reports"]').click();
          await page.waitForSelector("[data-report-log] [data-report-entry]", { timeout: 10_000 });
          const third = await page.evaluate(() => [...document.querySelectorAll("[data-report-entry]")][3]!.getAttribute("data-report-entry"));
          await page.locator("[data-mobile2-back]").first().click();
          await page.waitForSelector('[data-mobile2-open="reports"]', { timeout: 10_000 });
          await page.evaluate((seq) => localStorage.setItem("llvReportLogSeen:atlas", String(seq)), third);
          await page.locator('[data-mobile2-open="reports"]').click();
          await page.waitForSelector("[data-report-log] [data-report-entry]", { timeout: 10_000 });
          await page.mouse.move(0, 0);
          await pause(page, 500);
          await page.screenshot({ path: path.join(out, `phone-log-${key}.png`) });
          const log = await readLog(page);
          if (log.screen !== "reports") fail(`screen ${log.screen}`);
          if (log.entries !== 30 || log.classes.length !== 6) fail(`entries ${log.entries}, classes ${log.classes.join(",")}`);
          if (log.fresh !== 3) fail(`${log.fresh} new marks`);
          if (!log.github || !log.cards) fail(`links: ${log.github} GitHub, ${log.cards} cards`);
          if (log.sideways > 0 || log.pageSideways > 0) fail(`overflows sideways: log ${log.sideways}, page ${log.pageSideways}`);
          if (log.overlaps.length) fail(`text over text: ${JSON.stringify(log.overlaps)}`);
          await page.evaluate(() => {
            const scroller = document.querySelector("[data-report-log] .overflow-y-auto")!;
            scroller.scrollTop = scroller.scrollHeight;
          });
          await pause(page, 300);
          await page.screenshot({ path: path.join(out, `phone-log-end-${key}.png`) });
          const end = await readLog(page);
          if ((end.olderHeight ?? 0) < 44) fail(`Show older is ${end.olderHeight}px tall`);

          /* The ⋯ sheet: Bridge reports on, then off by its own switch. */
          await page.locator('[data-mobile2-open="menu"]').first().click();
          await page.waitForSelector('[data-mobile2-sheet="menu"] [data-bridge-reports]', { timeout: 10_000 });
          await page.waitForFunction(() => [...document.querySelectorAll('[data-mobile2-sheet="menu"] [role=switch]')].every((toggle) => !toggle.hasAttribute("disabled")), undefined, { timeout: 10_000 });
          await page.locator('[data-mobile2-sheet="menu"] [data-bridge-reports]').scrollIntoViewIfNeeded();
          await pause(page, 500);
          await page.screenshot({ path: path.join(out, `phone-menu-${key}-on.png`) });
          const readRow = () => page.evaluate(() => {
            const element = document.querySelector('[data-mobile2-sheet="menu"] [data-bridge-reports]')!;
            const toggle = element.querySelector<HTMLElement>("[data-bridge-reports-switch]")!;
            const name = element.querySelector("span.flex-1")!;
            const a = name.getBoundingClientRect();
            const b = toggle.getBoundingClientRect();
            return {
              state: element.getAttribute("data-bridge-reports"),
              label: name.textContent?.trim() ?? "",
              hint: element.querySelector('[role="status"]')?.textContent?.trim() ?? "",
              switchSize: [Math.round(b.width), Math.round(b.height)],
              labelMeetsSwitch: Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5,
              inside: b.right <= window.innerWidth && a.left >= 0,
            };
          });
          const on = await readRow();
          await page.locator('[data-mobile2-sheet="menu"] [data-bridge-reports-switch]').click();
          await page.waitForFunction(() => document.querySelector('[data-mobile2-sheet="menu"] [data-bridge-reports]')?.getAttribute("data-bridge-reports") === "off", undefined, { timeout: 10_000 });
          await pause(page, 400);
          await page.screenshot({ path: path.join(out, `phone-menu-${key}-off.png`) });
          const off = await readRow();
          if (on.state !== "on" || on.label !== t("projectSettings.bridgeReports") || on.hint !== t("projectSettings.bridgeReports.on")) fail(`on ${JSON.stringify(on)}`);
          if (off.state !== "off" || off.hint !== t("projectSettings.bridgeReports.off")) fail(`off ${JSON.stringify(off)}`);
          for (const entry of [on, off]) {
            if (entry.switchSize[0]! < 44 || entry.switchSize[1]! < 44) fail(`switch under 44 px: ${entry.switchSize.join("×")}`);
            if (entry.labelMeetsSwitch || !entry.inside) fail(`geometry ${JSON.stringify(entry)}`);
          }
          await page.locator('[data-mobile2-sheet="menu"] [data-mobile2-close]').click();
          await page.waitForFunction(() => !document.querySelector('[data-mobile2-sheet="menu"]'), undefined, { timeout: 10_000 });
          await page.waitForSelector("[data-report-log-off]", { timeout: 10_000 });
          await pause(page, 400);
          await page.screenshot({ path: path.join(out, `phone-log-off-${key}.png`) });
          const offLog = await readLog(page);
          if (offLog.off !== t("reportLog.off") || offLog.offSwitch !== "false" || offLog.entries !== 0) fail(`off screen ${JSON.stringify(offLog)}`);
          const offSwitch = await rectOf(page, "[data-report-log-off] [data-bridge-reports-switch]");
          if (!offSwitch || offSwitch.height < 44) fail(`the off screen's switch is ${JSON.stringify(offSwitch)}`);
          results.push({ key, button, log, end: { olderHeight: end.olderHeight }, menu: { on, off }, offLog });
          if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          await page.close();
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(evidence, "phone.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * docs/design/needs-attention.md, the permission row (#2215): a Claude tool
 * request its safety check raised, on the fixture's `?permission=1` scene, as
 * the phone's Needs-you sheet shows it at 390 × 844 and 430 × 932 and as the
 * desktop island's popover shows it at 1280 × 900, each in light and dark:
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "permission row"
 *
 * The headline (tool, command, the engine's full decision_reason) ends in an
 * ellipsis inside its row, the age stays visible beside it, and Allow once /
 * Deny have size, sit inside the surface, overlap neither each other nor the
 * row, and send the answer they name. Frames go to `LLV_PERMISSION_FRAMES`
 * (default `.artifacts/permission-row`, not committed); readings to
 * `evidence/needs-attention/permission-row.json`.
 */
const PERMISSION_OUT = path.resolve(process.env.LLV_PERMISSION_FRAMES || ".artifacts/permission-row");
const PERMISSION_EVIDENCE = path.resolve("evidence/needs-attention");
const PERMISSION_ROW = '[data-attention-row$=":permission:request-safety-1"]';

/** The permission row's geometry, measured against the surface that holds it. */
const readPermissionRow = (page: Page, surface: string) => page.evaluate(([rowSelector, surfaceSelector]) => {
  const box = (element: Element | null) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  };
  type Box = NonNullable<ReturnType<typeof box>>;
  const within = (inner: Box | null, outer: Box | null) => Boolean(inner && outer && inner.x >= outer.x - 0.5 && inner.right <= outer.right + 0.5 && inner.y >= outer.y - 0.5 && inner.bottom <= outer.bottom + 0.5);
  const cross = (a: Box | null, b: Box | null) => Boolean(a && b && Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0.5);
  const row = document.querySelector<HTMLElement>(rowSelector);
  const holder = row?.parentElement ?? null;
  const decision = row?.querySelector<HTMLElement>("[data-attention-decision]") ?? null;
  const age = row?.querySelector<HTMLElement>("[data-attention-age]") ?? null;
  const ageLine = age?.parentElement ?? null;
  const allow = holder?.querySelector("[data-permission-allow]") ?? null;
  const deny = holder?.querySelector("[data-permission-deny]") ?? null;
  const surfaceBox = box(document.querySelector(surfaceSelector));
  const rowBox = box(row);
  const decisionBox = box(decision);
  const ageBox = box(age);
  const allowBox = box(allow);
  const denyBox = box(deny);
  const style = decision ? getComputedStyle(decision) : null;
  return {
    viewport: { width: innerWidth, height: innerHeight },
    surface: surfaceBox,
    row: rowBox,
    decision: {
      text: decision?.textContent ?? null,
      box: decisionBox,
      scrollWidth: decision?.scrollWidth ?? 0,
      clientWidth: decision?.clientWidth ?? 0,
      textOverflow: style?.textOverflow ?? null,
      whiteSpace: style?.whiteSpace ?? null,
      insideRow: within(decisionBox, rowBox),
    },
    age: {
      text: age?.textContent ?? null,
      box: ageBox,
      insideRow: within(ageBox, rowBox),
      /* Clipped by its line's overflow box, as the phone's meta line clips. */
      insideLine: within(ageBox, box(ageLine)),
      crossesDecision: cross(ageBox, decisionBox),
    },
    allow: { text: allow?.textContent ?? null, box: allowBox },
    deny: { text: deny?.textContent ?? null, box: denyBox },
    buttonsInsideSurface: within(allowBox, surfaceBox) && within(denyBox, surfaceBox),
    buttonsCrossEachOther: cross(allowBox, denyBox),
    buttonsCrossRow: cross(allowBox, rowBox) || cross(denyBox, rowBox),
    buttonsInViewport: [allowBox, denyBox].every((b) => Boolean(b && b.x >= 0 && b.right <= innerWidth && b.y >= 0 && b.bottom <= innerHeight)),
  };
}, [PERMISSION_ROW, surface] as const);

type PermissionReading = Awaited<ReturnType<typeof readPermissionRow>>;

function permissionFailures(reading: PermissionReading, headline: string, minButton: number): string[] {
  const failures: string[] = [];
  const fail = (label: string) => failures.push(label);
  if (reading.decision.text !== headline) fail(`the headline reads ${JSON.stringify(reading.decision.text)}`);
  if (!(reading.decision.scrollWidth > reading.decision.clientWidth)) fail(`the headline is not cut: ${reading.decision.scrollWidth} ≤ ${reading.decision.clientWidth}`);
  if (reading.decision.textOverflow !== "ellipsis" || reading.decision.whiteSpace !== "nowrap") fail(`the headline does not end in an ellipsis: ${reading.decision.textOverflow} / ${reading.decision.whiteSpace}`);
  if (!reading.decision.insideRow) fail(`the headline leaves its row: ${JSON.stringify(reading.decision.box)} in ${JSON.stringify(reading.row)}`);
  if (!reading.age.text || !reading.age.box || reading.age.box.width <= 0) fail(`no age: ${JSON.stringify(reading.age)}`);
  if (!reading.age.insideRow || !reading.age.insideLine) fail(`the age is clipped: ${JSON.stringify(reading.age)}`);
  if (reading.age.crossesDecision) fail("the age sits on the headline");
  for (const [name, button] of [["Allow once", reading.allow], ["Deny", reading.deny]] as const) {
    if (button.text !== name) fail(`${name} reads ${JSON.stringify(button.text)}`);
    if (!button.box || button.box.width <= 0 || button.box.height < minButton) fail(`${name} is ${JSON.stringify(button.box)}, wanted a height of ${minButton}`);
  }
  if (!reading.buttonsInsideSurface) fail("a button leaves the surface");
  if (!reading.buttonsInViewport) fail("a button is off screen");
  if (reading.buttonsCrossEachOther) fail("Allow once and Deny overlap");
  if (reading.buttonsCrossRow) fail("a button sits on the row");
  return failures;
}

browserTest("permission row: the headline truncates, the age stays, and Allow once / Deny answer from the phone sheet and the desktop popover", async () => {
  fs.mkdirSync(PERMISSION_OUT, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const headline = translate("en", "attention.decisionPermissionNamed", { request: `Bash: ${FAKE_SAFETY_COMMAND} — ${FAKE_SAFETY_REASON}` });
  const results: unknown[] = [];
  const failures: string[] = [];
  const answersOf = (page: Page) => page.evaluate(() => (window as unknown as { evidence: { permissionAnswers: Array<Record<string, unknown>> } }).evidence.permissionAnswers);
  try {
    for (const scheme of SCHEMES) {
      for (const viewport of VIEWPORTS) {
        const key = `phone-${viewport.width}-${scheme}`;
        const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: scheme });
        await context.addInitScript(() => { localStorage.setItem("llv_lang", "en"); });
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${fixtureBase}/?permission=1#p=atlas`);
          await page.waitForSelector("[data-mobile2-open='attention']", { timeout: 20_000 });
          await pause(page, 600);
          await page.locator("[data-mobile2-open='attention']").click();
          await page.waitForSelector(`[data-mobile2-sheet="attention"] ${PERMISSION_ROW}`, { timeout: 10_000 });
          await pause(page, 600);
          await page.screenshot({ path: path.join(PERMISSION_OUT, `${key}.png`) });
          const reading = await readPermissionRow(page, '[data-mobile2-sheet="attention"]');
          const own = permissionFailures(reading, headline, 44);
          await page.locator('[data-mobile2-sheet="attention"] [data-permission-deny]').click();
          await pause(page, 400);
          const answers = await answersOf(page);
          if (answers.length !== 1 || answers[0]!.decision !== "deny" || answers[0]!.requestId !== "request-safety-1") own.push(`Deny sent ${JSON.stringify(answers)}`);
          if (pageErrors.length) own.push(`page errors: ${pageErrors.join(" | ")}`);
          failures.push(...own.map((label) => `${key}: ${label}`));
          results.push({ key, reading, answers, failures: own });
          await page.close();
        } finally {
          await context.close();
        }
      }
      const key = `desktop-1280-${scheme}`;
      const context = await browser.newContext({ viewport: { width: 1_280, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
      await context.addInitScript(() => { localStorage.setItem("llv_lang", "en"); });
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/?permission=1#p=atlas`);
        await page.waitForSelector("[data-attention-count]", { timeout: 20_000 });
        await pause(page, 600);
        await page.locator("[data-attention-count]").click();
        await page.waitForSelector(PERMISSION_ROW, { timeout: 10_000 });
        await pause(page, 400);
        /* The popover is the scrolling box the row sits in. */
        const surface = await page.evaluate((selector) => {
          let node = document.querySelector(selector)?.parentElement ?? null;
          while (node && !node.className.includes("overflow-y-auto")) node = node.parentElement;
          node?.setAttribute("data-evidence-popover", "");
          return Boolean(node);
        }, PERMISSION_ROW);
        await page.screenshot({ path: path.join(PERMISSION_OUT, `${key}.png`) });
        const clip = await rectOf(page, "[data-evidence-popover]");
        if (clip) await page.screenshot({ path: path.join(PERMISSION_OUT, `${key}-popover.png`), clip: { x: Math.max(0, clip.x - 8), y: Math.max(0, clip.y - 48), width: clip.width + 16, height: clip.height + 56 } });
        const reading = await readPermissionRow(page, "[data-evidence-popover]");
        const own = surface ? permissionFailures(reading, headline, 18) : ["no popover holds the row"];
        await page.locator(`${PERMISSION_ROW} + [data-permission-actions] [data-permission-allow]`).click();
        await pause(page, 400);
        const answers = await answersOf(page);
        if (answers.length !== 1 || answers[0]!.decision !== "allow" || answers[0]!.requestId !== "request-safety-1") own.push(`Allow once sent ${JSON.stringify(answers)}`);
        if (pageErrors.length) own.push(`page errors: ${pageErrors.join(" | ")}`);
        failures.push(...own.map((label) => `${key}: ${label}`));
        results.push({ key, reading, answers, failures: own });
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.mkdirSync(PERMISSION_EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(PERMISSION_EVIDENCE, "permission-row.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 300_000);

/*
 * "Asks you" (docs/research/attention-classifier.md §7) on the phone at
 * 390 × 844, en and uk, on the fixture's `?asks=1` scene: a task whose agent
 * ended its turn asking the operator carries the «asks you» badge and the
 * sentence that asks; the seat's report log carries the ask by time among the
 * reports, «‹agent› asks you: ‹the sentence›», and the agent's name opens its
 * conversation; the ⋯ sheet carries the "Asks you" switch with this month's
 * spend.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable ASKS_YOU_PNG_DIR=… \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "Asks you"
 *
 * PNGs go to `ASKS_YOU_PNG_DIR` (default `.artifacts/asks-you`, not
 * committed); readings to `evidence/asks-you/phone.json`.
 */
browserTest("Asks you: the card, the report-log line and the ⋯ switch on the phone at 390, en and uk", async () => {
  const out = path.resolve(process.env.ASKS_YOU_PNG_DIR ?? ".artifacts/asks-you");
  const evidence = path.resolve("evidence/asks-you");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const viewport = { width: 390, height: 844 };
  try {
    for (const lang of ["en", "uk"] as const) {
      const t = (name: string, params?: Record<string, string | number>) => translate(lang, name as never, params);
      const key = `390-${lang}-light`;
      const fail = (text: string) => failures.push(`${key}: ${text}`);
      const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 3, colorScheme: "light" });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/?kanban=1&asks=1#p=atlas`);
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
        await pause(page, 800);

        /* The card: the badge names the reason, the line under it the ask. */
        await page.locator('[data-phone-kanban-tab="assigned"]').click();
        await page.waitForFunction(() => document.querySelector("[data-phone-kanban]")?.getAttribute("data-phone-kanban-active") === "assigned");
        await pagerAtRest(page);
        const askCard = page.locator('[data-phone-card="task:t-cache"]');
        await askCard.scrollIntoViewIfNeeded();
        await pause(page, 400);
        await page.screenshot({ path: path.join(out, `phone-board-${key}.png`) });
        await askCard.screenshot({ path: path.join(out, `phone-card-${key}.png`) });
        const cardReading = await page.evaluate(() => {
          const element = document.querySelector('[data-phone-card="task:t-cache"]')!;
          const ask = element.querySelector("[data-phone-card-ask]");
          return {
            badge: element.querySelector("[data-phone-card-badge]")?.textContent?.trim() ?? null,
            ask: ask?.textContent?.trim() ?? null,
            sideways: document.documentElement.scrollWidth - innerWidth,
          };
        });
        if (cardReading.badge !== t("needs.ask")) fail(`the card's badge reads ${cardReading.badge}`);
        if (!cardReading.ask?.includes("Evict by size or by age?")) fail(`the card's ask line reads ${cardReading.ask}`);
        if (cardReading.sideways > 0) fail(`the page scrolls sideways by ${cardReading.sideways}px`);

        /* The seat's report log: the ask lines, by time, their agents links. */
        await page.locator("[data-mobile2-seat-open]").click();
        await page.waitForSelector('[data-mobile2-open="reports"]', { timeout: 10_000 });
        await page.locator('[data-mobile2-open="reports"]').click();
        await page.waitForSelector("[data-report-log] [data-report-ask]", { timeout: 10_000 });
        await page.locator("[data-report-log] [data-report-ask]").first().scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        await pause(page, 500);
        await page.screenshot({ path: path.join(out, `phone-log-${key}.png`) });
        const log = await page.evaluate(() => {
          const rows = [...document.querySelectorAll("[data-report-log-entries] > li")];
          const times = rows.map((row) => Date.parse(row.querySelector("time")?.getAttribute("datetime") ?? ""));
          return {
            asks: rows.filter((row) => row.hasAttribute("data-report-ask")).map((row) => ({
              text: row.querySelector("p")?.textContent ?? "",
              link: row.querySelector("a[data-report-link=conversation]")?.getAttribute("href") ?? null,
              linkHeight: Math.round(row.querySelector("a[data-report-link=conversation]")?.getBoundingClientRect().height ?? 0),
            })),
            ordered: times.every((time, index) => index === 0 || time <= times[index - 1]!),
            sideways: document.documentElement.scrollWidth - innerWidth,
          };
        });
        if (log.asks.length !== 2) fail(`${log.asks.length} ask lines`);
        if (!log.asks[0]?.text.endsWith(t("reportLog.askLine", { gist: "Evict by size or by age? Say which and I finish the migration." }))) fail(`the first ask line reads ${log.asks[0]?.text}`);
        if (!log.asks[0]?.link?.startsWith("#c=conversation_kanban-")) fail(`the first ask links to ${log.asks[0]?.link}`);
        if (!log.ordered || log.sideways > 0) fail(`order ${log.ordered}, sideways ${log.sideways}`);

        /* The ⋯ sheet: the Asks you switch, on, with the month's spend. */
        await page.locator('[data-mobile2-open="menu"]').first().click();
        await page.waitForSelector('[data-mobile2-sheet="menu"] [data-asks-you]', { timeout: 10_000 });
        await page.locator('[data-mobile2-sheet="menu"] [data-asks-you]').scrollIntoViewIfNeeded();
        await pause(page, 500);
        await page.screenshot({ path: path.join(out, `phone-menu-${key}.png`) });
        const row = await page.evaluate(() => {
          const element = document.querySelector('[data-mobile2-sheet="menu"] [data-asks-you]')!;
          const toggle = element.querySelector<HTMLElement>("[data-asks-you-switch]")!;
          const box = toggle.getBoundingClientRect();
          return {
            state: element.getAttribute("data-asks-you"),
            hint: element.querySelector('[role="status"]')?.textContent?.trim() ?? "",
            switchSize: [Math.round(box.width), Math.round(box.height)],
            inside: box.right <= innerWidth,
          };
        });
        if (row.state !== "on" || !row.hint.includes("Jev") || row.switchSize[0]! < 44 || row.switchSize[1]! < 44 || !row.inside) fail(`the switch row ${JSON.stringify(row)}`);
        await page.locator('[data-mobile2-sheet="menu"] [data-mobile2-close]').click();
        await page.waitForFunction(() => !document.querySelector('[data-mobile2-sheet="menu"]'), undefined, { timeout: 10_000 });

        /* The agent's name opens its conversation. */
        const target = log.asks[0]?.link ?? "";
        await page.locator("[data-report-log] [data-report-ask] a[data-report-link=conversation]").first().click();
        await page.waitForFunction((hash) => location.hash === hash, target, { timeout: 10_000 }).catch(() => fail(`the link left the hash at ${page.url()}`));
        await pause(page, 1_000);
        await page.screenshot({ path: path.join(out, `phone-opened-${key}.png`) });
        const opened = await page.evaluate(() => ({ screen: document.querySelector("[data-mobile2-screen]")?.getAttribute("data-mobile2-screen") ?? null, hash: location.hash }));
        if (opened.screen !== "chat") fail(`the link opened ${JSON.stringify(opened)}`);
        results.push({ key, card: cardReading, log, row, opened });
        if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
        await page.close();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(evidence, "phone.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * Each orchestrator sets its own project's reports (orchestrator-reports
 * §5.6.1) over a post-only bot (`?bot=postonly`: another program owns its
 * updates through a webhook). On the desktop the seat row's Reports chip opens
 * the section; on the phone the seat sheet's Reports row opens its sheet. Each
 * case switches Telegram on, which writes nothing, adds a group by id in the
 * picker, which selects it, saves it for this project alone, then opens the
 * bot panel's overview and moves another project in place, which writes that
 * project alone. At 1440 and 390, en and uk. Gated: the section and the panel
 * stay inside the window with nothing scrolling sideways, the phone's buttons
 * are 44 px tall, and every write names only its own project. The closed
 * desktop chip names the setting in both states and the chat by its title
 * (the fixture's two groups have 20-character aliases that share a prefix);
 * the phone's way in, the seat sheet's Reports row, is framed first; the
 * overview carries the public-group warning above its lines.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "telegram per orchestrator"
 *
 * Frames go to `$LLV_TELEGRAM_REPORTS_OUT` (default
 * `.artifacts/telegram-per-orchestrator`), readings to
 * `evidence/telegram-bot/per-orchestrator.json`.
 */
browserTest("telegram per orchestrator: the seat's Reports section, a chat added by id, and the overview", async () => {
  const out = path.resolve(process.env.LLV_TELEGRAM_REPORTS_OUT ?? ".artifacts/telegram-per-orchestrator");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(BOT_EVIDENCE, { recursive: true });
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const results: unknown[] = [];
  const failures: string[] = [];
  const cases = [
    { viewport: { width: 1_440, height: 900 }, phone: false, lang: "en" },
    { viewport: { width: 1_440, height: 900 }, phone: false, lang: "uk" },
    { viewport: { width: 390, height: 844 }, phone: true, lang: "en" },
    { viewport: { width: 390, height: 844 }, phone: true, lang: "uk" },
  ] as const;
  /* What a surface holds: its box against the window, sideways scroll, and
     the phone's short buttons. */
  const readSurface = (page: Page, selector: string) => page.evaluate(({ selector }) => {
    const node = document.querySelector<HTMLElement>(selector);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const buttons = [...node.querySelectorAll<HTMLElement>("button, input, select")].filter((element) => element.getBoundingClientRect().height > 0);
    return {
      box: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) },
      viewport: { width: innerWidth, height: innerHeight },
      sideways: node.scrollWidth - node.clientWidth,
      short: buttons.filter((element) => element.getBoundingClientRect().height < 43.5).map((element) => `${element.tagName.toLowerCase()} ${(element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40)} ${Math.round(element.getBoundingClientRect().height)}`),
      text: node.innerText,
    };
  }, { selector });
  try {
    for (const { viewport, phone, lang } of cases) {
      const key = `${phone ? "phone" : "desktop"}-${viewport.width}-${lang}`;
      const context = await browser.newContext({ viewport, colorScheme: "light", deviceScaleFactor: 2, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
      const check = (label: string, reading: Awaited<ReturnType<typeof readSurface>>) => {
        if (!reading) { failures.push(`${key} ${label}: not shown`); return; }
        const { box, viewport: window } = reading;
        if (box.left < -1 || box.right > window.width + 1) failures.push(`${key} ${label}: leaves the window sideways ${JSON.stringify(box)}`);
        if (reading.sideways > 0) failures.push(`${key} ${label}: scrolls ${reading.sideways} px sideways`);
        if (phone && reading.short.length) failures.push(`${key} ${label}: controls under 44 px: ${JSON.stringify(reading.short)}`);
      };
      let page: Page | null = null;
      try {
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${base}/?kanban=1&bot=postonly`);
        const body = phone ? "[data-testid=mobile-seat-reports-sheet] [data-seat-reports-body]" : "[data-seat-reports-popover]";
        const label = lang === "uk" ? "Звіти" : "Reports";
        /* The closed chip: its name, its value and its tooltip, framed on the
           seat row. */
        const readChip = async (frame: string) => {
          const chip = page!.locator("[data-seat-reports-chip]").first();
          const reading = await chip.evaluate((node) => ({
            state: node.getAttribute("data-seat-reports-chip"),
            label: node.querySelector<HTMLElement>("[data-seat-reports-label]")?.innerText ?? null,
            face: node.querySelector<HTMLElement>("[data-seat-reports-face]")?.innerText ?? null,
            faceWhole: (() => { const face = node.querySelector<HTMLElement>("[data-seat-reports-face]"); return face ? face.scrollWidth <= face.clientWidth : null; })(),
            title: node.getAttribute("title"),
            row: (() => {
              const controls = node.closest("[data-orchestrator-controls]");
              const rects = controls ? [...controls.children].map((child) => child.getBoundingClientRect()).filter((rect) => rect.width > 0 && rect.height > 0) : [];
              /* One line: every control shares some height with every other. */
              const oneLine = Math.max(...rects.map((rect) => rect.top)) < Math.min(...rects.map((rect) => rect.bottom));
              return { lines: oneLine ? 1 : 2, controls: rects.map((rect) => ({ left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) })), right: Math.round(Math.max(...rects.map((rect) => rect.right))), host: Math.round(node.closest("[data-orchestrator-incumbent]")?.getBoundingClientRect().right ?? 0) };
            })(),
          }));
          const row = await page!.locator("[data-orchestrator-incumbent]").first().boundingBox();
          if (row) await page!.screenshot({ path: path.join(out, frame), clip: { x: Math.max(0, row.x - 12), y: Math.max(0, row.y - 12), width: Math.min(viewport.width - Math.max(0, row.x - 12), row.width + 24), height: row.height + 24 } });
          return reading;
        };
        let seatSheet: unknown = null;
        let chipLog: Awaited<ReturnType<typeof readChip>> | null = null;
        if (phone) {
          await page.locator("[data-mobile2-seat-controls]").first().click({ timeout: 15_000 });
          await page.waitForSelector('[data-mobile2-open="seat-reports"]', { timeout: 10_000 });
          await pause(page, 600);
          seatSheet = await page.locator('[data-mobile2-open="seat-reports"]').evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return { text: (node as HTMLElement).innerText, box: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) }, controls: document.querySelectorAll('[data-mobile2-open="seat-reports"]').length, reportLogButtons: document.querySelectorAll('[data-mobile2-open="reports"]').length };
          });
          const row = seatSheet as { text: string; box: { height: number }; controls: number };
          if (!row.text.includes(label)) failures.push(`${key}: the seat sheet's Reports row reads ${JSON.stringify(row.text)}`);
          if (row.box.height < 44) failures.push(`${key}: the seat sheet's Reports row is ${row.box.height} px tall`);
          if (row.controls !== 1) failures.push(`${key}: ${row.controls} controls carry data-mobile2-open="seat-reports"`);
          await page.screenshot({ path: path.join(out, `${key}-0-seat-sheet.png`) });
          await page.locator('[data-mobile2-open="seat-reports"]').click({ timeout: 10_000 });
        } else {
          /* The fixture's attention toasts arrive over the seat row; each is
             put away first, as the operator would. */
          await page.waitForSelector("[data-seat-reports-chip]", { timeout: 15_000 });
          await pause(page, 1_500);
          for (let round = 0; round < 5 && await page.locator("[data-attention-toast-dismiss]").count(); round += 1) {
            await page.locator("[data-attention-toast-dismiss]").first().click().catch(() => {});
            await pause(page, 400);
          }
          chipLog = await readChip(`${key}-0-chip-log.png`);
          if (chipLog.state !== "log" || chipLog.label !== label || chipLog.face !== (lang === "uk" ? "Журнал" : "Log")) failures.push(`${key}: the closed log-only chip reads ${JSON.stringify(chipLog)}`);
          if (chipLog.row.lines !== 1 || chipLog.row.right > chipLog.row.host + 1) failures.push(`${key}: the seat row's controls wrap or spill ${JSON.stringify(chipLog.row)}`);
          await page.locator("[data-seat-reports-chip]").first().click({ timeout: 15_000 });
        }
        await page.waitForSelector(`${body} [data-seat-reports-switch]`, { timeout: 10_000 });
        await pause(page, 600);
        const off = await readSurface(page, body);
        check("section off", off);
        await page.screenshot({ path: path.join(out, `${key}-1-seat-reports-off.png`) });

        await page.locator(`${body} [data-seat-reports-switch]`).click();
        await pause(page, 600);
        const picker = await readSurface(page, body);
        check("picker", picker);
        const writesAfterOn = await page.evaluate(() => (window as unknown as { evidence: { reportWrites: unknown[] } }).evidence.reportWrites.length);
        if (writesAfterOn !== 0) failures.push(`${key}: switching Telegram on wrote ${writesAfterOn} time(s)`);
        await page.screenshot({ path: path.join(out, `${key}-2-seat-reports-picker.png`) });

        await page.evaluate((selector) => { document.querySelectorAll<HTMLDetailsElement>(`${selector} details`).forEach((details) => { details.open = true; }); }, body);
        await page.locator(`${body} [data-telegram-add-chat-input]`).fill("-1000000000606");
        await page.locator(`${body} [data-telegram-add-chat-submit]`).click();
        await page.waitForSelector(`${body} [data-telegram-add-chat-added="atlas-design-reviews"]`, { timeout: 5_000 });
        await pause(page, 400);
        const selected = await page.locator(`${body} [data-seat-reports-chat="atlas-design-reviews"]`).getAttribute("aria-checked");
        if (selected !== "true") failures.push(`${key}: the chat added by id is not selected (${selected})`);
        await page.locator(`${body} [data-telegram-add-chat-added]`).scrollIntoViewIfNeeded();
        const added = await readSurface(page, body);
        check("added by id", added);
        await page.screenshot({ path: path.join(out, `${key}-3-add-by-id.png`) });

        await page.locator(`${body} [data-seat-reports-save]`).click();
        await page.waitForSelector(`${body} [data-seat-reports-saved]`, { timeout: 5_000 });
        await page.locator(`${body} [data-seat-reports-line]`).scrollIntoViewIfNeeded();
        await pause(page, 400);
        const line = await page.locator(`${body} [data-seat-reports-line]`).textContent();
        await page.screenshot({ path: path.join(out, `${key}-4-saved.png`) });
        const seatWrites = await page.evaluate(() => structuredClone((window as unknown as { evidence: { reportWrites: unknown[] } }).evidence.reportWrites));
        const expectedSeat = [{ project: "atlas", reportTelegram: { chat: "atlas-design-reviews", name: "Atlas" } }];
        if (JSON.stringify(seatWrites) !== JSON.stringify(expectedSeat)) failures.push(`${key}: the seat wrote ${JSON.stringify(seatWrites)}`);

        await page.keyboard.press("Escape");
        await pause(page, 400);
        let chipChat: Awaited<ReturnType<typeof readChip>> | null = null;
        let rowChat: string | null = null;
        if (phone) {
          rowChat = await page.locator('[data-mobile2-open="seat-reports"]').innerText({ timeout: 5_000 }).catch(() => null);
          if (!rowChat?.includes("Design review")) failures.push(`${key}: the seat sheet's Reports row reads ${JSON.stringify(rowChat)} after the save`);
          await page.keyboard.press("Escape");
          await pause(page, 300);
        } else {
          chipChat = await readChip(`${key}-4b-chip-chat.png`);
          if (chipChat.state !== "chat" || chipChat.label !== label || chipChat.face !== "Design review" || !chipChat.faceWhole || !chipChat.title?.includes("Design review")) failures.push(`${key}: the closed chat chip reads ${JSON.stringify(chipChat)}`);
          if (chipChat.row.lines !== 1 || chipChat.row.right > chipChat.row.host + 1) failures.push(`${key}: the seat row's controls wrap or spill ${JSON.stringify(chipChat.row)}`);
        }
        await openTelegramPanel(page, phone, lang);
        await page.evaluate(() => document.querySelector("[data-telegram-project-reports]")?.scrollIntoView({ block: "center" }));
        await pause(page, 500);
        const panelSelector = '[role="dialog"][aria-label="Telegram"]';
        const overview = await readSurface(page, "[data-telegram-project-reports]");
        const warning = await page.evaluate(() => {
          const node = document.querySelector<HTMLElement>("[data-telegram-project-reports-warning]");
          const first = document.querySelector<HTMLElement>("[data-telegram-project-report]");
          return node && first ? { text: node.innerText, above: node.getBoundingClientRect().bottom <= first.getBoundingClientRect().top } : null;
        });
        if (!warning?.above) failures.push(`${key}: the overview's public-group warning is missing or under the lines ${JSON.stringify(warning)}`);
        const panel = await readSurface(page, panelSelector);
        check("overview panel", panel ? { ...panel, short: phone ? (overview?.short ?? []) : [] } : null);
        await page.screenshot({ path: path.join(out, `${key}-5-overview.png`) });
        const lines = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-telegram-project-report]")].map((node) => ({ project: node.dataset.telegramProjectReport, value: node.querySelector<HTMLSelectElement>("select")?.value.replace(/\u0000/g, "") ?? null })));
        const expectedLines = [{ project: "atlas", value: "atlas-design-reviews" }, { project: "-projects-ledger", value: "team-reports" }, { project: "-projects-mesh", value: "log-only" }];
        if (JSON.stringify(lines) !== JSON.stringify(expectedLines)) failures.push(`${key}: the overview reads ${JSON.stringify(lines)}`);
        await page.locator('[data-telegram-project-report="-projects-ledger"] select').selectOption("atlas-design-reviews");
        await pause(page, 600);
        const allWrites = await page.evaluate(() => structuredClone((window as unknown as { evidence: { reportWrites: unknown[] } }).evidence.reportWrites));
        const expectedAll = [...expectedSeat, { project: "-projects-ledger", reportTelegram: { chat: "atlas-design-reviews", name: "Ledger" } }];
        if (JSON.stringify(allWrites) !== JSON.stringify(expectedAll)) failures.push(`${key}: the overview wrote ${JSON.stringify(allWrites)}`);
        await page.screenshot({ path: path.join(out, `${key}-6-overview-switched.png`) });
        if (pageErrors.length) failures.push(`${key}: page errors ${pageErrors.join(" | ")}`);
        results.push({ key, viewport, lang, seatSheet, chipLog, off, picker, added, line, chipChat, rowChat, overview, warning, lines, writes: allWrites });
      } catch (error) {
        failures.push(`${key}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        await page?.screenshot({ path: path.join(out, `${key}-failed.png`) }).catch(() => {});
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(BOT_EVIDENCE, "per-orchestrator.json"), `${JSON.stringify({ results, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * The seat deputy's block on the phone (docs/design/ghost-seat.md §6.4): the
 * production `LogFeed` of a seat over
 * `src/components/conversation/deputyBlockEvidence.fixture.tsx`, at 390 px on
 * a touch context, in both languages. The desktop half is the kanban driver's
 * «the orchestrator's parallel self in the seat's feed».
 *
 * Gated as there, plus the phone's own: a collapsed line is a 44 px target
 * across its whole width, its result shows whole on up to two lines with the
 * chevron on the first, no row inside a block is captioned with the bare
 * engine name, and the chip lines of one block share a left edge.
 */
browserTest("the orchestrator's parallel self on the phone: pinned, streaming, collapsed to a 44 px line", async () => {
  const { MEASURE_DEPUTY_BLOCKS, deputyEvidenceFailures } = await import("@/components/conversation/deputyBlockEvidence.measure");
  const { openFixture } = await import("@/components/kanban/issue1695BrowserHarness");
  const out = path.resolve(".artifacts/ghost-seat-phone");
  const evidence = path.resolve("evidence/ghost-seat");
  const pngDir = process.env.DEPUTY_PNG_DIR ?? path.join(process.env.HOME ?? "/var/tmp", "Pictures/delegatus-review/ghost-seat");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  fs.mkdirSync(pngDir, { recursive: true });
  const server = await serveEvidenceFixture(out, "src/components/conversation/deputyBlockEvidence.fixture.tsx");
  const browser = await launchChromium();
  const readings: Record<string, unknown> = {};
  const failures: string[] = [];
  try {
    for (const scenario of ["running", "interleaved", "collapsed"] as const) {
      for (const lang of ["en", "uk"] as const) {
        const label = `${scenario}-390-${lang}`;
        const opened = await openFixture(browser, `${server.base}?scenario=${scenario}`, { width: 390, height: 2400 }, "light", lang, "no-preference", true);
        try {
          await opened.page.locator("[data-deputy-block]").first().waitFor();
          await opened.page.waitForTimeout(300);
          if (scenario === "interleaved") {
            await opened.page.locator('[data-deputy-block="deputy_a"] [data-deputy-toggle]').first().click({ position: { x: 6, y: 6 } });
            await opened.page.waitForTimeout(300);
          }
          const reading = await opened.page.evaluate(MEASURE_DEPUTY_BLOCKS) as import("@/components/conversation/deputyBlockEvidence.measure").DeputyEvidenceReading;
          readings[label] = reading;
          failures.push(...deputyEvidenceFailures(reading, label, { scenario, phone: true, lang }));
          await opened.page.locator("[data-feed-state]").screenshot({ path: path.join(pngDir, `${scenario}-phone-390-${lang}.png`) });
          if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await opened.context.close();
        }
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }
  fs.writeFileSync(path.join(evidence, "phone.json"), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);

/*
 * docs/design/seat-panel-noise.md on the phone: the running conversation is an
 * orchestrator seat (`?seatnoise=<i..v>`), opened full screen at 390 px, light
 * and dark, English and Ukrainian. The cases and the per-frame checks are the
 * desktop block's (`kanbanBoard.browser.test.tsx`, "seat panel carries no
 * internal noise"): no recovery envelope text, the error chip only on the
 * stopped launch and carrying its sentence, the mandate card on the launch
 * window with no operator bubble beside it, no ToolSearch row, the runtime
 * pill on the high tier, no sideways overflow and no zero-width control.
 * Readings go to `evidence/seat-panel-noise/phone.json`.
 */
browserTest("seat panel noise: cases i-v hold no internal noise on the phone at 390, light and dark, en and uk", async () => {
  const out = path.resolve(".artifacts/seat-panel-noise-phone");
  const evidence = path.resolve("evidence/seat-panel-noise");
  fs.mkdirSync(out, { recursive: true });
  fs.mkdirSync(evidence, { recursive: true });
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const failures: string[] = [];
  const frames: Record<string, unknown> = {};
  const readPanel = (page: Page) => page.evaluate(() => {
    const root = document.body;
    const text = root.textContent ?? "";
    const visible = (root as HTMLElement).innerText;
    const toolSearch: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if ((node.nodeValue ?? "").trim().startsWith("ToolSearch")) toolSearch.push(node.nodeValue!.trim());
    const controls = [...root.querySelectorAll<HTMLElement>("button, [role=button], input, textarea, select")]
      .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
    const pill = root.querySelector("[data-runtime-pill]");
    const chips = [...root.querySelectorAll<HTMLElement>('[data-launch-chip="error"]')];

    /* b1-b3 (docs/design/seat-panel-noise.md): launch chips, MCP task rows and shell rows are one line each, cut with an ellipsis, the whole text in a tooltip. */
    const box = (el: Element) => el.getBoundingClientRect();
    const inside = (el: Element, row: Element) => box(el).right <= box(row).right + 1 && box(el).left >= box(row).left - 1;
    const launchLines = [...root.querySelectorAll<HTMLElement>("[data-launch-chip-line]")].map((row) => ({
      height: Math.round(box(row).height),
      chips: [...row.querySelectorAll<HTMLElement>("[data-launch-chip]")].map((el) => ({ kind: el.getAttribute("data-launch-chip"), title: el.getAttribute("title"), inside: inside(el, row), width: Math.round(box(el).width), tops: Math.round(box(el).top) })),
      retry: Boolean(row.querySelector("[data-launch-retry]")),
      retryInside: row.querySelector("[data-launch-retry]") ? inside(row.querySelector("[data-launch-retry]")!, row) : null,
      rowInside: box(row).right <= box(row.parentElement!).right + 1,
    }));
    const mcpRows = [...root.querySelectorAll<HTMLElement>("[data-testid=mcp-call-card] summary")].map((row) => {
      const title = row.querySelector<HTMLElement>("[data-mcp-title]")!;
      const links = [...row.querySelectorAll<HTMLElement>("[data-testid^=mcp-link-]")];
      return {
        height: Math.round(box(row).height),
        text: (title.textContent ?? "").trim(),
        titleAttr: title.getAttribute("title"),
        cut: title.scrollWidth > title.clientWidth,
        titleWidth: Math.round(box(title).width),
        links: links.map((el) => ({ text: (el.textContent ?? "").trim(), title: el.getAttribute("title"), inside: inside(el, row), width: Math.round(box(el).width), height: Math.round(box(el).height) })),
      };
    });
    const shellRows = [...root.querySelectorAll<HTMLElement>("[data-tool-row]")].filter((row) => (row.textContent ?? "").includes("ls -d /workspace")).map((row) => {
      const label = [...row.querySelectorAll<HTMLElement>("span")].find((el) => (el.textContent ?? "").includes("ls -d /workspace") && el.getAttribute("title"))!;
      return { height: Math.round(box(row).height), titleAttr: label.getAttribute("title"), cut: label.scrollWidth > label.clientWidth, inside: inside(label, row) };
    });
    return {
      launchLines,
      mcpRows,
      shellRows,
      envelope: /structured launch recovery|"phase"|\{\s*"/.test(visible),
      rawRecords: /transcript record|"type"\s*:/.test(visible),
      toolSearch,
      errorChips: chips.map((el) => ({ text: el.textContent, title: el.getAttribute("title") })),
      mandateCards: root.querySelectorAll("[data-mandate-card]").length,
      operatorBubbles: [...root.querySelectorAll("[data-outbox-entry], [data-user-bubble]")].filter((el) => (el.textContent ?? "").includes("Keep the project moving")).length,
      pill: pill ? (pill.textContent ?? "").trim() : null,
      overflowX: document.documentElement.scrollWidth - innerWidth,
      zeroWidthControls: controls.filter((el) => el.getBoundingClientRect().width < 1).map((el) => el.tagName + (el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : "")),
      answer: text.includes("Search: the verifier passed"),
    };
  });
  try {
    for (const lang of ["en", "uk"] as const) for (const scheme of SCHEMES) for (const kind of ["i", "ii", "iii", "iv", "v"] as const) {
      const label = `${kind}-390-${scheme}-${lang}`;
      /* The phone's pill names the tier by its id in every language. */
      const high = "high";
      const low = "low";
      const sentence = translate(lang, "spawnCard.failedDetail");
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: scheme });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${base}/?seatnoise=${kind}#c=${{ iv: "conversation_seat_iv-old", v: "conversation_seat_v" }[kind as string] ?? "conversation_running"}`);
        await page.waitForFunction(() => Boolean(document.querySelector("[data-feed-state]")), undefined, { timeout: 20_000 })
          .catch(async (error) => { await page.screenshot({ path: path.join(out, `${label}-stuck.png`) }); throw new Error(`${label}: ${error.message.split("\n")[0]}`); });
        await page.waitForSelector("[data-runtime-pill]", { state: "attached", timeout: 15_000 }).catch(() => undefined);
        let rotation: unknown = null;
        if (kind === "iv") {
          const before = await readPanel(page);
          await page.evaluate(() => (window as unknown as { evidence: { storeSeatProfile(): void } }).evidence.storeSeatProfile());
          if (!before.pill?.endsWith(low)) failures.push(`${label}: the codex seat's pill before the rotation reads "${before.pill}", not …${low}`);
          await page.evaluate(() => (window as unknown as { evidence: { rotateSeat(): void } }).evidence.rotateSeat());
          await page.evaluate(() => { location.hash = "#c=conversation_seat_iv-new"; });
          await page.waitForFunction(() => (document.querySelector("[data-runtime-pill]")?.textContent ?? "").includes("Opus"), undefined, { timeout: 40_000 });
          if (!before.pill?.toLowerCase().includes("5.6-sol")) failures.push(`${label}: the codex seat's pill before the rotation reads "${before.pill}", not its model 5.6-sol`);
          rotation = { before: before.pill };
        }
        if (kind === "ii" || kind === "iv" || kind === "v") {
          await page.waitForFunction(() => (document.body.textContent ?? "").includes("Search: the verifier passed"), undefined, { timeout: 25_000 }).catch(() => undefined);
        }
        await page.waitForTimeout(600);
        const read = await readPanel(page);
        await page.screenshot({ path: path.join(out, `${label}.png`) });
        frames[label] = { ...read, rotation, pageErrors };
        if (read.envelope) failures.push(`${label}: the panel prints the recovery envelope`);
        if (read.rawRecords) failures.push(`${label}: the panel prints a raw transcript record`);
        const seatModel = kind === "v" ? "5.6-sol" : "opus";
        if ((read.pill || !(kind === "i" || kind === "iii")) && !read.pill?.toLowerCase().includes(seatModel)) failures.push(`${label}: the pill reads "${read.pill}", not the seat's model ${seatModel}`);
        if (kind === "iii") {
          if (read.errorChips.length !== 1 || read.errorChips[0]!.text !== sentence) failures.push(`${label}: error chips ${JSON.stringify(read.errorChips)}`);
        } else if (read.errorChips.length) failures.push(`${label}: an error chip ${JSON.stringify(read.errorChips)}`);
        const launchWindow = kind === "i" || kind === "iii";
        if (read.mandateCards !== (launchWindow ? 1 : 0)) failures.push(`${label}: ${read.mandateCards} mandate cards`);
        if (read.operatorBubbles) failures.push(`${label}: the mandate is an operator bubble`);
        if (read.toolSearch.length) failures.push(`${label}: ToolSearch rows ${JSON.stringify(read.toolSearch)}`);
        if (!launchWindow && !read.answer) failures.push(`${label}: the transcript did not render`);
        if (!launchWindow && !read.pill?.endsWith(high)) failures.push(`${label}: the pill reads "${read.pill}", not …${high}`);
        if (launchWindow && read.pill && !read.pill.endsWith(high)) failures.push(`${label}: the pill reads "${read.pill}", not …${high}`);
        for (const line of read.launchLines) {
          if (line.height > 48) failures.push(`${label}: the launch chips wrap (${line.height}px)`);
          if (!line.rowInside || line.chips.some((chip) => !chip.inside || chip.width < 24 || !chip.title)) failures.push(`${label}: a launch chip leaves its line, is squeezed or has no tooltip ${JSON.stringify(line.chips)}`);
          if (new Set(line.chips.map((chip) => chip.tops)).size > 1) failures.push(`${label}: the launch chips sit on different lines`);
        }
        if (read.launchLines.length !== (launchWindow ? 1 : 0)) failures.push(`${label}: ${read.launchLines.length} launch chip lines`);
        if (kind === "iii" && read.launchLines[0]?.retryInside === false) failures.push(`${label}: a retry action leaves the line`);
        if (launchWindow && !read.launchLines[0]?.chips.some((chip) => chip.kind === "id")) failures.push(`${label}: the launch id chip is gone`);
        const claudeRows = kind === "ii" || kind === "iv";
        if (read.mcpRows.length !== (claudeRows ? 2 : 0)) failures.push(`${label}: ${read.mcpRows.length} MCP rows`);
        for (const row of read.mcpRows) {
          if (row.height > 48) failures.push(`${label}: the MCP row "${row.text}" wraps (${row.height}px)`);
          if (row.titleAttr !== row.text) failures.push(`${label}: the MCP row "${row.text}" does not carry its whole text as a tooltip`);
          if (row.titleWidth < 60) failures.push(`${label}: the MCP title holds ${row.titleWidth}px`);
          if (row.links.some((link) => !link.inside || link.width < 24 || link.height < 24 || !link.title)) failures.push(`${label}: an MCP action leaves its row or is squeezed ${JSON.stringify(row.links)}`);
        }
        if (claudeRows && !read.mcpRows.some((row) => row.text.includes("3f6b1c2e-8d4a-4e75-cf10-5c7d2b9e0f41") && row.links.length)) failures.push(`${label}: the task row lost its id or its action`);
        if (read.shellRows.length !== (claudeRows ? 1 : 0)) failures.push(`${label}: ${read.shellRows.length} shell rows`);
        for (const row of read.shellRows) {
          if (row.height > 48) failures.push(`${label}: the shell row wraps (${row.height}px)`);
          if (!row.titleAttr?.includes("/workspace/demo/projects/atlas-pipeline-9c1d2e3f status")) failures.push(`${label}: the shell row does not carry its whole command as a tooltip`);
        }
        if (read.overflowX > 1) failures.push(`${label}: overflows by ${read.overflowX}px`);
        if (read.zeroWidthControls.length) failures.push(`${label}: zero-width controls ${read.zeroWidthControls.join(", ")}`);
        if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); stop(); }
  fs.writeFileSync(path.join(evidence, "phone.json"), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 900_000);

/*
 * The narrow card's stage chain (docs/design/narrow-card-stage-chain.md) on the
 * phone's task screen at 390 px. A finished lane's chain is about 342 px wide,
 * so it stands its stages one under another on a rail, the fail branch
 * indented under its reviewer. The same rules the desktop shelf card is held to
 * (`stageChainMeasure.ts`), light and dark, with the touch pointer's 30 px pills.
 * STAGE_CHAIN_STAMP=before takes the "before" frames on a checkout without the
 * change and asserts nothing.
 *
 *   STAGE_CHAIN_PNG_DIR=… LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=/usr/bin/google-chrome-stable \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "narrow card"
 */
browserTest("narrow card: a finished lane on the task screen stands its stages one under another on a rail at 390, in light and dark", async () => {
  const stamp = process.env.STAGE_CHAIN_STAMP === "before" ? "before" : "after";
  const out = path.resolve(process.env.STAGE_CHAIN_PNG_DIR ?? path.join(process.env.HOME ?? ".", "Pictures/delegatus-review/stage-chain-vertical"));
  fs.mkdirSync(out, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const failures: string[] = [];
  const readings: Record<string, StageChainLane> = {};
  try {
    for (const scheme of ["light", "dark"] as const) {
      for (const task of ["t-chain-fix", "t-chain-through"] as const) {
        const key = `${task}-390-${scheme}`;
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: scheme });
        await context.addInitScript(() => { localStorage.setItem("llv_lang", "en"); });
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${fixtureBase}/?kanban=1&stage-chain=1#p=atlas`);
          await page.waitForSelector(`[data-phone-card="task:${task}"]`, { timeout: 20_000 });
          await pause(page, 600);
          await page.locator(`[data-phone-card="task:${task}"]`).click();
          await page.waitForSelector(`[data-mobile2-task="${task}"] [data-phone-task-body="${task}"]`, { timeout: 10_000 });
          /* A finished lane folds behind one row; the chain is what its row opens. */
          await page.locator("[data-phone-task-ended]").click();
          await page.waitForSelector(`[data-mobile2-task="${task}"] .pblock[data-density="task"]`, { timeout: 10_000 });
          await page.mouse.move(0, 0);
          await pause(page, 600);
          if (task === "t-chain-fix") await page.screenshot({ path: path.join(out, `${stamp}-390-phone-${scheme}.png`) });
          else await page.screenshot({ path: path.join(out, `${stamp}-390-phone-through-${scheme}.png`) });
          const lane = await page.evaluate(measureStageChain(`[data-mobile2-task="${task}"] .pblock[data-density="task"]`)) as StageChainLane | null;
          if (!lane) { failures.push(`${key}: no lane row drawn`); continue; }
          readings[key] = lane;
          expect(pageErrors).toEqual([]);
          if (stamp === "before") continue;
          failures.push(...stageChainFailures(key, lane));
          const pills = lane.steps.map((step) => Math.round(step.bottom - step.top));
          if (pills.some((height) => height < 30)) failures.push(`${key}: a pill is under the touch pointer's 30 px (${pills.join(", ")})`);
        } finally { await context.close(); }
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  const evidence = path.resolve("evidence/stage-chain-vertical");
  fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, `phone-${stamp}.json`), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
  expect(failures).toEqual([]);
}, 300_000);

describe("a new conversation's first message is a normal row on the phone", () => {
  /*
   * docs/design/first-bubble-no-raw-json.md on the phone: the cases and the
   * per-step checks are the desktop block's (`kanbanBoard.browser.test.tsx`,
   * "a new conversation's first message is a normal row") at 390 x 844 with
   * touch, light and dark, English and Ukrainian, over the fixture's
   * `?firstmessage=<p|s|f>`: p a plain spawn's prompt in the focus view, s a
   * seat created from the sheet's draft with Confirm actually pressed, f a
   * failed launch. Added here: the affordances a coarse pointer reaches (the
   * failure's resend, the row's gutter control) are at least 44 px. The phone's
   * focus view re-resolves a conversation when its path flips from `spawn:` to
   * the transcript, so the plain case reads each state as a first paint of its
   * own (`&step=<n>`); the in-page hand-off (same node, no empty frame) is the
   * desktop block's and the DOM test's. The seat case stays in one page.
   *
   *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=<chrome> \
   *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "first message is a normal row"
   *
   * Readings go to `evidence/first-message/phone.json`; frames to `.artifacts/first-message-phone/`.
   */
  const PLAIN_LINE = "Fix the failing export test.";
  const MANDATE_LINE = "Keep the project moving.";
  type Evidence = { advanceFirstMessage(): number };
  const SHEET = '[data-testid="mobile-orchestrator-sheet"]';
  /* Red as drawn: a `danger` utility with no hover/focus variant, inside the feed. */
  const RED = "(root) => [...root.querySelectorAll('[data-log-feed-scroller] [class*=\"danger\"]')].filter((el) => [...el.classList].some((token) => /^(text|bg|border|ring|outline|fill|stroke)-danger/.test(token)))";
  const ROOT = `(document.querySelector('${SHEET}') ?? document.body)`;

  const watch = (page: Page) => page.evaluate(([red, rootOf]) => {
    const reds = (0, eval)(red as string) as (root: Element) => Element[];
    const sink = { envelope: false, danger: [] as string[], outboxMax: 0, userBubbleMax: 0, mandateMax: 0, lapses: [] as string[], timeline: [] as string[] };
    (window as unknown as { __fm: typeof sink }).__fm = sink;
    const scan = () => {
      const root = (0, eval)(rootOf as string) as HTMLElement;
      if (/structured launch recovery|"phase"|\{\s*"/.test(root.innerText)) sink.envelope = true;
      for (const el of reds(root)) {
        if (el.closest("[data-outbox-failure], [data-launch-chip]")) continue;
        const mark = (el.outerHTML ?? "").slice(0, 160);
        if (!sink.danger.includes(mark)) sink.danger.push(mark);
      }
      sink.outboxMax = Math.max(sink.outboxMax, root.querySelectorAll("[data-outbox-entry]").length);
      sink.userBubbleMax = Math.max(sink.userBubbleMax, root.querySelectorAll("[data-user-bubble]").length);
      sink.mandateMax = Math.max(sink.mandateMax, root.querySelectorAll("[data-mandate-card]").length);
      /* The committed states in order, consecutive repeats folded: what the operator could have seen between two reads. */
      const state = `outbox ${root.querySelectorAll("[data-outbox-entry]").length}, bubbles ${root.querySelectorAll("[data-user-bubble]").length}, rows ${root.querySelectorAll("[data-message-row]").length}, cards ${root.querySelectorAll("[data-mandate-card]").length}, chips ${root.querySelectorAll("[data-launch-chips]").length}`;
      if (sink.timeline[sink.timeline.length - 1] !== state) sink.timeline.push(state);      /* After the first card: a state with no card means the first message is gone. */
      if (sink.mandateMax >= 1 && !root.querySelector("[data-mandate-card]") && !sink.lapses.includes(state)) sink.lapses.push(state);
    };
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    scan();
  }, [RED, ROOT] as const);

  const readPane = (page: Page, line: string, mark: boolean) => page.evaluate(({ line, mark, red, rootOf }) => {
    const reds = (0, eval)(red) as (root: Element) => Element[];
    const root = (0, eval)(rootOf) as HTMLElement;
    const visible = root.innerText;
    const rows = [...root.querySelectorAll<HTMLElement>("[data-message-row]")].filter((row) => (row.textContent ?? "").includes(line));
    const card = root.querySelector<HTMLElement>("[data-mandate-card]");
    const first = rows[0] ?? card;
    if (mark && first) first.setAttribute("data-fm-mark", "1");
    const rect = first ? first.getBoundingClientRect() : null;
    const controls = [...root.querySelectorAll<HTMLElement>("button, [role=button], input, textarea, select")]
      .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
    /* What a thumb has to hit on the message itself: the gutter control and the failure's actions. */
    const reach = [...root.querySelectorAll<HTMLElement>("[data-outbox-progress], [data-outbox-failure] button:not([data-outbox-reason]), [data-launch-retry]")]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({ label: el.getAttribute("aria-label") ?? el.getAttribute("data-outbox-progress") ?? (el.textContent ?? "").trim().slice(0, 30), width: Math.round(el.getBoundingClientRect().width), height: Math.round(el.getBoundingClientRect().height) }));
    return {
      envelope: /structured launch recovery|"phase"|\{\s*"/.test(visible),
      danger: reds(root).filter((el) => !el.closest("[data-outbox-failure], [data-launch-chip]")).length,
      rows: rows.length,
      outboxEntries: root.querySelectorAll("[data-outbox-entry]").length,
      userBubbles: [...root.querySelectorAll<HTMLElement>("[data-user-bubble]")].map((el) => `${el.parentElement?.closest("[data-message-row]") ? "row" : "bare"}: ${(el.textContent ?? "").slice(0, 40)}`),
      mandateCards: root.querySelectorAll("[data-mandate-card]").length,
      mandateOpenSections: root.querySelectorAll("[data-mandate-card] details[open]").length,
      mandateHeight: card ? Math.round(card.getBoundingClientRect().height) : null,
      rowState: rows[0]?.getAttribute("data-message-row") ?? null,
      sameNode: first ? first.hasAttribute("data-fm-mark") : null,
      rect: rect ? { top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
      failureLines: root.querySelectorAll("[data-outbox-failure]").length,
      failureText: root.querySelector("[data-outbox-failure] [data-outbox-status]")?.textContent ?? null,
      errorChips: [...root.querySelectorAll<HTMLElement>('[data-launch-chip="error"]')].map((el) => ({ text: el.textContent, title: el.getAttribute("title") })),
      reach,
      overflowX: document.documentElement.scrollWidth - innerWidth,
      zeroWidthControls: controls.filter((el) => el.getBoundingClientRect().width < 1).map((el) => el.tagName + (el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : "")),
      answered: (root.textContent ?? "").includes("Looking at the export test."),
    };
  }, { line, mark, red: RED, rootOf: ROOT });

  browserTest("cases p, s and f hold one clean row at 390, light and dark, en and uk", async () => {
    const out = path.resolve(".artifacts/first-message-phone");
    const evidence = path.resolve("evidence/first-message");
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(evidence, { recursive: true });
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    const failures: string[] = [];
    const frames: Record<string, unknown> = {};
    try {
      for (const lang of ["en", "uk"] as const) for (const scheme of SCHEMES) for (const kind of ["p", "s", "f"] as const) {
        const label = `${kind}-390-${scheme}-${lang}`;
        const sentence = translate(lang, "spawnCard.failedDetail");
        const line = kind === "s" ? MANDATE_LINE : PLAIN_LINE;
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: scheme });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        try {
          const pageErrors: string[] = [];
          const openPage = async (url: string) => {
            const opened = await context.newPage();
            opened.on("pageerror", (error) => pageErrors.push(error.message));
            await opened.goto(url);
            await opened.waitForFunction(() => Boolean(document.querySelector("[data-feed-state]")), undefined, { timeout: 20_000 })
              .catch(async (error) => { await opened.screenshot({ path: path.join(out, `${label}-stuck.png`) }); throw new Error(`${label}: ${error.message.split("\n")[0]}`); });
            return opened;
          };
          let page: Page;
          if (kind === "s") {
            page = await context.newPage();
            page.on("pageerror", (error) => pageErrors.push(error.message));
            await page.goto(`${base}/?kanban=1&seatless=donly&firstmessage=s#p=atlas`);
            await page.waitForSelector("[data-mobile2-seat-open]", { timeout: 20_000 });
            await page.locator("[data-mobile2-seat-open]").first().click();
            await page.waitForSelector('[data-orchestrator-sheet-mode="create"]', { timeout: 10_000 });
            await watch(page);
            await page.locator("[data-orchestrator-confirm]").first().click();
            /* The sheet hands off to the focused pane, so the first paint is read wherever the window is. */
            await page.waitForSelector("[data-mandate-card], [data-outbox-entry]", { state: "attached", timeout: 20_000 });
          } else {
            page = await openPage(`${base}/?firstmessage=${kind}&step=0#c=conversation_running`);
            await watch(page);
          }
          const steps = kind === "f" ? ["failed"] : ["pending", "delivered", "transcript", "answered"];
          const readings: Array<Record<string, unknown>> = [];
          const timelines: string[][] = [];
          /* The seat's mandate opened at Pending (a real tap on "Read the mandate") and its height there. */
          let openedHeight: number | null = null;
          for (const [index, step] of steps.entries()) {
            if (index > 0 && kind === "s") {
              await page.evaluate(() => (window as unknown as { evidence: Evidence }).evidence.advanceFirstMessage());
              if (step === "answered") await page.waitForFunction(() => (document.body.textContent ?? "").includes("Looking at the export test."), undefined, { timeout: 25_000 });
              else await page.waitForTimeout(1_800);
            } else if (index > 0) {
              /* The focus view re-resolves the conversation when its path flips, so each later state of the plain case is a first paint of its own. */
              const seenSoFar = await page.evaluate(() => (window as unknown as { __fm: { timeline: string[] } }).__fm.timeline);
              timelines.push(seenSoFar);
              await page.close();
              page = await openPage(`${base}/?firstmessage=${kind}&step=${index}#c=conversation_running`);
              await watch(page);
              if (step === "answered") await page.waitForFunction(() => (document.body.textContent ?? "").includes("Looking at the export test."), undefined, { timeout: 25_000 });
              await page.waitForTimeout(600);
            } else await page.waitForTimeout(600);
            const read = await readPane(page, line, false);
            await page.screenshot({ path: path.join(out, `${label}-${step}.png`) });
            readings.push({ step, ...read });
            const at = `${label} ${step}`;
            if (kind === "s" && index === 0) {
              await page.locator("[data-mandate-card] summary").first().click();
              await page.waitForTimeout(300);
              openedHeight = (await readPane(page, line, false)).mandateHeight;
              await page.screenshot({ path: path.join(out, `${label}-${step}-open.png`) });
            } else if (kind === "s") {
              if (read.mandateOpenSections !== 1) failures.push(`${at}: the mandate opened at pending is closed (${read.mandateOpenSections} open sections)`);
              if (openedHeight !== null && read.mandateHeight !== null && Math.abs(read.mandateHeight - openedHeight) > 2) failures.push(`${at}: the opened mandate is ${read.mandateHeight}px high, ${openedHeight}px at pending`);
              await page.screenshot({ path: path.join(out, `${label}-${step}-open.png`) });
            }
            if (read.envelope) failures.push(`${at}: the pane prints the recovery envelope`);
            if (read.danger) failures.push(`${at}: ${read.danger} red elements outside the failure line`);
            if (read.overflowX > 1) failures.push(`${at}: overflows by ${read.overflowX}px`);
            if (read.zeroWidthControls.length) failures.push(`${at}: zero-width controls ${read.zeroWidthControls.join(", ")}`);
            const small = read.reach.filter((control) => control.height < 44 || control.width < 44);
            if (small.length) failures.push(`${at}: touch targets under 44 px ${JSON.stringify(small)}`);
            if (kind === "f") {
              if (read.rows !== 1 || read.failureLines !== 1) failures.push(`${at}: ${read.rows} rows and ${read.failureLines} failure lines`);
              if (read.errorChips.length !== 1 || read.errorChips[0]!.text !== sentence) failures.push(`${at}: error chips ${JSON.stringify(read.errorChips)}`);
              if (read.failureText?.includes("runtime host unavailable")) failures.push(`${at}: the failure line prints the raw reason`);
              continue;
            }
            if (read.errorChips.length) failures.push(`${at}: an error chip ${JSON.stringify(read.errorChips)}`);
            if (kind === "p") {
              if (read.userBubbles.length !== 1) failures.push(`${at}: ${read.userBubbles.length} bubbles carry the prompt`);
              if (index === 0 && read.rowState !== "pending") failures.push(`${at}: the pending row reads ${read.rowState}`);
            } else if (read.mandateCards !== 1 || read.outboxEntries !== 0 || read.userBubbles.length) {
              failures.push(`${at}: ${read.mandateCards} mandate cards, ${read.outboxEntries} launch bubbles and ${read.userBubbles.length} operator bubbles ${JSON.stringify(read.userBubbles)}`);
            }
          }
          const seen = await page.evaluate(() => (window as unknown as { __fm: unknown }).__fm) as { envelope: boolean; danger: string[]; outboxMax: number; userBubbleMax: number; mandateMax: number; lapses: string[]; timeline: string[] };
          if (seen.envelope) failures.push(`${label}: the envelope showed between steps`);
          if (kind !== "f" && seen.danger.length) failures.push(`${label}: a red element showed between steps ${JSON.stringify(seen.danger)}`);
          if (kind === "p" && seen.outboxMax > 1) failures.push(`${label}: ${seen.outboxMax} launch bubbles showed at once`);
          if (kind === "s" && seen.outboxMax > 0) failures.push(`${label}: the mandate was seeded as the operator's bubble (${seen.outboxMax})`);
          if (kind === "s" && seen.mandateMax > 1) failures.push(`${label}: ${seen.mandateMax} mandate cards showed at once`);
          if (kind === "s" && seen.userBubbleMax > 0) failures.push(`${label}: the mandate showed as an operator bubble (${seen.userBubbleMax})`);
          if (kind === "s" && seen.lapses.length) failures.push(`${label}: after the first card the window held no card: ${JSON.stringify(seen.lapses)}`);
          frames[label] = { readings, seen, timelines, pageErrors };
          if (pageErrors.length) failures.push(`${label}: page errors ${pageErrors.join(" | ")}`);
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      stop();
    }
    fs.writeFileSync(path.join(evidence, "phone.json"), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
    expect(failures).toEqual([]);
  }, 1_800_000);
});

describe("fast TTS header", () => {
  browserTest("phone header renders idle, loading and playing and shares row Stop", async () => {
    const { captureFastTtsHeaders } = await import("@/components/kanban/issue1695BrowserHarness");
    const browser = await launchChromium();
    try { await captureFastTtsHeaders(browser, true); } finally { await browser.close(); }
  }, 120_000);
});

/*
 * The phone conversation's chrome (2026-10-02): the pinned message and the
 * background tasks live behind the header's ⋯ menu, nothing sits under the bar,
 * the seat's report button is back on the bar, and read-aloud sits beside each
 * assistant message and nowhere in the header.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=<chrome> \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "phone chrome"
 *
 * Frames go to `$HOME/Pictures/delegatus-review/phone-chrome/`, readings to
 * `evidence/phone-chrome/readings.json`.
 */
describe("phone chrome", () => {
  browserTest("pinned message and background tasks in the ⋯ menu, read-aloud beside the message, at 390 in en and uk, light and dark", async () => {
    const out = path.join(os.homedir(), "Pictures/delegatus-review/phone-chrome");
    const evidence = path.resolve("evidence/phone-chrome");
    fs.mkdirSync(out, { recursive: true });
    fs.mkdirSync(evidence, { recursive: true });
    const speech = { backend: "soniox", lockedByEnv: false, options: [{ id: "soniox", available: true, keyPath: "$CONFIG/soniox-api-key", model: "tts-rt-v2", voice: "Adrian", language: "en", cap: 4000 }] };
    const { base, stop } = await serveFixture({ "/api/tts/backend": speech });
    const browser = await launchChromium();
    const failures: string[] = [];
    const readings: Record<string, unknown>[] = [];
    const scenes = [
      { name: "tasks3", query: "chrome=3" },
      { name: "pinned-only", query: "chrome=0" },
      { name: "tasks8", query: "chrome=8" },
      { name: "empty", query: "chrome=0&nopin" },
    ] as const;
    /** Every visible control inside `root` that a finger has to hit, under 44 px in either direction. */
    const smallControls = (page: Page, root: string) => page.evaluate((selector) => {
      const scope = document.querySelector(selector);
      if (!scope) return ["missing"];
      return [...scope.querySelectorAll<HTMLElement>("button, a[href], [role=menuitem]")].flatMap((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return [];
        return rect.width < 43.5 || rect.height < 43.5 ? [`${node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 24)} ${Math.round(rect.width)}x${Math.round(rect.height)}`] : [];
      });
    }, root);
    try {
      for (const lang of ["en", "uk"] as const) for (const scheme of SCHEMES) for (const scene of scenes) {
        const key = `390-${lang}-${scheme}-${scene.name}`;
        const fail = (text: string) => failures.push(`${key}: ${text}`);
        const tasksOn = scene.name === "tasks3" || scene.name === "tasks8";
        const pinnedOn = scene.name !== "empty";
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: scheme });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${base}/?${scene.query}&seatnoise=ii&runtime=structured#c=conversation_running`);
          await page.waitForSelector("[data-mobile2-bar] [data-mobile2-open=menu]", { timeout: 20_000 });
          await page.waitForSelector("[data-mobile-message=agent]", { timeout: 20_000 });
          await pause(page, 900);
          /* The bar: its height, its icons, and what sits between it and the feed. */
          const frame = await page.evaluate(() => {
            const bar = document.querySelector("[data-mobile2-bar]")!.getBoundingClientRect();
            const feed = document.querySelector("[data-log-feed-scroller]")!.getBoundingClientRect();
            return {
              barHeight: bar.height, barBottom: bar.bottom, feedTop: feed.top, gap: Math.round(feed.top - bar.bottom),
              strips: document.querySelectorAll("[data-task-relations], [data-task-relations-slot], [data-flip-key]").length,
              speechInBar: document.querySelectorAll("[data-mobile2-bar] [data-tts-trigger], [data-mobile2-bar] [data-tts-header]").length,
              reports: !!document.querySelector('[data-mobile2-bar] [data-mobile2-open=reports]'),
              sideways: document.documentElement.scrollWidth - innerWidth,
              barBadge: document.querySelectorAll("[data-mobile2-bar] [data-mobile2-menu-badge], [data-mobile2-bar] [data-mobile2-notice-dot]").length,
            };
          });
          if (frame.barHeight !== 52) fail(`the bar is ${frame.barHeight}px high`);
          /* The pane's own card frame (its border and engine stripe) is the 5 px that is always there; a strip is 44 px or more. */
          if (frame.gap > 8) fail(`${frame.gap}px sit between the bar and the feed`);
          if (frame.strips) fail(`${frame.strips} strips remain under the bar`);
          if (frame.speechInBar) fail("a speech control is on the bar");
          if (!frame.reports) fail("the seat's report button is not on the bar");
          if (frame.sideways > 0) fail(`the page scrolls sideways by ${frame.sideways}px`);
          if (frame.barBadge) fail("the bar carries a badge or dot");
          const barSmall = await smallControls(page, "[data-mobile2-bar]");
          if (barSmall.length) fail(`bar controls under 44 px: ${barSmall.join(", ")}`);
          await page.screenshot({ path: path.join(out, `${key}-conversation.png`) });
          /* Read-aloud: in the message's own action row, at 44 px, with copy beside it. */
          await page.waitForSelector("[data-mobile-message-actions] [data-tts-trigger]", { timeout: 10_000 });
          const speak = await page.evaluate(() => {
            const trigger = [...document.querySelectorAll<HTMLElement>("[data-mobile-message-actions] [data-tts-trigger]")].at(-1)!;
            const rect = trigger.getBoundingClientRect();
            const row = trigger.closest("[data-mobile-message-actions]")!;
            return { width: rect.width, height: rect.height, copy: !!row.querySelector("button[aria-label]:not([data-tts-trigger])"), inMessage: !!trigger.closest("[data-mobile-message]"), header: trigger.hasAttribute("data-tts-header"), label: trigger.getAttribute("aria-label") };
          });
          if (speak.width < 44 || speak.height < 44) fail(`the read-aloud control is ${speak.width}x${speak.height}`);
          if (!speak.copy || !speak.inMessage || speak.header) fail(`the read-aloud control sits wrong: ${JSON.stringify(speak)}`);
          const messageSmall = await smallControls(page, "[data-mobile-message-actions]");
          if (messageSmall.length) fail(`message controls under 44 px: ${messageSmall.join(", ")}`);
          await page.locator("[data-mobile-message-actions]").last().scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(out, `${key}-read-aloud.png`) });
          /* The header menu, open. */
          await page.locator("[data-mobile2-bar] [data-mobile2-open=menu]").click();
          await page.waitForSelector("[data-mobile2-sheet=menu]");
          await pause(page, 500);
          const rowState = await page.evaluate(() => ({
            pinned: !!document.querySelector('[data-mobile2-menu-row=pinned]'),
            background: document.querySelector('[data-mobile2-menu-row=background]')?.textContent?.trim() ?? null,
            order: [...document.querySelectorAll("[data-mobile2-menu-row]")].slice(0, 2).map((node) => node.getAttribute("data-mobile2-menu-row")),
            sideways: document.documentElement.scrollWidth - innerWidth,
          }));
          if (rowState.pinned !== pinnedOn) fail(`pinned row ${rowState.pinned}, expected ${pinnedOn}`);
          const tasksCount = scene.name === "tasks3" ? 3 : scene.name === "tasks8" ? 8 : 0;
          const tasksLabel = translate(lang, "mobile2.chat.menuBackground", { count: tasksCount });
          if ((rowState.background !== null) !== tasksOn || (tasksOn && !rowState.background!.includes(tasksLabel))) fail(`tasks row ${JSON.stringify(rowState.background)}, expected ${tasksOn ? tasksLabel : "none"}`);
          if (rowState.sideways > 0) fail(`menu scrolls sideways by ${rowState.sideways}px`);
          const menuSmall = await smallControls(page, "[data-mobile2-sheet=menu]");
          if (menuSmall.length) fail(`menu controls under 44 px: ${menuSmall.join(", ")}`);
          await page.screenshot({ path: path.join(out, `${key}-menu.png`) });
          const sheets: Record<string, unknown> = {};
          if (pinnedOn && scene.name === "tasks3") {
            await page.locator("[data-mobile2-menu-row=pinned]").click();
            await page.waitForSelector("[data-mobile2-sheet=pinned]");
            await pause(page, 500);
            const pinned = await page.evaluate(() => ({ text: document.querySelector("[data-mobile2-pinned-item] p")?.textContent ?? "", open: document.querySelector("[data-mobile2-pinned-open]")?.textContent?.trim() ?? "", sideways: document.documentElement.scrollWidth - innerWidth }));
            if (!pinned.text.includes("Never leave a lane without an owner.")) fail("the pinned sheet does not show the full text");
            if (!pinned.open.includes(translate(lang, "mobile2.pinned.openCard"))) fail(`the pinned sheet's button reads ${pinned.open}`);
            if (pinned.sideways > 0) fail(`pinned sheet scrolls sideways by ${pinned.sideways}px`);
            const small = await smallControls(page, "[data-mobile2-sheet=pinned]");
            if (small.length) fail(`pinned sheet controls under 44 px: ${small.join(", ")}`);
            await page.screenshot({ path: path.join(out, `${key}-pinned-sheet.png`) });
            sheets.pinned = pinned;
            await page.locator("[data-mobile2-sheet=pinned] [data-mobile2-close]").click();
            await page.waitForSelector("[data-mobile2-sheet=pinned]", { state: "detached" });
            await page.locator("[data-mobile2-bar] [data-mobile2-open=menu]").click();
            await page.waitForSelector("[data-mobile2-sheet=menu]");
          }
          if (tasksOn) {
            await page.locator("[data-mobile2-menu-row=background]").click();
            await page.waitForSelector("[data-mobile2-sheet=background]");
            await pause(page, 500);
            const list = await page.evaluate(() => ({
              rows: document.querySelectorAll("[data-mobile2-sheet=background] [data-mobile2-task]").length,
              standingStop: document.querySelectorAll("[data-mobile2-sheet=background] [data-mobile2-task-stop]").length,
              hostWord: (document.querySelector("[data-mobile2-sheet=background]")?.textContent ?? "").includes("Stop host") || (document.querySelector("[data-mobile2-sheet=background]")?.textContent ?? "").includes("Зупинити хост"),
              sideways: document.documentElement.scrollWidth - innerWidth,
              sheetSideways: (() => { const body = document.querySelector<HTMLElement>("[data-mobile2-sheet=background] [data-mobile2-sheet-body]"); return body ? body.scrollWidth - body.clientWidth : 0; })(),
            }));
            const expected = scene.name === "tasks3" ? 3 : 8;
            if (list.rows !== expected) fail(`${list.rows} task rows, expected ${expected}`);
            if (list.standingStop) fail("a Stop control is visible before a task's ⋯ is opened");
            if (list.hostWord) fail("the tasks sheet says «host»");
            if (list.sideways > 0 || list.sheetSideways > 0) fail(`tasks sheet scrolls sideways (${list.sideways}/${list.sheetSideways})`);
            const listSmall = await smallControls(page, "[data-mobile2-sheet=background]");
            if (listSmall.length) fail(`tasks sheet controls under 44 px: ${listSmall.join(", ")}`);
            await page.screenshot({ path: path.join(out, `${key}-tasks-sheet.png`) });
            sheets.tasks = list;
            if (scene.name === "tasks3") {
              await page.locator("[data-mobile2-task-menu]").first().click();
              await page.waitForSelector("[data-mobile2-task-actions]");
              await pause(page, 300);
              const taskMenu = await page.evaluate(() => ({
                head: document.querySelector("[data-mobile2-task-actions]")?.firstElementChild?.textContent?.trim() ?? "",
                items: [...document.querySelectorAll("[data-mobile2-task-actions] [role=menuitem]")].map((node) => node.textContent?.trim()),
                sideways: document.documentElement.scrollWidth - innerWidth,
              }));
              const wanted = [translate(lang, "task.stopTask"), translate(lang, "task.showOutput"), translate(lang, "task.copyCommand")];
              if (!/^PID \d+$/.test(taskMenu.head)) fail(`the task menu header reads ${taskMenu.head}`);
              if (JSON.stringify(taskMenu.items) !== JSON.stringify(wanted)) fail(`the task menu holds ${JSON.stringify(taskMenu.items)}`);
              if (taskMenu.sideways > 0) fail(`task menu scrolls sideways by ${taskMenu.sideways}px`);
              const small = await smallControls(page, "[data-mobile2-task-actions]");
              if (small.length) fail(`task menu controls under 44 px: ${small.join(", ")}`);
              await page.screenshot({ path: path.join(out, `${key}-task-menu.png`) });
              sheets.taskMenu = taskMenu;
            }
          }
          if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
          readings.push({ key, frame, speak, rowState, sheets, pageErrors });
        } catch (error) {
          failures.push(`${key}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser.close();
      stop();
    }
    fs.writeFileSync(path.join(evidence, "readings.json"), `${JSON.stringify({ readings, failures }, null, 2)}\n`);
    expect(failures).toEqual([]);
  }, 900_000);
});

describe("fast TTS live latency", () => {
  const liveTest = process.env.LLV_SWIPE_BROWSER_TEST === "1" && process.env.LLV_TTS_LIVE_LATENCY === "1" ? test : test.skip;
  liveTest("interleaves ten cold baseline and candidate tap-to-speech measurements", async () => {
    const { measureFastTtsLatency } = await import("@/components/kanban/issue1695BrowserHarness");
    const browser = await launchChromium();
    try { await measureFastTtsLatency(browser); } finally { await browser.close(); }
  }, 500_000);
});

/*
 * Composer context mode (docs/design/composer-context-mode.md §9.2): the Codex
 * composer's Context toggle, its auto switching with the turn, and the context
 * row, on the real Viewer at 390 and 1440 in en and uk.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=<chrome> \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "composer context mode"
 *
 * Readings go to `evidence/composer-context-mode/readings.json`; frames to
 * `.artifacts/composer-context-mode/`, which is not committed.
 */
type ContextEvidence = {
  contextTurn: string;
  injects: Array<{ text?: string }>;
  sends: unknown[];
  injectsEchoed: number;
  setContextTurn(turn: "idle" | "running"): Promise<void>;
  publishContextReceipt(status: string, reason?: string): Promise<void>;
  echoInjects(): void;
};
const contextHook = (page: Page, call: "idle" | "running") => page.evaluate((turn) => (window as unknown as { evidence: ContextEvidence }).evidence.setContextTurn(turn), call);
const composerMode = (page: Page) => page.evaluate(() => document.querySelector("[data-composer-mode]")?.getAttribute("data-composer-mode") ?? "normal");
const toggleReading = (page: Page) => page.evaluate(() => {
  const button = document.querySelector<HTMLElement>("[data-composer-context-toggle]");
  const box = button?.getBoundingClientRect();
  return button && box ? {
    pressed: button.getAttribute("aria-pressed"), disabled: button.getAttribute("aria-disabled") === "true",
    width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10,
  } : null;
});
const waitForMode = async (page: Page, want: string, timeoutMs: number) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await composerMode(page) === want) return Date.now() - started;
    await page.waitForTimeout(25);
  }
  throw new Error(`the composer never reached mode ${want} within ${timeoutMs} ms`);
};

browserTest("composer context mode: the toggle, auto switching and the context row at 390 and 1440 in en and uk", async () => {
  const { base, stop } = await serveFixture();
  const browser = await launchChromium();
  const out = path.resolve(".artifacts/composer-context-mode");
  fs.mkdirSync(out, { recursive: true });
  const readings: Array<Record<string, unknown>> = [];
  const combos = [
    { width: 390, locale: "en", scheme: "dark" }, { width: 390, locale: "uk", scheme: "dark" }, { width: 390, locale: "en", scheme: "light" },
    { width: 1440, locale: "en", scheme: "dark" }, { width: 1440, locale: "uk", scheme: "dark" },
  ] as const;
  try {
    for (const { width, locale, scheme } of combos) {
      const phone = width === 390;
      const full = locale === "en" && scheme === "dark";
      const tag = `${width}-${locale}-${scheme}`;
      const context = await browser.newContext({ viewport: { width, height: phone ? 844 : 900 }, colorScheme: scheme, ...(phone ? { hasTouch: true, isMobile: true } : {}) });
      try {
        await context.addInitScript((lang) => localStorage.setItem("llv_lang", lang), locale);
        const page = await context.newPage();
        const reading: Record<string, unknown> = { width, locale, scheme };
        const text = (key: string) => translate(locale, key as never);

        await page.goto(`${base}/?context-mode=1#c=conversation_running`);
        const input = page.locator("textarea:visible").first();
        await page.waitForSelector("[data-composer-context-toggle]");
        await page.waitForTimeout(600);

        /* 1: idle, off; the phone's target is 44 x 44. */
        reading.idle = await toggleReading(page);
        expect((reading.idle as { pressed: string }).pressed).toBe("false");
        if (phone) expect(reading.idle).toMatchObject({ width: 44, height: 44 });
        await page.screenshot({ path: path.join(out, `${tag}-1-idle.png`) });

        /* 2: the turn starts; off at +300 ms, on by +700 ms, dashed box. */
        const started = Date.now();
        await contextHook(page, "running");
        await page.waitForTimeout(Math.max(0, 300 - (Date.now() - started)));
        expect(await composerMode(page)).toBe("normal");
        await page.waitForTimeout(Math.max(0, 700 - (Date.now() - started)));
        const onAt = Date.now() - started + await waitForMode(page, "context", 1_000);
        reading.enterMs = onAt;
        reading.running = { toggle: await toggleReading(page), borderStyle: await page.evaluate(() => getComputedStyle(document.querySelector("[data-composer-mode]")!).borderStyle) };
        expect((reading.running as { borderStyle: string }).borderStyle).toBe("dashed");
        expect((reading.running as { toggle: { pressed: string } }).toggle.pressed).toBe("true");
        await page.screenshot({ path: path.join(out, `${tag}-2-running.png`) });

        if (full) {
          /* 3: a one-second idle flicker keeps the mode. */
          await contextHook(page, "idle");
          await page.waitForTimeout(1_000);
          expect(await composerMode(page)).toBe("context");
          await contextHook(page, "running");
          await page.waitForTimeout(600);
          expect(await composerMode(page)).toBe("context");
          reading.flickerKeptContext = true;

          /* 4: idle for real: still on at +2000 ms, off by +3000 ms. */
          const idleAt = Date.now();
          await contextHook(page, "idle");
          await page.waitForTimeout(2_000 - (Date.now() - idleAt));
          expect(await composerMode(page)).toBe("context");
          reading.exitMs = Date.now() - idleAt + await waitForMode(page, "normal", 1_500);
          expect(reading.exitMs as number).toBeLessThanOrEqual(3_100);

          /* 5: a key is down when the turn starts; the switch waits out the typing quiet. */
          await input.click();
          await page.keyboard.press("a");
          const keyAt = Date.now();
          await contextHook(page, "running");
          await page.waitForTimeout(1_000);
          expect(await composerMode(page)).toBe("normal");
          await waitForMode(page, "context", 2_000);
          reading.typingGuardMs = Date.now() - keyAt;
          expect(reading.typingGuardMs as number).toBeGreaterThanOrEqual(1_450);
          await input.fill("");
        }

        /* 6: Enter in context mode files one context row within a frame and posts to inject only. */
        const line = full ? "Add the release note to the plan." : `Add the ${locale} note to the plan.`;
        await input.fill(line);
        await input.press("Enter");
        await page.waitForSelector('[data-message-intent="context"][data-outbox-state="delivering"]', { timeout: 500 });
        const posted = await page.evaluate(() => {
          const hook = (window as unknown as { evidence: ContextEvidence }).evidence;
          return { injects: hook.injects.map((body) => body.text), sends: hook.sends.length };
        });
        expect(posted.injects).toEqual([line]);
        expect(posted.sends).toBe(0);
        reading.enter = { ...posted, chip: await page.locator("[data-message-context-chip]").first().innerText() };
        await page.screenshot({ path: path.join(out, `${tag}-6-row.png`) });

        /* 7: the record lands; one bubble carries the text, confirmed, still with the chip. */
        await page.evaluate(() => (window as unknown as { evidence: ContextEvidence }).evidence.echoInjects());
        await page.evaluate(() => (window as unknown as { evidence: ContextEvidence }).evidence.publishContextReceipt("delivered"));
        await page.waitForSelector('[data-message-row="confirmed"]', { timeout: 10_000 });
        await page.waitForTimeout(400);
        reading.joined = await page.evaluate((needle) => ({
          bubbles: [...document.querySelectorAll("[data-user-bubble]")].filter((element) => element.textContent?.includes(needle)).length,
          confirmed: document.querySelectorAll('[data-message-row="confirmed"] [data-user-bubble]').length,
          chips: document.querySelectorAll("[data-message-context-chip]").length,
        }), line);
        expect(reading.joined).toMatchObject({ bubbles: 1, chips: 1 });
        await page.screenshot({ path: path.join(out, `${tag}-7-joined.png`) });

        if (full) {
          /* 8: a refused injection shows its reason and Edit, and no replay. */
          await input.fill("Second note the host refuses.");
          await input.press("Enter");
          await page.waitForSelector('[data-outbox-state="delivering"]', { timeout: 500 });
          await page.evaluate(() => (window as unknown as { evidence: ContextEvidence }).evidence.publishContextReceipt("failed", "unsupported-injection"));
          await page.waitForSelector("[data-outbox-edit]", { timeout: 5_000 });
          reading.failed = await page.evaluate(() => ({
            edit: document.querySelectorAll("[data-outbox-edit]").length,
            replay: document.querySelectorAll("[data-outbox-retry], [data-outbox-operation-retry]").length,
            text: document.querySelector("[data-outbox-edit]")?.closest("[data-outbox-entry]")?.textContent ?? "",
          }));
          expect(reading.failed).toMatchObject({ edit: 1, replay: 0 });
          expect((reading.failed as { text: string }).text.length).toBeGreaterThan(0);
          await page.screenshot({ path: path.join(out, `${tag}-8-failed.png`) });

          /* 9: an unknown fate offers Check status only. */
          await page.locator("[data-outbox-edit]").click();
          await input.fill("Third note whose answer is lost.");
          await input.press("Enter");
          await page.waitForFunction(() => (window as unknown as { evidence: ContextEvidence }).evidence.injects.length === 3, undefined, { timeout: 2_000 });
          await page.evaluate(() => (window as unknown as { evidence: ContextEvidence }).evidence.publishContextReceipt("uncertain"));
          await page.locator("[data-outbox-progress]").first().click();
          await page.waitForSelector("[data-outbox-check]", { timeout: 5_000 });
          reading.uncertain = await page.evaluate(() => ({
            check: document.querySelectorAll("[data-outbox-check]").length,
            edit: document.querySelectorAll("[data-outbox-edit]").length,
            replay: document.querySelectorAll("[data-outbox-retry], [data-outbox-operation-retry]").length,
          }));
          expect(reading.uncertain).toMatchObject({ edit: 0, replay: 0 });
          expect((reading.uncertain as { check: number }).check).toBeGreaterThan(0);
          await page.screenshot({ path: path.join(out, `${tag}-9-uncertain.png`) });
        }

        /* 11: geometry with the mode on. */
        reading.geometry = await page.evaluate(() => {
          const unit = document.querySelector<HTMLElement>('[data-testid="composer-input-unit"]');
          const all = [...(unit?.querySelectorAll<HTMLElement>("button, [role=button], select, a") ?? [])]
            .map((element) => ({ element, box: element.getBoundingClientRect() })).filter(({ box }) => box.width > 0 && box.height > 0);
          /* The voice-call button is 32 px on the phone before this change and is not part of it; it is recorded in
             `untouched` and left out of the 44 px reading. */
          const controls = all.filter(({ element }) => element.getAttribute("data-testid") !== "voice-call-button");
          const untouched = all.filter(({ element }) => element.getAttribute("data-testid") === "voice-call-button").map(({ box }) => `voice-call-button ${Math.round(box.width)}x${Math.round(box.height)}`);
          const pill = document.querySelector<HTMLElement>("[data-runtime-pill]")?.getBoundingClientRect() ?? null;
          const chip = document.querySelector<HTMLElement>("[data-composer-context-toggle]")?.getBoundingClientRect() ?? null;
          const overlaps = controls.some(({ box: a }, i) => controls.some(({ box: b }, j) => i < j
            && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5));
          const row = document.querySelector<HTMLElement>("[data-composer-context-toggle]")?.parentElement?.closest<HTMLElement>("div") ?? null;
          return {
            pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            toolsRow: row ? { scrollWidth: row.scrollWidth, clientWidth: row.clientWidth } : null,
            smallest: Math.round(Math.min(...controls.map(({ box }) => Math.min(box.width, box.height)))),
            untouched,
            small: controls.filter(({ box }) => Math.min(box.width, box.height) < 44).map(({ element, box }) => `${element.tagName.toLowerCase()}[${[...element.attributes].filter((a) => a.name.startsWith("data-") || a.name === "aria-label").map((a) => `${a.name}=${a.value}`).join(",")}] ${Math.round(box.width)}x${Math.round(box.height)}`),
            pillWidth: pill ? Math.round(pill.width) : null,
            sameLine: pill && chip ? Math.abs((pill.top + pill.height / 2) - (chip.top + chip.height / 2)) < 12 : null,
            overlaps,
          };
        });
        const geometry = reading.geometry as { pageOverflow: boolean; toolsRow: { scrollWidth: number; clientWidth: number } | null; smallest: number; pillWidth: number | null; sameLine: boolean | null; overlaps: boolean };
        expect(geometry.pageOverflow).toBe(false);
        expect(geometry.overlaps).toBe(false);
        if (geometry.toolsRow) expect(geometry.toolsRow.scrollWidth).toBeLessThanOrEqual(geometry.toolsRow.clientWidth);
        if (phone) {
          expect(geometry.smallest).toBeGreaterThanOrEqual(44);
          if (geometry.pillWidth !== null) expect(geometry.pillWidth).toBeGreaterThanOrEqual(60);
        } else if (geometry.sameLine !== null) expect(geometry.sameLine).toBe(true);
        readings.push(reading);

        /* 10: a host that has not advertised injection: a disabled toggle that says why, as text. */
        const bare = await context.newPage();
        await bare.goto(`${base}/?context-mode=noinject#c=conversation_running`);
        await bare.waitForSelector("[data-composer-context-toggle]");
        await bare.waitForTimeout(600);
        const before = await toggleReading(bare);
        await bare.locator("[data-composer-context-toggle]").click({ force: true });
        const reason = text("inject.unsupported");
        await bare.getByText(reason).first().waitFor({ state: "visible", timeout: 2_000 });
        const after = await toggleReading(bare);
        readings.push({ width, locale, scheme, noInject: { before, after, reasonVisible: true, reason } });
        expect(before).toMatchObject({ disabled: true, pressed: "false" });
        expect(after).toMatchObject({ disabled: true, pressed: "false" });
        await bare.screenshot({ path: path.join(out, `${tag}-10-noinject.png`) });
      } finally { await context.close(); }
    }
  } finally { await browser.close(); stop(); }
  const evidenceDir = path.resolve("evidence/composer-context-mode");
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, "readings.json"), `${JSON.stringify({ readings }, null, 2)}\n`);
}, 400_000);

/*
 * A task another machine runs, on the phone (docs/design/synced-task-card.md
 * §8): the board card keeps to one button and gains its lane line and a
 * passive host line under the remote stripe; the task screen draws each remote
 * lane in a frame with no control, the chain standing vertical in its 342 px,
 * and a passive host pill where "+ Agent" was. `LLV_SYNCED_PHASE=before`
 * against a checkout without the change renders the same scene and only takes
 * pictures and the local card's readings; the default `after` also fails on
 * every measurement. Pictures go to `SYNCED_TASK_OUT`, else the review folder.
 */
describe("synced task card on the phone", () => {
  const PHASE = process.env.LLV_SYNCED_PHASE === "before" ? "before" : "after";
  const SELF = ["11111111", "1111", "4111", "8111", "111111111111"].join("-");
  const STAGE = ["22222222", "2222", "4222", "8222", "222222222222"].join("-");
  const KEY = `repo-${"a".repeat(32)}`;
  const OUT_DIR = process.env.SYNCED_TASK_OUT ?? path.join(os.homedir(), "Pictures/delegatus-review/synced-task");
  const lane = (k: string, taskId: string, state: string, g: Array<Record<string, unknown>>, at: number) => ({ k: `l:${k}`, p: KEY, tk: [taskId], s: state, at, g, peer: "Stage", install: STAGE, stale: false, asOf: Date.now() });
  const feed = () => {
    const now = Date.now();
    return {
      agents: [], self: SELF, hosts: { [STAGE]: { label: "Stage", linked: true } },
      lanes: [
        lane("5e0a41c2", "t-rem-run", "running", [
          { id: "build", ro: "builder", st: "passed", n: 1, e: "codex", m: "gpt-6.1-sol" },
          { id: "review", ro: "reviewer", st: "running", n: 2, r: 2, f: { to: "fix", max: 3, u: 1 }, e: "claude", m: "claude-opus-5" },
          { id: "fix", ro: "builder", st: "pending", b: 1, e: "codex", m: "gpt-6.1-sol" },
        ], now - 4 * 60_000),
        lane("a1b2c3d4", "t-rem-wait", "needs_decision", [
          { id: "build", ro: "builder", st: "passed", n: 1, e: "codex", m: "gpt-6.1-sol" },
          { id: "review", ro: "reviewer", st: "needs_decision", n: 1, fc: 2, e: "claude", m: "claude-opus-5" },
        ], now - 14 * 60_000),
        lane("0badc0de", "t-rem-done", "completed", [
          { id: "build", ro: "builder", st: "passed", n: 1, e: "codex", m: "gpt-6.1-sol" },
          { id: "review", ro: "reviewer", st: "passed", n: 1, e: "claude", m: "claude-opus-5" },
        ], now - 3 * 3_600_000),
      ],
    };
  };
  const readLocal = (page: Page) => page.locator('[data-phone-card="task:t-favicon"]').evaluate((node) => {
    const style = getComputedStyle(node);
    return { width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height), backgroundImage: style.backgroundImage,
      backgroundColor: style.backgroundColor, boxShadow: style.boxShadow, text: (node.textContent ?? "").replace(/\d+[smhd]\b/g, "N").replace(/\s+/g, " ").trim() };
  });

  browserTest("remote cards and the task screen read at a glance at 390, light and dark, en and uk", async () => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const { base, stop } = await serveFixture({ "/api/links/agents": feed() });
    const browser = await launchChromium();
    const failures: string[] = [];
    try {
      for (const scheme of SCHEMES) for (const lang of ["en", "uk"] as const) {
        const tag = `${scheme}-${lang}`;
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: scheme, reducedMotion: "reduce" });
        await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
        try {
          const page = await context.newPage();
          const pageErrors: string[] = [];
          page.on("pageerror", (error) => pageErrors.push(error.message));
          await page.goto(`${base}/?kanban=1&synced=1#p=${KEY}`);
          await page.waitForSelector('[data-phone-card="task:t-rem-run"]', { timeout: 20_000 });
          await pause(page, 800);
          const local = await readLocal(page);
          const localFile = path.join(OUT_DIR, `before-phone-local-card-${tag}.json`);
          if (PHASE === "before") fs.writeFileSync(localFile, `${JSON.stringify(local, null, 2)}\n`);
          else if (fs.existsSync(localFile)) expect(local).toEqual(JSON.parse(fs.readFileSync(localFile, "utf8")));
          const cardSel = (id: string) => `[data-phone-card="task:${id}"]`;
          await page.locator(cardSel("t-rem-run")).scrollIntoViewIfNeeded();
          await pause(page, 300);
          await page.screenshot({ path: path.join(OUT_DIR, `${PHASE}-phone-390-board-${tag}.png`) });
          for (const id of ["t-rem-run", "t-rem-wait", "t-rem-old"]) {
            await page.locator(cardSel(id)).scrollIntoViewIfNeeded();
            await page.locator(cardSel(id)).screenshot({ path: path.join(OUT_DIR, `${PHASE}-phone-390-card-${id.replace("t-rem-", "")}-${tag}.png`) });
          }
          if (PHASE === "after") {
            for (const id of ["t-rem-run", "t-rem-wait", "t-rem-old"]) {
              const read = await page.locator(cardSel(id)).evaluate((node) => {
                const rect = node.getBoundingClientRect();
                const host = node.querySelector<HTMLElement>("[data-phone-card-host]");
                return {
                  tag: node.tagName, nested: node.querySelectorAll("button, a, input").length, stripe: getComputedStyle(node).backgroundImage.includes("repeating-linear-gradient"),
                  shadow: getComputedStyle(node).boxShadow, host: host?.textContent ?? null,
                  hostClipped: Boolean(host && host.scrollWidth > host.clientWidth + 0.5 && getComputedStyle(host.querySelector("span:last-child")!).textOverflow !== "ellipsis"),
                  inside: rect.left >= -0.5 && rect.right <= innerWidth + 0.5, pills: [...node.querySelectorAll<HTMLElement>(".pb-pill[data-stage]")].map((pill) => pill.dataset.stage),
                };
              });
              const fail = (what: string) => failures.push(`${tag} ${id}: ${what}`);
              if (read.tag !== "BUTTON" || read.nested) fail(`the card is not one button with nothing inside (${read.tag}, ${read.nested})`);
              if (!read.stripe) fail("no pinstripe in its computed background");
              if (!read.shadow.includes("inset")) fail(`no tinted line in its shadow: ${read.shadow}`);
              if (read.host !== translate(lang, "kanban.remote.managedOn", { host: "Stage" })) fail(`host line reads ${read.host}`);
              if (read.hostClipped || !read.inside) fail("the host line is clipped or the card leaves the screen");
              if (id === "t-rem-old" && read.pills.length) fail("an older peer's card draws a scheme");
              if (id !== "t-rem-old" && !read.pills.length) fail("no stage pills on a card whose peer sent lanes");
            }
          }
          /* The finished card waits on the Done tab. */
          await page.locator('[data-phone-kanban-tab="done"]').click();
          await pause(page, 500);
          await page.locator(cardSel("t-rem-done")).scrollIntoViewIfNeeded().catch(() => {});
          await page.screenshot({ path: path.join(OUT_DIR, `${PHASE}-phone-390-done-${tag}.png`) });
          await page.locator('[data-phone-kanban-tab="assigned"]').click();
          await pause(page, 400);
          for (const id of ["t-rem-run", "t-rem-wait"]) {
            await page.locator(cardSel(id)).scrollIntoViewIfNeeded();
            await page.locator(cardSel(id)).click();
            await page.waitForSelector(`[data-phone-task-body="${id}"]`, { timeout: 10_000 });
            await pause(page, 500);
            await page.screenshot({ path: path.join(OUT_DIR, `${PHASE}-phone-390-task-${id.replace("t-rem-", "")}-${tag}.png`) });
            if (PHASE === "after") {
              const read = await page.evaluate(() => {
                const bar = document.querySelector<HTMLElement>("[data-phone-task-bar]")!;
                const pill = bar.querySelector<HTMLElement>("[data-phone-task-host]");
                const status = bar.querySelector<HTMLElement>("[data-phone-task-status-pill]")!;
                const frame = document.querySelector<HTMLElement>("[data-phone-task-remote-lanes] .phone-lane");
                const tops = [...(frame?.querySelectorAll<HTMLElement>(".pb-pill[data-stage]") ?? [])].map((node) => Math.round(node.getBoundingClientRect().top));
                const pillRect = pill?.getBoundingClientRect();
                const statusRect = status.getBoundingClientRect();
                return {
                  pill: pill?.textContent ?? null, pillHeight: pillRect ? Math.round(pillRect.height) : 0, pillTag: pill?.tagName ?? null,
                  add: Boolean(bar.querySelector("[data-phone-task-add-agent]")), barOverflow: bar.scrollWidth > bar.clientWidth + 0.5,
                  pillOverlapsStatus: Boolean(pillRect && pillRect.left < statusRect.right && pillRect.right > statusRect.left),
                  frameStripe: frame ? getComputedStyle(frame).backgroundImage.includes("repeating-linear-gradient") : false,
                  frameControls: frame?.querySelectorAll("button, a, input").length ?? -1,
                  vertical: tops.length > 1 && tops.every((top, index) => index === 0 || top > tops[index - 1]!), pills: tops.length,
                  note: frame?.querySelector("[data-managed-on]")?.textContent ?? null, overflowX: document.documentElement.scrollWidth - innerWidth,
                };
              });
              const fail = (what: string) => failures.push(`${tag} task ${id}: ${what}`);
              if (read.pill !== translate(lang, "kanban.remote.managedOn", { host: "Stage" }) || read.pillTag !== "SPAN") fail(`host pill is ${read.pillTag} "${read.pill}"`);
              if (read.pillHeight < 44) fail(`host pill is ${read.pillHeight} px tall`);
              if (read.add) fail("+ Agent is still offered");
              if (read.barOverflow || read.pillOverlapsStatus) fail("the bottom bar overflows or its two pills overlap");
              if (!read.frameStripe) fail("the remote lane frame has no stripe");
              if (read.frameControls !== 0) fail(`${read.frameControls} controls inside the remote lane`);
              if (!read.vertical) fail("the chain does not stand vertical in the 342 px lane");
              if (id === "t-rem-wait" && !read.note?.includes(translate(lang, "pipelineBlock.remote.decisionTail", { host: "Stage" }))) fail(`the waiting lane says "${read.note}"`);
              if (read.overflowX > 0.5) fail("the page overflows sideways");
            }
            await page.goBack();
            await page.waitForSelector(cardSel(id), { timeout: 10_000 });
            await pause(page, 400);
          }
          if (pageErrors.length) failures.push(`${tag}: page errors ${pageErrors.join(" | ")}`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); stop(); }
    if (failures.length) throw new Error(failures.join("\n"));
  }, 400_000);
});

/*
 * Tool call context tokens (docs/design/tool-call-tokens.md): the feed's real
 * tool rows, drawn from one parsed conversation that holds a call in each of
 * the four bands, a pair sharing a measured round, a call with nothing to
 * count, and the worst-case row of §11 — an error chip, 59 s and ~99.9k —
 * at 390 and 1440 px, light and dark, in both languages.
 *
 *   LLV_SWIPE_BROWSER_TEST=1 CHROME_BIN=google-chrome-stable \
 *     CONTEXT_TOKENS_PNG_DIR=docs/design/tool-call-tokens \
 *     bun test src/components/mobile/issue1671Evidence.browser.test.tsx -t "tool call context tokens"
 */
describe("tool call context tokens", () => {
  const measureRows = `(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    const lineHeight = parseFloat(getComputedStyle(document.body).lineHeight) || 16;
    const rows = [...document.querySelectorAll('[data-tool-row], [data-testid="mcp-call-card"] summary')].map((row) => {
      const caption = row.querySelector("[data-context-tokens]");
      const title = row.querySelector("span.flex-1");
      const value = caption && caption.querySelector("span:not([aria-hidden])");
      const cap = caption ? box(caption) : null;
      const r = box(row);
      return {
        label: (row.textContent || "").trim().slice(0, 70),
        row: r,
        caption: cap,
        band: caption ? Number(caption.getAttribute("data-context-band")) : null,
        basis: caption ? caption.getAttribute("data-context-basis") : null,
        text: caption ? caption.textContent : null,
        title: caption ? caption.getAttribute("title") : null,
        color: value ? getComputedStyle(value).color : null,
        weight: value ? Number(getComputedStyle(value).fontWeight) : null,
        titleWidth: title ? box(title).width : null,
        pushedOut: [...row.children].filter((child) => box(child).right > r.right + 0.5).map((child) => (child.textContent || "").trim().slice(0, 20) + " +" + Math.round(box(child).right - r.right) + "px"),
        oneLine: cap ? cap.height < lineHeight * 1.6 : null,
        inside: cap ? cap.left >= r.left - 0.5 && cap.right <= r.right + 0.5 && cap.top >= r.top - 1 && cap.bottom <= r.bottom + 1 : null,
      };
    });
    return { rows, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth };
  })()`;

  type Reading = {
    label: string; row: { height: number }; caption: { height: number } | null; band: number | null; basis: string | null;
    text: string | null; title: string | null; color: string | null; weight: number | null; titleWidth: number | null;
    oneLine: boolean | null; inside: boolean | null; pushedOut: string[];
  };

  browserTest("every band, the shared pair and the worst-case row hold their geometry in both themes and languages", async () => {
    const { openFixture } = await import("@/components/kanban/issue1695BrowserHarness");
    const pngDir = path.resolve(process.env.CONTEXT_TOKENS_PNG_DIR ?? ".artifacts/context-tokens");
    fs.mkdirSync(pngDir, { recursive: true });
    const server = await serveEvidenceFixture(OUT, "src/components/feed/__fixtures__/contextTokens.fixture.tsx");
    const browser = await launchChromium();
    const failures: string[] = [];
    const readings: Record<string, unknown> = {};
    try {
      for (const width of [390, 1440]) {
        for (const scheme of SCHEMES) {
          for (const lang of ["en", "uk"] as const) {
            const tag = `${width}px ${scheme} ${lang}`;
            const { context, page, pageErrors } = await openFixture(browser, server.base, { width, height: 1500 }, scheme, lang, "no-preference", width < 500, width < 500 ? 2 : 1);
            try {
              await page.locator("[data-context-tokens-feed]").waitFor();
              const read = await page.evaluate(measureRows) as { rows: Reading[]; scrollWidth: number; clientWidth: number };
              readings[tag] = read.rows.map((row) => ({ label: row.label, band: row.band, basis: row.basis, text: row.text, height: row.row.height, titleWidth: row.titleWidth }));
              const captions = read.rows.filter((row) => row.caption);
              if (!read.rows.some((row) => row.label.includes("Listing pipelines") && row.caption)) failures.push(`${tag}: the MCP row carries no caption`);
              const bare = read.rows.find((row) => !row.caption && row.label.includes("ls tmp"));
              if (!bare) failures.push(`${tag}: the uncaptioned baseline row is missing`);
              const bands = new Set(captions.map((row) => row.band));
              for (const band of [0, 1, 2, 3]) if (!bands.has(band)) failures.push(`${tag}: no row in band ${band}`);
              for (const row of captions) {
                const at = `${tag} "${row.label}"`;
                if (!row.oneLine) failures.push(`${at}: the caption wraps`);
                if (!row.inside) failures.push(`${at}: the caption leaves its row`);
                if (row.pushedOut.length) failures.push(`${at}: ${row.pushedOut.join(", ")} is pushed past the row's edge`);
                if (bare && Math.abs(row.row.height - bare.row.height) > 1) failures.push(`${at}: row is ${row.row.height}px, baseline ${bare.row.height}px`);
                if (width === 390 && (row.titleWidth ?? 0) < 96) failures.push(`${at}: the title keeps only ${row.titleWidth}px`);
                if (!row.title || !/\d/.test(row.title)) failures.push(`${at}: no hover title`);
                if ((row.basis === "measured") === (row.text ?? "").includes("~")) failures.push(`${at}: basis ${row.basis} but caption "${row.text}"`);
              }
              /* Each band reads heavier than the one below: the colours differ and the weight never drops. */
              const byBand = [0, 1, 2, 3].map((band) => captions.find((row) => row.band === band));
              for (let band = 1; band < 4; band += 1) {
                const low = byBand[band - 1]; const high = byBand[band];
                if (low && high && low.color === high.color) failures.push(`${tag}: bands ${band - 1} and ${band} share the colour ${high.color}`);
                if (low && high && (high.weight ?? 0) < (low.weight ?? 0)) failures.push(`${tag}: band ${band} is lighter than band ${band - 1}`);
              }
              if ((byBand[3]?.weight ?? 0) < 600) failures.push(`${tag}: band 3 is not semibold`);
              const worst = captions.find((row) => row.text?.includes("99.9k"));
              if (!worst) failures.push(`${tag}: the worst-case row is missing`);
              const unit = lang === "uk" ? "токен" : "token";
              if (!captions.every((row) => (row.title ?? "").includes(unit))) failures.push(`${tag}: a hover title is not in ${lang}`);
              if (read.scrollWidth > read.clientWidth + 0.5) failures.push(`${tag}: the page overflows sideways`);
              if (pageErrors.length) failures.push(`${tag}: page errors ${pageErrors.join(" | ")}`);
              await page.locator("[data-context-tokens-feed]").screenshot({ path: path.join(pngDir, `tool-call-tokens-${width}-${scheme}-${lang}.png`) });
            } finally { await context.close(); }
          }
        }
      }
    } finally { await browser.close(); server.stop(); }
    fs.mkdirSync("evidence/tool-call-tokens", { recursive: true });
    fs.writeFileSync("evidence/tool-call-tokens/rows.json", `${JSON.stringify({ readings }, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join("\n"));
  }, 120_000);
});

browserTest("task chip: the phone task screen's Ask button attaches the task and opens the orchestrator's conversation", async () => {
  /* The phone's card is one button (#699), so the task chip's button sits where the phone keeps the card's
     actions: the opened task's bottom bar, beside «+ Agent». Pressing it attaches the task as a chip and opens
     the seat's conversation over the task screen, with the chip above the composer and the input empty. */
  const OUT_CHIP = path.resolve(".artifacts/task-chip-phone");
  const EVIDENCE_CHIP = path.resolve("evidence/task-chip-to-orchestrator");
  fs.mkdirSync(OUT_CHIP, { recursive: true });
  fs.mkdirSync(EVIDENCE_CHIP, { recursive: true });
  const { base: fixtureBase, stop } = await serveFixture();
  const browser = await launchChromium();
  const failures: string[] = [];
  const readings: Record<string, unknown>[] = [];
  try {
    for (const lang of ["en", "uk"] as const) {
      const key = `390-${lang}`;
      const fail = (label: string) => failures.push(`${key}: ${label}`);
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "light" });
      await context.addInitScript((language) => { localStorage.setItem("llv_lang", language); }, lang);
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${fixtureBase}/?kanban=1#p=atlas`);
        await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
        await pause(page, 600);
        const cardSelector = '[data-phone-card-kind="task"]';
        await page.locator(cardSelector).first().click();
        await page.waitForSelector("[data-phone-task-ask-orchestrator]", { timeout: 10_000 });
        await pause(page, 400);
        const bar = await page.evaluate(() => {
          const ask = document.querySelector<HTMLElement>("[data-phone-task-ask-orchestrator]")!;
          const bar = ask.closest<HTMLElement>("[data-phone-task-bar]")!;
          const box = ask.getBoundingClientRect();
          const barBox = bar.getBoundingClientRect();
          const text = (node: Element) => node.textContent?.replace(/\s+/g, " ").trim() ?? "";
          return {
            label: ask.getAttribute("aria-label"), text: text(ask), height: Math.round(box.height), width: Math.round(box.width),
            inside: box.left >= barBox.left - 1 && box.right <= barBox.right + 1,
            overflow: bar.scrollWidth - bar.clientWidth,
            siblings: [...bar.querySelectorAll("button")].map((button) => ({ text: text(button), right: Math.round(button.getBoundingClientRect().right) })),
          };
        });
        await page.screenshot({ path: path.join(OUT_CHIP, `task-bar-${lang}.png`) });
        await page.click("[data-phone-task-ask-orchestrator]");
        const opened = await page.waitForSelector("[data-task-chip]", { timeout: 10_000 }).then(() => true, () => false);
        await pause(page, 500);
        const chip = opened ? await page.evaluate(() => {
          const node = document.querySelector<HTMLElement>("[data-task-chip]")!;
          const box = node.getBoundingClientRect();
          const textarea = [...document.querySelectorAll<HTMLTextAreaElement>("textarea")].find((area) => area.getBoundingClientRect().height > 0);
          return { text: node.textContent?.replace(/\s+/g, " ").trim() ?? "", inView: box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth, removeHeight: Math.round(node.querySelector<HTMLElement>("[data-task-chip-remove]")!.getBoundingClientRect().height), draft: textarea?.value ?? null };
        }) : null;
        await page.screenshot({ path: path.join(OUT_CHIP, `chip-composer-${lang}.png`) });
        readings.push({ key, bar, opened, chip });
        if (bar.text !== translate(lang, "taskChip.ask")) fail(`the button says ${JSON.stringify(bar.text)}`);
        if (bar.height < 44) fail(`the button is ${bar.height} px tall, under the 44 px target`);
        if (!bar.inside || bar.overflow > 0) fail(`the bar's row overflows ${JSON.stringify(bar)}`);
        if (!opened) fail("no chip reached a composer after the press");
        else if (!chip!.inView || chip!.draft !== "") fail(`the chip ${JSON.stringify(chip)}`);
        if (pageErrors.length) fail(`page errors ${pageErrors.join(" | ")}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    stop();
  }
  fs.writeFileSync(path.join(EVIDENCE_CHIP, "phone.json"), `${JSON.stringify(readings, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 180_000);

describe("agent memory isolation", () => {
  browserTest("memory Needs-you row names the stage and limit in en and uk", async () => {
    const out = path.resolve(".artifacts/agent-memory-phone");
    fs.mkdirSync(out, { recursive: true });
    const server = await serveEvidenceFixture(out, "src/components/attention/needsYouPanel.fixture.tsx");
    const browser = await launchChromium();
    const cases: Record<string, unknown>[] = [];
    try {
      for (const locale of ["en", "uk"] as const) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: "light", reducedMotion: "reduce" });
        try {
          await context.addInitScript((lang) => localStorage.setItem("llv_lang", lang), locale);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${server.base}?lang=${locale}&memory=1&open=1`);
          await page.locator('[data-mobile2-open="attention"]').click();
          const row = page.locator("[data-needs-you-row]").filter({ hasText: locale === "en" ? "Killed: out of memory" : "Зупинено: нестача пам’яті" });
          await row.waitFor({ timeout: 15000 });
          expect(await row.innerText()).toContain(locale === "en" ? "build · limit 15 GB" : "build · ліміт 15 ГБ");
          await row.scrollIntoViewIfNeeded();
          const geometry = await row.evaluate((element) => ({ width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right, overflow: document.documentElement.scrollWidth > innerWidth }));
          expect(geometry.right).toBeLessThanOrEqual(390);
          expect(geometry.overflow).toBeFalse();
          expect(errors).toEqual([]);
          await page.screenshot({ path: path.join(out, `${locale}.png`) });
          cases.push({ locale, ...geometry, errors });
        } finally { await context.close(); }
      }
      fs.mkdirSync("evidence/agent-memory", { recursive: true });
      fs.writeFileSync("evidence/agent-memory/phone.json", JSON.stringify({ driver: "src/components/mobile/issue1671Evidence.browser.test.tsx", cases }, null, 2) + "\n");
    } finally { await browser.close(); server.stop(); }
  }, 90000);
});
browserTest("stage agent row: conversations, parked questions and earlier attempts at phone and desktop widths", async () => {
  const { base, stop } = await serveFixture();
  const browser = await launchChromium().catch((error) => { stop(); throw error; });
  const out = path.resolve(".artifacts/stage-open-agent");
  fs.mkdirSync(out, { recursive: true });
  const readings: unknown[] = [];
  try {
    for (const width of [390, 1440]) for (const lang of ["en", "uk"] as const) for (const state of ["running", "passed", "failed", "needs_decision"]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: "dark" });
      try {
        await context.addInitScript((locale) => localStorage.setItem("llv_lang", locale), lang);
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${base}/?kanban=1&stage-agent=${state}#p=atlas`);
        if (width === 390) {
          await page.locator('[data-phone-card="task:t-data"]').waitFor();
          await page.locator('[data-phone-card="task:t-data"]').click();
          if (state === "passed") await page.locator('[data-phone-task-ended]').click();
          await page.locator('[data-phone-task-lane="lane-decision"] [data-open-stages]').click();
        } else {
          await page.locator('.card[data-id="task:t-data"]').waitFor();
          await page.locator('.card[data-id="task:t-data"] [data-open-stages="lane-decision"]').click();
        }
        const stage = page.locator(width === 390 ? '[data-mobile2-pipeline="lane-decision"] .pb-stage[data-stage="design"]' : '[data-stages-sheet] .pane[data-stage="design"]');
        const open = stage.locator('[data-open-conversation="design"]');
        await open.waitFor();
        expect(await open.innerText()).toBe(lang === "uk" ? "Відкрити агента" : "Open agent");
        const box = await open.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.width).toBeGreaterThan(50);
        if (width === 390) expect(box!.height).toBeGreaterThanOrEqual(44);
        const question = stage.locator('[data-stage-question="design"]');
        if (state === "needs_decision") {
          expect(await question.innerText()).toContain("Яке компонування обрати?");
          const geometry = await question.evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth, whiteSpace: getComputedStyle(element).whiteSpace }));
          expect(geometry.scroll).toBeLessThanOrEqual(geometry.width);
          expect(geometry.whiteSpace).toBe("pre-wrap");
          if (width === 1440) {
            expect(await question.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
            await question.focus();
            await page.keyboard.press("End");
            await page.waitForFunction(() => {
              const element = document.querySelector('[data-stage-question="design"]');
              return !!element && element.scrollTop + element.clientHeight >= element.scrollHeight - 1;
            }, undefined, { timeout: 5_000 });
            const buttonReachable = await open.evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
            });
            expect(buttonReachable).toBe(true);
          }
        } else expect(await question.count()).toBe(0);
        await stage.screenshot({ path: path.join(out, `${width}-${lang}-${state}.png`) });
        if (width === 390) {
          await stage.locator('details summary').click();
          expect(await stage.locator('[data-open-attempt="1"]').isVisible()).toBe(true);
          await stage.locator('[data-open-attempt="1"]').click();
          await page.locator('[data-mobile2-conversation]').waitFor();
          await page.goBack();
          await open.waitFor();
        } else {
          await stage.locator('[data-attempt="1"]').click();
          expect(await stage.locator('[data-kanban-reader]').count()).toBe(1);
        }
        if (width === 1440) expect(await stage.locator('[data-attempt="1"]').isVisible()).toBe(true);
        await open.click();
        if (width === 1440) {
          await page.locator('[data-stages-sheet]').waitFor({ state: "detached", timeout: 5_000 });
        }
        const reader = page.locator(width === 390 ? '[data-mobile2-conversation="conversation_kanban-1"]' : '[data-kanban-reader="conversation_kanban-1"]').filter({ has: page.locator('textarea') });
        await reader.waitFor();
        expect(await reader.isVisible()).toBe(true);
        expect(await reader.evaluate((element) => element.closest('[data-stages-sheet]') === null)).toBe(true);
        const composer = reader.locator('textarea').first();
        expect(await composer.isEnabled()).toBe(true);
        await composer.scrollIntoViewIfNeeded();
        const visibleComposer = await composer.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const x = rect.x + rect.width / 2;
          const y = rect.y + rect.height / 2;
          return x > 0 && x < innerWidth && y > 0 && y < innerHeight
            && element.contains(document.elementFromPoint(x, y));
        });
        expect(visibleComposer).toBe(true);
        await composer.fill("Use the compact layout.");
        await page.screenshot({ path: path.join(out, `${width}-${lang}-${state}-reader.png`) });
        await composer.press("Enter");
        await page.waitForFunction(() => (window as unknown as { evidence: { sends: Array<{ text?: string; path?: string; conversationId?: string }> } }).evidence.sends.some((send) => send.text === "Use the compact layout." && (send.path === "/repo/kanban-1.jsonl" || send.conversationId === "conversation_kanban-1")));
        readings.push({ width, lang, state, buttonHeight: box!.height, readerOutsideSheet: true, visibleComposer, composerEnabled: true, sends: await page.evaluate(() => (window as unknown as { evidence: { sends: unknown[] } }).evidence.sends.length) });
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    }
    fs.writeFileSync(path.join(out, "geometry.json"), JSON.stringify(readings, null, 2));
    fs.mkdirSync("evidence/stage-open-agent", { recursive: true });
    fs.writeFileSync("evidence/stage-open-agent/geometry.json", JSON.stringify(readings, null, 2) + "\n");
  } finally { await browser.close(); stop(); }
}, 180_000);

describe("seat hand-over with evidence answered last", () => {
  browserTest("Claude and Codex keep the opened card at 390 in en and uk", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    try { await captureSeatMandateHandover(browser, base, true); }
    finally { await browser.close(); stop(); }
  }, 180_000);
});

describe("state writes disk-full alert", () => {
  browserTest("phone alert stays clear of header and composer at 390px", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    const out = path.resolve(".artifacts/self-update-reload/state-writes");
    fs.mkdirSync(out, { recursive: true });
    const readings: unknown[] = [];
    try {
      for (const scheme of ["light", "dark"] as const) for (const locale of ["en", "uk"] as const) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: scheme });
        try {
          await context.addInitScript((lang) => localStorage.setItem("llv_lang", lang), locale);
          const page = await context.newPage();
          await page.goto(`${base}/?state-disk-full=1`);
          const alert = page.locator("[data-state-writes-alert]");
          await alert.waitFor();
          expect(await alert.count()).toBe(1);
          const geometry = await alert.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const overlaps = [...document.querySelectorAll('header, [data-mobile2-bar], textarea')].filter((other) => {
              const b = other.getBoundingClientRect();
              return b.width && b.height && box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top;
            }).length;
            return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, height: box.height, overlaps, clipped: el.scrollHeight > el.clientHeight };
          });
          expect(geometry.x).toBeGreaterThanOrEqual(0);
          expect(geometry.y).toBeGreaterThanOrEqual(0);
          expect(geometry.right).toBeLessThanOrEqual(390);
          expect(geometry.bottom).toBeLessThanOrEqual(844);
          expect(geometry.overlaps).toBe(0);
          expect(geometry.clipped).toBe(false);
          await page.screenshot({ path: path.join(out, `phone-${scheme}-${locale}.png`) });
          readings.push({ scheme, locale, geometry });
        } finally { await context.close(); }
      }
      fs.mkdirSync("evidence/state-lease-recovery", { recursive: true });
      fs.writeFileSync("evidence/state-lease-recovery/phone.json", JSON.stringify(readings, null, 2) + "\n");
    } finally { await browser.close(); stop(); }
  }, 120_000);
});

/*
 * Whole-card drag on the phone (operator, 2026-10-02): hold 0.35 s and the card
 * lifts with a dock of the four columns at the bottom; a release over a column
 * moves it, a release in place opens today's menu, and scrolling and swiping
 * between columns keep working. The board is the kanban scene with 44 more tasks
 * (`&cards=44`), measured under CPU throttling x4 from a recorded trace
 * (`kanban/dragFrameMeter.ts`). `LLV_DRAG_LABEL` names the record written to
 * `evidence/whole-card-drag/<label>-phone.json`.
 */
describe("whole-card drag on the phone", () => {
  const LABEL = process.env.LLV_DRAG_LABEL ?? "run";
  const DRAG_OUT = path.resolve(".artifacts/whole-card-drag");
  const open = async (browser: Awaited<ReturnType<typeof launchChromium>>, base: string, record?: { dir: string }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
      ...(record ? { recordVideo: { dir: record.dir, size: { width: 390, height: 844 } } } : {}),
    });
    await context.addInitScript(() => localStorage.setItem("llv_lang", "uk"));
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`${base}/?kanban=1&cards=44#p=atlas`);
    await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
    await pause(page, 800);
    return { context, page, pageErrors, cdp: await context.newCDPSession(page) };
  };
  /** The first task card on screen in Assigned, and a point on it clear of its controls. */
  const grabPoint = async (page: Page, key?: string): Promise<Point> => {
    const card = key ? page.locator(`[data-phone-kanban-column="assigned"] [data-phone-card="${key}"]`) : page.locator('[data-phone-kanban-column="assigned"] [data-phone-card^="task:t-bulk-"]').first();
    await card.scrollIntoViewIfNeeded();
    await pause(page, 300);
    const box = (await card.boundingBox())!;
    return [box.x + box.width / 2, box.y + 18];
  };

  browserTest("a 3 s drag under 4x CPU throttling holds the display rate on a 48-card board", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    try {
      const { context, page, pageErrors, cdp } = await open(browser, base);
      try {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        /* LLV_DRAG_ANIMATIONS=running keeps the board's glyph animations going while a card is held:
           the ablation that shows what they cost a drag. */
        if (process.env.LLV_DRAG_ANIMATIONS === "running") await page.addStyleTag({ content: "html [data-card-drag] .mglyph[data-live=\"1\"] :is(.mg-turn, .mg-breathe, .mg-write, .mg-sway, .mg-tilt, .mg-corona, .mg-core, .mg-spin, .mg-phase), html [data-card-drag] .mglyph[data-live=\"1\"]::before, html [data-card-drag] .animate-pulse, html [data-card-drag] .motion-safe\\:animate-pulse { animation-play-state: running !important; }" });
        const from = await grabPoint(page);
        /* The lift (the hold's end: the ghost, the dock, the board standing still) and the drag are read apart:
           the first is one frame's work the operator feels as the card coming up, the second is the 3 s that follow. */
        let tile!: Rect;
        const lift = await recordDrag(page, cdp, DRAG_OUT, `${LABEL}-phone-lift`, async () => {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
          await pause(page, 700);
          tile = (await rectOf(page, '[data-phone-dock-tile="blocked"]'))!;
          expect(tile, "the dock is drawn after the hold").not.toBeNull();
          return 0;
        });
        const reading = await recordDrag(page, cdp, DRAG_OUT, `${LABEL}-phone`, () =>
          playPath(cdp, [from, [from[0] + 60, from[1] - 140], [from[0] - 40, from[1] - 260], [tile.x + tile.width / 2, tile.y + tile.height / 2]], 3000, 16, true));
        expect(await page.locator("[data-phone-lift-ghost]").count(), "the card is lifted").toBe(1);
        expect(await page.locator('[data-phone-dock-tile="blocked"][data-over]').count(), "the finger is over Blocked").toBe(1);
        await page.screenshot({ path: path.join(DRAG_OUT, `${LABEL}-phone-mid-drag.png`) });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await pause(page, 600);
        expect(await page.locator("[data-phone-dock]").count(), "the dock goes with the finger").toBe(0);
        fs.mkdirSync("evidence/whole-card-drag", { recursive: true });
        fs.writeFileSync(`evidence/whole-card-drag/${LABEL}-phone.json`, `${JSON.stringify({ board: "phone kanban scene plus 44 tasks with long titles and lanes", viewport: "390x844 touch", cpuThrottling: 4, path: "hold 0.35 s, then 3 s with one move per 16 ms", lift: { ...lift, trace: undefined }, drag: { ...reading, trace: undefined } }, null, 2)}\n`);
        console.log(JSON.stringify({ lift, drag: reading }));
        expect(pageErrors).toEqual([]);
        if (process.env.LLV_DRAG_ANIMATIONS !== "running") {
          expect(reading.frameMs.p95, "p95 frame time at x4").toBeLessThanOrEqual(16.7 + 0.5);
          expect(reading.longTasks.count, "tasks over 50 ms at x4").toBe(0);
        }
      } finally { await context.close(); }
    } finally { await browser.close(); stop(); }
  }, 180_000);

  /* LLV_DRAG_VIDEO=<dir> records the hold, the lift, the drag and the drop as a video, with a dot where the finger is. */
  const VIDEO = process.env.LLV_DRAG_VIDEO;
  (VIDEO ? browserTest : test.skip)("records a phone drag to a video", async () => {
    fs.mkdirSync(VIDEO!, { recursive: true });
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    try {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2,
        recordVideo: { dir: VIDEO!, size: { width: 390, height: 844 } },
      });
      await context.addInitScript(() => localStorage.setItem("llv_lang", "en"));
      await context.addInitScript(() => {
        const dot = document.createElement("div");
        dot.style.cssText = "position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(220,60,40,.55);border:2px solid #fff;z-index:99999;pointer-events:none;display:none";
        const place = (event: PointerEvent) => { dot.style.display = "block"; dot.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`; };
        addEventListener("pointermove", place, true); addEventListener("pointerdown", place, true);
        addEventListener("pointerup", () => { dot.style.display = "none"; }, true);
        document.addEventListener("DOMContentLoaded", () => document.body.appendChild(dot));
      });
      const page = await context.newPage();
      await page.goto(`${base}/?kanban=1&cards=44#p=atlas`);
      await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
      await pause(page, 1000);
      const cdp = await context.newCDPSession(page);
      const from = await grabPoint(page);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
      await pause(page, 900);
      const tile = (await rectOf(page, '[data-phone-dock-tile="blocked"]'))!;
      const target: Point = [tile.x + tile.width / 2, tile.y + tile.height / 2];
      for (const [x, y] of [...along(from, [from[0] + 30, from[1] - 120], 20), ...along([from[0] + 30, from[1] - 120], [from[0] - 20, from[1] - 220], 20), ...along([from[0] - 20, from[1] - 220], target, 30)]) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
        await pause(page, 24);
      }
      await pause(page, 600);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await pause(page, 1500);
      const video = page.video()!;
      await context.close();
      await video.saveAs(path.join(VIDEO!, "phone-drag.webm"));
      await video.delete();
    } finally { await browser.close(); stop(); }
  }, 120_000);

  browserTest("with the finger on a dock tile, the ghost is above the dock and the tile's label is uncovered, at 390 and 320", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    try {
      for (const width of [390, 320]) {
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 640 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
        await context.addInitScript(() => localStorage.setItem("llv_lang", "uk"));
        const page = await context.newPage();
        try {
          await page.goto(`${base}/?kanban=1&cards=44#p=atlas`);
          await page.waitForSelector("[data-phone-kanban] [data-phone-card]", { timeout: 20_000 });
          await pause(page, 800);
          const cdp = await context.newCDPSession(page);
          const from = await grabPoint(page);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
          await pause(page, 520);
          for (const status of ["blocked", "done", "inbox"]) {
            const tile = (await rectOf(page, `[data-phone-dock-tile="${status}"]`))!;
            const target: Point = [tile.x + tile.width / 2, tile.y + tile.height / 2];
            for (const [x, y] of along(from, target, 8)) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] }); await pause(page, 16); }
            await pause(page, 120);
            const ghost = (await rectOf(page, "[data-phone-lift-ghost]"))!;
            const dock = (await rectOf(page, "[data-phone-dock]"))!;
            const label = (await page.evaluate((sel) => {
              const tileEl = document.querySelector(sel)!;
              const text = [...tileEl.querySelectorAll("*")].find((node) => node.children.length === 0 && (node.textContent ?? "").trim() !== "") ?? tileEl;
              const box = text.getBoundingClientRect();
              return { x: box.x, y: box.y, width: box.width, height: box.height };
            }, `[data-phone-dock-tile="${status}"]`));
            expect(ghost.y + ghost.height, `${width}px ${status}: the ghost's bottom edge is above the dock`).toBeLessThanOrEqual(dock.y + 0.5);
            expect(label.y, `${width}px ${status}: the label is below the ghost`).toBeGreaterThanOrEqual(ghost.y + ghost.height - 0.5);
            expect(ghost.x, `${width}px: the ghost stays on the screen`).toBeGreaterThanOrEqual(-0.5);
            expect(ghost.x + ghost.width, `${width}px: the ghost stays on the screen`).toBeLessThanOrEqual(width + 0.5);
            expect(await page.locator(`[data-phone-dock-tile="${status}"][data-over]`).count(), `${width}px: the finger is over ${status}`).toBe(1);
          }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        } finally { await context.close(); }
      }
    } finally { await browser.close(); stop(); }
  }, 180_000);

  browserTest("a release over a column moves the task, in place opens the menu, elsewhere does nothing; scrolling and the pager still work", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    try {
      const { context, page, pageErrors, cdp } = await open(browser, base);
      try {
        const card = '[data-phone-kanban-column="assigned"] [data-phone-card^="task:t-bulk-"]';
        const where = (selector: string) => page.evaluate((sel) => document.querySelector(sel)?.closest("[data-phone-kanban-column]")?.getAttribute("data-phone-kanban-column") ?? null, selector);
        const first = await page.locator(card).first().getAttribute("data-phone-card");
        const id = `[data-phone-card="${first}"]`;
        const from = await grabPoint(page);

        /* Held and released where it was: today's menu, nothing moved. */
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from[0], y: from[1] }] });
        await pause(page, 520);
        expect(await page.locator("[data-phone-dock]").count()).toBe(1);
        expect(await page.locator("[data-mobile2-sheet]").count(), "the menu waits for the release").toBe(0);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await pause(page, 500);
        expect(await page.locator('[data-mobile2-sheet="card"]').count()).toBe(1);
        expect(await where(id)).toBe("assigned");
        await touch(cdp, [[195, 40]]);
        await pause(page, 500);
        expect(await page.locator("[data-mobile2-sheet]").count(), "a tap outside closes the menu").toBe(0);

        /* Lifted and let go over nothing: back where it was. */
        const at = await grabPoint(page, first!);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at[0], y: at[1] }] });
        await pause(page, 520);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: at[0] + 10, y: at[1] - 200 }] });
        await pause(page, 100);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await pause(page, 400);
        expect(await where(id)).toBe("assigned");
        expect(await page.locator("[data-mobile2-sheet]").count()).toBe(0);

        /* Lifted and let go over Blocked: it moves, with the usual receipt. */
        const again = await grabPoint(page, first!);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: again[0], y: again[1] }] });
        await pause(page, 520);
        const tile = (await rectOf(page, '[data-phone-dock-tile="blocked"]'))!;
        const target: Point = [tile.x + tile.width / 2, tile.y + tile.height / 2];
        for (const [x, y] of along(again, target, 10)) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] }); await pause(page, 16); }
        await pause(page, 100);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await pause(page, 500);
        expect(await where(id)).toBe("blocked");
        expect(await page.locator("[data-mobile2-receipt]").count()).toBe(1);
        expect(await page.locator("[data-mobile2-sheet]").count(), "a drop opens no menu").toBe(0);
        const patches = await page.evaluate(() => (window as unknown as { evidence: { taskPatches: Array<{ id: string; body: { status?: string } }> } }).evidence.taskPatches);
        expect(patches.map((patch) => [patch.id, patch.body.status])).toEqual([[first!.replace("task:", ""), "blocked"]]);

        /* The column scrolls under a finger that moves at once, and no dock appears. */
        const scroller = '[data-phone-kanban-column="assigned"]';
        const before = await page.evaluate((sel) => document.querySelector(sel)!.scrollTop, scroller);
        await touch(cdp, along([195, 600], [198, 300], 14), 16);
        await pause(page, 500);
        expect(await page.evaluate((sel) => document.querySelector(sel)!.scrollTop, scroller), "a vertical drag scrolls the column").toBeGreaterThan(before + 40);
        expect(await page.locator("[data-phone-dock]").count()).toBe(0);

        /* The pager swipes between columns. */
        await page.locator('[data-phone-kanban-tab="assigned"]').click();
        await pause(page, 500);
        await touch(cdp, along([330, 500], [60, 506], 14), 16);
        await pause(page, 700);
        expect(await page.evaluate(() => document.querySelector("[data-phone-kanban]")!.getAttribute("data-phone-kanban-active")), "a swipe left changes the column").toBe("blocked");

        /* A finger held on a card and then moved scrolls nothing: the card is the thing in hand. */
        await page.locator('[data-phone-kanban-tab="assigned"]').click();
        await pause(page, 500);
        const held = await grabPoint(page);
        const top = await page.evaluate((sel) => document.querySelector(sel)!.scrollTop, scroller);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: held[0], y: held[1] }] });
        await pause(page, 520);
        for (const [x, y] of along(held, [held[0], held[1] - 220], 10)) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] }); await pause(page, 16); }
        expect(await page.evaluate((sel) => document.querySelector(sel)!.scrollTop, scroller), "a lifted card does not scroll the column").toBe(top);
        expect(await page.locator("[data-phone-lift-ghost]").count()).toBe(1);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        expect(pageErrors).toEqual([]);
      } finally { await context.close(); }
    } finally { await browser.close(); stop(); }
  }, 180_000);
});

/*
 * Launching an agent from the phone's draft screen: the screen is the new
 * agent's conversation from the first frame and stays so while the scan swaps
 * the launch window for the transcript, and one Back leaves it. The running
 * conversation in the fixture is live and outranks the new agent, so a
 * fallback in the focus view would paint it.
 */
describe("launching an agent on the phone", () => {
  browserTest("the new agent holds the screen from send to transcript, and one Back reaches the board", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    const out = path.resolve(".artifacts/phone-launch-focus");
    fs.mkdirSync(out, { recursive: true });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      try {
        await context.addInitScript(() => localStorage.setItem("llv_lang", "en"));
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.goto(`${base}/?launch=1#p=atlas`);
        await page.locator("[data-mobile2-open=\"menu\"]").waitFor({ timeout: 15_000 });
        await page.locator("[data-mobile2-open=\"menu\"]").tap();
        await page.getByText("New agent", { exact: true }).tap();
        const prompt = page.locator("textarea").first();
        await prompt.waitFor({ timeout: 10_000 });
        await prompt.fill("Ship the fix");
        await page.evaluate(() => {
          const sampled: string[] = [];
          (window as unknown as { titles: string[] }).titles = sampled;
          const tick = () => {
            const title = document.querySelector("[data-mobile2-title-text]")?.textContent ?? "";
            if (sampled.at(-1) !== title) sampled.push(title);
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await page.locator("form").first().evaluate((form) => (form as HTMLFormElement).requestSubmit());
        await page.waitForFunction(() => (window as unknown as { evidence: { spawns: unknown[] } }).evidence.spawns.length === 1, null, { timeout: 10_000 });
        await pause(page, 1_000);
        await page.screenshot({ path: path.join(out, "launched-window.png") });
        await page.evaluate(() => {
          (window as unknown as { evidence: { materializeLaunch(): void } }).evidence.materializeLaunch();
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await page.waitForFunction(() => (window as unknown as { titles: string[] }).titles.includes("Launched agent"), null, { timeout: 15_000 }).catch(async (error) => {
          await page.screenshot({ path: path.join(out, "stuck.png") });
          throw new Error(`${error.message}; page errors ${JSON.stringify(pageErrors)}; titles ${JSON.stringify(await page.evaluate(() => (window as unknown as { titles: string[] }).titles))}`);
        });
        await pause(page, 1_000);
        await page.screenshot({ path: path.join(out, "transcript.png") });
        const titles = await page.evaluate(() => (window as unknown as { titles: string[] }).titles);
        expect(titles.filter((title) => title.includes("Rebuild the board status projection"))).toEqual([]);
        expect(titles.at(-1)).toBe("Launched agent");
        await page.locator("[data-mobile2-back]").tap();
        await page.locator('[data-mobile2-screen="board"]').waitFor({ timeout: 5_000 });
        expect(await page.locator('[data-mobile2-screen="chat"]').count()).toBe(0);
        fs.mkdirSync("evidence/phone-launch-focus", { recursive: true });
        fs.writeFileSync("evidence/phone-launch-focus/titles.json", `${JSON.stringify({ viewport: "390x844", titles }, null, 2)}\n`);
      } finally { await context.close(); }
    } finally { await browser.close(); stop(); }
  }, 90_000);
});

describe("older history on the phone", () => {
  /*
   * A real touch drag toward the start of an 800-line conversation, on a
   * phone at 4x CPU slowdown. The audit that found the desktop walk slow could
   * not say anything about the phone, because its synthetic touch gestures did
   * not move the feed; `Input.dispatchTouchEvent` does, and this case drives
   * it. The feed pages in earlier history as the reader nears the top, every
   * row the reader had on screen keeps its DOM node, and the walk ends at the
   * first line. The readings go to `.artifacts/phone-older-history/walk.json`.
   */
  const HISTORY_OUT = path.resolve(".artifacts/phone-older-history");

  browserTest("a touch drag brings the earlier pages in without remounting what the reader has", async () => {
    fs.mkdirSync(HISTORY_OUT, { recursive: true });
    const { base, stop } = await serveEvidenceFixture(HISTORY_OUT, "src/components/conversation/conversationWindowEvidence.fixture.tsx");
    const browser = await launchChromium();
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
      try {
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const cdp = await context.newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await page.goto(`${base.replace(/\/$/, "")}/?case=long-history&turns=200&window=120&page=100`);
        await page.waitForFunction(() => document.querySelectorAll("[data-feed-key]").length > 20);
        await pause(page, 600);
        const marked = await page.evaluate(() => {
          const rows = Array.from(document.querySelectorAll("[data-feed-key]"));
          for (const row of rows) row.setAttribute("data-first-window", "1");
          const state: number[] = [];
          (window as unknown as { __frames: number[] }).__frames = state;
          let last = performance.now();
          const tick = (now: number) => { state.push(now - last); last = now; requestAnimationFrame(tick); };
          requestAnimationFrame(tick);
          return rows.length;
        });
        const rect = await rectOf(page, "[data-log-feed-scroller]");
        if (!rect) throw new Error("no feed");
        const x = rect.x + rect.width / 2;
        const read = () => page.evaluate(() => {
          const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
          const earlier = [...feed.querySelectorAll("button")].some((button) => /earlier|loading/i.test(button.textContent ?? ""));
          return {
            top: Math.round(feed.scrollTop),
            rows: feed.querySelectorAll("[data-feed-key]").length,
            kept: feed.querySelectorAll("[data-first-window]").length,
            loads: (window as unknown as { llvHistory: { loads: () => number } }).llvHistory.loads(),
            atStart: !earlier,
          };
        });
        const first = await read();
        let gestures = 0;
        let last = first;
        const startedAt = Date.now();
        for (; gestures < 400; gestures += 1) {
          await touch(cdp, along([x, rect.y + rect.height * 0.15], [x, rect.y + rect.height * 0.85], 10));
          await pause(page, 120);
          last = await read();
          if (last.atStart && last.top < 5) break;
        }
        const reachedStartMs = Date.now() - startedAt;
        const frames = await page.evaluate(() => (window as unknown as { __frames: number[] }).__frames.slice(1));
        const walk = {
          gestures, reachedStartMs, loads: last.loads, rows: last.rows, kept: last.kept, marked,
          frames: frames.length, over100: frames.filter((ms) => ms > 100).length, maxFrameMs: Math.round(Math.max(0, ...frames)),
        };
        fs.writeFileSync(path.join(HISTORY_OUT, "walk.json"), JSON.stringify(walk, null, 2));
        await page.screenshot({ path: path.join(HISTORY_OUT, "at-start-390.png") });
        expect(pageErrors).toEqual([]);
        /* The drag moved the feed (the audit's gestures did not), earlier
           pages arrived, the walk ended at the first line, and every row
           that was on screen at the start is still the same node. */
        expect(last.top).toBeLessThan(first.top);
        expect(last.loads).toBeGreaterThanOrEqual(1);
        expect(last.atStart).toBe(true);
        expect(last.kept).toBe(marked);
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
      stop();
    }
  }, 300_000);
});

describe("long conversation scroll", () => {
  /*
   * A reader partway up a long conversation while an older page arrives. The
   * scene is the fixture's `?scroll-history` feed: 120 loaded records, 60
   * prepended while a real wheel and touch gesture are in flight, then late
   * image and code growth above the reader, a tail append and a toolbar
   * resize. The message under the reader's eye may move by no more than 3 px
   * through all of it, at 390 px in both languages and at 1440 px. Readings
   * and frames go to `.artifacts/scroll-history/`.
   */
  browserTest("history and late layout preserve the reader", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    const out = path.resolve(".artifacts/scroll-history");
    fs.mkdirSync(out, { recursive: true });
    const readings: unknown[] = [];
    try {
      for (const [width, locale] of [[390, "en"], [390, "uk"], [1440, "en"]] as const) for (const compact of [false, true]) {
        const context = await browser.newContext({ viewport: { width, height: 844 },
          ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
        try {
          await context.addInitScript((lang) => localStorage.setItem("llv_lang", lang), locale);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${base}/?scroll-history=1${compact ? "&compact=1" : ""}`);
          await page.waitForFunction(() => document.querySelectorAll("[data-feed-key]").length === 120);
          await page.waitForTimeout(500);
          const scroller = page.locator("[data-log-feed-scroller]");
          // Start within the oldest loaded answer, then drive actual upward input.
          await scroller.evaluate((el) => { el.scrollTop = 300; });
          await page.waitForTimeout(400);
          await scroller.hover();
          await page.mouse.wheel(0, -220);
          await page.waitForFunction(() => (window as unknown as { historyFixture: { pending: boolean } }).historyFixture.pending);
          await page.waitForTimeout(500);
          await page.evaluate(() => {
            const el = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
            const row = [...el.querySelectorAll<HTMLElement>("[data-feed-key]")].find((node) => node.getBoundingClientRect().bottom > el.getBoundingClientRect().top)!;
            const state = window as unknown as { scrollTrace: { anchor: string; frames: Array<Record<string, unknown>>; phase: string; running: boolean } };
            state.scrollTrace = { anchor: row.dataset.feedKey!, frames: [], phase: "idle", running: true };
            const frame = (time: number) => {
              if (!state.scrollTrace.running) return;
              const row = el.querySelector<HTMLElement>(`[data-feed-key="${state.scrollTrace.anchor}"]`)!;
              state.scrollTrace.frames.push({ time, phase: state.scrollTrace.phase, scrollTop: el.scrollTop,
                anchorY: row.getBoundingClientRect().top, height: el.scrollHeight, viewport: el.clientHeight,
                viewportTop: el.getBoundingClientRect().top, visualHeight: visualViewport?.height,
                overflowAnchor: getComputedStyle(el).overflowAnchor });
              requestAnimationFrame(frame);
            };
            // rAF runs before ResizeObserver in the rendering algorithm. Keep
            // that raw reading, then record the offset that survives pre-paint
            // resize restoration (the production observer was registered first).
            const settled = new ResizeObserver(() => {
              const latest = state.scrollTrace.frames.at(-1);
              if (!latest || !state.scrollTrace.running) return;
              const row = el.querySelector<HTMLElement>(`[data-feed-key="${state.scrollTrace.anchor}"]`)!;
              latest.preResizeAnchorY ??= latest.anchorY;
              latest.preResizeScrollTop ??= latest.scrollTop;
              latest.anchorY = row.getBoundingClientRect().top;
              latest.scrollTop = el.scrollTop;
              latest.resizeObserved = true;
            });
            settled.observe(el);
            settled.observe(el.firstElementChild!);
            requestAnimationFrame(frame);
          });
          const phase = async (name: string, action: () => Promise<unknown>) => {
            await page.evaluate((name) => { (window as unknown as { scrollTrace: { phase: string } }).scrollTrace.phase = name; }, name);
            await action();
            await page.waitForTimeout(650);
          };
          await phase("wheel-up", () => page.mouse.wheel(0, -20));
          if (width === 390) {
            const cdp = await context.newCDPSession(page);
            await phase("touch-up", async () => {
              await touch(cdp, along([190, 260], [190, 295]), 24);
              await page.evaluate(() => { (window as unknown as { scrollTrace: { phase: string } }).scrollTrace.phase = "touch-rest"; });
            });
            await cdp.detach();
          }
          await page.evaluate(() => { (window as unknown as { scrollTrace: { phase: string } }).scrollTrace.phase = "steady"; });
          await page.waitForTimeout(100);
          const label = process.env.LLV_SCROLL_MEASUREMENT ?? "after";
          await page.screenshot({ path: path.join(out, `${label}-${width}-${locale}-${compact}-before.png`) });
          await phase("prepend", () => page.evaluate(() => (window as unknown as { historyFixture: { prepend(): void } }).historyFixture.prepend()));
          await page.screenshot({ path: path.join(out, `${label}-${width}-${locale}-${compact}-prepend.png`) });
          await phase("live-bottom", () => page.evaluate(() => (window as unknown as { historyFixture: { append(): void } }).historyFixture.append()));
          await phase("late-image-above", () => page.evaluate(() => {
            const row = document.querySelector<HTMLElement>('[data-feed-key="row:59:0"]')!;
            const img = document.createElement("img"); img.width = 200; img.height = 180;
            img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
            row.append(img);
          }));
          await phase("late-code-markdown-above", () => page.evaluate(() => {
            const row = document.querySelector<HTMLElement>('[data-feed-key="row:59:0"]')!;
            const pre = document.createElement("pre");
            pre.textContent = "const late = 1;\n".repeat(8);
            const paragraph = document.createElement("p");
            paragraph.textContent = "Late markdown wrapping on a phone. ".repeat(12);
            row.append(pre, paragraph);
          }));
          await phase("toolbar-resize", () => page.setViewportSize({ width, height: 780 }));
          await page.screenshot({ path: path.join(out, `${label}-${width}-${locale}-${compact}-after.png`) });
          const result = await page.evaluate(() => {
            const trace = (window as unknown as { scrollTrace: { frames: Array<{phase: string; anchorY: number; scrollTop: number}>; running: boolean } }).scrollTrace;
            trace.running = false;
            const baseline = trace.frames.filter((f) => f.phase === "steady").at(-1)!.anchorY;
            const stationary = trace.frames.filter((f) => ["prepend", "live-bottom", "late-image-above", "late-code-markdown-above", "toolbar-resize"].includes(f.phase));
            const rest = trace.frames.filter((f) => f.phase === "touch-rest");
            const restSteps = rest.slice(1).map((f, i) => Math.abs(f.anchorY - rest[i].anchorY));
            return { frames: trace.frames, baseline, maxDrift: Math.max(...stationary.map((f) => Math.abs(f.anchorY - baseline))),
              gestureRestMaxStep: Math.max(0, ...restSteps), gestureRestTravel: restSteps.reduce((sum, step) => sum + step, 0),
              gestureRestMovingFrames: restSteps.filter((step) => step > 0).length };
          });

          console.log(`scroll-history width=${width} locale=${locale} compact=${compact} maxDrift=${result.maxDrift}`);
          // Re-follow at the bottom, then prove new tail rows remain visible.
          await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
          await page.mouse.wheel(0, 100);
          const back = page.getByRole("button", { name: locale === "uk" ? "Повернутись до живого хвоста" : "Back to the live tail" });
          if (await back.count()) await back.click();
          await page.evaluate(() => (window as unknown as { historyFixture: { append(): void } }).historyFixture.append());
          await page.waitForTimeout(300);
          const bottomGap = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
          readings.push({ width, locale, compact, ...result, bottomGap, errors });
          expect(bottomGap).toBeLessThanOrEqual(50);
          expect(errors).toEqual([]);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); stop(); }
    const label = process.env.LLV_SCROLL_MEASUREMENT ?? "after";
    fs.writeFileSync(path.join(out, `${label}.json`), `${JSON.stringify({ readings }, null, 2)}\n`);
    if (label === "after") for (const reading of readings as Array<{ width: number; maxDrift: number; gestureRestMaxStep: number; gestureRestTravel: number; gestureRestMovingFrames: number }>) {
      expect(reading.maxDrift).toBeLessThanOrEqual(3);
      if (reading.width === 390) {
        // Native smooth scrolling follows the browser's easing curve. Require
        // the settle to span several frames, rather than a one-frame snap.
        expect(reading.gestureRestMaxStep).toBeLessThan(reading.gestureRestTravel);
        expect(reading.gestureRestMovingFrames).toBeGreaterThanOrEqual(3);
      }
    }
  }, 240_000);

  /*
   * A page that lands while a flick's momentum is still travelling: the
   * finger is up, so nothing marks the reader as holding the feed, and the
   * feed's own restore write fires a scrollend of its own. The feed neither
   * pulls itself back against the reader (a glide aimed at a boundary the
   * momentum then passes) nor reads the momentum as drift and writes it back.
   */
  browserTest("a page landing during momentum leaves the feed to the reader", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    const out = path.resolve(".artifacts/scroll-history");
    fs.mkdirSync(out, { recursive: true });
    const rounds: unknown[] = [];
    try {
      for (const locale of ["en", "uk"] as const) for (let round = 0; round < 3; round += 1) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
        try {
          await context.addInitScript((lang) => localStorage.setItem("llv_lang", lang), locale);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const cdp = await context.newCDPSession(page);
          await page.goto(`${base}/?scroll-history=1`);
          await page.waitForFunction(() => document.querySelectorAll("[data-feed-key]").length === 120);
          await page.waitForTimeout(500);
          await page.evaluate(() => {
            const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
            feed.scrollTop = 6000;
            const state = { frames: [] as Array<{ top: number; height: number; time: number }>,
              writes: [] as Array<{ time: number; delta: number }>, glides: [] as number[] };
            (window as unknown as { momentum: typeof state }).momentum = state;
            // Every write the page makes to the feed's offset, and every glide it starts.
            const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
            Object.defineProperty(Element.prototype, "scrollTop", { ...descriptor, set(this: Element, value: number) {
              const before = this.scrollTop;
              descriptor.set!.call(this, value);
              if (this === feed) state.writes.push({ time: performance.now(), delta: this.scrollTop - before });
            } });
            const scrollBy = Element.prototype.scrollBy as (...args: unknown[]) => void;
            Element.prototype.scrollBy = function (this: Element, ...args: unknown[]) {
              if (this === feed) state.glides.push(performance.now());
              return scrollBy.apply(this, args);
            } as typeof Element.prototype.scrollBy;
            const frame = (time: number) => {
              state.frames.push({ top: feed.scrollTop, height: feed.scrollHeight, time });
              requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
          });
          const rect = await rectOf(page, "[data-log-feed-scroller]");
          if (!rect) throw new Error("no feed");
          const x = rect.x + rect.width / 2;
          let landed = false;
          for (let gesture = 0; gesture < 60 && !landed; gesture += 1) {
            await touch(cdp, along([x, rect.y + rect.height * 0.15], [x, rect.y + rect.height * 0.85], 20));
            // Finger up, momentum travelling: this is when the page lands.
            if (await page.evaluate(() => (window as unknown as { historyFixture: { pending: boolean } }).historyFixture.pending)) {
              await page.evaluate(() => (window as unknown as { historyFixture: { prepend(): void } }).historyFixture.prepend());
              landed = true;
            } else await page.waitForTimeout(140);
          }
          expect(landed).toBe(true);
          await page.waitForTimeout(1_500);
          const reading = await page.evaluate(() => {
            const { frames, writes, glides } = (window as unknown as { momentum: { frames: Array<{ top: number; height: number; time: number }>;
              writes: Array<{ time: number; delta: number }>; glides: number[] } }).momentum;
            const arrival = frames.findIndex((f, i) => i > 0 && f.height - frames[i - 1]!.height > 1_000);
            const speed = (i: number) => Math.abs(frames[i]!.top - frames[i - 1]!.top);
            // The momentum is over once the offset has stayed put for six frames.
            let end = arrival + 1;
            for (let still = 0; end < frames.length && still < 6; end += 1) still = speed(end) < 0.5 ? still + 1 : 0;
            const travelling = frames.slice(arrival + 1, end);
            const rises = travelling.map((f, i) => f.top - frames[arrival + i]!.top);
            const restore = writes.find((w) => w.time >= frames[arrival]!.time - 20);
            return {
              arrival, framesInFlight: travelling.length, speedBefore: arrival > 0 ? speed(arrival - 1) : 0,
              maxRise: Math.max(0, ...rises),
              // Frames right after the landing in which the feed stood still against a moving flick.
              stalled: frames.slice(arrival + 1, arrival + 6).filter((f, i) => Math.abs(f.top - frames[arrival + i]!.top) < 0.5).length,
              laterWrites: writes.filter((w) => w !== restore && w.time >= frames[arrival]!.time - 20 && Math.abs(w.delta) > 3).map((w) => Math.round(w.delta)),
              glidesInFlight: glides.filter((time) => time >= frames[arrival]!.time && time < frames[Math.min(end, frames.length - 1)]!.time).length,
            };
          });
          rounds.push({ locale, round, ...reading });
          console.log(`scroll-history momentum locale=${locale} round=${round} ${JSON.stringify(reading)}`);
          expect(errors).toEqual([]);
          // The check means something only if the flick was still carrying the feed when the page landed.
          expect(reading.framesInFlight).toBeGreaterThanOrEqual(5);
          expect(reading.speedBefore).toBeGreaterThan(20);
          expect(reading.maxRise).toBeLessThanOrEqual(3);
          expect(reading.stalled).toBe(0);
          expect(reading.laterWrites).toEqual([]);
          expect(reading.glidesInFlight).toBe(0);
        } finally { await context.close(); }
      }
    } finally {
      await browser.close(); stop();
      fs.writeFileSync(path.join(out, "momentum.json"), `${JSON.stringify({ rounds }, null, 2)}\n`);
    }
  }, 240_000);

  /*
   * Late layout above the reader inside the message being read. A long answer
   * or a long tool run is one row taller than the screen, and the reader rests
   * deep inside it: an image that decodes above them in the same row leaves
   * the row's top where it was, so the row alone cannot say the text moved.
   * The block under the reader is held across the growth. The first-child
   * image grows the row above the reader; the same image added to the row
   * above is the control.
   */
  browserTest("late content above the reader inside the row being read keeps the text still", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    const out = path.resolve(".artifacts/scroll-history");
    fs.mkdirSync(out, { recursive: true });
    const readings: unknown[] = [];
    try {
      for (const [width, locale] of [[390, "en"], [390, "uk"], [1440, "en"]] as const) for (const compact of [false, true]) {
        const context = await browser.newContext({ viewport: { width, height: 844 },
          ...(width === 390 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
        try {
          await context.addInitScript((lang) => localStorage.setItem("llv_lang", lang), locale);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${base}/?scroll-history=1${compact ? "&compact=1" : ""}`);
          await page.waitForFunction(() => document.querySelectorAll("[data-feed-key]").length === 120);
          await page.waitForTimeout(500);
          // One message taller than the screen: sixteen more paragraphs in its row.
          await page.evaluate(() => {
            const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
            const rows = [...feed.querySelectorAll<HTMLElement>("[data-feed-key]")];
            const row = rows[40]!;
            row.dataset.reading = "1";
            rows[39]!.dataset.above = "1";
            for (let n = 0; n < 16; n += 1) {
              const paragraph = document.createElement("p");
              paragraph.dataset.late = String(n);
              paragraph.style.cssText = "margin:0 0 16px";
              paragraph.textContent = `Paragraph ${n} of a long answer. `.repeat(6);
              row.append(paragraph);
            }
            feed.scrollTop = row.getBoundingClientRect().top - feed.getBoundingClientRect().top + feed.scrollTop - 200;
          });
          await page.waitForTimeout(400);
          const scroller = page.locator("[data-log-feed-scroller]");
          const box = await rectOf(page, "[data-log-feed-scroller]");
          if (!box) throw new Error("no feed");
          // Real input releases the tail and walks into the message: about 685 px in.
          const depth = () => page.evaluate(() => {
            const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
            return feed.getBoundingClientRect().top - document.querySelector<HTMLElement>("[data-reading]")!.getBoundingClientRect().top;
          });
          const cdp = width === 390 ? await context.newCDPSession(page) : null;
          if (!cdp) await scroller.hover();
          for (let step = 0; step < 40 && Math.abs((await depth()) - 685) > 40; step += 1) {
            const move = Math.max(-300, Math.min(300, 685 - (await depth())));
            if (cdp) await touch(cdp, along([box.x + box.width / 2, box.y + box.height * 0.6], [box.x + box.width / 2, box.y + box.height * 0.6 - move], 12), 40);
            else await page.mouse.wheel(0, move);
            await page.waitForTimeout(700);
          }
          const rested = await depth();
          // The paragraph under the reader's eye, and the first-child image added above it.
          const under = () => page.evaluate(() => {
            const top = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!.getBoundingClientRect().top;
            const hit = [...document.querySelectorAll<HTMLElement>("[data-late]")].find((p) => p.getBoundingClientRect().bottom > top + 1)!;
            return { id: hit.dataset.late!, y: hit.getBoundingClientRect().top - top };
          });
          const before = await under();
          await page.screenshot({ path: path.join(out, `inside-${width}-${locale}-${compact}-before.png`) });
          const grow = (selector: string) => page.evaluate((selector) => {
            const img = document.createElement("img");
            img.width = 200; img.height = 180; img.style.display = "block";
            img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
            document.querySelector<HTMLElement>(selector)!.prepend(img);
          }, selector);
          await grow("[data-above]");
          await page.waitForTimeout(650);
          const afterNeighbour = await under();
          await grow("[data-reading]");
          await page.waitForTimeout(650);
          const afterInside = await under();
          await page.screenshot({ path: path.join(out, `inside-${width}-${locale}-${compact}-after.png`) });
          const reading = { width, locale, compact, rested: Math.round(rested), sameParagraph: before.id === afterInside.id && before.id === afterNeighbour.id,
            neighbourDrift: Math.abs(afterNeighbour.y - before.y), insideDrift: Math.abs(afterInside.y - before.y) };
          readings.push(reading);
          console.log(`scroll-history inside-row ${JSON.stringify(reading)}`);
          expect(errors).toEqual([]);
          expect(reading.rested).toBeGreaterThan(600);
          expect(reading.sameParagraph).toBe(true);
          expect(reading.neighbourDrift).toBeLessThanOrEqual(3);
          expect(reading.insideDrift).toBeLessThanOrEqual(3);
        } finally { await context.close(); }
      }
    } finally {
      await browser.close(); stop();
      fs.writeFileSync(path.join(out, "inside-row.json"), `${JSON.stringify({ readings }, null, 2)}\n`);
    }
  }, 240_000);

  /*
   * The reading that brings a released feed to rest on a line costs the same
   * on a long history as on a short one. With 1500 rows mounted at 4x CPU, 24
   * short drags each come to rest; the layout reads made between a scrollend
   * and the first scroll event after it are the rest reading (its longest
   * task is timed), and an edge on a row boundary used to walk every mounted
   * row there.
   */
  browserTest("the rest reading does not walk the mounted rows", async () => {
    const out = path.resolve(".artifacts/scroll-history");
    fs.mkdirSync(out, { recursive: true });
    const { base, stop } = await serveEvidenceFixture(out, "src/components/conversation/conversationWindowEvidence.fixture.tsx");
    const browser = await launchChromium();
    const walks: Array<{ rows: number; mounted: number; rests: number[]; restMs: number[]; restBursts: string[]; slowFrames: number }> = [];
    try {
      for (const turns of [60, 600]) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: "dark" });
        try {
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
          await page.goto(`${base.replace(/\/$/, "")}/?case=long-history&turns=${turns}&window=${turns * 4}&page=100`);
          await page.waitForFunction(() => document.querySelectorAll("[data-feed-key]").length > 20);
          await pause(page, 600);
          await page.evaluate(() => {
            const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
            const state = { counting: false, reads: 0, bursts: [] as Array<{ reads: number; start: number; end: number }>, rests: [] as number[], restMs: [] as number[], restBursts: [] as string[], gaps: [] as number[] };
            (window as unknown as { rest: typeof state }).rest = state;
            const count = <T extends object>(target: T, name: keyof T) => {
              const original = target[name] as unknown as (...args: unknown[]) => unknown;
              (target as Record<keyof T, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
                if (!state.counting) return original.apply(this, args);
                const started = performance.now();
                state.reads += 1;
                try { return original.apply(this, args); } finally {
                  const ended = performance.now();
                  const burst = state.bursts.at(-1);
                  // Reads of one task follow each other; another task starts a new burst.
                  if (burst && started - burst.end < 8) { burst.reads += 1; burst.end = ended; } else state.bursts.push({ reads: 1, start: started, end: ended });
                }
              };
            };
            count(Element.prototype, "getBoundingClientRect");
            count(Range.prototype, "getClientRects");
            count(Document.prototype, "elementFromPoint");
            count(window, "getComputedStyle");
            // The reading's own span: from its first layout read to its last.
            const finish = () => {
              if (!state.counting) return;
              state.counting = false;
              state.rests.push(state.reads);
              state.restMs.push(Math.max(0, ...state.bursts.map((burst) => burst.end - burst.start)));
              state.restBursts.push(state.bursts.map((burst) => `${burst.reads}r/${Math.round(burst.end - burst.start)}ms`).join(" "));
            };
            window.addEventListener("scrollend", (event) => {
              if (event.target !== feed) return;
              state.counting = true; state.reads = 0; state.bursts = [];
              window.setTimeout(finish, 400);
            }, true);
            feed.addEventListener("scroll", finish);
            let last = performance.now();
            const tick = (now: number) => { state.gaps.push(now - last); last = now; requestAnimationFrame(tick); };
            requestAnimationFrame(tick);
          });
          const rect = await rectOf(page, "[data-log-feed-scroller]");
          if (!rect) throw new Error("no feed");
          const x = rect.x + rect.width / 2;
          await page.evaluate(() => { document.querySelector<HTMLElement>("[data-log-feed-scroller]")!.scrollTop = 4000; });
          // The page's own start-up and this jump are not rests: measure from the first touch.
          await pause(page, 2_000);
          await page.evaluate(() => { (window as unknown as { rest: { gaps: number[]; rests: number[] } }).rest.gaps.length = 0; (window as unknown as { rest: { rests: number[]; restMs: number[] } }).rest.rests.length = 0; (window as unknown as { rest: { restMs: number[] } }).rest.restMs.length = 0; });
          for (let drag = 0; drag < 24; drag += 1) {
            // A short drag: a few lines, no momentum worth the name, then rest.
            await touch(cdp, along([x, rect.y + rect.height * 0.5], [x, rect.y + rect.height * (drag % 2 ? 0.58 : 0.42) + drag], 8), 40);
            await pause(page, 900);
          }
          const walk = await page.evaluate(() => {
            const { rests, restMs, gaps } = (window as unknown as { rest: { rests: number[]; restMs: number[]; gaps: number[] } }).rest;
            return { mounted: document.querySelectorAll("[data-feed-key]").length, rests, restMs: restMs.map((ms) => Math.round(ms * 10) / 10),
              restBursts: (window as unknown as { rest: { restBursts: string[] } }).rest.restBursts, slowFrames: gaps.slice(1).filter((ms) => ms > 100).length };
          });
          walks.push({ rows: turns * 4, ...walk });
          console.log(`scroll-history rest turns=${turns} mounted=${walk.mounted} rests=${walk.rests.length} maxReads=${Math.max(0, ...walk.rests)} maxRestMs=${Math.max(0, ...walk.restMs)} slowFrames=${walk.slowFrames}`);
          expect(errors).toEqual([]);
          expect(walk.rests.length).toBeGreaterThanOrEqual(12);
        } finally { await context.close(); }
      }
    } finally {
      await browser.close(); stop();
      fs.writeFileSync(path.join(out, "rest-reads.json"), `${JSON.stringify({ walks }, null, 2)}\n`);
    }
    const [short, long] = walks;
    expect(long!.mounted).toBeGreaterThan(1_000);
    // Reads per rest do not grow with the rows mounted.
    expect(Math.max(...long!.rests)).toBeLessThanOrEqual(Math.max(...short!.rests) + 20);
    // No rest reading takes over 100 ms at 4x. Its reads are one task; the
    // frames of the whole walk are recorded for the evidence, not asserted:
    // a frame of the page's own rendering can be long on a busy machine.
    expect(Math.max(...long!.restMs)).toBeLessThan(100);
  }, 300_000);

  /*
   * Folding a long operator message under the reader. Its «collapse» label is
   * the deepest block under the top edge while the message is open; folding
   * leaves the label in the DOM with no box, and a label with no box reads as
   * a rectangle of zeros, which the feed used to take for the content having
   * moved by the feed's own offset from the window. The message must stay put
   * at every depth the label can sit at, and a row appended at the tail
   * afterwards must not push it either.
   */
  browserTest("folding a long message under the reader leaves it where it was", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    const out = path.resolve(".artifacts/scroll-history");
    fs.mkdirSync(out, { recursive: true });
    const readings: unknown[] = [];
    try {
      for (const locale of ["en", "uk"] as const) for (const depth of [-3, 3, 8, 14]) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
        try {
          await context.addInitScript((lang) => localStorage.setItem("llv_lang", lang), locale);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`${base}/?scroll-history=1&compact=1&long-operator=1`);
          await page.waitForFunction(() => document.querySelectorAll("[data-feed-key]").length === 120);
          await page.waitForTimeout(500);
          const cdp = await context.newCDPSession(page);
          const scroller = page.locator("[data-log-feed-scroller]");
          // The twelfth long operator message, opened with a tap on its summary.
          const mark = () => page.evaluate(() => {
            const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
            const details = feed.querySelectorAll<HTMLElement>("[data-user-bubble] details")[12]!;
            details.dataset.probe = "1";
            details.closest<HTMLElement>("[data-feed-key]")!.dataset.probeRow = "1";
            feed.scrollTop += details.getBoundingClientRect().top - feed.getBoundingClientRect().top - 300;
          });
          await mark();
          await page.waitForTimeout(400);
          await tap(page, cdp, "[data-probe] > summary");
          await page.waitForTimeout(400);
          const rowTop = () => page.evaluate(() => document.querySelector<HTMLElement>("[data-probe-row]")!.getBoundingClientRect().top
            - document.querySelector<HTMLElement>("[data-log-feed-scroller]")!.getBoundingClientRect().top);
          await scroller.evaluate((el, target) => {
            const row = el.querySelector<HTMLElement>("[data-probe-row]")!;
            el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - target;
          }, depth);
          await page.waitForTimeout(300);
          // One real wheel step releases the tail, so the feed keeps an anchor of its own.
          await scroller.hover();
          await page.mouse.wheel(0, 1);
          await page.waitForTimeout(900);
          const before = await rowTop();
          await page.screenshot({ path: path.join(out, `fold-${locale}-${depth}-before.png`) });
          await tap(page, cdp, "[data-probe] > summary");
          await page.waitForTimeout(900);
          const folded = await rowTop();
          const closed = await page.evaluate(() => !document.querySelector<HTMLDetailsElement>("[data-probe]")!.open);
          for (let n = 0; n < 5; n += 1) {
            await page.evaluate(() => (window as unknown as { historyFixture: { append(): void } }).historyFixture.append());
            await page.waitForTimeout(150);
          }
          await page.waitForTimeout(500);
          const appended = await rowTop();
          await page.screenshot({ path: path.join(out, `fold-${locale}-${depth}-after.png`) });
          const reading = { locale, depth, before: Math.round(before * 100) / 100, folded: Math.round(folded * 100) / 100,
            appended: Math.round(appended * 100) / 100, closed };
          readings.push(reading);
          console.log(`scroll-history fold ${JSON.stringify(reading)}`);
          expect(errors).toEqual([]);
          expect(closed).toBe(true);
          expect(Math.abs(folded - before)).toBeLessThanOrEqual(3);
          expect(Math.abs(appended - before)).toBeLessThanOrEqual(3);
          await cdp.detach();
        } finally { await context.close(); }
      }
    } finally {
      await browser.close(); stop();
      fs.writeFileSync(path.join(out, "fold.json"), `${JSON.stringify({ readings }, null, 2)}\n`);
    }
  }, 240_000);

  /*
   * The desktop canvas scales a pane with a transform, and a zoom moves the
   * pane's rectangles without a scroll event. The reader's anchor is kept in
   * the scroller's own layout pixels, so a zoom between taking it and the next
   * layout change is not read as the content having moved: after a real wheel
   * walk off the tail, the pane is scaled to 0.6, 1, 0.8 and 0.5 with a row
   * appended after each, and neither scrollTop nor the row under the reader
   * (in layout pixels) may move by more than 3.
   */
  browserTest("a zoom of the pane between layout changes does not move the reader", async () => {
    const { base, stop } = await serveFixture();
    const browser = await launchChromium();
    const out = path.resolve(".artifacts/scroll-history");
    fs.mkdirSync(out, { recursive: true });
    const readings: unknown[] = [];
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 844 } });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${base}/?scroll-history=1&compact=1`);
        await page.waitForFunction(() => document.querySelectorAll("[data-feed-key]").length === 120);
        await page.waitForTimeout(500);
        const scroller = page.locator("[data-log-feed-scroller]");
        await scroller.hover();
        for (let step = 0; step < 6; step += 1) {
          await page.mouse.wheel(0, -260);
          await page.waitForTimeout(200);
        }
        await page.waitForTimeout(900);
        const read = () => page.evaluate(() => {
          const feed = document.querySelector<HTMLElement>("[data-log-feed-scroller]")!;
          const bounds = feed.getBoundingClientRect();
          const scale = bounds.height / feed.offsetHeight;
          const row = [...feed.querySelectorAll<HTMLElement>("[data-feed-key]")].find((node) => node.getBoundingClientRect().bottom > bounds.top + 1)!;
          return { scrollTop: feed.scrollTop, scale, key: row.dataset.feedKey!, rowTop: (row.getBoundingClientRect().top - bounds.top) / scale };
        });
        let last = await read();
        expect(last.scrollTop).toBeGreaterThan(0);
        await page.screenshot({ path: path.join(out, "zoom-before.png") });
        for (const zoom of [0.6, 1, 0.8, 0.5]) {
          await page.evaluate((zoom) => {
            const root = document.getElementById("root")!;
            root.style.transformOrigin = "top left";
            root.style.transform = `scale(${zoom})`;
          }, zoom);
          await page.waitForTimeout(200);
          const zoomed = await read();
          await page.evaluate(() => (window as unknown as { historyFixture: { append(): void } }).historyFixture.append());
          await page.waitForTimeout(700);
          const after = await read();
          const reading = { zoom, scale: Math.round(after.scale * 100) / 100, scrollTopMoved: Math.round((after.scrollTop - last.scrollTop) * 100) / 100,
            sameRow: after.key === last.key, rowMoved: Math.round((after.rowTop - last.rowTop) * 100) / 100,
            zoomItselfMoved: Math.round((zoomed.scrollTop - last.scrollTop) * 100) / 100 };
          readings.push(reading);
          console.log(`scroll-history zoom ${JSON.stringify(reading)}`);
          expect(Math.abs(reading.scrollTopMoved)).toBeLessThanOrEqual(3);
          expect(reading.sameRow).toBe(true);
          expect(Math.abs(reading.rowMoved)).toBeLessThanOrEqual(3);
          last = after;
        }
        await page.screenshot({ path: path.join(out, "zoom-after.png") });
        expect(errors).toEqual([]);
      } finally { await context.close(); }
    } finally {
      await browser.close(); stop();
      fs.writeFileSync(path.join(out, "zoom.json"), `${JSON.stringify({ readings }, null, 2)}\n`);
    }
  }, 120_000);
});
