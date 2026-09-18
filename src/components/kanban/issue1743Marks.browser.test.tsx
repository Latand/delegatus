import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

import { openFixture, serveEvidenceFixture } from "./issue1695BrowserHarness";

/*
 * Rendered evidence for #1743, on the harness the #1695 cases already use: the
 * real Viewer over `issue1695Evidence.fixture.tsx?scenario=issue1743`, with the
 * production stylesheet, in Chromium.
 *
 *   LLV_KANBAN_BROWSER_TEST=1 CHROME_BIN=$(which google-chrome-stable) \
 *     bun test src/components/kanban/issue1743Marks.browser.test.tsx
 *
 * The seeded task carries two pipelines. In the first, the critique's fail edge
 * has sent the work back to the builder TWICE of three; in the second the same
 * kind of edge has spent its whole budget. Across their stages sit mixed engines,
 * all five effort levels, a long uncatalogued model, a stage edited after its
 * last launch, and a stage that has never started.
 *
 * Three surfaces are gated, each in English and in Ukrainian, light and dark:
 *
 *   card graph  — the task card's own graph at 1280 px
 *   modal graph — the same graph inside the Stages sheet
 *   390 px      — the phone, where the kanban never mounts (mobile v2 keeps its
 *                 own board); what is gated there is that the SAME engine mark
 *                 component draws, so the vocabulary is one across the Viewer.
 *
 * What it measures, as numbers: the count on each travelled edge, whether the
 * spent edge is drawn exhausted, the engine mark and effort step on every node
 * and chip, which nodes read as configuration, which flag a differing next
 * attempt, and — for every node — whether any child overflows its box.
 *
 * Measurements go to `evidence/issue-1743/marks.json`; frames to
 * `.artifacts/issue-1743/`, which is not committed.
 */

const browserTest = process.env.LLV_KANBAN_BROWSER_TEST === "1" ? test : test.skip;
const OUT = path.resolve(".artifacts/issue-1743");
const EVIDENCE = path.resolve("evidence/issue-1743");
const CARD = '[data-kanban-board] .card[data-id="task:t-marks"]';
const LOOPED = '.stage-section[data-pipeline="p-marks"]';
const SPENT = '.stage-section[data-pipeline="p-marks-spent"]';

interface NodeMeasure {
  stage: string;
  engineMark: string | null;
  effortStep: string | null;
  identity: string | null;
  nextDiffers: boolean;
  model: string;
  /** The model text is ellipsized rather than widening the node. */
  modelTruncated: boolean;
  /** Pixels by which the widest child sticks out of the node's own box. */
  overflowX: number;
  overflowY: number;
}

interface EdgeMeasure {
  edge: string;
  fired: string | null;
  travelled: boolean;
  spent: boolean;
  /** The circled number drawn on the arrow, when one is. */
  circle: string | null;
}

interface GraphMeasure {
  nodes: NodeMeasure[];
  edges: EdgeMeasure[];
  /** Effective on-screen px of the identity row's 10 px caption text. */
  captionPx: number;
  identityWords: string | null;
}

const READ_GRAPH = (scopeSelector: string) => (page: Page) => page.evaluate((selector): GraphMeasure | null => {
  const scope = document.querySelector(selector);
  const graph = scope?.querySelector<HTMLElement>(".pgraph");
  if (!scope || !graph) return null;
  /* The graph may sit under a scale transform (the modal's zoom), so the caption
     size that matters is the one it actually lands at on screen. */
  const drawn = graph.getBoundingClientRect().width / Math.max(1, graph.offsetWidth);
  const captionRaw = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-caption")) || 10;
  const nodes = [...graph.querySelectorAll<HTMLElement>(".pnode")].map((node) => {
    const box = node.getBoundingClientRect();
    let overflowX = 0;
    let overflowY = 0;
    for (const child of node.querySelectorAll<HTMLElement>("*")) {
      /* The edge ports are drawn straddling the border on purpose, so they are
         not content and cannot overflow it. */
      if (child.classList.contains("pport")) continue;
      const rect = child.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      overflowX = Math.max(overflowX, rect.right - box.right, box.left - rect.left);
      overflowY = Math.max(overflowY, rect.bottom - box.bottom, box.top - rect.top);
    }
    const identity = node.querySelector<HTMLElement>(".pident");
    return {
      stage: node.dataset.stage ?? "",
      engineMark: node.querySelector("[data-engine-mark]")?.getAttribute("data-engine-mark") ?? null,
      effortStep: node.querySelector("[data-effort-pills]")?.getAttribute("data-effort-step") ?? null,
      identity: identity?.dataset.identity ?? null,
      nextDiffers: Boolean(node.querySelector("[data-next-differs]")),
      model: identity?.querySelector(".imodel")?.textContent?.trim() ?? "",
      modelTruncated: (() => {
        const text = identity?.querySelector<HTMLElement>(".imodel");
        return Boolean(text && text.scrollWidth > text.clientWidth + 1);
      })(),
      overflowX: Math.round(overflowX * 100) / 100,
      overflowY: Math.round(overflowY * 100) / 100,
    };
  });
  const edges = [...graph.querySelectorAll<SVGPathElement>(".pedge")].map((path) => {
    const id = path.getAttribute("data-edge") ?? "";
    const label = graph.querySelector<HTMLElement>(`[data-edge-label="${id}"]`);
    const cls = path.getAttribute("class") ?? "";
    return {
      edge: id,
      fired: path.getAttribute("data-edge-fired"),
      travelled: cls.includes("taken"),
      spent: cls.includes("spent") || (label?.className ?? "").includes("spent"),
      circle: label?.querySelector(".ccircle")?.textContent?.trim() ?? null,
    };
  });
  return {
    nodes,
    edges,
    captionPx: Math.round(captionRaw * drawn * 100) / 100,
    identityWords: graph.dataset.identityWords ?? null,
  };
}, scopeSelector);

