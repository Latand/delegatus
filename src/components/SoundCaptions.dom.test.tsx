import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";

/*
 * The stack of sound captions (docs/design/sound-captions.md §4–§5): what each
 * toast says in each language, which ones are buttons, what a click hands back,
 * what the stack does when it is held, bounded, hidden or on a phone. Layout
 * and look are rendered by the kanban browser driver.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  Event: dom.Event,
  localStorage: dom.localStorage,
  MutationObserver: dom.MutationObserver,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});

const { SoundCaptions, captionText } = await import("./SoundCaptions");
const { configureSoundCaptionsForTests, pushSoundCaption, resetSoundCaptionsForTests, soundCaptionsSnapshot } = await import("@/lib/audio/captions");
const { createFakeTimers } = await import("@/lib/audio/fakeTimers.fixture");
const { setLocale, translate } = await import("@/lib/i18n");
type CaptionTarget = import("@/lib/audio/captions").CaptionTarget;
type CueCaption = import("@/lib/audio/captions").CueCaption;
type Props = import("./SoundCaptions").SoundCaptionsProps;

let root: Root | null = null;
let timers = createFakeTimers(0);
beforeEach(() => {
  timers = createFakeTimers(0);
  configureSoundCaptionsForTests({ timers });
  setLocale("en");
});
afterEach(async () => {
  if (root) await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
  resetSoundCaptionsForTests();
  setLocale("en");
});

const noop = () => undefined;
async function mount(extra: Partial<Props> = {}): Promise<{ column: () => HTMLElement | null; toasts: () => HTMLElement[] }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host);
    root.render(<SoundCaptions mobile={false} right={16} hidden={false} suppressPath={null} titleOf={() => null} onOpen={noop} {...extra} />);
  });
  return {
    column: () => document.querySelector<HTMLElement>("[data-sound-captions]"),
    toasts: () => [...document.querySelectorAll<HTMLElement>("[data-sound-caption]")].filter((element) => !element.hasAttribute("data-leaving")),
  };
}
const push = (captions: CueCaption[], sound: Parameters<typeof pushSoundCaption>[0]["sound"] = "reply", batch = 1) =>
  act(async () => { pushSoundCaption({ sound, batch, captions }); });
const advance = (ms: number) => act(async () => { timers.advance(ms); });
const lane: CaptionTarget = { kind: "lane", pipelineId: "p1", project: "proj" };
/* React derives enter and leave from the bubbling over and out pair. */
const pointerIn = (element: Element) => element.dispatchEvent(new dom.MouseEvent("pointerover", { bubbles: true }) as unknown as Event);
const pointerOut = (element: Element) => element.dispatchEvent(new dom.MouseEvent("pointerout", { bubbles: true }) as unknown as Event);
const text = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();

