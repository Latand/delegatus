/*
 * Renders the tasks-menu prototype through the shared evidence harness (the
 * kanban driver's `serveEvidenceFixture` and `openFixture`) and measures every
 * frame. Run from a `git archive` export with this folder in it:
 *
 *   CHROME_BIN=<chrome wrapper> TASKS_MENU_OUT=/var/tmp/<dir> \
 *     bash scripts/gate-slot.sh bun docs/design/tasks-menu-prototype/capture.ts
 *
 * The stylesheet is the production one with one extra `@source` line for this
 * folder, because globals.css scans src/ only. Frames go to $TASKS_MENU_OUT;
 * the measurements to $TASKS_MENU_OUT/geometry.json. TASKS_MENU_ONLY=<regexp>
 * renders the matching frames and merges them into that file. Each frame's
 * `problems` list names what the visual critic's findings would still catch;
 * a clean run prints «with problems 0».
 */
import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import postcss from "postcss";
import type { Browser, Page } from "playwright-core";

import { caseChromium, openFixture, serveEvidenceFixture } from "@/components/kanban/issue1695BrowserHarness";

const OUT = process.env.TASKS_MENU_OUT ?? path.resolve(".artifacts/tasks-menu");
const FRAMES = path.join(OUT, "frames");
fs.mkdirSync(FRAMES, { recursive: true });

const globals = fs.readFileSync("src/app/globals.css", "utf8").replace(
  '@import "tailwindcss" source("..");',
  '@import "tailwindcss" source("..");\n@source "../../docs/design/tasks-menu-prototype";',
);
const css = (await postcss([tailwind()]).process(globals, { from: path.resolve("src/app/globals.css") })).css;

type Lang = "en" | "uk";
type Theme = "light" | "dark";
interface Shot { name: string; query: string; width: number; lang: Lang; theme: Theme; click?: string }

const WIDTHS = [1440, 1000, 390] as const;
const HEIGHT: Record<number, number> = { 1440: 900, 1000: 760, 390: 844 };
const shots: Shot[] = [];
for (const width of WIDTHS) for (const lang of ["uk", "en"] as const) for (const theme of ["light", "dark"] as const) {
  const phone = width === 390 ? "&phone=1" : "";
  const base = `${width}-${lang}-${theme}`;
  shots.push({ name: `original-${base}`, query: `v=0${phone}`, width, lang, theme });
  shots.push({ name: `variant-1-${base}-tasks`, query: `v=1${phone}`, width, lang, theme });
  shots.push({ name: `variant-1-${base}-agents`, query: `v=1&tab=agents${phone}`, width, lang, theme });
  shots.push({ name: `variant-1-${base}-expanded`, query: `v=1&expand=t-login${phone}`, width, lang, theme });
  shots.push({ name: `variant-2-${base}-tasks`, query: `v=2${phone}`, width, lang, theme });
  shots.push({ name: `variant-2-${base}-agents`, query: `v=2&tab=agents${phone}`, width, lang, theme });
  shots.push({ name: `variant-2-${base}-expanded`, query: `v=2&expand=t-login${phone}`, width, lang, theme });
  shots.push({ name: `variant-3-${base}-tasks`, query: `v=3&select=t-login${phone}`, width, lang, theme });
  shots.push({ name: `variant-3-${base}-agents`, query: `v=3&tab=agents&select=t-login${phone}`, width, lang, theme });
  if (width === 390) {
    shots.push({ name: `variant-3-${base}-detail`, query: `v=3&select=t-login&detail=1${phone}`, width, lang, theme });
    shots.push({ name: `variant-3-${base}-agent-detail`, query: `v=3&tab=agents&agent=a-login&detail=1${phone}`, width, lang, theme });
  }
  if (width === 1440) {
    shots.push({ name: `original-${base}-all`, query: "v=0", width, lang, theme, click: '[data-task-panel] button[aria-pressed="false"]' });
    for (const v of [1, 2, 3]) shots.push({ name: `variant-${v}-${base}-all`, query: `v=${v}&scope=all${v === 3 ? "&select=t-pricing" : ""}`, width, lang, theme });
    for (const v of [1, 2, 3]) shots.push({ name: `variant-${v}-${base}-status`, query: `v=${v}&pop=t-header${v === 3 ? "&select=t-login" : ""}`, width, lang, theme });
  }
}

