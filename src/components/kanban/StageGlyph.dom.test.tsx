import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Root } from "react-dom/client";

/* The model glyph in front of a stage (docs/design/model-glyphs.md): what it
   draws for each model and state, what it leaves to the host's own mark, and
   the name it carries in both languages. */

const dom = new Window({ url: "http://localhost/", width: 800, height: 600 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, localStorage: dom.localStorage };
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
});

const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { StageGlyph } = await import("./StageGlyph");
const { StageIdentity } = await import("./identityMarks");
const { setLocale } = await import("@/lib/i18n");

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) flushSync(() => root.unmount());
  document.body.replaceChildren();
  setLocale("en");
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  flushSync(() => root.render(node));
  return host;
}

test("a running stage draws its model moving; a settled one carries its state as a badge", () => {
  const host = mount(
    <>
      <StageGlyph state="running" model={{ engine: "claude", model: "fable" }} fallback="mark" />
      <StageGlyph state="passed" model={{ engine: "codex", model: "gpt-6-sol" }} fallback="mark" />
      <StageGlyph state="failed" model={{ engine: "codex", model: "gpt-5.6-terra" }} fallback="mark" />
      <StageGlyph state="needs_decision" model={{ engine: "claude", model: "haiku" }} fallback="mark" />
      <StageGlyph state="pending" model={{ engine: "codex", model: "gpt-6-luna" }} fallback="dot" />
    </>,
  );
  const glyphs = [...host.querySelectorAll<HTMLElement>(".mglyph")];
  expect(glyphs.map((glyph) => [glyph.dataset.glyph, glyph.dataset.glyphState, glyph.dataset.live ?? null, Boolean(glyph.querySelector(".mg-badge"))])).toEqual([
    ["fable", "running", "1", false],
    ["sol", "passed", null, true],
    ["terra", "failed", null, true],
    ["haiku", "needs", null, true],
    ["luna", "waiting", null, false],
  ]);
  /* The badge takes the stage's tone from the one tone map. */
  expect(glyphs.map((glyph) => glyph.className.match(/tone-\w+/)?.[0])).toEqual(["tone-active", "tone-ok", "tone-bad", "tone-needs", "tone-idle"]);
  expect(host.querySelector(".pmark, .pdot")).toBeNull();
});

test("a host that prints the state word draws the glyph without a badge, so it keeps all of its ink", () => {
  const host = mount(
    <>
      <StageGlyph state="failed" model={{ engine: "codex", model: "gpt-6-astra" }} fallback="dot" badge={false} />
      <StageGlyph state="passed" model={{ engine: "claude", model: "sonnet" }} fallback="mark" badge={false} />
    </>,
  );
  expect([...host.querySelectorAll<HTMLElement>(".mglyph")].map((glyph) => [glyph.dataset.glyphState, Boolean(glyph.querySelector(".mg-badge"))])).toEqual([["failed", false], ["passed", false]]);
});

test("a stage pane's header draws the glyph named, or its tone dot for a model with none", () => {
  const host = mount(
    <>
      <span data-case="glyph"><StageGlyph state="running" model={{ engine: "claude", model: "haiku" }} fallback="tone" named title="Running" /></span>
      <span data-case="dot"><StageGlyph state="running" model={{ engine: "codex", model: "gpt-5.5" }} fallback="tone" named title="Running" /></span>
      <span data-case="settled-dot"><StageGlyph state="passed" model={{ engine: "codex", model: "gpt-5.5" }} fallback="tone" title="Passed" /></span>
    </>,
  );
  const glyph = host.querySelector<HTMLElement>('[data-case="glyph"] .mglyph')!;
  expect([glyph.dataset.glyph, glyph.getAttribute("role"), glyph.getAttribute("aria-label"), glyph.title]).toEqual(["haiku", "img", "Haiku: running", "Running"]);
  const dot = host.querySelector<HTMLElement>('[data-case="dot"] span')!;
  expect(dot.className).toContain("animate-pulse");
  expect([dot.style.backgroundColor, dot.title]).toEqual(["var(--color-accent)", "Running"]);
  const settled = host.querySelector<HTMLElement>('[data-case="settled-dot"] span')!;
  expect(settled.className).not.toContain("animate-pulse");
  expect(settled.style.backgroundColor).toBe("var(--color-success)");
});

test("each Claude model draws an object of its own", () => {
  const host = mount(
    <>
      {["opus", "sonnet", "haiku", "fable"].map((model) => <StageGlyph key={model} state="running" model={{ engine: "claude", model }} fallback="mark" />)}
    </>,
  );
  const drawings = [...host.querySelectorAll<HTMLElement>(".mglyph")].map((glyph) => glyph.querySelector("svg")!.innerHTML);
  expect(new Set(drawings).size).toBe(4);
  /* Each moves in its own way: the spark turns and breathes, the quill writes,
     the blossom sways, the fox tilts its head. */
  expect([...host.querySelectorAll<HTMLElement>(".mglyph")].map((glyph) => [...glyph.querySelectorAll("[class*=mg-]")].map((node) => node.getAttribute("class")).filter((name) => /mg-(turn|breathe|write|sway|tilt)/.test(name ?? "")))).toEqual([
    ["mg-turn", "mg-breathe"], ["mg-fill mg-write"], ["mg-fill mg-sway"], ["mg-fill mg-tilt"],
  ]);
});