describe("what a toast says", () => {
  const visualCritic = { id: "visual-critic", kind: "run", role: { roleId: "visual-critic" } } as const;
  const cases: Array<[string, Parameters<typeof pushSoundCaption>[0]["sound"], CueCaption, string, string]> = [
    ["step", "step", { what: "step", subject: "Sound captions", stage: visualCritic as never, target: lane }, "Visual critic passed", "Критик вигляду — пройдено"],
    ["merged", "landed", { what: "merged", subject: "Ship it", pr: 3218, target: lane }, "Merged · PR #3218", "Злито · PR #3218"],
    ["lane-done", "landed", { what: "lane-done", subject: "Ship it", target: lane }, "Lane finished", "Лінію завершено"],
    ["merge-blocked", "fault", { what: "merge-blocked", subject: "Ship it", target: lane }, "Merge blocked", "Злиття заблоковано"],
    ["decision", "your-move", { what: "decision", subject: "T", target: null }, "The orchestrator asks you", "Оркестратор питає вас"],
    ["question", "your-move", { what: "question", subject: "T", target: null }, "An agent asks you", "Агент питає вас"],
    ["plan", "your-move", { what: "plan", subject: "T", target: null }, "An agent waits for plan approval", "Агент чекає на схвалення плану"],
    ["permission", "your-move", { what: "permission", subject: "T", target: null }, "An agent asks for permission", "Агент просить дозволу"],
    ["lane-decision", "your-move", { what: "lane-decision", subject: "T", target: null }, "A lane waits for your decision", "Лінія чекає вашого рішення"],
    ["prototype", "your-move", { what: "prototype", subject: "T", target: null }, "A prototype waits for your choice", "Прототип чекає вашого вибору"],
    ["update", "your-move", { what: "update", subject: null, target: null }, "An update waits for your decision", "Оновлення чекає вашого рішення"],
    ["attention", "your-move", { what: "attention", subject: "Look at the diff", target: null }, "An agent asks you to look", "Агент кличе вас подивитися"],
    ["delivery", "fault", { what: "delivery", subject: "T", target: null }, "A message was not delivered", "Повідомлення не доставлено"],
    ["launch", "fault", { what: "launch", subject: "T", target: null }, "An agent failed to start", "Агент не запустився"],
    ["memory", "fault", { what: "memory", subject: "T", target: null }, "An agent was stopped: out of memory", "Агента зупинено: забракло пам'яті"],
    ["released", "released", { what: "released", subject: "Release 1.2", target: null }, "Delegatus was updated", "Delegatus оновлено"],
    ["deploy-failed", "fault", { what: "deploy-failed", subject: null, target: null }, "A Delegatus deploy failed", "Деплой Delegatus не вдався"],
    ["deploy-rolled-back", "fault", { what: "deploy-rolled-back", subject: null, target: null }, "A Delegatus deploy was rolled back", "Деплой Delegatus відкочено"],
    ["limit", "fault", { what: "limit", subject: "Account A · 5h", target: null }, "A limit ran out", "Вичерпано ліміт"],
    ["reply", "reply", { what: "reply", subject: "T", target: { kind: "conversation", conversationId: "c1" } }, "An agent replied", "Агент відповів"],
    ["launched", "launched", { what: "launched", subject: "T", target: null }, "Agent launched", "Агента запущено"],
  ];

  for (const [name, sound, caption, en, uk] of cases) {
    test(`${name}: one line in each language, and the sound's own marker`, async () => {
      const view = await mount();
      await push([caption], sound);
      expect(view.toasts()).toHaveLength(1);
      expect(view.toasts()[0]!.getAttribute("data-sound-caption")).toBe(sound);
      expect(text(view.toasts()[0]!)).toContain(en);
      expect(captionText((key, params) => translate("uk", key, params), soundCaptionsSnapshot()[0]!, () => null).headline).toBe(uk);
      await act(async () => { setLocale("uk"); });
      expect(text(view.toasts()[0]!)).toContain(uk);
    });
  }

  test("a visual critic passing names the stage over the task title", async () => {
    const view = await mount();
    await push([{ ...cases[0]![2], subject: "Sound captions each sound" }], "step");
    const toast = view.toasts()[0]!;
    expect(toast.querySelector(".sc-line")!.textContent).toBe("Visual critic passed");
    expect(toast.querySelector(".sc-who")!.textContent).toBe("Visual critic");
    expect(toast.querySelector(".sc-subject")!.textContent).toBe("Sound captions each sound");
    await act(async () => { setLocale("uk"); });
    expect(toast.querySelector(".sc-line")!.textContent).toBe("Критик вигляду — пройдено");
  });

  test("a subject is on one line with the whole text in its title; no subject, no second line", async () => {
    const view = await mount();
    await push([{ what: "update", subject: null, target: null }], "your-move");
    expect(view.toasts()[0]!.querySelector(".sc-subject")).toBeNull();
    await push([{ what: "question", subject: "A long task title that will be cut by the ellipsis", target: null }], "your-move");
    const subject = view.toasts()[1]!.querySelector<HTMLElement>(".sc-subject")!;
    expect(subject.title).toBe("A long task title that will be cut by the ellipsis");
  });

  test("a request with no caption says its sound's most generic line", async () => {
    const view = await mount();
    for (const [sound, line] of [["step", "A stage passed"], ["landed", "Lane finished"], ["your-move", "An agent asks you"], ["fault", "Something broke"], ["reply", "An agent replied"], ["launched", "Agent launched"], ["released", "Delegatus was updated"]] as const) {
      await push([], sound);
      expect(text(view.toasts()[view.toasts().length - 1]!)).toBe(line);
    }
  });

  test("a reply that names only its conversation takes the conversation's title", async () => {
    const view = await mount({ titleOf: (id) => (id === "c1" ? "Fix the board" : null) });
    await push([{ what: "reply", subject: null, target: { kind: "conversation", conversationId: "c1" } }], "reply");
    expect(view.toasts()[0]!.querySelector(".sc-subject")!.textContent).toBe("Fix the board");
  });

  test("one play for several events says how many in each language, with the plural form", () => {
    const item = (sound: "step" | "landed" | "your-move" | "fault", n: number) => ({ id: 1, sound, n, captions: [{ what: "reply", subject: "First", target: null } as CueCaption] });
    const en = (sound: "step" | "landed" | "your-move" | "fault", n: number) => captionText((key, params) => translate("en", key, params), item(sound, n), () => null);
    const uk = (sound: "step" | "landed" | "your-move" | "fault", n: number) => captionText((key, params) => translate("uk", key, params), item(sound, n), () => null);
    expect(en("step", 3).headline).toBe("3 stages passed");
    expect(en("landed", 1 + 1).headline).toBe("2 lanes landed");
    expect(en("your-move", 4).headline).toBe("Needs you: 4");
    expect(en("fault", 2).headline).toBe("2 faults");
    expect(uk("step", 2).headline).toBe("Пройдено 2 етапи");
    expect(uk("step", 5).headline).toBe("Пройдено 5 етапів");
    expect(uk("landed", 3).headline).toBe("Завершено 3 лінії");
    expect(uk("your-move", 4).headline).toBe("Потрібні ви: 4");
    expect(uk("fault", 5).headline).toBe("5 збоїв");
    expect(en("step", 3).subject).toBe("First · and 2 more");
    expect(uk("step", 3).subject).toBe("First · і ще 2");
  });
});