/* What each frame is measured for. Geometry: sideways scroll (also sub-pixel,
   by pushing scrollLeft and reading it back), facts cut by their box (a Range
   over the text against the box), title/age overlap, phone targets under
   44 px, and which rows are visible without scrolling, in order. Then the
   visual critic's findings, each as a number that must stay at its clean
   value (`problemsOf` below reads them). */
async function measure(page: Page, width: number) {
  return page.evaluate((viewportWidth) => {
    const root = document.scrollingElement!;
    root.scrollLeft = 10_000;
    const pageScrollsSideways = root.scrollLeft !== 0;
    root.scrollLeft = 0;
    const scrollers = [...document.querySelectorAll<HTMLElement>("[data-proto-scroll], [data-proto-pane], [data-task-panel] .overflow-y-auto, [data-mobile2-sheet] .overflow-y-auto")];
    const sideways = scrollers.filter((element) => {
      element.scrollLeft = 10_000;
      const moved = element.scrollLeft !== 0;
      element.scrollLeft = 0;
      return moved;
    }).length;
    const outside = [...document.querySelectorAll<HTMLElement>("body *")].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && (box.right > viewportWidth + 0.5 || box.left < -0.5);
    }).map((element) => element.tagName + (element.getAttribute("class") ?? "").slice(0, 40)).slice(0, 5);
    const textBox = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect();
    };
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < window.innerHeight;
    };
    const all = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) => [...scope.querySelectorAll<T>(selector)].filter(shown);
    const cut: string[] = [];
    for (const element of all("[data-proto-now], [data-proto-pr], .motion-line, [data-proto-fold], [data-proto-tabs] button, [data-proto-scope] button, [data-proto-project], [data-proto-agent-line], [data-proto-agent-task], [data-proto-title]")) {
      const box = element.getBoundingClientRect();
      const text = textBox(element);
      if (text.right > box.right + 0.5 || text.bottom > box.bottom + 0.5) cut.push((element.textContent ?? "").slice(0, 60));
    }
    const overlaps: string[] = [];
    for (const age of all("[data-proto-age]")) {
      const title = age.closest("button")?.querySelector<HTMLElement>("[data-proto-title], [data-proto-agent-name], .truncate.font-semibold");
      if (!title) continue;
      const a = age.getBoundingClientRect();
      const b = textBox(title);
      if (a.left < b.right - 0.5 && a.top < b.bottom && b.top < a.bottom) overlaps.push((title.textContent ?? "").slice(0, 40));
    }
    const scroller = scrollers[0];
    const view = scroller?.getBoundingClientRect();
    const rowSelector = "[data-proto-row] [data-proto-title], [data-proto-agent] [data-proto-agent-name], [data-task-panel] button[title] .truncate, [data-task-sheet-row] .truncate";
    const visibleTitles = view ? [...document.querySelectorAll<HTMLElement>(rowSelector)].filter((element) => {
      const box = element.getBoundingClientRect();
      return box.height > 0 && box.top >= view.top - 0.5 && box.bottom <= view.bottom + 0.5;
    }).map((element) => element.textContent ?? "") : [];
    const smallTargets = viewportWidth <= 430
      ? all("button").filter((element) => element.getBoundingClientRect().height < 43.5)
        .map((element) => `${(element.textContent ?? element.getAttribute("aria-label") ?? "").slice(0, 30)} ${element.getBoundingClientRect().height.toFixed(0)}px`)
      : [];
    const panel = document.querySelector<HTMLElement>("[data-proto-dock], [data-task-panel], [data-proto-sheet], [data-mobile2-sheet]")?.getBoundingClientRect();

    /* The critic's findings, measured. Only the variants carry these marks. */
    const painted = (value: string) => !/^(transparent|rgba\(.*,\s*0\))$/.test(value);
    const ownText = (element: Element) => [...element.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? "").trim().length > 0);
    /* A text pill or chip: passive text in a row or a card that sits on its
       own fill or inside its own border. Buttons and the popover are not. */
    const pills = all("[data-proto-row] *, [data-proto-expanded] *, [data-proto-agent] *, [data-proto-agent-head] *").filter((element) => {
      if (element.closest("[data-proto-actions], [data-proto-status-pop]")) return false;
      if (element.tagName === "BUTTON" || element.tagName === "svg" || element.closest("svg")) return false;
      const style = getComputedStyle(element);
      const framed = parseFloat(style.borderTopWidth) > 0 && painted(style.borderTopColor);
      return (framed || painted(style.backgroundColor)) && (ownText(element) || element.matches("[data-proto-stage]"));
    }).map((element) => (element.textContent ?? "").slice(0, 30));
    const glyphGaps = all("[data-proto-stage-name]").map((name) => {
      const glyph = name.closest("[data-proto-now]")?.querySelector("[data-proto-glyph]") ?? name.previousElementSibling;
      return glyph ? name.getBoundingClientRect().left - glyph.getBoundingClientRect().right : 99;
    });
    const unique = (values: number[]) => [...new Set(values.map((value) => Math.round(value)))].sort((a, b) => a - b);
    const chevronRights = unique(all("[data-proto-chevron] svg").map((element) => element.getBoundingClientRect().right));
    const titleGaps = unique(all("[data-proto-row] > button").flatMap((row) => {
      const title = row.querySelector("[data-proto-title]");
      const line = row.querySelector("[data-proto-line]");
      return title && line ? [line.getBoundingClientRect().top - textBox(title).bottom] : [];
    }));
    const projects = all("[data-proto-project]");
    const projectRights = unique(projects.map((element) => element.getBoundingClientRect().right));
    /* A task row's project sits right under its age; an agent row's on its task line. */
    const projectOffLine = projects.filter((element) => {
      const age = element.closest("[data-proto-meta]")?.querySelector("[data-proto-age]");
      if (age) return Math.abs(age.getBoundingClientRect().bottom - element.getBoundingClientRect().top) > 1.5;
      const line = element.closest("button")!.querySelector("[data-proto-agent-task]");
      return !line || Math.abs(line.getBoundingClientRect().top - element.getBoundingClientRect().top) > 1.5;
    }).length;
    const rowHeights = unique(all("[data-proto-row] > button").map((row) => row.getBoundingClientRect().height));
    /* Every rendered row's height by task, scrolled out of view or not, so an
       «all projects» frame can be held to its «this project» frame. */
    const rowHeightById = Object.fromEntries([...document.querySelectorAll<HTMLElement>("[data-proto-row] > button")]
      .filter((row) => row.getBoundingClientRect().height > 0)
      .map((row) => [row.parentElement!.getAttribute("data-proto-row")!, Math.round(row.getBoundingClientRect().height)]));
    /* A wrapped stage state or question continues under the stage name. */
    const hangingWraps = all("[data-proto-now]").flatMap((now) => {
      const name = now.querySelector("[data-proto-stage-name]");
      const word = name?.nextElementSibling;
      if (!name || !word) return [];
      const left = name.getBoundingClientRect().left;
      return [...word.getClientRects()].filter((rect) => rect.left < left - 0.5).map(() => (now.textContent ?? "").slice(0, 40));
    });
    /* One word for a running stage: the agent's («working»), never «running». */
    const runningWords = all("[data-proto-now], [data-proto-stages] li, [data-proto-stages] span").filter((element) => /\brunning\b/.test(element.innerText)).length;
    /* An age printed in seconds reads as a minute from 60 s on. */
    const longSeconds = all("[data-proto-age]").filter((element) => /^(?:[6-9]\d)\s?(?:с|s)(?!\p{L})/u.test((element.textContent ?? "").trim())).map((element) => element.textContent ?? "");
    const agentRows = all("[data-proto-agent] > button");
    const agentChevrons = all("[data-proto-agent] [data-proto-chevron] svg").length;
    const agentRowHeights = unique(agentRows.map((row) => row.getBoundingClientRect().height));
    /* One time per row: the same duration printed twice in one row or one
       agent line is the critic's «one fact shown twice». `innerText` reads
       what is drawn, so a closed popover does not count. */
    const TIME = /\d+\s?(?:хв|год|дн|міс|с|m|h|d|s|mo)(?![\p{L}\d])/gu;
    const repeatedTimes = all("[data-proto-row] > button, [data-proto-agent] > button, [data-proto-agent-facts]").filter((element) => {
      const found = element.innerText.match(TIME) ?? [];
      return new Set(found).size !== found.length;
    }).map((element) => element.innerText.replace(/\s+/g, " ").slice(0, 60));
    /* An opened task: its row and its card together print each duration once. */
    const repeatedInOpened = all("[data-proto-expanded]").filter((card) => {
      const row = card.closest("[data-proto-row]")?.querySelector<HTMLElement>(":scope > button");
      const found = [...(row?.innerText.match(TIME) ?? []), ...([...card.querySelectorAll<HTMLElement>("[data-proto-agent-facts]")].flatMap((line) => line.innerText.match(TIME) ?? []))];
      return new Set(found).size !== found.length;
    }).length;
    const timesPerAgent = unique(all("[data-proto-agent] > button, [data-proto-agent-facts]").map((element) => (element.innerText.match(TIME) ?? []).length));
    const asksUnderHeading = all('[data-proto-group="needs-you"] [data-proto-row] > button').filter((row) => /питає вас|asks you|Потрібні ви|Needs you/.test(row.textContent ?? "")).length;
    const needsYouPrefix = all("[data-proto-row] > button").filter((row) => /Потрібні ви:|Needs you:/.test(row.textContent ?? "")).length;
    const askTones = [...new Set(all("[data-proto-ask]").map((element) => getComputedStyle(element).color))];
    const tabCounts = all("[data-proto-tabs] button").filter((button) => /\d/.test(button.textContent ?? "")).length;
    const variant = document.querySelector("[data-proto-variant]")?.getAttribute("data-proto-variant") ?? null;
    const scrollerFirst = document.querySelector("[data-proto-scroll]")?.firstElementChild;
    const firstBlock = scrollerFirst ? (scrollerFirst.getAttribute("data-proto-group") ?? scrollerFirst.getAttribute("data-proto-bucket") ?? (scrollerFirst.hasAttribute("data-proto-agents") ? "agents" : scrollerFirst.tagName.toLowerCase())) : null;
    const agentsTab = document.querySelector('[data-proto-tabs] button[aria-selected="true"]') === document.querySelectorAll("[data-proto-tabs] button")[1];
    const pane = document.querySelector<HTMLElement>("[data-proto-pane]");
    const paneRead = pane ? (() => {
      const box = pane.getBoundingClientRect();
      const content = Math.max(...[...pane.querySelectorAll<HTMLElement>("*")].map((element) => element.getBoundingClientRect().bottom)) - box.top;
      const facts = pane.querySelector("[data-proto-agent-facts]");
      return {
        paneWidth: Math.round(box.width),
        boardVisible: Math.round(box.left),
        paneHeight: Math.round(box.height),
        emptyBelowContent: Math.round(box.height - content),
        agentFactsSpan: facts ? Math.round(textBox(facts).width) : null,
        selectedInList: all("[data-proto-agent] > button[aria-current], [data-proto-row] > button[aria-current]").length,
        favouritesFold: agentsTab ? all("[data-proto-agents] [data-proto-fold]").length : null,
        agentTitleInPane: agentsTab ? all("[data-proto-pane] [data-proto-agent-task]").length : 0,
        closeButton: all("[data-proto-pane] [data-proto-pane-close]").length,
      };
    })() : null;
    const pop = all("[data-proto-status-pop]")[0];
    const popRead = pop ? (() => {
      const box = pop.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { inside: box.left >= 0 && box.right <= viewportWidth && box.top >= 0 && box.bottom <= window.innerHeight, onTop: Boolean(top && pop.contains(top)), text: pop.textContent ?? "" };
    })() : null;
    const expanded = all("[data-proto-expanded]")[0];
    return {
      pageScrollsSideways, sidewaysScrollers: sideways, outside, cut, overlaps, smallTargets,
      panelWidth: panel ? Math.round(panel.width) : null,
      rowsAboveFold: visibleTitles.length,
      firstTitles: visibleTitles.slice(0, 10),
      critic: variant ? {
        variant, firstBlock, pills, statusDots: all("[data-proto-status-dot]").length,
        taskRows: all("[data-proto-row] > button [data-proto-line]").length, rowDots: all("[data-proto-row] > button [data-proto-status-dot]").length,
        minGlyphGap: glyphGaps.length ? Math.round(Math.min(...glyphGaps) * 10) / 10 : null,
        chevrons: all("[data-proto-chevron] svg").length, chevronRights, titleGaps, rowHeights,
        projectRights, projectOffLine, rowHeightById, hangingWraps, runningWords, longSeconds,
        agentRows: agentRows.length, agentRowHeights, agentChevrons, spawnedMarks: all("[data-proto-spawned]").length,
        detailScreen: document.querySelector("[data-proto-detail]")?.getAttribute("data-proto-detail") ?? null,
        detailParts: { back: all("[data-proto-back]").length, agentHead: all("[data-proto-agent-head]").length, card: all("[data-proto-expanded]").length },
        repeatedTimes, repeatedInOpened, timesPerAgent, asksUnderHeading, needsYouPrefix, askTones, tabCounts,
        newTaskOnAgents: agentsTab ? all("[data-proto-new]").length : 0,
        headTabs: all("[data-proto-head] [data-proto-tabs]").length,
        expandedShown: expanded ? expanded.getAttribute("data-proto-expanded") : null,
        pane: paneRead, pop: popRead,
      } : null,
    };
  }, width);
}

