import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  localStorage: dom.localStorage,
});

const { MemoryOnMessage } = await import("./MemoryOnMessage");
const { onArtifactPreview } = await import("@/components/preview/previewBus");

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; setLocale("en"); });

async function mount(memory: { added: Array<{ title: string; path: string | null }>; none: boolean }, mobile = false) {
  const container = dom.document.createElement("div");
  root = createRoot(container as unknown as Element);
  await act(async () => root!.render(<MemoryOnMessage memory={memory} mobile={mobile} />));
  return container;
}
const press = (element: unknown) => act(async () => { (element as { click(): void }).click(); });

for (const locale of ["en", "uk"] as const) {
  test(`the chip counts the added memories and opens their titles in place in ${locale}`, async () => {
    setLocale(locale);
    const added = [
      { title: "Synthetic first title", path: "~/fixture/memory/first.md" },
      { title: "Synthetic second title that runs long enough to need a second line under a narrow bubble", path: "~/fixture/memory/second.md" },
      { title: "Synthetic third title", path: null },
    ];
    const container = await mount({ added, none: false });
    const chip = container.querySelector("[data-memory-chip]")!;
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.textContent).toBe(translate(locale, "memory.message.chip", { n: 3 }));
    expect(chip.getAttribute("title")).toBe(translate(locale, "memory.message.added", { count: 3 }));
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    const list = container.querySelector("[data-memory-titles]")!;
    expect(chip.getAttribute("aria-controls")).toBe(list.id);
    expect(list.className).toBe("hidden");

    await press(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(list.className).not.toContain("hidden");
    const rows = [...list.querySelectorAll("[data-memory-title]")];
    expect(rows.map(row => row.textContent)).toEqual(added.map(entry => entry.title));
    /* Nothing folds a title: each row wraps, and none carries a truncating class. */
    for (const row of rows) { expect(row.querySelector("span")!.className).toContain("break-words"); expect(row.outerHTML).not.toContain("truncate"); }
    /* A title opens its file when the index still holds one; otherwise it is text. */
    expect(rows.map(row => row.tagName)).toEqual(["BUTTON", "BUTTON", "SPAN"]);

    await press(chip);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(list.className).toBe("hidden");
  });

  test(`no candidate chosen is one muted line with nothing to press in ${locale}`, async () => {
    setLocale(locale);
    const container = await mount({ added: [], none: true });
    const line = container.querySelector("[data-memory-none]")!;
    expect(line.tagName).toBe("P");
    expect(line.textContent).toBe(translate(locale, "memory.message.none"));
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("[data-memory-offer]")).toBeNull();
  });
}

test("the ordinary turn draws nothing", async () => {
  const container = await mount({ added: [], none: false });
  expect(container.innerHTML).toBe("");
});

test("a title opens that memory's file in the document preview", async () => {
  const opened: string[] = [];
  const stop = onArtifactPreview(request => opened.push(request.path));
  try {
    const container = await mount({ added: [{ title: "Synthetic title", path: "~/fixture/memory/first.md" }], none: false });
    await press(container.querySelector("[data-memory-chip]"));
    await press(container.querySelector("button[data-memory-title]"));
    expect(opened).toEqual(["~/fixture/memory/first.md"]);
  } finally { stop(); }
});

test("on the phone the chip and each title are 44 px targets", async () => {
  const container = await mount({ added: [{ title: "Synthetic title", path: "~/fixture/memory/first.md" }], none: false }, true);
  const chip = container.querySelector("[data-memory-chip]")!;
  expect(chip.className).toContain("min-h-11");
  expect(chip.className).toContain("min-w-11");
  await press(chip);
  expect(container.querySelector("[data-memory-title]")!.className).toContain("min-h-11");
});

test("neither language says the memory was offered", () => {
  for (const locale of ["en", "uk"] as const) for (const key of ["memory.message.chip", "memory.message.none"] as const) {
    expect(translate(locale, key, { n: 1 })).not.toMatch(/offer|запропон|Jev/i);
  }
  expect(translate("en", "memory.message.added", { count: 1 })).toBe("1 memory added to this message");
  expect(translate("en", "memory.message.added", { count: 3 })).toBe("3 memories added to this message");
  expect(translate("uk", "memory.message.added", { count: 1 })).toContain("підставлено 1 спогад");
  expect(translate("uk", "memory.message.added", { count: 3 })).toContain("підставлено 3 спогади");
  expect(translate("uk", "memory.message.added", { count: 5 })).toContain("підставлено 5 спогадів");
});
