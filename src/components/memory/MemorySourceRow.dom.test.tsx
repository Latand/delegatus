import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import type { MemorySourceView } from "@/lib/memory/viewTypes";
import { MemorySourceRow, memorySourceLine } from "./MemorySourceRow";

/* The Settings row of the memory source switch (memory-source-switch.md §3.4)
   over a stub of `/api/memory/source`: every state's words in both
   languages, the optimistic press and its rollback on a refused write. */

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator,
  localStorage: dom.localStorage, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event, CustomEvent: dom.CustomEvent });
installActEnv();
const originalFetch = globalThis.fetch;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  globalThis.fetch = originalFetch; document.body.innerHTML = "";
  setLocale("en");
});

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const COUNTS = { files: 351, parts: 351, pendingFiles: 231, pendingParts: 231, pendingLoadedParts: 231, adopted: 80, dropped: 40 };
const VIEWS = {
  unchosen: { choice: null, phase: null },
  preparing: { choice: "delegatus", phase: "importing", import: { counts: null, remainingGenerations: 0, hold: null } },
  importing: { choice: "delegatus", phase: "importing", import: { counts: COUNTS, remainingGenerations: 0, hold: null } },
  draining: { choice: "delegatus", phase: "draining", import: { counts: { ...COUNTS, pendingFiles: 0, pendingParts: 0, pendingLoadedParts: 0 }, remainingGenerations: 2, hold: null } },
  active: { choice: "delegatus", phase: "active", import: { counts: { ...COUNTS, pendingFiles: 0, pendingParts: 0, pendingLoadedParts: 0 }, remainingGenerations: 0, hold: null } },
  engines: { choice: "engines", phase: "active", sync: { intervalHours: 24, lastAt: new Date(NOW - 3 * 3_600_000).toISOString(), nextAt: null, added: 4, capped: false, failure: null } },
} satisfies Record<string, MemorySourceView>;
type Name = keyof typeof VIEWS;

/* The design's own sentences (§3.4, §4.9), with the counts it shows. The
   Ukrainian apostrophe is the menu's own (’), as «Спільна пам’ять» has it. */
const DESIGN: Record<"en" | "uk", Record<Name, string>> = {
  en: {
    unchosen: "Off: agents use Claude's and Codex's own memory and Delegatus rules together. Turn on to keep one memory.",
    preparing: "Backing up Claude and Codex notes for the curator. Their memory stays on until the import finishes.",
    importing: "Importing Claude and Codex notes through the curator: 120 of 351. Their memory stays on until this finishes.",
    draining: "New agent starts use Delegatus rules only; waiting for 2 agents that started earlier to restart so their last notes can be imported.",
    active: "On: agents remember through Delegatus rules. Claude's and Codex's own memory is off.",
    engines: "Off: agents use Claude's and Codex's own memory. Delegatus rules are paused. New Claude and Codex notes are imported daily (last 3 hours ago, 4 new).",
  },
  uk: {
    unchosen: "Вимкнено: агенти мають і власну пам’ять Claude та Codex, і правила Delegatus. Увімкніть, щоб лишилася одна пам’ять.",
    preparing: "Резервне копіювання нотаток Claude і Codex для куратора. Їхня пам’ять працює, доки імпорт не завершиться.",
    importing: "Імпорт нотаток Claude і Codex через куратора: 120 з 351. Їхня пам’ять працює, доки імпорт не завершиться.",
    draining: "Нові агенти користуються лише правилами Delegatus; чекаємо, поки 2 агенти, запущені раніше, перезапустяться, щоб імпортувати їхні останні нотатки.",
    active: "Увімкнено: агенти пам’ятають через правила Delegatus. Власна пам’ять Claude і Codex вимкнена.",
    engines: "Вимкнено: агенти користуються власною пам’яттю Claude і Codex. Правила Delegatus на паузі. Нові нотатки Claude і Codex імпортуються щодня (востаннє 3 години тому, 4 нові).",
  },
};

