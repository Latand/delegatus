/*
 * What the two browser drivers (the kanban board's and the phone's) read off a
 * task lane's stage chain, and what a narrow lane has to satisfy
 * (docs/design/narrow-card-stage-chain.md), and what a wide lane has to
 * satisfy: each fail branch hangs under the stage it fails from. Not a test:
 * the drivers import it, so the desktop card and the phone's task screen are
 * held to one set of rules.
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
  /** True when a word of the name (split at spaces and hyphens) is drawn across two lines. */
  wordBroken: boolean;
  /** The pill's visible text, its `st-*` state class and its border colour. */
  label: string;
  state: string | null;
  borderColor: string;
};

type Box = { left: number; top: number; right: number; bottom: number };

export type StageChainLane = {
  width: number;
  direction: string;
  steps: StageChainStep[];
  overlaps: string[];
  /** The rects of what shares the row with the pills: the work links and the age. */
  beside?: Box[];
  /** The pass row's room, and the room the pass stages need on one line with no branch at all. */
  pass?: { room: number; need: number };
};

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
    /* A word cut across lines: its range has rects on two tops. */
    let wordBroken = false;
    const nameWalker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
    for (let node = nameWalker.nextNode(); node; node = nameWalker.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.trim() || node.parentElement.closest(".pb-branch-word, .pb-attempt")) continue;
      for (const m of node.nodeValue.matchAll(/[^\\s-]+/g)) {
        const range = document.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
        if (tops.size > 1) wordBroken = true;
      }
    }
    return {
      stage: pill.getAttribute("data-stage"), kind: step.getAttribute("data-step"), through: step.hasAttribute("data-through"),
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      arrow: arrow ? getComputedStyle(arrow).display : null,
      before: pseudo(step, "::before"), after: pseudo(step, "::after"),
      cut: name.scrollWidth > name.clientWidth + 1, inkOutside, nameLines: Math.round(name.getBoundingClientRect().height / lineHeight), wordBroken,
      label: name.innerText.trim(), state: ([...pill.classList].find((c) => c.startsWith("st-")) || null), borderColor: getComputedStyle(pill).borderTopColor,
    };
  });
  const overlaps = [];
  for (let i = 0; i < steps.length; i++) for (let j = i + 1; j < steps.length; j++) {
    const a = steps[i], b = steps[j];
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w > 0.5 && h > 0.5) overlaps.push(a.stage + "/" + b.stage);
  }
  const beside = [...block.querySelectorAll(".pb-chain > .pb-links, .pb-chain > .pb-tail")].map((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  /* The pass stages on one line, branches left out: each pill, the arrow before it with its 4 px margin, and the row's 4 px gaps. */
  const row = block.querySelector(".pb-chain > .pb-pills");
  const main = [...row.querySelectorAll(".pb-step:not([data-step=branch])")];
  const need = main.reduce((sum, step) => {
    const arrow = step.querySelector(":scope > .pb-arrow");
    return sum + step.querySelector(".pb-pill").getBoundingClientRect().width + (arrow ? arrow.getBoundingClientRect().width + parseFloat(getComputedStyle(arrow).marginInlineEnd || "0") : 0);
  }, 0) + 4 * Math.max(0, main.length - 1);
  const pass = { room: row.clientWidth, need };
  return { width: block.getBoundingClientRect().width, direction: getComputedStyle(row).flexDirection, steps, overlaps, beside, pass };
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

/** What a wide lane owes (§2): a row, the pass stages on one line while they
    fit with an arrow before each later one, and every fail branch 28 px right of
    the stage it fails from, 8 px under it, on a dashed elbow that lands on the
    pill's middle. `gates` names each branch's expected stage; the word "branch"
    is left to the elbow. Returns the broken rules, worded for the failure. */
export function wideStageChainFailures(label: string, lane: StageChainLane, gates: Record<string, string>): string[] {
  const failures: string[] = [];
  const fail = (text: string) => failures.push(`${label}: ${text}`);
  if (lane.width < 380) fail(`the lane is ${lane.width} px wide, expected a wide one`);
  if (lane.direction !== "row") fail(`the chain is ${lane.direction}, expected row`);
  if (lane.overlaps.length) fail(`pills overlap — ${lane.overlaps.join(", ")}`);
  for (const step of lane.steps) {
    if (step.cut) fail(`${step.stage}: the name is clipped`);
    if (step.inkOutside) fail(`${step.stage}: text paints outside its pill`);
    if (step.wordBroken) fail(`${step.stage}: a word of "${step.label}" breaks across lines (the pill is ${Math.round(step.right - step.left)} px wide)`);
    if (/^(branch|гілка):/.test(step.label)) fail(`${step.stage}: still says "${step.label}"`);
    for (const box of lane.beside ?? []) {
      if (Math.min(step.right, box.right) - Math.max(step.left, box.left) > 0.5 && Math.min(step.bottom, box.bottom) - Math.max(step.top, box.top) > 0.5) fail(`${step.stage}: a pill runs into the links or the age`);
    }
  }
  const main = lane.steps.filter((step) => step.kind !== "branch");
  const branches = lane.steps.filter((step) => step.kind === "branch");
  /* A branch's width never moves a pass stage to a new line: when the pass stages fit one line without any branch, they share one top. */
  if (lane.pass && lane.pass.need <= lane.pass.room && main.some((step) => Math.abs(step.top - main[0]!.top) > 1)) {
    fail(`the pass stages need ${lane.pass.need} px of ${lane.pass.room} px and still stand on ${new Set(main.map((step) => Math.round(step.top))).size} lines`);
  }
  main.forEach((step, index) => {
    if (drawn(step.before.content) || drawn(step.after.content)) fail(`${step.stage}: a main stage draws a connector`);
    if (index > 0 && step.arrow === "none") fail(`${step.stage}: no arrow before it`);
    /* A branch adds nothing to its unit but the few pixels its longest word needs: the next main stage on the same
       line follows its gate by the arrow and its gaps, and by that much when the gate's fix is wider than the gate. */
    const next = main[index + 1];
    if (next && Math.abs(next.top - step.top) <= 1) {
      const gap = next.left - step.right;
      const widest = lane.steps.filter((entry) => entry.kind === "branch" && gates[entry.stage] === step.stage).reduce((most, entry) => Math.max(most, entry.right - entry.left), 0);
      const room = 4 + 12 + 4 + 4 + (widest ? Math.max(0, widest + 1 - (step.right - step.left)) : 0);
      if (gap < 0) fail(`${next.stage}: starts ${-gap} px before ${step.stage} ends`);
      if (gap > room + 1) fail(`${next.stage}: ${gap} px after ${step.stage}, expected the arrow and its gaps only`);
    }
  });
  for (const step of branches) {
    const gate = gates[step.stage];
    const anchor = main.find((entry) => Math.abs(entry.left - (step.left - 28)) <= 1 && entry.bottom <= step.top + 1);
    if (!anchor) { fail(`${step.stage}: no stage 28 px left of it and above it`); continue; }
    if (gate && anchor.stage !== gate) fail(`${step.stage}: hangs under ${anchor.stage}, expected ${gate}`);
    if (Math.abs(step.top - anchor.bottom - 8) > 1) fail(`${step.stage}: ${step.top - anchor.bottom} px under ${anchor.stage}, expected 8`);
    if (step.after.borderLeft !== "dashed" || step.after.borderBottom !== "dashed") fail(`${step.stage}: the elbow is ${step.after.borderLeft}/${step.after.borderBottom}`);
    if (Math.abs(step.after.left - 15) > 0.5 || Math.abs(step.after.width - 13) > 0.5) fail(`${step.stage}: elbow left ${step.after.left}, width ${step.after.width}`);
    const armAt = step.top - 8 + step.after.height;
    const middle = (step.top + step.bottom) / 2;
    if (Math.abs(armAt - middle) > 1.5) fail(`${step.stage}: the elbow arm lands at ${armAt}, the pill's middle is ${middle}`);
    /* The elbow's box, rail to arm, crosses no other pill: it stands 13 px left of its own pill. */
    const elbow: Box = { left: step.left - 28 + 15, right: step.left, top: step.top - 8, bottom: step.top - 8 + step.after.height };
    for (const other of lane.steps) {
      if (other === step) continue;
      if (Math.min(elbow.right, other.right) - Math.max(elbow.left, other.left) > 0.5 && Math.min(elbow.bottom, other.bottom) - Math.max(elbow.top, other.top) > 0.5) fail(`${step.stage}: its elbow crosses ${other.stage}`);
    }
  }
  /* The last fix has no later fix to keep clear of: it takes the room to the lane's edge before it wraps. */
  const last = branches.at(-1);
  if (last && last.nameLines > 2) fail(`${last.stage}: the last fix takes ${last.nameLines} lines, expected 2 at most`);
  return failures;
}