/** The minimized strip: one chip per stage, each carrying mark and ladder. */
const readChips = (page: Page, scopeSelector: string) => page.evaluate((selector) => {
  const scope = document.querySelector(selector);
  if (!scope) return null;
  return {
    chips: [...scope.querySelectorAll<HTMLElement>(".psummary .pchip")].map((chip) => ({
      stage: chip.dataset.stage ?? "",
      engineMark: chip.querySelector("[data-engine-mark]")?.getAttribute("data-engine-mark") ?? null,
      effortStep: chip.querySelector("[data-effort-pills]")?.getAttribute("data-effort-step") ?? null,
      markWidth: Math.round((chip.querySelector("[data-engine-mark]")?.getBoundingClientRect().width ?? 0) * 100) / 100,
      scaleWidth: Math.round((chip.querySelector("[data-effort-pills]")?.getBoundingClientRect().width ?? 0) * 100) / 100,
      nextDiffers: Boolean(chip.querySelector("[data-next-differs]")),
    })),
    loops: [...scope.querySelectorAll<HTMLElement>(".ploop")].map((loop) => ({
      count: loop.querySelector(".ccircle")?.textContent?.trim() ?? null,
      spent: loop.className.includes("spent"),
    })),
  };
}, scopeSelector);

/** The phone surface: the kanban does not mount there, and the engine mark does. */
const readPhone = (page: Page) => page.evaluate(() => ({
  board: document.querySelector("[data-mobile2-board]") ? "mobile2" : document.querySelector("[data-kanban-board]") ? "kanban" : "none",
  marks: [...document.querySelectorAll("[data-engine-mark]")].map((mark) => mark.getAttribute("data-engine-mark")),
  markBoxes: [...document.querySelectorAll<HTMLElement>("[data-engine-mark]")]
    .map((mark) => Math.round(mark.getBoundingClientRect().width))
    .filter((width) => width > 0),
  /* The one mark component emits this attribute; a surviving ad-hoc glyph would
     draw an engine icon with none. */
  pipelineRows: document.querySelectorAll('[data-mobile2-row="pipeline"]').length,
}));