type Handler = (init?: RequestInit) => unknown;
const puts: unknown[] = [];
function serve(read: Handler, write: Handler = () => Response.json({ error: "unexpected" }, { status: 500 })) {
  puts.length = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    expect(String(input)).toBe("/api/memory/source");
    if (init?.method === "PUT") puts.push(JSON.parse(String(init.body)));
    const answer = await (init?.method === "PUT" ? write : read)(init);
    return answer instanceof Response ? answer : Response.json(answer);
  }) as typeof fetch;
}
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function render(phone = false) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<MemorySourceRow phone={phone} />); });
  await settle();
  return host;
}
const lineOf = (host: HTMLElement) => host.querySelector("[data-memory-source-line]")!.textContent;
const switchOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("[data-memory-source-switch]")!;
const stateOf = (host: HTMLElement) => host.querySelector("[data-header-menu-memory-source]")!.getAttribute("data-memory-source-state");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const lang of ["en", "uk"] as const) test(`${lang}: every state reads in the design's words, with the switch where the state puts it`, async () => {
  setLocale(lang);
  for (const name of Object.keys(VIEWS) as Name[]) {
    const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params);
    /* The pure line at a frozen clock is the design's sentence. */
    expect(memorySourceLine(VIEWS[name], false, t, lang, NOW)).toBe(DESIGN[lang][name]);
    if (name === "engines") continue;
    serve(() => VIEWS[name]);
    const host = await render();
    expect(stateOf(host)).toBe(name);
    expect(lineOf(host)).toBe(DESIGN[lang][name]);
    expect(host.querySelector("[data-memory-source-title]")!.textContent).toBe(lang === "en" ? "Delegatus memory" : "Пам’ять Delegatus");
    expect(switchOf(host).getAttribute("aria-checked")).toBe(String(name !== "unchosen"));
    expect(switchOf(host).getAttribute("aria-label")).toBe(translate(lang, "memorySource.title"));
    expect(switchOf(host).getAttribute("aria-describedby")).toBe(host.querySelector("[data-memory-source-line]")!.id);
    act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
  }
  /* The row draws the engines position with its sync line; the time is relative to the page's clock. */
  serve(() => ({ ...VIEWS.engines, sync: { ...VIEWS.engines.sync, lastAt: new Date(Date.now() - 3 * 3_600_000).toISOString() } }));
  const host = await render();
  expect(stateOf(host)).toBe("engines");
  expect(lineOf(host)).toBe(DESIGN[lang].engines);
  expect(switchOf(host).getAttribute("aria-checked")).toBe("false");
});

test("the two off states differ in their own sentences", () => {
  for (const lang of ["en", "uk"] as const) {
    const unchosen = translate(lang, "memorySource.unchosen"), engines = translate(lang, "memorySource.engines");
    expect(unchosen).not.toBe(engines);
    expect(unchosen).toContain(lang === "en" ? "Turn on to keep one memory" : "Увімкніть, щоб лишилася одна пам’ять");
    expect(engines).toContain(lang === "en" ? "Delegatus rules are paused" : "Правила Delegatus на паузі");
    expect(engines).not.toContain(lang === "en" ? "Turn on" : "Увімкніть");
  }
});

