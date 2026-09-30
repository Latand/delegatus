/*
 * What the two browser drivers (the kanban board's and the phone's) read off a
 * task lane's stage chain, and what a narrow lane has to satisfy
 * (docs/design/narrow-card-stage-chain.md). Not a test: the drivers import it,
 * so the desktop card and the phone's task screen are held to one set of rules.
 */

type Pseudo = { content: string; height: number; left: number; width: number; borderLeft: string; borderBottom: string };

export type StageChainStep = {
  stage: string;
  kind: string | null;
  through: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  arrow: string | null;
  before: Pseudo;
  after: Pseudo;
  cut: boolean;
  inkOutside: boolean;
  nameLines: number;
};

export type StageChainLane = { width: number; direction: string; steps: StageChainStep[]; overlaps: string[] };

/** A script for `page.evaluate`: the lane row under `selector`, read from
    geometry and computed style, or null when it is not drawn. */
export const measureStageChain = (selector: string) => `(() => {
  const block = document.querySelector(${JSON.stringify(selector)});
  if (!block) return null;
  const pseudo = (el, which) => {
    const s = getComputedStyle(el, which);
    return { content: s.content, height: parseFloat(s.height) || 0, left: parseFloat(s.left) || 0, width: parseFloat(s.width) || 0, borderLeft: s.borderLeftStyle, borderBottom: s.borderBottomStyle };
  };
  const steps = [...block.querySelectorAll(".pb-chain .pb-step")].map((step) => {
    const pill = step.querySelector(".pb-pill");
    const rect = pill.getBoundingClientRect();
    const arrow = step.querySelector(":scope > .pb-arrow");
    /* The pill's ink: every text rect must sit inside the pill. */
    let inkOutside = false;
    const walker = document.createTreeWalker(pill, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (r.width * r.height <= 0.5) continue;
        if (r.left < rect.left - 1 || r.right > rect.right + 1 || r.top < rect.top - 1 || r.bottom > rect.bottom + 1) inkOutside = true;
      }
    }
    const name = pill.querySelector(".pb-name");
    const lineHeight = parseFloat(getComputedStyle(name).lineHeight) || 16;
    return {
      stage: pill.getAttribute("data-stage"), kind: step.getAttribute("data-step"), through: step.hasAttribute("data-through"),
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      arrow: arrow ? getComputedStyle(arrow).display : null,
      before: pseudo(step, "::before"), after: pseudo(step, "::after"),
      cut: name.scrollWidth > name.clientWidth + 1, inkOutside, nameLines: Math.round(name.getBoundingClientRect().height / lineHeight),
    };
  });
  const overlaps = [];
  for (let i = 0; i < steps.length; i++) for (let j = i + 1; j < steps.length; j++) {
    const a = steps[i], b = steps[j];
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 0.5 && h > 0.5) overlaps.push(a.stage + "/" + b.stage);
  }
  return { width: block.getBoundingClientRect().width, direction: getComputedStyle(block.querySelector(".pb-pills")).flexDirection, steps, overlaps };
})()`;

const drawn = (content: string) => content !== "none" && content !== "normal";

/** What a narrow lane owes (§3): a column, no arrow, the rail 8 px long and 15
    px in, the branch 28 px right of the main column, directly under its
    reviewer on a dashed elbow that lands on the pill's middle, nothing cut and
    no pills on each other. Returns the broken rules, worded for the failure. */
export function stageChainFailures(label: string, lane: StageChainLane): string[] {
  const failures: string[] = [];
  const fail = (text: string) => failures.push(`${label}: ${text}`);
  if (lane.width >= 380) fail(`the lane is ${lane.width} px wide, expected a narrow one`);
  if (lane.direction !== "column") fail(`the chain is ${lane.direction}, expected column`);
  if (lane.overlaps.length) fail(`pills overlap — ${lane.overlaps.join(", ")}`);
  for (const step of lane.steps) {
    if (step.arrow !== null && step.arrow !== "none") fail(`${step.stage}: the arrow still shows (${step.arrow})`);
    if (step.cut) fail(`${step.stage}: the name is clipped`);
    if (step.inkOutside) fail(`${step.stage}: text paints outside its pill`);
  }
  const main = lane.steps.filter((step) => step.kind !== "branch");
  for (const step of main) if (Math.abs(step.left - main[0]!.left) > 1) fail(`${step.stage}: left ${step.left} differs from ${main[0]!.left}`);
  for (let i = 1; i < main.length; i++) if (main[i]!.top < main[i - 1]!.bottom + 4) fail(`${main[i]!.stage}: not under ${main[i - 1]!.stage}`);
  /* The rail: none before the first step, 8 px long and 15 px in for each later one. */
  if (drawn(main[0]!.before.content)) fail(`the first step draws a connector (${main[0]!.before.content})`);
  for (const step of main.slice(1)) {
    if (Math.abs(step.before.height - 8) > 0.5 || Math.abs(step.before.left - 15) > 0.5 || Math.abs(step.before.width - 1) > 0.5) fail(`${step.stage}: connector ${JSON.stringify(step.before)}`);
  }
  for (const step of lane.steps.filter((entry) => entry.kind === "branch")) {
    const anchor = main.filter((entry) => entry.bottom <= step.top + 1).at(-1);
    if (!anchor) { fail(`${step.stage}: no main stage above the branch`); continue; }
    if (Math.abs(step.left - main[0]!.left - 28) > 1) fail(`${step.stage}: branch offset ${step.left - main[0]!.left}, expected 28`);
    if (step.top < anchor.bottom + 4) fail(`${step.stage}: branch not under ${anchor.stage}`);
    if (step.after.borderLeft !== "dashed" || step.after.borderBottom !== "dashed") fail(`${step.stage}: the elbow is ${step.after.borderLeft}/${step.after.borderBottom}`);
    if (Math.abs(step.after.left - 15) > 0.5 || Math.abs(step.after.width - 13) > 0.5) fail(`${step.stage}: elbow left ${step.after.left}, width ${step.after.width}`);
    /* The arm leaves 8 px above the branch row and lands on the pill's middle. */
    const armAt = step.top - 8 + step.after.height;
    const middle = (step.top + step.bottom) / 2;
    if (Math.abs(armAt - middle) > 1.5) fail(`${step.stage}: the elbow arm lands at ${armAt}, the pill's middle is ${middle}`);
    /* The rail passes beside the branch exactly when a main stage follows it. */
    const followed = main.some((entry) => entry.top > step.bottom);
    if (step.through !== followed) fail(`${step.stage}: through=${step.through}, a stage follows=${followed}`);
    if (step.through && step.before.height < step.bottom - step.top + 8 - 0.5) fail(`${step.stage}: the rail stops at the branch (${step.before.height} px)`);
  }
  return failures;
}