describe("what a click does", () => {
  test("a toast with a target is a button, and a click hands the target back and removes the toast", async () => {
    const opened: CaptionTarget[] = [];
    const view = await mount({ onOpen: (target) => opened.push(target) });
    await push([{ what: "step", subject: "Task", stage: { id: "build", kind: "run" } as never, target: lane }], "step");
    const [toast] = view.toasts();
    expect(toast!.tagName).toBe("BUTTON");
    expect(toast!.getAttribute("type")).toBe("button");
    await act(async () => { toast!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    expect(opened).toEqual([lane]);
    expect(soundCaptionsSnapshot()).toEqual([]);
  });

  test("a toast without a target is plain text, not a control", async () => {
    const view = await mount();
    await push([{ what: "released", subject: "Release", target: null }], "released");
    expect(view.toasts()[0]!.tagName).toBe("DIV");
    expect(view.column()!.querySelectorAll("button")).toHaveLength(0);
  });

  test("a batch leads where its first caption leads", async () => {
    const opened: CaptionTarget[] = [];
    const view = await mount({ onOpen: (target) => opened.push(target) });
    const other: CaptionTarget = { kind: "lane", pipelineId: "p2", project: "proj" };
    await push([{ what: "lane-done", subject: "A", target: lane }, { what: "lane-done", subject: "B", target: other }], "landed", 2);
    await act(async () => { view.toasts()[0]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    expect(opened).toEqual([lane]);
  });

  test("a needs-you caption hands back the entry together with where it falls back to", async () => {
    const opened: CaptionTarget[] = [];
    const view = await mount({ onOpen: (target) => opened.push(target) });
    const target: CaptionTarget = { kind: "needs-you", entryId: "e1", then: { kind: "conversation", path: "/a.jsonl", conversationId: "c1" } };
    await push([{ what: "question", subject: "T", target }], "your-move");
    await act(async () => { view.toasts()[0]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    expect(opened).toEqual([target]);
  });
});

describe("the stack", () => {
  test("a toast stays 2 s on the fake clock and then leaves", async () => {
    const view = await mount();
    await push([{ what: "reply", subject: "T", target: null }]);
    await advance(1999);
    expect(view.toasts()).toHaveLength(1);
    await advance(1);
    expect(view.toasts()).toHaveLength(0);
  });

  test("hovering holds every toast, and leaving resumes the countdown", async () => {
    const view = await mount();
    await push([{ what: "reply", subject: "T", target: null }]);
    await advance(1200);
    await act(async () => { pointerIn(view.toasts()[0]!); });
    await advance(10_000);
    expect(view.toasts()).toHaveLength(1);
    await act(async () => { pointerOut(view.toasts()[0]!); });
    await advance(999);
    expect(view.toasts()).toHaveLength(1);
    await advance(1);
    expect(view.toasts()).toHaveLength(0);
  });

  test("keyboard focus holds the stack like the pointer does", async () => {
    const view = await mount();
    await push([{ what: "reply", subject: "T", target: lane }]);
    await act(async () => { view.toasts()[0]!.dispatchEvent(new dom.Event("focusin", { bubbles: true }) as unknown as Event); });
    await advance(10_000);
    expect(soundCaptionsSnapshot()).toHaveLength(1);
    await act(async () => { view.toasts()[0]!.dispatchEvent(new dom.Event("focusout", { bubbles: true }) as unknown as Event); });
    await advance(2000);
    expect(soundCaptionsSnapshot()).toHaveLength(0);
  });

  test("five in a row show four, the newest last, and the oldest is the one that went", async () => {
    const view = await mount();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await push([{ what: "reply", subject: name, target: null }]);
      await advance(300);
    }
    expect(view.toasts().map((toast) => toast.querySelector(".sc-subject")!.textContent)).toEqual(["b", "c", "d", "e"]);
  });

  test("a hold released while no toast is left does not leave the next one held", async () => {
    const view = await mount();
    await push([{ what: "reply", subject: "T", target: lane }]);
    await act(async () => { pointerIn(view.toasts()[0]!); });
    await act(async () => { view.toasts()[0]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    await push([{ what: "reply", subject: "next", target: null }]);
    await advance(2000);
    expect(view.toasts()).toHaveLength(0);
  });

  test("the floating needs-you panel hides the stack, and the countdown runs on underneath", async () => {
    const view = await mount({ hidden: true });
    await push([{ what: "reply", subject: "T", target: null }]);
    expect(view.column()).toBeNull();
    expect(soundCaptionsSnapshot()).toHaveLength(1);
    await advance(2000);
    expect(soundCaptionsSnapshot()).toHaveLength(0);
  });

  test("the conversation the question toast already shows is not captioned twice", async () => {
    const view = await mount({ suppressPath: "/a.jsonl" });
    await push([{ what: "question", subject: "T", target: { kind: "needs-you", entryId: "e1", then: { kind: "conversation", path: "/a.jsonl" } } }], "your-move");
    expect(view.column()).toBeNull();
    await push([{ what: "question", subject: "Other", target: { kind: "conversation", path: "/b.jsonl" } }], "your-move");
    expect(view.toasts()).toHaveLength(1);
    expect(text(view.toasts()[0]!)).toContain("Other");
  });

  test("a phone-class window mounts nothing at all", async () => {
    const view = await mount({ mobile: true });
    await push([{ what: "reply", subject: "T", target: null }]);
    expect(view.column()).toBeNull();
    expect(document.querySelector("[data-sound-caption]")).toBeNull();
    expect(document.querySelector("style")).toBeNull();
  });

  test("the column is a polite live region at the given right edge, under the toast layer", async () => {
    const view = await mount({ right: 336 });
    await push([{ what: "reply", subject: "T", target: null }]);
    const column = view.column()!;
    expect(column.getAttribute("aria-live")).toBe("polite");
    expect(column.style.right).toBe("336px");
    expect(document.querySelector("style")!.textContent).toContain("z-index: 84");
  });
});