test("Astra is a sun: a filled disc, a white-hot core and a corona of twelve rays", () => {
  const host = mount(<StageGlyph state="running" model={{ engine: "codex", model: "gpt-6-astra" }} fallback="mark" />);
  const corona = host.querySelector(".mg-corona")!.getAttribute("d")!;
  /* A star of twelve points is twenty-four vertices. */
  expect(corona.split("L")).toHaveLength(24);
  expect(host.querySelectorAll("circle.mg-fill")).toHaveLength(1);
  const core = host.querySelector("circle.mg-core")!;
  expect(core.getAttribute("fill")).toBe(`url(#${host.querySelector("radialGradient")!.id})`);
});

test("a settled stage whose conversation works again moves while keeping its badge", () => {
  const host = mount(<StageGlyph state="passed" model={{ engine: "claude", model: "opus" }} live fallback="mark" />);
  const glyph = host.querySelector<HTMLElement>(".mglyph")!;
  expect(glyph.dataset.live).toBe("1");
  expect(glyph.dataset.glyphState).toBe("passed");
});

test("a model with no glyph keeps exactly the mark or dot its host drew", () => {
  const host = mount(
    <>
      <StageGlyph state="running" model={{ engine: "codex", model: "gpt-5.5" }} fallback="mark" />
      <StageGlyph state="failed" model={{ engine: "copilot", model: "auto" }} fallback="mark" />
      <StageGlyph state="running" model={null} fallback="dot" />
    </>,
  );
  expect(host.querySelector(".mglyph")).toBeNull();
  expect([...host.querySelectorAll(".pmark")].map((mark) => [mark.getAttribute("data-mark"), mark.getAttribute("data-live")])).toEqual([["dot", "1"], ["cross", null]]);
  expect(host.querySelectorAll("i.pdot[aria-hidden=true]")).toHaveLength(1);
});

test("the glyph is decoration beside a host label, and says model and state where it is named, in en and uk", () => {
  const quiet = mount(<StageGlyph state="running" model={{ engine: "codex", model: "gpt-6-astra" }} fallback="dot" />);
  expect(quiet.querySelector(".mglyph")!.getAttribute("aria-hidden")).toBe("true");
  expect(quiet.querySelector("[role=img]")).toBeNull();

  const named = <StageGlyph state="running" model={{ engine: "codex", model: "gpt-6-astra" }} fallback="dot" named />;
  expect(mount(named).querySelector("[role=img]")!.getAttribute("aria-label")).toBe("GPT-6-Astra: running");
  setLocale("uk");
  expect(mount(named).querySelector("[role=img]")!.getAttribute("aria-label")).toBe("GPT-6-Astra: працює");
});

test("each Luna, Terra and Astra draws with an id of its own, so two on one page do not share a mask", () => {
  const host = mount(
    <>
      <StageGlyph state="running" model={{ engine: "codex", model: "gpt-6-luna" }} fallback="dot" />
      <StageGlyph state="pending" model={{ engine: "codex", model: "gpt-5.6-luna" }} fallback="dot" />
      <StageGlyph state="running" model={{ engine: "codex", model: "gpt-5.6-terra" }} fallback="dot" />
      <StageGlyph state="running" model={{ engine: "codex", model: "gpt-6-astra" }} fallback="dot" />
    </>,
  );
  const ids = [...host.querySelectorAll("mask, clipPath, radialGradient")].map((element) => element.id);
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
  expect(host.querySelectorAll("[mask]")[1]!.getAttribute("mask")).toBe(`url(#${ids[1]})`);
});

test("beside a drawn glyph the identity draws no second engine mark; a model without a glyph keeps it", () => {
  const identity = (engine: string, model: string) => ({ engine, model, modelLabel: model, effort: "high", source: "launched" as const, modelIsDefault: false, next: null });
  const host = mount(
    <>
      <span data-case="glyph"><StageIdentity identity={identity("claude", "opus")} density="node" glyph /></span>
      <span data-case="no-glyph"><StageIdentity identity={identity("codex", "gpt-5.5")} density="node" glyph /></span>
      <span data-case="alone"><StageIdentity identity={identity("claude", "opus")} density="node" /></span>
    </>,
  );
  const mark = (name: string) => host.querySelector(`[data-case="${name}"] [data-engine-mark]`)?.getAttribute("data-engine-mark") ?? null;
  expect([mark("glyph"), mark("no-glyph"), mark("alone")]).toEqual([null, "codex", "claude"]);
  /* The model's name and the effort stay as words and ladder. */
  expect(host.querySelector('[data-case="glyph"] .imodel')?.textContent).toBe("opus");
  expect(host.querySelector('[data-case="glyph"] [data-effort-pills]')).not.toBeNull();
});