type Reading = Awaited<ReturnType<typeof measure>>;

/** Every way a frame can still carry a critic finding, by name. Empty is clean. */
function problemsOf(name: string, reading: Reading, pageErrors: readonly unknown[]): string[] {
  const out: string[] = [];
  if (pageErrors.length) out.push(`page errors ${pageErrors.length}`);
  if (reading.pageScrollsSideways || reading.sidewaysScrollers) out.push("sideways scroll");
  if (reading.outside.length) out.push(`outside viewport: ${reading.outside.join(" | ")}`);
  if (reading.cut.length) out.push(`cut: ${reading.cut.join(" | ")}`);
  if (reading.overlaps.length) out.push(`title/age overlap: ${reading.overlaps.join(" | ")}`);
  const critic = reading.critic;
  if (!critic) return out;
  if (reading.smallTargets.length) out.push(`small targets: ${reading.smallTargets.join(" | ")}`);
  if (critic.pills.length) out.push(`text pills or chips: ${critic.pills.join(" | ")}`);
  if (critic.minGlyphGap !== null && critic.minGlyphGap < 6) out.push(`glyph ${critic.minGlyphGap}px from the stage name`);
  if (critic.chevronRights.length > 1) out.push(`chevron column moves: ${critic.chevronRights.join(",")}`);
  if (critic.titleGaps.length > 1) out.push(`title-to-line gap uneven: ${critic.titleGaps.join(",")}`);
  if (critic.projectRights.length > 1) out.push(`project place moves: ${critic.projectRights.join(",")}`);
  if (critic.projectOffLine) out.push(`project away from its place: ${critic.projectOffLine}`);
  if (critic.hangingWraps.length) out.push(`wrapped state left of the stage name: ${critic.hangingWraps.join(" | ")}`);
  if (critic.runningWords) out.push(`«running» beside «working»: ${critic.runningWords}`);
  if (critic.longSeconds.length) out.push(`age in seconds past a minute: ${critic.longSeconds.join(" | ")}`);
  if (critic.repeatedTimes.length) out.push(`one time twice: ${critic.repeatedTimes.join(" | ")}`);
  if (critic.repeatedInOpened) out.push("a duration repeated between the row and its opened card");
  if (critic.timesPerAgent.some((count) => count > 1)) out.push(`agent with ${critic.timesPerAgent.join("/")} times`);
  if (critic.asksUnderHeading) out.push(`«asks you» under «Needs you»: ${critic.asksUnderHeading}`);
  if (critic.needsYouPrefix) out.push(`«Needs you:» sentence on a row: ${critic.needsYouPrefix}`);
  if (critic.tabCounts) out.push(`count in a tab: ${critic.tabCounts}`);
  if (critic.newTaskOnAgents) out.push("«new task» on the Agents tab");
  if (critic.headTabs !== 1 && !name.endsWith("-detail")) out.push(`tabs in the head: ${critic.headTabs}`);
  if (/-(tasks|all|expanded|status)$/.test(name) && critic.variant === "2" && critic.firstBlock !== "needs-you") out.push(`variant 2 opens on ${critic.firstBlock}`);
  if (/-(tasks|all|expanded|status)$/.test(name) && critic.variant !== "3" && !critic.chevrons) out.push("no open mark on rows");
  if (/variant-3-390-.*-tasks$/.test(name) && !critic.chevrons) out.push("no open mark on phone rows");
  if (name.endsWith("-expanded") && critic.expandedShown !== "t-login") out.push("opened task not in view");
  if (/-(tasks|all|expanded|status)$/.test(name) && (!critic.taskRows || critic.rowDots !== critic.taskRows)) out.push(`status dots on ${critic.rowDots} of ${critic.taskRows} rows`);
  if (/variant-3-390-.*-agents$/.test(name) && critic.agentChevrons !== critic.agentRows) out.push(`agent rows with an open mark: ${critic.agentChevrons} of ${critic.agentRows}`);
  if (name.endsWith("-agent-detail") && !(critic.detailScreen === "agent" && critic.detailParts.back === 1 && critic.detailParts.agentHead === 1 && critic.detailParts.card === 1)) out.push(`agent screen incomplete: ${JSON.stringify(critic.detailParts)}`);
  if (/-3-390-.*-detail$/.test(name) && !name.endsWith("-agent-detail") && !(critic.detailScreen === "task" && critic.detailParts.back === 1 && critic.detailParts.card === 1)) out.push(`task screen incomplete: ${JSON.stringify(critic.detailParts)}`);
  if (name.endsWith("-agents") && critic.agentRowHeights.some((height) => height > 76)) out.push(`agent row ${Math.max(...critic.agentRowHeights)}px tall`);
  if (name.endsWith("-agents") && critic.spawnedMarks >= critic.agentRows) out.push("every agent row is labelled");
  if (critic.pane) {
    if (critic.pane.boardVisible < 280) out.push(`board keeps ${critic.pane.boardVisible}px`);
    if (critic.pane.emptyBelowContent > 32) out.push(`pane ${critic.pane.emptyBelowContent}px taller than its content`);
    if (critic.pane.closeButton !== 1) out.push("pane without one close button");
    if (critic.pane.agentFactsSpan !== null && critic.pane.agentFactsSpan > critic.pane.paneWidth - 32) out.push("agent facts stretched across the pane");
    if (critic.pane.selectedInList !== 1) out.push(`selected rows in the list: ${critic.pane.selectedInList}`);
    if (critic.pane.favouritesFold === 0) out.push("no favourites fold");
    if (critic.pane.agentTitleInPane) out.push("agent row repeated in the pane");
  }
  if (name.endsWith("-status") && !(critic.pop && critic.pop.inside && critic.pop.onTop)) out.push("status popover clipped or covered");
  return out;
}

