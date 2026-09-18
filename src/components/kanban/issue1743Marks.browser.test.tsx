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
 * Four surfaces are gated, each in English and in Ukrainian, light and dark:
 *
 *   card graph  — the task card's own graph at 1280 px, inside a 256 px column
 *   640 px      — the narrowest desktop, where the card graph falls to legend
 *                 mode and the arrow carries a bare badge
 *   modal graph — the same graph inside the Stages sheet, with its pane headers
 *   390 px      — the phone: its board rows AND its pipeline screen, which draws
 *                 a pipeline as stage rows rather than as a graph
 *
 * What it measures, as numbers: the count on each travelled edge, whether the
 * spent edge is drawn exhausted, the engine mark and effort step on every node,
 * chip and phone stage row, which nodes read as configuration, which flag a
 * differing next attempt, and — for every node, every edge label, every loop
 * chip and every pane header — whether anything overflows the box it sits in.
 *
 * The language of each frame is proved rather than assumed: `openFixture` seeds
 * `llv_lang` before the first render, and every frame records the document's own
 * `lang` plus the strings it drew, so an English render can never again be filed
 * as Ukrainian evidence.
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
  /** An arrow that has just carried work animates; it is dashed while it does. */
  live: boolean;
  /** The stroke as drawn: dashed while an edge is only configured, solid once
      it has been travelled — on a pass edge exactly as on a fail edge. */
  dash: string;
  /** The circled number drawn on the arrow, when one is. */
  circle: string | null;
  /** What the label settled on when it sits beside the return lane. */
  form: string | null;
  /** The label's own text, so a language claim can be checked. */
  text: string;
  /** Pixels by which the label sticks out of the graph's own box. */
  overflowX: number;
  /** Painted area of the label in px², and the fill it paints. */
  area: number;
  fill: string;
  filled: boolean;
  /** The disc's own fill and the fill behind it: a disc painted in its
      surround is a hole, which is the pass count's drawing, not a fail's. */
  circleFill: string;
  markFill: string;
}

interface GraphMeasure {
  nodes: NodeMeasure[];
  edges: EdgeMeasure[];
  /** Effective on-screen px of the identity row's 10 px caption text. */
  captionPx: number;
  identityWords: string | null;
  /** Rows the graph moved under itself because a label did not fit beside it.
      The key must sample the SAME mark the arrow above it carries. */
  legend: Array<{ edge: string; text: string; circle: string | null; filled: boolean; spent: boolean }>;
}