for (const lang of ["en", "uk"] as const) test(`${lang}: counts, parts, agents left, holds, failures and the sync's variants`, () => {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(lang, key, params);
  const line = (view: MemorySourceView) => memorySourceLine(view, false, t, lang, NOW);
  /* Parts in brackets only while a file of several has one left (§4.4). */
  const split = line({ ...VIEWS.importing, import: { ...VIEWS.importing.import, counts: { ...COUNTS, files: 566, parts: 575, pendingFiles: 446, pendingParts: 455 } } });
  expect(split).toContain(lang === "en" ? "120 of 566 (455 parts left)" : "120 з 566 (лишилося 455 частин)");
  const one = line({ ...VIEWS.importing, import: { ...VIEWS.importing.import, counts: { ...COUNTS, files: 351, parts: 352, pendingFiles: 1, pendingParts: 2 } } });
  expect(one).toContain(lang === "en" ? "350 of 351 (2 parts left)" : "350 з 351 (лишилося 2 частини)");
  expect(line({ ...VIEWS.draining, import: { ...VIEWS.draining.import, remainingGenerations: 1 } })).toBe(t("memorySource.draining", { count: 1 }));
  expect(line({ ...VIEWS.draining, import: { ...VIEWS.draining.import, remainingGenerations: 1 } })).toContain(lang === "en" ? "waiting for 1 agent that started earlier to restart so its" : "поки 1 агент, запущений раніше, перезапуститься");
  expect(line({ ...VIEWS.draining, import: { ...VIEWS.draining.import, remainingGenerations: 5 } })).toContain(lang === "en" ? "5 agents" : "5 агентів, запущених раніше");
  expect(line({ ...VIEWS.draining, import: { ...VIEWS.draining.import, remainingGenerations: 0 } })).toBe(t("memorySource.drainingLast"));
  /* A hold names its reason after the state's words. */
  expect(line({ ...VIEWS.draining, import: { ...VIEWS.draining.import, hold: "source_changed" } }))
    .toBe(`${t("memorySource.draining", { count: 2 })} ${t("memorySource.hold", { reason: t("memorySource.reason.source_changed") })}`);
  /* An admission hold and an undone import name themselves after the state's words (§4.5, §4.7). */
  for (const admission of ["memoryOff", "wakesOff", "curatorOff", "update", "deployment"] as const) {
    const text = line({ ...VIEWS.importing, import: { ...VIEWS.importing.import, admission } });
    expect(text).toBe(`${DESIGN[lang].importing} ${t("memorySource.admission", { reason: t(`memorySource.admission.${admission}`) })}`);
    expect(text).not.toMatch(/undefined|\{|memorySource\.|memoryOff|wakesOff|curatorOff/);
  }
  expect(line({ ...VIEWS.importing, import: { ...VIEWS.importing.import, admission: "wakesOff" } })).toContain(lang === "en" ? "The import is waiting: orchestrator wakes are off." : "Імпорт чекає: пробудження оркестратора вимкнено.");
  expect(line({ ...VIEWS.active, import: { ...VIEWS.active.import, undo: { state: "undone", kept: 0 } } })).toBe(`${DESIGN[lang].active} ${lang === "en" ? "The import was undone." : "Імпорт скасовано."}`);
  const partly = (kept: number) => line({ ...VIEWS.active, import: { ...VIEWS.active.import, undo: { state: "partlyUndone", kept } } });
  expect(partly(1)).toBe(`${DESIGN[lang].active} ${lang === "en" ? "The import was partly undone: 1 rule stays because of later edits." : "Імпорт скасовано частково: 1 правило лишається через пізніші правки."}`);
  expect(partly(3)).toContain(lang === "en" ? "3 rules stay" : "3 правила лишаються");
  expect(partly(5)).toContain(lang === "en" ? "5 rules stay" : "5 правил лишається");
  expect(line({ ...VIEWS.engines, import: { counts: null, remainingGenerations: 0, hold: null, undo: { state: "undone", kept: 0 } } }))
    .toContain(lang === "en" ? "Delegatus rules are paused." : "Правила Delegatus на паузі.");
  expect(line({ ...VIEWS.engines, import: { counts: null, remainingGenerations: 0, hold: null, undo: { state: "undone", kept: 0 } } }))
    .toContain(lang === "en" ? "The import was undone." : "Імпорт скасовано.");
  /* A failed import put the switch back: the off line names why. */
  for (const reason of ["integrity", "backup_refused", "source_changed", "interrupted", "failed"] as const) {
    const text = line({ ...VIEWS.unchosen, lastFailure: { reason, at: "2026-10-23T11:00:00.000Z" } });
    expect(text).toBe(`${t("memorySource.unchosen")} ${t("memorySource.lastFailure", { reason: t(`memorySource.reason.${reason}`) })}`);
    expect(text).not.toMatch(/integrity|backup_refused|source_changed/);
  }
  const sync = (patch: Partial<NonNullable<MemorySourceView["sync"]>>) => line({ ...VIEWS.engines, sync: { ...VIEWS.engines.sync, ...patch } });
  expect(sync({ intervalHours: 0 })).toBe(`${t("memorySource.engines")} ${lang === "en" ? "Their new notes are not imported." : "Їхні нові нотатки не імпортуються."}`);
  expect(sync({ failure: "integrity" })).toContain(t("memorySource.reason.integrity"));
  expect(sync({ failure: "integrity" })).not.toContain(lang === "en" ? "3 hours ago" : "3 години тому");
  expect(sync({ lastAt: null })).toContain(t("memorySource.sync.never"));
  expect(sync({ capped: true })).toContain(t("memorySource.sync.capped"));
  expect(sync({ intervalHours: 6 })).toContain(lang === "en" ? "every 6 hours" : "кожні 6 годин");
  expect(sync({ intervalHours: 1 })).toContain(lang === "en" ? "every hour" : "щогодини");
  expect(sync({ added: 1 })).toContain(lang === "en" ? "1 new" : "1 нова");
  /* A position with nothing synced yet (no import ever ran) adds nothing. */
  expect(line({ choice: "engines", phase: null })).toBe(t("memorySource.engines"));
  for (const text of [split, one, sync({ failure: "backup_refused" })]) expect(text).not.toMatch(/undefined|\{|memorySource\./);
});

test("a press moves the switch and the line at once; the server's counts arrive with its answer", async () => {
  const write = deferred<unknown>();
  serve(() => VIEWS.unchosen, () => write.promise);
  const host = await render();
  await act(async () => { switchOf(host).click(); });
  /* Before the write answers: on, and importing with no counts yet. */
  expect(switchOf(host).getAttribute("aria-checked")).toBe("true");
  expect(stateOf(host)).toBe("preparing");
  expect(lineOf(host)).toBe(translate("en", "memorySource.preparing"));
  expect(puts).toEqual([{ source: "delegatus" }]);
  /* A second press while the write is out sends nothing. */
  await act(async () => { switchOf(host).click(); });
  expect(puts).toHaveLength(1);
  write.resolve(VIEWS.importing);
  await settle();
  expect(stateOf(host)).toBe("importing");
  expect(lineOf(host)).toBe(DESIGN.en.importing);
  expect(host.querySelector("[data-memory-source-failed]")).toBeNull();
});

for (const refusal of ["500", "409", "network"] as const) test(`a refused write (${refusal}) puts the switch back and says so in the same line`, async () => {
  const write = deferred<unknown>();
  serve(() => VIEWS.active, () => write.promise);
  const host = await render();
  await act(async () => { switchOf(host).click(); });
  expect(puts).toEqual([{ source: "engines" }]);
  expect(switchOf(host).getAttribute("aria-checked")).toBe("false");
  expect(lineOf(host)).toBe(translate("en", "memorySource.engines"));
  write.resolve(refusal === "500" ? Response.json({ error: "write_failed" }, { status: 500 })
    : refusal === "409" ? Response.json({ error: "first_choice_delegatus" }, { status: 409 })
    : Promise.reject(new TypeError("fetch failed")));
  await settle();
  expect(switchOf(host).getAttribute("aria-checked")).toBe("true");
  expect(stateOf(host)).toBe("active");
  expect(host.querySelector("[data-memory-source-failed]")!.textContent!.trim()).toBe(translate("en", "memorySource.saveFailed"));
  expect(lineOf(host)).toBe(`${translate("en", "memorySource.saveFailed")} ${DESIGN.en.active}`);
  expect(host.querySelector("[data-memory-source-failed]")!.className).toContain("text-danger");
  /* The failure belongs to that press: the next press clears it. */
  serve(() => VIEWS.active, () => VIEWS.engines);
  await act(async () => { switchOf(host).click(); });
  await settle();
  expect(host.querySelector("[data-memory-source-failed]")).toBeNull();
  expect(stateOf(host)).toBe("engines");
});

test("a read that started before the press never lands over it", async () => {
  const stale = deferred<unknown>();
  let reads = 0;
  /* The server's own state: active until the write, engines after it. Only the second read hangs. */
  let server: Name = "active";
  serve(() => (++reads === 2 ? stale.promise : VIEWS[server]), () => { server = "engines"; return VIEWS.engines; });
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<MemorySourceRow readEveryMs={20} />); });
  await settle();
  expect(stateOf(host)).toBe("active");
  /* The next refresh goes out and hangs; the press answers first, then the refresh with the older state. */
  for (let step = 0; step < 200 && reads < 2; step++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); });
  expect(reads).toBe(2);
  await act(async () => { switchOf(host).click(); });
  await settle();
  expect(stateOf(host)).toBe("engines");
  stale.resolve(VIEWS.active);
  await settle();
  expect(stateOf(host)).toBe("engines");
  expect(switchOf(host).getAttribute("aria-checked")).toBe("false");
});