async function shoot(browser: Browser, base: string, shot: Shot) {
  const phone = shot.width === 390;
  const { context, page, pageErrors } = await openFixture(browser, `${base}?${shot.query}`, { width: shot.width, height: HEIGHT[shot.width]! }, shot.theme, shot.lang, "reduce", phone);
  try {
    await page.waitForSelector("[data-proto-variant], [data-task-panel], [data-mobile2-sheet]", { timeout: 30_000 });
    if (shot.click) await page.locator(shot.click).first().click();
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.querySelector("[data-proto-expanded]")?.closest("li")?.scrollIntoView({ block: "nearest" }));
    await page.waitForTimeout(250);
    const file = path.join(FRAMES, `${shot.name}.png`);
    await page.screenshot({ path: file });
    const reading = await measure(page, shot.width);
    return { ...reading, file, pageErrors };
  } finally {
    await context.close();
  }
}

const server = await serveEvidenceFixture(path.join(OUT, "serve"), "docs/design/tasks-menu-prototype/fixture.tsx", {
  "/style.css": () => new Response(css, { headers: { "content-type": "text/css" } }),
});
let browser = await caseChromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const results: Record<string, unknown> = fs.existsSync(path.join(OUT, "geometry.json")) && process.env.TASKS_MENU_ONLY ? JSON.parse(fs.readFileSync(path.join(OUT, "geometry.json"), "utf8")) : {};
let dirty = 0;
const only = process.env.TASKS_MENU_ONLY ? new RegExp(process.env.TASKS_MENU_ONLY) : null;
try {
  for (const shot of shots) {
    if (only && !only.test(shot.name)) continue;
    if (!browser.isConnected()) browser = await caseChromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
    const reading = await shoot(browser, server.base, shot);
    const problems = problemsOf(shot.name, reading, reading.pageErrors);
    if (problems.length) dirty += 1;
    results[shot.name] = { width: shot.width, lang: shot.lang, theme: shot.theme, ...reading, problems, file: path.basename(reading.file) };
    console.log(shot.name, JSON.stringify({ rows: reading.rowsAboveFold, problems }));
  }
} finally {
  await browser.close();
  server.stop();
}
/* «All projects» must not make a row taller than the same task's row in
   «this project» at the same width, language and theme. */
type Stored = { problems: string[]; critic: { rowHeightById: Record<string, number> } | null };
for (const [name, value] of Object.entries(results) as [string, Stored][]) {
  const pair = name.endsWith("-all") ? results[name.replace(/-all$/, "-tasks")] as Stored | undefined : undefined;
  if (!value.critic || !pair?.critic) continue;
  const taller = Object.entries(value.critic.rowHeightById).filter(([id, height]) => id in pair.critic!.rowHeightById && height !== pair.critic!.rowHeightById[id]).map(([id, height]) => `${id} ${pair.critic!.rowHeightById[id]}→${height}`);
  value.problems = value.problems.filter((problem) => !problem.startsWith("row height differs from «this project»"));
  if (taller.length) {
    if (!value.problems.length) dirty += 1;
    value.problems.push(`row height differs from «this project»: ${taller.join(", ")}`);
    console.log(name, "row heights", taller.join(", "));
  }
}
fs.writeFileSync(path.join(OUT, "geometry.json"), `${JSON.stringify(results, null, 2)}\n`);
console.log("frames", Object.keys(results).length, "with problems", dirty, "->", FRAMES);