const READ_GRAPH = (scopeSelector: string) => (page: Page) => page.evaluate((selector): GraphMeasure | null => {
  const scope = document.querySelector(selector);
  const graph = scope?.querySelector<HTMLElement>(".pgraph");
  const box = scope?.querySelector<HTMLElement>(".pgraph-box");
  if (!scope || !graph) return null;
  /* The graph may sit under a scale transform (the modal's zoom), so the caption
     size that matters is the one it actually lands at on screen. */
  const drawn = graph.getBoundingClientRect().width / Math.max(1, graph.offsetWidth);
  const captionRaw = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--text-caption")) || 10;
  const nodes = [...graph.querySelectorAll<HTMLElement>(".pnode")].map((node) => {
    const rect = node.getBoundingClientRect();
    let overflowX = 0;
    let overflowY = 0;
    for (const child of node.querySelectorAll<HTMLElement>("*")) {
      /* The edge ports are drawn straddling the border on purpose, so they are
         not content and cannot overflow it. */
      if (child.classList.contains("pport")) continue;
      const childRect = child.getBoundingClientRect();
      if (!childRect.width && !childRect.height) continue;
      overflowX = Math.max(overflowX, childRect.right - rect.right, rect.left - childRect.left);
      overflowY = Math.max(overflowY, childRect.bottom - rect.bottom, rect.top - childRect.top);
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
    /* Painted boxes, not layout boxes: a label carries a translate of its own
       (centred on its point, or only vertically when it sits beside the return
       lane), so only the rendered rectangle says whether the graph box cuts it.
       Both rects are in the same scaled space, so dividing by the graph's own
       scale gives the answer in layout px at any zoom. */
    const overflowX = label
      ? Math.max(0, (label.getBoundingClientRect().right - graph.getBoundingClientRect().right) / Math.max(drawn, 0.01))
      : 0;
    /* Where a fail label paints depends on the form it took: a full pill inverts
       ITSELF when the budget is spent, while a bare badge has no pill and the
       ink sits on the mark inside it. Read whichever of the two actually paints,
       so "exhausted is never the lighter drawing" is measured on the drawing
       the operator sees (#1743). */
    const opaque = (colour: string) => Boolean(colour) && colour !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(colour);
    const mark = label?.querySelector<HTMLElement>(".cfired") ?? null;
    const labelFill = label ? getComputedStyle(label).backgroundColor : "";
    const markFill = mark ? getComputedStyle(mark).backgroundColor : "";
    const fill = opaque(labelFill) ? labelFill : markFill;
    const paintedRect = (opaque(labelFill) ? label : mark ?? label)?.getBoundingClientRect();
    return {
      edge: id,
      fired: path.getAttribute("data-edge-fired"),
      travelled: cls.includes("taken"),
      spent: cls.includes("spent") || (label?.className ?? "").includes("spent"),
      live: cls.includes("live"),
      dash: getComputedStyle(path).strokeDasharray,
      circle: label?.querySelector(".ccircle")?.textContent?.trim() ?? null,
      form: label?.dataset.edgeLabelForm ?? null,
      text: label?.textContent?.trim() ?? "",
      overflowX: Math.round(overflowX * 100) / 100,
      area: paintedRect ? Math.round(paintedRect.width * paintedRect.height) : 0,
      fill,
      filled: opaque(labelFill) || opaque(markFill),
      circleFill: (() => {
        const circle = label?.querySelector<HTMLElement>(".ccircle");
        return circle ? getComputedStyle(circle).backgroundColor : "";
      })(),
      markFill,
    };
  });
  return {
    nodes,
    edges,
    captionPx: Math.round(captionRaw * drawn * 100) / 100,
    identityWords: graph.dataset.identityWords ?? null,
    legend: [...(box?.querySelectorAll<HTMLElement>(".plegend li") ?? [])].map((row) => ({
      edge: row.dataset.legendEdge ?? "",
      text: row.textContent?.trim() ?? "",
      circle: row.querySelector(".ccircle")?.textContent?.trim() ?? null,
      filled: Boolean(row.querySelector(".ccircle.filled")),
      spent: Boolean(row.querySelector(".cfired.spent")),
    })),
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
      text: loop.textContent?.trim() ?? "",
      /* The chip is a fixed 22 px pill: text that wraps inside it paints above
         and below the pill, which is what a 256 px card did (#1743). */
      clientHeight: loop.clientHeight,
      scrollHeight: loop.scrollHeight,
      clientWidth: loop.clientWidth,
      scrollWidth: loop.scrollWidth,
      budget: loop.querySelector(".lbudget")?.textContent?.trim() ?? "",
      budgetTruncated: (() => {
        const part = loop.querySelector<HTMLElement>(".lbudget");
        return Boolean(part && part.scrollWidth > part.clientWidth + 1);
      })(),
    })),
  };
}, scopeSelector);

/** Every pane header the sheet drew: the model must survive beside the role. */
const readPaneHeads = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".gsheet .pane")].map((pane) => {
  const role = pane.querySelector<HTMLElement>(".pane-title .prole");
  const model = role?.querySelector<HTMLElement>(".imodel");
  return {
    stage: pane.getAttribute("data-stage") ?? "",
    engineMark: role?.querySelector("[data-engine-mark]")?.getAttribute("data-engine-mark") ?? null,
    effortStep: role?.querySelector("[data-effort-pills]")?.getAttribute("data-effort-step") ?? null,
    model: model?.textContent?.trim() ?? "",
    modelWidth: Math.round((model?.getBoundingClientRect().width ?? 0) * 100) / 100,
    /* Content wider than the row is content the row cuts. */
    roleOverflow: role ? Math.max(0, role.scrollWidth - role.clientWidth) : 0,
    nextExpanded: Boolean(role?.querySelector(".pnext .nvals")),
    nextDiffers: Boolean(role?.querySelector("[data-next-differs]")),
  };
}));

/** The phone board: the kanban does not mount there, and the engine mark does. */
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

