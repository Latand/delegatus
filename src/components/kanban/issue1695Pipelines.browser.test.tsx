import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";

/*
 * Rendered evidence for pipelines on kanban cards (#1695 K5a): the real Viewer
 * over `issue1695Evidence.fixture.tsx?scenario=pipelines`, with the production
 * stylesheet, in Chromium:
 *
 *   LLV_KANBAN_BROWSER_TEST=1 bun test src/components/kanban/issue1695Pipelines.browser.test.tsx
 *
 * With KANBAN_PROTOTYPE_URL pointing at a served copy of the approved
 * prototype, the same cards are rendered by the prototype at the same board
 * width, saved beside the production frames, and their graph geometry is
 * compared.
 *
 * Gated here:
 *   - the retry pipeline's graph: direction chosen for the width, node boxes,
 *     pass edges solid, the fail edge back to Implement dashed in its lane with
 *     "fail · retry 1 of 2", Review's round chip, Verify running;
 *   - a two-stage pipeline fits left to right;
 *   - a shelf card starts on the summary, with its forward fail branch;
 *   - the toggle switches graph and summary;
 *   - a node opens its stage's conversation inside the card and is marked;
 *   - Past attempts lists the superseded attempts and opens one;
 *   - a new attempt arriving through the fail edge marks that edge live, and
 *     the mark clears.
 *
 * Measurements go to `evidence/issue-1695/k5a.json`; frames to
 * `.artifacts/issue-1695/`, which is not committed.
 */

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1695");
const EVIDENCE = path.resolve("evidence/issue-1695");
const PROTOTYPE = process.env.KANBAN_PROTOTYPE_URL?.trim().replace(/\/$/, "") || null;
const VIEWPORT = { width: 1440, height: 900 } as const;
/* Wide enough that the Assigned column fits a two-stage graph left to right. */
const WIDE = { width: 1680, height: 950 } as const;

type Scheme = "light" | "dark";

interface GraphMeasure {
  dir: string | null;
  nodes: Array<{ stage: string; width: number; height: number; state: string; detail: string }>;
  edges: Array<{ edge: string; classes: string; dashed: boolean }>;
  labels: string[];
}

/** The graph of one card, read the same way from either page. */
const measureGraph = (page: Page, cardSelector: string) => page.evaluate((selector): GraphMeasure | null => {
  const card = document.querySelector(selector);
  const graph = card?.querySelector<HTMLElement>(".pgraph");
  if (!graph) return null;
  return {
    dir: graph.dataset.dir ?? null,
    nodes: [...graph.querySelectorAll<HTMLElement>(".pnode")].map((node) => {
      const box = node.getBoundingClientRect();
      return {
        stage: node.dataset.stage ?? "",
        width: Math.round(box.width),
        height: Math.round(box.height),
        state: node.querySelector(".pstate")?.textContent?.trim() ?? "",
        detail: [...node.querySelectorAll(".pdetail, .rchip")].map((part) => part.textContent?.trim()).join(" "),
      };
    }),
    edges: [...graph.querySelectorAll<SVGPathElement>(".pedge")].map((edge) => ({
      edge: edge.dataset.edge ?? "",
      classes: edge.getAttribute("class") ?? "",
      dashed: getComputedStyle(edge).strokeDasharray !== "none",
    })),
    labels: [...graph.querySelectorAll(".pelabel")].map((label) => label.textContent?.trim() ?? ""),
  };
}, cardSelector);

const card = (id: string) => `[data-kanban-board] .card[data-id="task:${id}"]`;
const protoCard = (id: string) => `#app .card[data-id="${id}"]`;

async function boardReady(page: Page) {
  await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 20_000 });
  await page.waitForTimeout(700);
}

