import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

const dom = new Window({ url: "http://localhost/", width: 800, height: 600 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  localStorage: dom.localStorage,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
});
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
});

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { EngineMark, EngineBadge } = await import("./EngineMark");
const { SwitchCard } = await import("./SwitchCard");
const { ChatEngineMark } = await import("./mobile/chatEngineMark");
const { StageGlyph } = await import("./kanban/StageGlyph");
const { effortTint, engineBadgeFor } = await import("./utils");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(node));
  return host;
}

function makeAntigravityFile(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/tmp/antigravity/sessions/sess-neon/events.jsonl",
    root: "antigravity-sessions",
    name: "events.jsonl",
    project: "demo",
    title: "Neon session",
    engine: "antigravity",
    kind: "session",
    fmt: "antigravity",
    parent: null,
    mtime: Date.now() / 1000 - 10,
    size: 512,
    activity: "live",
    proc: "running",
    pid: 12345,
    model: "gemini-4-neon",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as unknown as FileEntry;
}

test("EngineMark draws the same Ne periodic-table tile as StageGlyph and stays distinct from Claude, Codex, and Shell", () => {
  const host = mount(
    <>
      <EngineMark engine="antigravity" size={12} label="Antigravity" />
      <EngineMark engine="claude" size={12} />
      <EngineMark engine="codex" size={12} />
      <EngineMark engine="shell" size={12} />
      <StageGlyph state="running" model={{ engine: "antigravity", model: "gemini-4-neon" }} motion="ordinary" fallback="mark" />
    </>,
  );

  const agyMark = host.querySelector<HTMLElement>('[data-engine-mark="antigravity"]')!;
  expect(agyMark).not.toBeNull();
  expect(agyMark.classList.contains("emark-neon")).toBe(true);
  expect(agyMark.style.color).toBe("var(--color-antigravity-mark)");
  expect(agyMark.getAttribute("role")).toBe("img");
  expect(agyMark.getAttribute("aria-label")).toBe("Antigravity");

  const agySvg = agyMark.querySelector("svg")!;
  const neonGlyphSvg = host.querySelector(".mglyph.g-neon svg")!;
  const claudeSvg = host.querySelector('[data-engine-mark="claude"] svg')!;
  const codexSvg = host.querySelector('[data-engine-mark="codex"] svg')!;
  const shellSvg = host.querySelector('[data-engine-mark="shell"] svg')!;

  /* EngineMark and StageGlyph share the exact periodic-table Ne tile geometry. */
  expect(agySvg.innerHTML).toBe(neonGlyphSvg.innerHTML);
  expect(agySvg.querySelector("rect.mg-tile")).not.toBeNull();
  expect(agySvg.querySelector("rect.mg-neon-gas")).not.toBeNull();
  expect(agySvg.querySelectorAll(".mg-neon-num")).toHaveLength(2);
  expect(agySvg.querySelector("path.mg-neon-sym")).not.toBeNull();

  /* Distinct monochrome silhouettes vs Claude, Codex, and Shell. */
  expect(new Set([agySvg.innerHTML, claudeSvg.innerHTML, codexSvg.innerHTML, shellSvg.innerHTML]).size).toBe(4);
});

test("working glow activates strictly when working=true on EngineMark, EngineBadge, SwitchCard, and ChatEngineMark", () => {
  const host = mount(
    <>
      <span data-case="agy-idle"><EngineMark engine="antigravity" size={14} working={false} /></span>
      <span data-case="agy-work"><EngineMark engine="antigravity" size={14} working /></span>
      <span data-case="badge-work"><EngineBadge engine="antigravity" size={12} working /></span>
      <span data-case="claude-work"><EngineMark engine="claude" size={14} working /></span>
      <span data-case="codex-work"><EngineMark engine="codex" size={14} working /></span>
      <span data-case="chat-idle"><ChatEngineMark file={makeAntigravityFile()} working={false} /></span>
      <span data-case="chat-work"><ChatEngineMark file={makeAntigravityFile()} working /></span>
      <span data-case="card-work">
        <SwitchCard
          file={makeAntigravityFile()}
          title="Neon working"
          project="demo"
          currentProject="demo"
          descendants={0}
          statusLine="Working"
          size="large"
          tone="working"
          onOpen={() => {}}
          onArchive={() => {}}
        />
      </span>
      <span data-case="card-idle">
        <SwitchCard
          file={makeAntigravityFile({ activity: "idle", proc: null })}
          title="Neon idle"
          project="demo"
          currentProject="demo"
          descendants={0}
          statusLine="Done"
          size="large"
          tone="quiet"
          onOpen={() => {}}
          onArchive={() => {}}
        />
      </span>
    </>,
  );

  const liveOf = (name: string) => host.querySelector<HTMLElement>(`[data-case="${name}"] [data-engine-mark]`)?.dataset.live ?? null;
  expect(liveOf("agy-idle")).toBeNull();
  expect(liveOf("agy-work")).toBe("1");
  expect(liveOf("badge-work")).toBe("1");
  expect(liveOf("claude-work")).toBeNull();
  expect(liveOf("codex-work")).toBeNull();
  expect(liveOf("chat-idle")).toBeNull();
  expect(liveOf("chat-work")).toBe("1");
  expect(liveOf("card-work")).toBe("1");
  expect(liveOf("card-idle")).toBeNull();
});