test("a failed first read says so and offers no press", async () => {
  serve(() => Response.json({}, { status: 500 }));
  const host = await render();
  expect(stateOf(host)).toBe("unknown");
  expect(lineOf(host)).toBe(translate("en", "memorySource.readFailed"));
  expect(switchOf(host).disabled).toBe(true);
  await act(async () => { switchOf(host).click(); });
  expect(puts).toEqual([]);
});

test("a later failed read is unknown with the switch where it was, and the next good read clears it", async () => {
  let answer: () => unknown = () => VIEWS.active;
  serve(() => answer());
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<MemorySourceRow readEveryMs={10} />); });
  await settle();
  expect(stateOf(host)).toBe("active");
  answer = () => Response.json({}, { status: 503 });
  for (let step = 0; step < 200 && stateOf(host) !== "unknown"; step++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); });
  expect(stateOf(host)).toBe("unknown");
  expect(lineOf(host)).toBe(translate("en", "memorySource.readFailed"));
  expect(switchOf(host).getAttribute("aria-checked")).toBe("true");
  expect(switchOf(host).disabled).toBe(false);
  answer = () => VIEWS.active;
  for (let step = 0; step < 200 && stateOf(host) !== "active"; step++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); });
  expect(lineOf(host)).toBe(DESIGN.en.active);
});