browserTest("#1743: every stage says who runs it, and a fail edge that fired twice says so on the arrow", async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const server = await serveEvidenceFixture(OUT);
  const base = `${server.base}?scenario=issue1743`;
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
    ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}),
  });
  const failures: string[] = [];
  const frames: Record<string, unknown> = {};

  /* The two facts the operator asked to see, checked on whichever graph is
     handed in: the looped edge fired twice with a return left, and the spent
     one is drawn exhausted. */
  const checkGraph = (label: string, measured: GraphMeasure | null, kind: "looped" | "spent") => {
    if (!measured) {
      failures.push(`${label}: no graph was drawn`);
      return;
    }
    const overflowing = measured.nodes.filter((node) => node.overflowX > 0.5 || node.overflowY > 0.5);
    if (overflowing.length) failures.push(`${label}: nodes overflow their box ${JSON.stringify(overflowing)}`);
    if (measured.nodes.some((node) => !node.engineMark)) {
      failures.push(`${label}: a node drew no engine mark ${JSON.stringify(measured.nodes.map((node) => [node.stage, node.engineMark]))}`);
    }
    if (measured.nodes.some((node) => !node.effortStep)) {
      failures.push(`${label}: a node drew no effort step ${JSON.stringify(measured.nodes.map((node) => [node.stage, node.effortStep]))}`);
    }
    if (kind === "looped") {
      const back = measured.edges.find((edge) => edge.edge === "critique:fail:build");
      if (back?.fired !== "2") failures.push(`${label}: the fail edge reads fired=${back?.fired}`);
      if (!back?.travelled) failures.push(`${label}: the fail edge that fired twice is not drawn as travelled`);
      if (back?.circle !== "2") failures.push(`${label}: the circled count on the arrow is ${JSON.stringify(back?.circle)}`);
      if (back?.spent) failures.push(`${label}: the fail edge with one return left is drawn exhausted`);
      /* The launched values win over a later edit, and the edit is flagged. */
      const build = measured.nodes.find((node) => node.stage === "build");
      if (build?.engineMark !== "claude") failures.push(`${label}: build shows ${build?.engineMark}, not what it launched on`);
      if (!build?.nextDiffers) failures.push(`${label}: build does not flag that the next attempt differs`);
      const ship = measured.nodes.find((node) => node.stage === "ship");
      if (ship?.identity !== "configured") failures.push(`${label}: the unstarted stage reads ${JSON.stringify(ship?.identity)}`);
      const started = measured.nodes.filter((node) => node.stage !== "ship" && node.stage !== "verify");
      if (started.some((node) => node.identity !== "launched")) {
        failures.push(`${label}: a started stage does not read as launched ${JSON.stringify(started.map((node) => [node.stage, node.identity]))}`);
      }
    } else {
      const back = measured.edges.find((edge) => edge.edge === "review:fail:fix");
      if (back?.fired !== "2") failures.push(`${label}: the spent fail edge reads fired=${back?.fired}`);
      if (!back?.spent) failures.push(`${label}: the exhausted budget is not drawn as exhausted`);
      if (back?.circle !== "2") failures.push(`${label}: the exhausted arrow's circle is ${JSON.stringify(back?.circle)}`);
    }
  };

  const desktop = async (lang: "en" | "uk", scheme: "light" | "dark") => {
    const label = `1280-${lang}-${scheme}`;
    const viewport = { width: 1280, height: 1000 };
    const opened = await openFixture(browser, base, viewport, scheme, lang);
    try {
      await opened.page.waitForSelector(CARD, { state: "attached", timeout: 20_000 });
      await opened.page.locator(CARD).evaluate((element) => element.scrollIntoView({ block: "start" }));
      await opened.page.waitForTimeout(400);
      /* The compact strip first: engine and effort with no graph open. */
      const chips = await readChips(opened.page, `${CARD} ${LOOPED}`);
      if (!chips?.chips.length) failures.push(`${label}: the compact strip drew no chip`);
      for (const chip of chips?.chips ?? []) {
        if (!chip.engineMark) failures.push(`${label}: chip ${chip.stage} drew no engine mark`);
        if (!chip.effortStep) failures.push(`${label}: chip ${chip.stage} drew no effort step`);
        if (chip.markWidth <= 0) failures.push(`${label}: chip ${chip.stage} mark is ${chip.markWidth} px wide`);
        if (chip.scaleWidth <= 0) failures.push(`${label}: chip ${chip.stage} effort scale is ${chip.scaleWidth} px wide`);
      }
      if (chips?.loops[0]?.count !== "2") failures.push(`${label}: the loop chip counts ${JSON.stringify(chips?.loops[0]?.count)}`);
      const spentChips = await readChips(opened.page, `${CARD} ${SPENT}`);
      if (!spentChips?.loops[0]?.spent) failures.push(`${label}: the spent loop chip is not drawn as spent`);

      /* Then the card graph itself. */
      for (const selector of [`${CARD} ${LOOPED}`, `${CARD} ${SPENT}`]) {
        await opened.page.click(`${selector} [data-graph-toggle]`);
      }
      await opened.page.waitForTimeout(400);
      const looped = await READ_GRAPH(`${CARD} ${LOOPED}`)(opened.page);
      const spent = await READ_GRAPH(`${CARD} ${SPENT}`)(opened.page);
      await opened.page.screenshot({ path: path.join(OUT, `card-${label}.png`) });
      checkGraph(`card ${label}`, looped, "looped");
      checkGraph(`card ${label}`, spent, "spent");
      if (looped && looped.captionPx < 9) failures.push(`card ${label}: identity text lands at ${looped.captionPx} px`);

      /* And the modal graph, which draws the same nodes under the sheet's zoom. */
      await opened.page.click(`${CARD} ${LOOPED} [data-open-stages]`);
      await opened.page.waitForSelector("[data-sheet-graph]", { state: "attached", timeout: 20_000 });
      /* The sheet's graph toggle is a switch: turn it on only if it is off. */
      if (await opened.page.getAttribute("[data-sheet-graph]", "aria-pressed") !== "true") {
        await opened.page.click("[data-sheet-graph]");
      }
      await opened.page.waitForSelector(".gsheet .pgraph", { state: "attached", timeout: 20_000 });
      await opened.page.waitForTimeout(400);
      const modal = await READ_GRAPH(".gsheet")(opened.page);
      /* Amendment 3: the modal draws the graph under a scale, so the identity
         row's 10 px caption lands smaller than it is written. Zooming out twice
         from the default takes it under the 9 px floor, and the words must give
         way to the mark and the ladder, which are shapes and stay readable. */
      await opened.page.click('[data-zoom="-"]');
      await opened.page.click('[data-zoom="-"]');
      await opened.page.waitForTimeout(300);
      const zoomedOut = await READ_GRAPH(".gsheet")(opened.page);
      const zoomScale = await opened.page.getAttribute("[data-zoom-scale]", "data-zoom-scale");
      const navChips = await opened.page.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-nav-stage]")].map((chip) => ({
        stage: chip.dataset.navStage ?? "",
        engineMark: chip.querySelector("[data-engine-mark]")?.getAttribute("data-engine-mark") ?? null,
        effortStep: chip.querySelector("[data-effort-pills]")?.getAttribute("data-effort-step") ?? null,
      })));
      await opened.page.screenshot({ path: path.join(OUT, `modal-${label}.png`) });
      checkGraph(`modal ${label}`, modal, "looped");
      if (modal && modal.captionPx < 9 && modal.identityWords !== "0") {
        failures.push(`modal ${label}: identity text lands at ${modal.captionPx} px and the words were kept`);
      }
      if (navChips.some((chip) => !chip.engineMark || !chip.effortStep)) {
        failures.push(`modal ${label}: a nav chip is missing its mark or ladder ${JSON.stringify(navChips)}`);
      }
      if (zoomedOut) {
        if (zoomedOut.captionPx >= 9) failures.push(`modal ${label}: two zoom-out steps still land the caption at ${zoomedOut.captionPx} px`);
        if (zoomedOut.identityWords !== "0") failures.push(`modal ${label}: the words survived at ${zoomedOut.captionPx} px`);
        if (zoomedOut.nodes.some((node) => node.model)) failures.push(`modal ${label}: a model still reads at ${zoomedOut.captionPx} px`);
        if (zoomedOut.nodes.some((node) => !node.engineMark || !node.effortStep)) {
          failures.push(`modal ${label}: the mark or the ladder was dropped with the words ${JSON.stringify(zoomedOut.nodes)}`);
        }
      }
      frames[label] = { viewport, chips, spentChips, looped, spent, modal, navChips, zoomedOut: { ...zoomedOut, zoomScale } };
      if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      await opened.context.close();
    }
  };

  const phone = async (lang: "en" | "uk") => {
    const label = `390-${lang}`;
    const viewport = { width: 390, height: 844 };
    const opened = await openFixture(browser, base, viewport, "light", lang);
    try {
      await opened.page.waitForSelector('[data-mobile2-row="pipeline"]', { state: "attached", timeout: 20_000 });
      await opened.page.waitForTimeout(400);
      const measured = await readPhone(opened.page);
      await opened.page.screenshot({ path: path.join(OUT, `phone-${label}.png`), fullPage: true });
      frames[label] = { viewport, measured };
      /* The kanban card graph does not exist at this width: mobile v2 keeps its
         own board (#1695). What must hold here is that the phone draws the SAME
         mark component, so the engine vocabulary is one across the Viewer. */
      if (measured.board !== "mobile2") failures.push(`${label}: the phone drew ${measured.board}`);
      if (!measured.marks.length) failures.push(`${label}: the phone drew no engine mark`);
      if (measured.marks.some((mark) => mark !== "claude" && mark !== "codex" && mark !== "openclaw")) {
        failures.push(`${label}: an unexpected engine mark ${JSON.stringify(measured.marks)}`);
      }
      if (measured.markBoxes.some((width) => width < 12)) failures.push(`${label}: a mark rendered at ${JSON.stringify(measured.markBoxes)} px`);
      if (!measured.pipelineRows) failures.push(`${label}: the phone board drew no pipeline row`);
      if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      await opened.context.close();
    }
  };

  try {
    for (const lang of ["en", "uk"] as const) {
      for (const scheme of ["light", "dark"] as const) await desktop(lang, scheme);
      await phone(lang);
    }
  } finally {
    await browser.close();
    server.stop();
  }
  fs.writeFileSync(path.join(EVIDENCE, "marks.json"), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 600_000);