test("shared CSS neon glow uses GLYPH_TURN_MS, respects prefers-reduced-motion, and pauses on composer focus and board holds", () => {
  const glyphCss = fs.readFileSync(path.join(import.meta.dir, "kanban/modelGlyph.css"), "utf8");
  const boardCss = fs.readFileSync(path.join(import.meta.dir, "kanban/kanbanBoard.css"), "utf8");
  const globalsCss = fs.readFileSync(path.join(import.meta.dir, "../app/globals.css"), "utf8");
  const tokensCss = fs.readFileSync(path.join(import.meta.dir, "../styles/tokens.css"), "utf8");

  /* Neon & Antigravity mark tokens exist in light and both dark blocks. */
  expect(tokensCss.match(/--glyph-neon:\s*#[0-9a-f]{6}/gi)?.length).toBe(3);
  expect(tokensCss.match(/--glyph-neon-glow:\s*#[0-9a-f]{6}/gi)?.length).toBe(3);
  expect(tokensCss.match(/--color-antigravity-mark:\s*#[0-9a-f]{6}/gi)?.length).toBe(3);

  /* Steady lit gas chamber and halo survive reduced motion for both StageGlyph and EngineMark. */
  expect(glyphCss).toContain(':is(.mglyph.g-neon, .emark-neon)[data-live="1"] .mg-neon-gas { opacity: 0.34; }');
  expect(glyphCss).toContain('.emark-neon[data-live="1"]::before { opacity: 1; }');
  /* Halo and gas keep one shared period (`--mg-turn`, GLYPH_TURN_MS) with no 3.2 s drift. */
  expect(glyphCss).toContain('--mg-period: var(--mg-turn);');
  expect(glyphCss).not.toMatch(/\.emark-neon\s*\{[^}]*--mg-period:\s*3\.2s/);

  /* Animations exist strictly inside prefers-reduced-motion: no-preference. */
  const motionBlockMatch = /@media \(prefers-reduced-motion: no-preference\)\s*\{([\s\S]*?)\n\}/.exec(glyphCss);
  expect(motionBlockMatch).not.toBeNull();
  const motionBlock = motionBlockMatch![1];
  expect(motionBlock).toContain('.mglyph.g-neon[data-live="1"]::before,');
  expect(motionBlock).toContain('.emark-neon[data-live="1"]::before { animation: mg-halo var(--mg-turn) ease-in-out infinite; }');
  expect(motionBlock).toContain('.emark-neon[data-live="1"] .mg-neon-gas { animation: mg-neon var(--mg-turn) ease-in-out infinite; }');

  const outsideMotion = glyphCss.replace(motionBlockMatch![0], "");
  expect(outsideMotion).not.toContain("animation: mg-neon");
  expect(glyphCss).not.toContain("drop-shadow");

  /* Keyframes animate opacity only (zero layout/reflow). */
  const keyframeMatch = /@keyframes mg-neon\s*\{((?:[^{}]|\{[^}]*\})*)\}/.exec(glyphCss);
  expect(keyframeMatch).not.toBeNull();
  expect(keyframeMatch![1]).not.toMatch(/\b(width|height|margin|padding|top|left|border-width|font-size|transform)\s*:/);

  /* Composer focus and board holds pause .emark-neon alongside .mglyph. */
  expect(globalsCss).toContain(':root[data-composer-focused] .emark-neon[data-live="1"]::before');
  expect(boardCss).toContain('.kb [data-layout-animating="content"] .emark-neon::before');
  expect(boardCss).toContain('[data-card-drag] .emark-neon[data-live="1"]::before');
  expect(boardCss.match(/\.mg-neon-gas/g)?.length).toBe(3);
});

test("Antigravity chips and EngineBadge use one neon cyan hue and paint the Ne tile with the engine mark token", () => {
  const lowFile = makeAntigravityFile({ effort: "low" });
  const lowTint = effortTint(lowFile);
  const badgeTint = engineBadgeFor("antigravity");

  /* Cyan neon hue (~194°), never the old purple #6f42c1 (hue 261°). */
  expect(lowTint.color).toContain("hsl(194 ");
  expect(badgeTint.style.color).toContain("hsl(194 ");
  expect(lowTint.soft).toContain("hsl(194 ");
  expect(badgeTint.style.backgroundColor).toContain("hsl(194 ");

  const host = mount(
    <>
      <span data-case="badge"><EngineBadge engine="antigravity" size={12} working /></span>
      <span data-case="card">
        <SwitchCard
          file={lowFile}
          title="Neon low effort"
          project="demo"
          currentProject="demo"
          descendants={0}
          statusLine="Working"
          size="large"
          tone="working"
          onOpen={() => {}}
          onArchive={() => {}}
        />
      </span>
    </>,
  );

  for (const key of ["badge", "card"]) {
    const mark = host.querySelector<HTMLElement>(`[data-case="${key}"] [data-engine-mark="antigravity"]`);
    expect(mark, `${key} renders Antigravity Ne tile`).not.toBeNull();
    expect(mark!.style.color, `${key} paints Ne tile in --color-antigravity-mark`).toBe("var(--color-antigravity-mark)");
    expect(mark!.dataset.live).toBe("1");
  }
});