browserTest("#1695 K5a: pipeline graphs, summaries and Past attempts on kanban cards, against the prototype", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const server = await serveEvidenceFixture(OUT);
  const base = `${server.base}?scenario=pipelines`;
  const browser: Browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
  const failures: string[] = [];
  const frames: Record<string, unknown> = {};
  const flows: Record<string, unknown> = {};
  const notes: string[] = [];
  let boardWidth = 0;

  const widths: Record<string, number> = {};
  const production = async (scheme: Scheme, label: string, run: (page: Page) => Promise<void>, viewport: { width: number; height: number } = VIEWPORT) => {
    const opened = await openFixture(browser, base, viewport, scheme);
    try {
      await boardReady(opened.page);
      widths[viewport.width] ??= await opened.page.evaluate(() => Math.round(document.querySelector("[data-kanban-board]")!.getBoundingClientRect().width));
      if (!boardWidth) boardWidth = await opened.page.evaluate(() => Math.round(document.querySelector("[data-kanban-board]")!.getBoundingClientRect().width));
      await run(opened.page);
      if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      await opened.context.close();
    }
  };
  const prototype = async (query: string, scheme: Scheme, label: string, run: (page: Page) => Promise<void>, viewport: { width: number; height: number } = VIEWPORT) => {
    if (!PROTOTYPE) return;
    const opened = await openFixture(browser, `${PROTOTYPE}/?${query}`, { width: widths[viewport.width] ?? viewport.width, height: viewport.height }, scheme);
    try {
      await opened.page.waitForSelector("#app[data-ready] .board", { timeout: 20_000 });
      await opened.page.waitForTimeout(600);
      await run(opened.page);
    } catch (error) {
      notes.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      await opened.context.close();
    }
  };
  const shot = (page: Page, side: string, id: string, scheme: Scheme) => page.screenshot({ path: path.join(OUT, `${side}-k5a-${id}-${scheme}.png`) });

  try {
    for (const scheme of ["light", "dark"] as const) {
      await production(scheme, `retry graph ${scheme}`, async (page) => {
        await page.locator(`${card("t-search")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(300);
        const graph = await measureGraph(page, card("t-search"));
        await shot(page, "production", "graph-branch-retry", scheme);
        frames[`graph-branch-retry-${scheme}`] = { production: graph };
        if (!graph) {
          failures.push(`retry graph ${scheme}: no graph on the active workspace card`);
          return;
        }
        const byStage = new Map(graph.nodes.map((node) => [node.stage, node] as const));
        if (graph.nodes.map((node) => node.stage).join() !== "implement,review,verify,merge") failures.push(`retry graph ${scheme}: nodes ${JSON.stringify(graph.nodes)}`);
        if (graph.nodes.some((node) => node.height !== 76)) failures.push(`retry graph ${scheme}: node heights ${graph.nodes.map((node) => node.height)}`);
        if (byStage.get("verify")?.state !== "running" || byStage.get("merge")?.state !== "waiting") failures.push(`retry graph ${scheme}: states ${JSON.stringify(graph.nodes)}`);
        if (byStage.get("review")?.detail !== "R1 ✓") failures.push(`retry graph ${scheme}: review rounds ${byStage.get("review")?.detail}`);
        const fail = graph.edges.find((edge) => edge.edge === "verify:fail:implement");
        if (!fail?.dashed || !/\bback\b/.test(fail.classes) || !/\btaken\b/.test(fail.classes)) failures.push(`retry graph ${scheme}: fail edge ${JSON.stringify(fail)}`);
        if (graph.edges.filter((edge) => !edge.dashed).length !== 3) failures.push(`retry graph ${scheme}: pass edges ${JSON.stringify(graph.edges)}`);
        if (!graph.labels.includes("fail · retry 1 of 2")) failures.push(`retry graph ${scheme}: labels ${JSON.stringify(graph.labels)}`);
      });
      await prototype("scrollto=t-search", scheme, `prototype retry graph ${scheme}`, async (page) => {
        await page.locator(`${protoCard("t-search")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "start" }));
        await page.waitForTimeout(300);
        const graph = await measureGraph(page, protoCard("t-search"));
        await shot(page, "prototype", "graph-branch-retry", scheme);
        Object.assign(frames[`graph-branch-retry-${scheme}`] as object ?? {}, { prototype: graph });
      });
    }

    await production("light", "two-stage graph", async (page) => {
      await page.locator(`${card("t-links")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      const graph = await measureGraph(page, card("t-links"));
      await shot(page, "production", "graph-two-stage", "light");
      frames["graph-two-stage"] = { production: graph };
      if (graph?.dir !== "LR" || graph.nodes.some((node) => node.width !== 176 || node.height !== 76)) failures.push(`two-stage graph: ${JSON.stringify(graph)}`);
    }, WIDE);
    await prototype("scrollto=t-links", "light", "prototype two-stage graph", async (page) => {
      await page.locator(`${protoCard("t-links")} .stage-section`).evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      Object.assign(frames["graph-two-stage"] as object, { prototype: await measureGraph(page, protoCard("t-links")) });
      await shot(page, "prototype", "graph-two-stage", "light");
    }, WIDE);

    await production("light", "summary and past attempts", async (page) => {
      const shelf = await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        return element ? {
          open: element.querySelector(".stage-section")?.classList.contains("open") ?? null,
          chips: [...element.querySelectorAll(".psummary .pchip")].map((chip) => chip.textContent?.trim()),
          loops: [...element.querySelectorAll(".psummary .ploop")].map((loop) => loop.textContent?.trim()),
        } : null;
      }, card("t-limits"));
      if (!shelf || shelf.open !== false || !shelf.chips.some((chip) => chip?.startsWith("branch:")) || shelf.loops.length !== 1) failures.push(`shelf summary: ${JSON.stringify(shelf)}`);
      frames["shelf-summary"] = { production: shelf };

      await page.locator(`${card("t-search")} details.history`).evaluate((element) => { (element as HTMLDetailsElement).open = true; element.scrollIntoView({ block: "center" }); });
      await page.waitForTimeout(300);
      const past = await page.evaluate((selector) => [...document.querySelectorAll(`${selector} details.history li`)].map((row) => ({
        label: row.querySelector(".lbl")?.textContent, verdict: row.querySelector(".verdict")?.textContent, open: Boolean(row.querySelector(".hopen")),
      })), card("t-search"));
      await shot(page, "production", "history-open", "light");
      if (past.length !== 2 || !past.every((row) => row.open)) failures.push(`past attempts: ${JSON.stringify(past)}`);
      frames["history-open"] = { production: past };
      await page.click(`${card("t-search")} details.history li .hopen`);
      await page.waitForSelector(`${card("t-search")} [data-kanban-reader]`, { timeout: 10_000 });
      const opened = await page.evaluate((selector) => document.querySelector<HTMLElement>(`${selector} [data-kanban-reader]`)?.dataset.kanbanReader ?? null, card("t-search"));
      if (!opened) failures.push("past attempts: Open conversation opened no reader in the card");
      flows.pastOpen = opened;
    });
    await prototype("history=open&scrollto=t-search", "light", "prototype history", async (page) => {
      await page.locator(`${protoCard("t-search")} details.history`).evaluate((element) => element.scrollIntoView({ block: "center" }));
      await page.waitForTimeout(300);
      await shot(page, "prototype", "history-open", "light");
    });

    await production("light", "toggle and node", async (page) => {
      const section = `${card("t-search")} .stage-section`;
      await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "start" }));
      await page.click(`${section} [data-graph-toggle]`);
      const summary = await page.evaluate((selector) => ({ nodes: document.querySelectorAll(`${selector} .pnode`).length, chips: document.querySelectorAll(`${selector} .pchip`).length }), section);
      await page.click(`${section} [data-graph-toggle]`);
      await page.waitForSelector(`${section} .pnode`, { timeout: 5_000 });
      await page.click(`${section} .pnode[data-stage="verify"]`);
      await page.waitForSelector(`${card("t-search")} [data-kanban-reader]`, { timeout: 10_000 });
      await page.waitForTimeout(300);
      const node = await page.evaluate((selector) => ({
        pressed: document.querySelector(`${selector} .pnode[data-stage="verify"]`)?.getAttribute("aria-pressed"),
        reader: document.querySelector<HTMLElement>(`${selector.replace(" .stage-section", "")} [data-kanban-reader]`)?.dataset.kanbanReader ?? null,
      }), section);
      await shot(page, "production", "node-reader", "light");
      if (summary.nodes !== 0 || summary.chips !== 4) failures.push(`toggle: summary ${JSON.stringify(summary)}`);
      if (node.pressed !== "true" || node.reader !== "conversation_search-ver-2") failures.push(`node: ${JSON.stringify(node)}`);
      flows.toggleAndNode = { summary, node };
    });

    await production("light", "live edge", async (page) => {
      const section = `${card("t-search")} .stage-section`;
      await page.locator(section).evaluate((element) => element.scrollIntoView({ block: "start" }));
      const before = await page.evaluate((selector) => document.querySelectorAll(`${selector} .pedge.live`).length, section);
      await page.evaluate(() => (window as unknown as { evidence: { addStageAttempt: (pipelineId: string, stageId: string, over: Record<string, unknown>) => void } })
        .evidence.addStageAttempt("p-search", "implement", { activatedBy: { stageId: "verify", attempt: 2, edge: "fail" } }));
      const started = Date.now();
      await page.waitForSelector(`${section} .pedge.live[data-edge="verify:fail:implement"]`, { timeout: 10_000 });
      const arrivedMs = Date.now() - started;
      const label = await page.evaluate((selector) => document.querySelector(`${selector} .pelabel.live`)?.textContent ?? null, section);
      await shot(page, "production", "live-edge", "light");
      await page.waitForFunction((selector) => !document.querySelector(`${selector} .pedge.live`), section, { timeout: 6_000 });
      if (before !== 0 || label !== "fail · retry 2 of 2") failures.push(`live edge: ${JSON.stringify({ before, label })}`);
      flows.liveEdge = { before, arrivedMs, label, cleared: true };
    });
  } finally {
    await browser.close();
    server.stop();
  }

  const compare = (key: string) => {
    const frame = frames[key] as { production?: GraphMeasure | null; prototype?: GraphMeasure | null } | undefined;
    if (!frame?.production || !frame.prototype) return null;
    return {
      dir: { production: frame.production.dir, prototype: frame.prototype.dir },
      nodeHeights: { production: frame.production.nodes.map((node) => node.height), prototype: frame.prototype.nodes.map((node) => node.height) },
      nodeWidths: { production: frame.production.nodes.map((node) => node.width), prototype: frame.prototype.nodes.map((node) => node.width) },
      edges: { production: frame.production.edges.length, prototype: frame.prototype.edges.length },
      labels: { production: frame.production.labels, prototype: frame.prototype.labels },
    };
  };
  const geometry = PROTOTYPE ? { retryLight: compare("graph-branch-retry-light"), retryDark: compare("graph-branch-retry-dark"), twoStage: compare("graph-two-stage") } : null;
  for (const [key, value] of Object.entries(geometry ?? {})) {
    if (!value) {
      failures.push(`${key}: the prototype frame was not measured`);
      continue;
    }
    if (value.dir.production !== value.dir.prototype) failures.push(`${key}: direction ${value.dir.production}, prototype ${value.dir.prototype}`);
    if (value.edges.production !== value.edges.prototype) failures.push(`${key}: ${value.edges.production} edges, prototype ${value.edges.prototype}`);
    if (JSON.stringify(value.nodeHeights.production) !== JSON.stringify(value.nodeHeights.prototype)) failures.push(`${key}: node heights ${value.nodeHeights.production}, prototype ${value.nodeHeights.prototype}`);
    const widthDelta = Math.max(0, ...value.nodeWidths.production.map((width, index) => Math.abs(width - (value.nodeWidths.prototype[index] ?? width))));
    if (widthDelta > 2) failures.push(`${key}: node widths ${value.nodeWidths.production}, prototype ${value.nodeWidths.prototype}`);
  }
  if (PROTOTYPE && notes.length) failures.push(...notes.map((note) => `prototype not driven: ${note}`));
  fs.writeFileSync(path.join(EVIDENCE, "k5a.json"), `${JSON.stringify({ prototypeCompared: Boolean(PROTOTYPE), boardWidth, boardWidths: widths, frames, geometry, flows, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);