/** The phone's pipeline screen: a pipeline drawn as stage rows. */
const readPhoneStages = (page: Page) => page.evaluate(() => ({
  rows: [...document.querySelectorAll<HTMLElement>("[data-mobile2-stage]")].map((row) => ({
    stage: row.dataset.mobile2Stage ?? "",
    engineMark: row.querySelector("[data-engine-mark]")?.getAttribute("data-engine-mark") ?? null,
    effortStep: row.querySelector("[data-effort-pills]")?.getAttribute("data-effort-step") ?? null,
    identity: row.querySelector<HTMLElement>(".pident")?.dataset.identity ?? null,
    model: row.querySelector(".imodel")?.textContent?.trim() ?? "",
    returns: row.querySelector(".ccircle")?.textContent?.trim() ?? null,
    /* A return is a FILLED disc in both states, with a closed ring once the
       budget is spent, and the budget itself is printed beside it: on a phone
       there is no arrow and no legend to carry either (#1743). */
    returnFilled: Boolean(row.querySelector(".cfired .ccircle.filled")),
    returnSpent: Boolean(row.querySelector(".cfired.spent")),
    returnBudget: row.querySelector("[data-mobile2-stage-budget]")?.textContent?.trim() ?? "",
    returnBudgetState: row.querySelector<HTMLElement>("[data-mobile2-stage-budget]")?.dataset.mobile2StageBudget ?? null,
    /* Painted area of the whole mark, so "exhausted reads heavier than live"
       is a number rather than a claim. */
    returnArea: (() => {
      const mark = row.querySelector<HTMLElement>(".cfired");
      if (!mark) return 0;
      const rect = mark.getBoundingClientRect();
      return Math.round(rect.width * rect.height);
    })(),
    /* The stage name may not be squeezed out by the budget beside it. */
    nameWidth: Math.round((row.querySelector<HTMLElement>(".truncate")?.getBoundingClientRect().width ?? 0)),
    /* Nothing on a 390 px row may paint outside the row. */
    overflowX: (() => {
      const rect = row.getBoundingClientRect();
      let out = 0;
      for (const child of row.querySelectorAll<HTMLElement>("*")) {
        const childRect = child.getBoundingClientRect();
        if (!childRect.width && !childRect.height) continue;
        out = Math.max(out, childRect.right - rect.right, rect.left - childRect.left);
      }
      return Math.round(out * 100) / 100;
    })(),
  })),
}));