test("the phone's row takes the sheet's 44 px switch and its type; the desktop's the panel's", async () => {
  serve(() => VIEWS.importing);
  const phone = await render(true);
  expect(switchOf(phone).className).toContain("h-11");
  expect(phone.querySelector("[data-memory-source-title]")!.parentElement!.className).toContain("text-body");
  act(() => root?.unmount()); root = undefined; document.body.innerHTML = "";
  const desktop = await render(false);
  expect(switchOf(desktop).className).toContain("h-6");
  expect(desktop.querySelector("[data-memory-source-line]")!.className).toContain("text-[11px]");
});

test("a write that landed before the connection dropped: the next read moves the switch and clears the notice", async () => {
  let server: Name = "active";
  serve(() => VIEWS[server], () => { server = "engines"; return Promise.reject(new TypeError("fetch failed")); });
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(<MemorySourceRow readEveryMs={10} />); });
  await settle();
  await act(async () => { switchOf(host).click(); });
  for (let step = 0; step < 200 && stateOf(host) !== "engines"; step++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); });
  expect(stateOf(host)).toBe("engines");
  expect(switchOf(host).getAttribute("aria-checked")).toBe("false");
  expect(host.querySelector("[data-memory-source-failed]")).toBeNull();
  expect(lineOf(host)).not.toContain(translate("en", "memorySource.saveFailed"));
});