/** What language the page is actually in, taken from the page itself. */
const readLanguage = (page: Page) => page.evaluate(() => ({
  documentLang: document.documentElement.lang,
  stored: (() => { try { return localStorage.getItem("llv_lang"); } catch { return null; } })(),
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
    /* A label the graph box cuts loses exactly the part that carries the
       remaining budget, so no label may stick out of the box (#1743). */
    const cut = measured.edges.filter((edge) => edge.overflowX > 0.5);
    if (cut.length) failures.push(`${label}: edge labels are cut by the graph box ${JSON.stringify(cut.map((edge) => [edge.edge, edge.overflowX, edge.text]))}`);
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
    /* Whatever a fail label gave up to fit, the budget it no longer prints is
       in the legend under the graph — never nowhere. A pass edge has no budget,
       so its bare circled count is the whole of what it has to say. */
    for (const edge of measured.edges.filter((entry) => entry.form === "badge")) {
      if (!measured.legend.some((row) => row.text.includes(String(edge.fired)) && row.text.length > 8)) {
        failures.push(`${label}: ${edge.edge} stepped down to a number and the legend says nothing`);
      }
    }
    /* Wherever the mark itself paints the exhausted ring, the disc inside it
       must still be a DISC: painted in the ring's own colour it is a hole, and
       a hole is this vocabulary's pass count (#1743). */
    for (const edge of measured.edges.filter((entry) => entry.spent && entry.travelled)) {
      if (edge.markFill && edge.markFill === edge.circleFill) {
        failures.push(`${label}: the exhausted count on ${edge.edge} is a hole in its ring (${edge.circleFill})`);
      }
    }
    /* Dashed is "configured, not travelled" on every kind of edge: a pass edge
       that has never fired may not read as a path the work has taken (#1743).
       A live arrow animates its own dashes, so it is not evidence either way. */
    for (const edge of measured.edges.filter((entry) => !entry.live)) {
      const dashed = Boolean(edge.dash) && edge.dash !== "none";
      if (edge.travelled && dashed) failures.push(`${label}: travelled edge ${edge.edge} is drawn dashed (${edge.dash})`);
      if (!edge.travelled && !dashed) failures.push(`${label}: untravelled edge ${edge.edge} is drawn solid`);
    }
    /* A key that samples a different mark than the arrow it explains explains
       nothing: the legend's circle is filled like the arrow's, and carries the
       same closed ring when the budget is spent (#1743). */
    for (const row of measured.legend) {
      const drawn = measured.edges.find((edge) => edge.edge === row.edge);
      if (!drawn?.travelled) continue;
      if (!row.filled) failures.push(`${label}: the legend for ${row.edge} samples an outlined count where the arrow is filled`);
      if (row.spent !== Boolean(drawn.spent)) {
        failures.push(`${label}: the legend for ${row.edge} reads spent=${row.spent} while the arrow reads spent=${drawn.spent}`);
      }
    }
  };

  /* The card's own graph at a given width, in one language and scheme. */
  const desktop = async (lang: "en" | "uk", scheme: "light" | "dark", width: number, withModal: boolean) => {
    const label = `${width}-${lang}-${scheme}`;
    const viewport = { width, height: width >= 1280 ? 1000 : 720 };
    const opened = await openFixture(browser, base, viewport, scheme, lang);
    try {
      await opened.page.waitForSelector(CARD, { state: "attached", timeout: 20_000 });
      const language = await readLanguage(opened.page);
      if (language.documentLang !== lang) failures.push(`${label}: the page rendered in ${JSON.stringify(language)}`);
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
      /* The loop chip is one 22 px line and the budget is the fact it exists
         for: it may neither wrap out of its pill nor be the part cut off. */
      for (const loop of [...(chips?.loops ?? []), ...(spentChips?.loops ?? [])]) {
        if (loop.scrollHeight > loop.clientHeight + 1) {
          failures.push(`${label}: a loop chip wraps out of its pill (${loop.scrollHeight} in ${loop.clientHeight}) ${JSON.stringify(loop.text)}`);
        }
        if (loop.scrollWidth > loop.clientWidth + 1) {
          failures.push(`${label}: a loop chip overflows its pill (${loop.scrollWidth} in ${loop.clientWidth}) ${JSON.stringify(loop.text)}`);
        }
        if (!loop.budget) failures.push(`${label}: a loop chip prints no budget ${JSON.stringify(loop.text)}`);
        if (loop.budgetTruncated) failures.push(`${label}: a loop chip's budget is cut ${JSON.stringify(loop.budget)}`);
      }

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
      /* Exhaustion is a luminance cue: wherever the two are drawn the same way,
         the spent edge must never carry LESS ink than the live one. */
      const liveLabel = looped?.edges.find((edge) => edge.edge === "critique:fail:build");
      const spentLabel = spent?.edges.find((edge) => edge.edge === "review:fail:fix");
      if (liveLabel && spentLabel) {
        if (!spentLabel.filled) failures.push(`card ${label}: the exhausted label paints no fill`);
        if (spentLabel.fill === liveLabel.fill) {
          failures.push(`card ${label}: the exhausted label paints the same fill as the live one (${spentLabel.fill})`);
        }
        /* Same drawing, so the areas are comparable: exhaustion may never be the
           lighter of the two. In legend mode both are bare badges, which is the
           case that read backwards before (#1743). */
        if (spentLabel.form === liveLabel.form && spentLabel.area < liveLabel.area) {
          failures.push(`card ${label}: the exhausted label is smaller than the live one (${spentLabel.area} vs ${liveLabel.area} px2)`);
        }
      }

      if (!withModal) {
        frames[label] = { viewport, language, chips, spentChips, looped, spent };
        if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
        return;
      }

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
      const paneHeads = await readPaneHeads(opened.page);
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
      /* A pane is 340-440 px wide: its title line keeps mark, model and ladder,
         and the model never lands at nothing (#1743). */
      if (!paneHeads.length) failures.push(`modal ${label}: the sheet drew no pane`);
      for (const head of paneHeads) {
        if (!head.engineMark) failures.push(`modal ${label}: pane ${head.stage} drew no engine mark`);
        if (!head.effortStep) failures.push(`modal ${label}: pane ${head.stage} drew no effort ladder`);
        if (head.model && head.modelWidth < 24) failures.push(`modal ${label}: pane ${head.stage} draws its model at ${head.modelWidth} px`);
        if (head.roleOverflow > 1) failures.push(`modal ${label}: pane ${head.stage} cuts ${head.roleOverflow} px of its identity row`);
        if (head.nextExpanded) failures.push(`modal ${label}: pane ${head.stage} spells the next attempt out on a line this narrow`);
      }
      if (zoomedOut) {
        if (zoomedOut.captionPx >= 9) failures.push(`modal ${label}: two zoom-out steps still land the caption at ${zoomedOut.captionPx} px`);
        if (zoomedOut.identityWords !== "0") failures.push(`modal ${label}: the words survived at ${zoomedOut.captionPx} px`);
        if (zoomedOut.nodes.some((node) => node.model)) failures.push(`modal ${label}: a model still reads at ${zoomedOut.captionPx} px`);
        if (zoomedOut.nodes.some((node) => !node.engineMark || !node.effortStep)) {
          failures.push(`modal ${label}: the mark or the ladder was dropped with the words ${JSON.stringify(zoomedOut.nodes)}`);
        }
      }
      frames[label] = { viewport, language, chips, spentChips, looped, spent, modal, paneHeads, navChips, zoomedOut: { ...zoomedOut, zoomScale } };
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
      const language = await readLanguage(opened.page);
      if (language.documentLang !== lang) failures.push(`${label}: the page rendered in ${JSON.stringify(language)}`);
      const measured = await readPhone(opened.page);
      await opened.page.screenshot({ path: path.join(OUT, `phone-${label}.png`), fullPage: true });
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

      /* The phone's pipeline screen draws the pipeline as stage rows: that is
         where "who runs this stage" and "work came back here" belong on a phone. */
      await opened.page.click('[data-mobile2-go="pipelines"]');
      await opened.page.waitForSelector('[data-mobile2-pipeline-row="p-marks"]', { state: "attached", timeout: 20_000 });
      await opened.page.click('[data-mobile2-pipeline-row="p-marks"]');
      await opened.page.waitForSelector("[data-mobile2-stage]", { state: "attached", timeout: 20_000 });
      await opened.page.waitForTimeout(400);
      const stages = await readPhoneStages(opened.page);
      await opened.page.screenshot({ path: path.join(OUT, `phone-pipeline-${label}.png`), fullPage: true });
      if (stages.rows.length !== 5) failures.push(`${label}: the pipeline screen drew ${stages.rows.length} stage rows`);
      for (const row of stages.rows) {
        if (!row.engineMark) failures.push(`${label}: stage row ${row.stage} drew no engine mark`);
        if (!row.effortStep) failures.push(`${label}: stage row ${row.stage} drew no effort ladder`);
        if (row.overflowX > 0.5) failures.push(`${label}: stage row ${row.stage} paints ${row.overflowX} px outside itself`);
        if (row.nameWidth < 40) failures.push(`${label}: stage row ${row.stage} draws its name at ${row.nameWidth} px`);
      }
      const unstarted = stages.rows.find((row) => row.stage === "ship");
      if (unstarted?.identity !== "configured") failures.push(`${label}: the unstarted stage row reads ${JSON.stringify(unstarted?.identity)}`);
      const returned = stages.rows.find((row) => row.stage === "build");
      if (returned?.returns !== "2") failures.push(`${label}: the stage work came back to counts ${JSON.stringify(returned?.returns)}`);
      if (!returned?.returnFilled) failures.push(`${label}: the live return is not a filled disc`);
      if (returned?.returnSpent) failures.push(`${label}: the return with one left is drawn as spent`);
      if (returned?.returnBudgetState !== "left") failures.push(`${label}: the live row's budget reads ${JSON.stringify(returned?.returnBudgetState)}`);
      if (!/2.*3/.test(returned?.returnBudget ?? "")) failures.push(`${label}: the live row prints the budget as ${JSON.stringify(returned?.returnBudget)}`);
      if (stages.rows.filter((row) => row.returns).length !== 1) {
        failures.push(`${label}: a row that was never returned to carries a count ${JSON.stringify(stages.rows.map((row) => [row.stage, row.returns]))}`);
      }

      /* And the pipeline whose budget is spent, on the same screen: exhaustion
         is what the phone drew lighter and wordless before (#1743). */
      await opened.page.click("[data-mobile2-back]");
      await opened.page.waitForSelector('[data-mobile2-pipeline-row="p-marks-spent"]', { state: "attached", timeout: 20_000 });
      await opened.page.click('[data-mobile2-pipeline-row="p-marks-spent"]');
      await opened.page.waitForSelector('[data-mobile2-stage="fix"]', { state: "attached", timeout: 20_000 });
      await opened.page.waitForTimeout(400);
      const spentStages = await readPhoneStages(opened.page);
      await opened.page.screenshot({ path: path.join(OUT, `phone-pipeline-spent-${label}.png`), fullPage: true });
      const spentRow = spentStages.rows.find((row) => row.stage === "fix");
      if (spentRow?.returns !== "2") failures.push(`${label}: the exhausted row counts ${JSON.stringify(spentRow?.returns)}`);
      if (!spentRow?.returnFilled) failures.push(`${label}: the exhausted return is not a filled disc`);
      if (!spentRow?.returnSpent) failures.push(`${label}: the exhausted return draws no closed ring`);
      if (spentRow?.returnBudgetState !== "spent") failures.push(`${label}: the exhausted row's budget reads ${JSON.stringify(spentRow?.returnBudgetState)}`);
      if (!/2.*2/.test(spentRow?.returnBudget ?? "")) failures.push(`${label}: the exhausted row prints the budget as ${JSON.stringify(spentRow?.returnBudget)}`);
      if (spentRow?.returnBudget === returned?.returnBudget) {
        failures.push(`${label}: the exhausted row says the same as the live one ${JSON.stringify(spentRow?.returnBudget)}`);
      }
      /* Exhaustion may never be the LIGHTER of the two drawings. */
      if ((spentRow?.returnArea ?? 0) < (returned?.returnArea ?? 0)) {
        failures.push(`${label}: the exhausted mark is smaller than the live one (${spentRow?.returnArea} vs ${returned?.returnArea} px2)`);
      }
      for (const row of spentStages.rows) {
        if (row.overflowX > 0.5) failures.push(`${label}: exhausted stage row ${row.stage} paints ${row.overflowX} px outside itself`);
      }
      frames[label] = { viewport, language, measured, stages, spentStages };
      if (opened.pageErrors.length) failures.push(`${label}: page errors ${opened.pageErrors.join(" | ")}`);
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    } finally {
      await opened.context.close();
    }
  };

  try {
    for (const lang of ["en", "uk"] as const) {
      for (const scheme of ["light", "dark"] as const) {
        await desktop(lang, scheme, 1280, true);
        /* The narrowest desktop the board supports: the card graph falls to
           legend mode and the arrow carries a bare badge. */
        await desktop(lang, scheme, 640, false);
      }
      await phone(lang);
    }
  } finally {
    await browser.close();
    server.stop();
  }

  /* The languages must differ where they say anything: a uk frame whose strings
     are byte-identical to the en one is an English render filed as Ukrainian. */
  for (const scheme of ["light", "dark"] as const) {
    for (const width of [1280, 640] as const) {
      const en = frames[`${width}-en-${scheme}`] as { chips?: { loops: Array<{ text: string }> } } | undefined;
      const uk = frames[`${width}-uk-${scheme}`] as { chips?: { loops: Array<{ text: string }> } } | undefined;
      const enText = en?.chips?.loops[0]?.text ?? "";
      const ukText = uk?.chips?.loops[0]?.text ?? "";
      if (!enText || !ukText) failures.push(`${width}-${scheme}: a loop chip printed nothing to compare languages on`);
      else if (enText === ukText) failures.push(`${width}-${scheme}: the Ukrainian frame drew the English string ${JSON.stringify(enText)}`);
    }
  }

  fs.writeFileSync(path.join(EVIDENCE, "marks.json"), `${JSON.stringify({ frames, failures }, null, 2)}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
}, 900_000);
