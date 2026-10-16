import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import type { ImportPreview, KeyEntry, KeysAnswer } from "@/lib/keys/shared";

/*
 * «Keys», Варіант 1 (docs/design/keys-settings.md): the page over a stub of
 * its own routes. A value reaches the page only from a reveal answer, and
 * copy puts it on the clipboard without putting it on the page. Values are
 * built at run time from runs of one character.
 */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, CustomEvent: dom.CustomEvent, KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.Event, localStorage: dom.localStorage,
});
const clipboard: string[] = [];
Object.defineProperty(dom.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { clipboard.push(text); } } });

/* react-dom decides at load whether the window supports input events, so it is loaded only once the window exists. */
const { createRoot } = await import("react-dom/client");
const { KeysImportPage, KeysMenuPage } = await import("./KeysSection");

/* Name-indexed: a NAME=value line with a key-shaped value reads as a credential to the publication gate. */
const envLine = (name: string, value: string) => [name, value].join("=");

const OPENROUTER = ["sk", "or", "v1", "0".repeat(64)].join("-");
const OPENAI = ["sk", "proj", "2".repeat(48)].join("-");
const PASTED = ["sk", "or", "v1", "3".repeat(64)].join("-");

const answer = (over: Partial<KeysAnswer> = {}): KeysAnswer => ({ staging: false, owner: true, keys: [
  { id: "openrouter", variable: "OPENROUTER_API_KEY", source: "file", masked: "sk-or-v1-••••••••0000" },
  { id: "openai", variable: "OPENAI_API_KEY", source: "env", masked: "sk-proj-••••••••2222" },
  { id: "elevenlabs", variable: "ELEVENLABS_API_KEY", source: "missing", masked: null },
  { id: "soniox", variable: "SONIOX_API_KEY", source: "failed", masked: null },
  { id: "fishaudio", variable: "FISH_AUDIO_API_KEY", source: "missing", masked: null },
  { id: "telegram", variable: "DELEGATUS_TELEGRAM_BOT_TOKEN", source: "missing", masked: null },
], ...over });

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
function serve(list: KeysAnswer, extra: (call: Call) => Response | Promise<Response> | undefined = () => undefined) {
  calls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    const custom = extra(call);
    if (custom) return custom;
    if (call.url === "/api/keys") return Response.json(list);
    const reveal = /^\/api\/keys\/([a-z]+)\/reveal$/.exec(call.url);
    if (reveal) return Response.json({ value: reveal[1] === "openai" ? OPENAI : OPENROUTER });
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
}

const originalFetch = globalThis.fetch;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  document.body.innerHTML = ""; clipboard.length = 0; setLocale("en");
  globalThis.fetch = originalFetch;
});

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
async function mount(node: React.ReactNode) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(node); });
  await settle(); await settle();
  return host;
}
const click = async (element: Element | null) => {
  expect(element).not.toBeNull();
  await act(async () => { (element as HTMLElement).click(); });
  await settle(); await settle();
};
const row = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-keys-row='${id}']`)!;

for (const lang of ["en", "uk"] as const) for (const size of ["menu", "sheet"] as const) test(`${lang} ${size}: six rows; a key set by a variable says so on its row and names the variable in its note, and cannot be replaced`, async () => {
  setLocale(lang);
  serve(answer());
  const host = await mount(<KeysMenuPage size={size} onImport={() => {}} />);
  expect([...host.querySelectorAll("[data-keys-row]")].map((node) => node.getAttribute("data-keys-row"))).toEqual(["openrouter", "openai", "elevenlabs", "soniox", "fishaudio", "telegram"]);
  const env = row(host, "openai");
  expect(env.querySelector("[data-keys-env-tail]")!.textContent).toBe(` · ${translate(lang, "keys.state.envShort")}`);
  expect(row(host, "openrouter").querySelector("[data-keys-env-tail]")).toBeNull();
  expect(env.querySelector("[data-keys-masked]")!.textContent).toBe("••••2222");
  await act(async () => { env.querySelector<HTMLElement>("[data-keys-dot]")!.focus(); });
  expect(env.querySelector("[data-keys-pop]")!.textContent).toBe(translate(lang, "keys.state.env", { variable: "OPENAI_API_KEY" }));
  /* Read-only here: no Add, and ⋯ offers the masked copy only. */
  expect(env.querySelector("[data-keys-add]")).toBeNull();
  await click(env.querySelector("[data-keys-more]"));
  expect([...env.querySelectorAll("[data-keys-menu-item]")].map((item) => item.getAttribute("data-keys-menu-item"))).toEqual(["masked"]);
  await click(row(host, "openrouter").querySelector("[data-keys-more]"));
  expect([...row(host, "openrouter").querySelectorAll("[data-keys-menu-item]")].map((item) => item.getAttribute("data-keys-menu-item"))).toEqual(["masked", "replace"]);
  /* An unreadable key says so and can be replaced; unset ones can be added. */
  expect(row(host, "soniox").textContent).toContain(translate(lang, "keys.state.failedShort"));
  expect(row(host, "soniox").querySelector("[data-keys-add]")!.textContent).toBe(translate(lang, "keys.replace"));
  expect(row(host, "telegram").querySelector("[data-keys-add]")!.textContent).toBe(translate(lang, "keys.add"));
  expect(host.innerHTML).not.toContain("0".repeat(16));
});

test("copy puts the key on the clipboard without showing it, through one reveal request named copy", async () => {
  serve(answer());
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await click(row(host, "openrouter").querySelector("[data-keys-copy]"));
  expect(clipboard).toEqual([OPENROUTER]);
  expect(calls.filter((call) => call.url.includes("/reveal"))).toEqual([{ url: "/api/keys/openrouter/reveal", method: "POST", body: { purpose: "copy" } }]);
  expect(host.innerHTML).not.toContain(OPENROUTER);
  expect(row(host, "openrouter").querySelector("[data-keys-note='copied']")!.textContent).toBe(translate("en", "keys.copiedShort"));
});

test("copy masked copies the masked form from the list and asks for no value", async () => {
  serve(answer());
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await click(row(host, "openai").querySelector("[data-keys-more]"));
  await click(row(host, "openai").querySelector("[data-keys-menu-item='masked']"));
  expect(clipboard).toEqual(["sk-proj-••••••••2222"]);
  expect(calls.some((call) => call.url.includes("/reveal"))).toBe(false);
  expect(row(host, "openai").querySelector("[data-keys-note='masked']")!.textContent).toBe(translate("en", "keys.copiedMasked", { masked: "••••2222" }));
});

test("the eye shows the value until pressed again, and a key set by a variable is revealed the same way", async () => {
  serve(answer());
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  const eye = () => row(host, "openai").querySelector<HTMLButtonElement>("[data-keys-eye]")!;
  expect(eye().getAttribute("aria-pressed")).toBe("false");
  await click(eye());
  expect(row(host, "openai").querySelector("[data-keys-revealed] code")!.textContent).toBe(OPENAI);
  expect(row(host, "openai").textContent).toContain(translate("en", "keys.revealHides"));
  expect(eye().getAttribute("aria-pressed")).toBe("true");
  expect(calls.filter((call) => call.url.includes("/reveal")).map((call) => call.body)).toEqual([{ purpose: "reveal" }]);
  await click(eye());
  expect(host.innerHTML).not.toContain(OPENAI);
});

test("copy all copies the export's NAME=value lines and says how many", async () => {
  const text = `# Delegatus keys · 2026-10-16 · 2\n${envLine("OPENROUTER_API_KEY", OPENROUTER)}\n${envLine("OPENAI_API_KEY", OPENAI)}\n`;
  serve(answer(), (call) => call.url === "/api/keys/export" ? Response.json({ text, count: 2, omitted: [] }) : undefined);
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await click(host.querySelector("[data-keys-copy-all]"));
  expect(clipboard).toEqual([text]);
  expect(host.querySelector("[data-keys-copied-all]")!.textContent).toBe(translate("en", "keys.copiedAll", { count: 2 }));
  expect(host.innerHTML).not.toContain(OPENROUTER);
});

async function type(host: HTMLElement, id: string, typed: string) {
  const input = row(host, id).querySelector<HTMLInputElement>("[data-keys-field] input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, typed);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  return input;
}
const submit = async (host: HTMLElement, id: string) => {
  await act(async () => { row(host, id).querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
};

test("a value that cannot be the key is refused in words at once, sent nowhere, and the field is emptied", async () => {
  serve(answer());
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await click(row(host, "elevenlabs").querySelector("[data-keys-add]"));
  const input = await type(host, "elevenlabs", "sk_short");
  expect(input.type).toBe("password");
  await submit(host, "elevenlabs");
  await settle();
  expect(calls.some((call) => call.method === "PUT")).toBe(false);
  expect(row(host, "elevenlabs").querySelector("[data-keys-error='invalid']")!.textContent).toBe(translate("en", "keys.invalid", { name: "ElevenLabs" }));
  expect(input.value).toBe("");
  expect(row(host, "elevenlabs").getAttribute("data-keys-source")).toBe("missing");
});

test("a valid save shows the key as saved before the server answers, then adopts the server's list", async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  const stored = answer();
  serve(stored, (call) => call.method === "PUT" ? held : undefined);
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await click(row(host, "soniox").querySelector("[data-keys-add]"));
  const typed = "4".repeat(64);
  await type(host, "soniox", typed);
  await submit(host, "soniox");
  await settle();
  /* The answer is still pending: the row already says saved, the field is gone, and nothing typed stays on the page. */
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(row(host, "soniox").getAttribute("data-keys-source")).toBe("file");
  expect(row(host, "soniox").querySelector("[data-keys-field]")).toBeNull();
  expect(row(host, "soniox").querySelector("[data-keys-note='saved']")).not.toBeNull();
  expect(row(host, "soniox").querySelector("[data-keys-eye]")).not.toBeNull();
  expect(host.innerHTML).not.toContain(typed);
  /* The server now holds the key, as its list and its save answer both say. */
  stored.keys[3] = { id: "soniox", variable: "SONIOX_API_KEY", source: "file", masked: "••••••••4444" };
  await act(async () => { release(Response.json(stored)); });
  await settle(); await settle();
  expect(row(host, "soniox").getAttribute("data-keys-source")).toBe("file");
  expect(row(host, "soniox").querySelector("[data-keys-field]")).toBeNull();
});

for (const refusal of [{ code: "write_failed", status: 500, shown: "failed" }, { code: "invalid_key", status: 400, shown: "invalid" }]) {
  test(`a refused save (${refusal.code}) is taken back: the row returns to its state and the field comes back with the reason`, async () => {
    let release!: (response: Response) => void;
    const held = new Promise<Response>((resolve) => { release = resolve; });
    serve(answer(), (call) => call.method === "PUT" ? held : undefined);
    const host = await mount(<KeysMenuPage onImport={() => {}} />);
    await click(row(host, "soniox").querySelector("[data-keys-add]"));
    await type(host, "soniox", "4".repeat(64));
    await submit(host, "soniox");
    await settle();
    expect(row(host, "soniox").getAttribute("data-keys-source")).toBe("file");
    await act(async () => { release(Response.json({ code: refusal.code }, { status: refusal.status })); });
    await settle(); await settle();
    expect(row(host, "soniox").getAttribute("data-keys-source")).toBe("failed");
    expect(row(host, "soniox").querySelector("[data-keys-note='saved']")).toBeNull();
    expect(row(host, "soniox").querySelector(`[data-keys-error='${refusal.shown}']`)).not.toBeNull();
    expect(row(host, "soniox").querySelector<HTMLInputElement>("[data-keys-field] input")!.value).toBe("");
    expect(host.innerHTML).not.toContain("4".repeat(32));
  });
}

const mask = (typed: string) => `••••••••${typed.slice(-4)}`;
const withElevenlabs = (list: KeysAnswer, typed: string): KeysAnswer => ({ ...list, keys: list.keys.map((entry) => entry.id === "elevenlabs" ? { ...entry, source: "file", masked: mask(typed) } : entry) });

/* Two saves of one key, the newer answered first: the older answer is the keys from before the newer one. */
async function twoSaves(older: "answers" | "fails") {
  const A = "1".repeat(64), B = "2".repeat(64);
  const puts: Array<(response: Response) => void> = [];
  const lists: Array<(response: Response) => void> = [];
  const base = answer();
  const answerA = withElevenlabs(base, A), answerB = withElevenlabs(base, B);
  /* The server's list: the keys as the second save leaves them, whichever answer arrives first. */
  serve(base, (call) => {
    if (call.method === "PUT") return new Promise<Response>((resolve) => { puts.push(resolve); });
    /* The reads the saves trigger stay in flight, so only the save answers decide what the row shows. */
    if (call.url === "/api/keys" && puts.length >= 2) return new Promise<Response>(() => {});
    if (call.url === "/api/keys" && lists.length < 1 && puts.length === 1) return new Promise<Response>((resolve) => { lists.push(resolve); });
    return undefined;
  });
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await click(row(host, "elevenlabs").querySelector("[data-keys-add]"));
  await type(host, "elevenlabs", A);
  await submit(host, "elevenlabs");
  await settle();
  /* A read that begins between the two saves and lands after both. */
  await act(async () => { window.dispatchEvent(new Event("delegatus:provider-key-changed")); });
  await click(row(host, "elevenlabs").querySelector("[data-keys-more]"));
  await click(row(host, "elevenlabs").querySelector("[data-keys-menu-item='replace']"));
  await type(host, "elevenlabs", B);
  await submit(host, "elevenlabs");
  await settle();
  expect(puts).toHaveLength(2);
  base.keys = answerB.keys;
  await act(async () => { puts[1]!(Response.json(answerB)); });
  await settle(); await settle();
  await act(async () => {
    puts[0]!(older === "answers" ? Response.json(answerA) : Response.json({ code: "write_failed" }, { status: 500 }));
    lists[0]?.(Response.json(answerA));
  });
  await settle(); await settle();
  return { host, B };
}

for (const older of ["answers", "fails"] as const) {
  test(`an older save of a key that ${older} after the newer one keeps the newer key shown, and Copy masked copies it`, async () => {
    const { host, B } = await twoSaves(older);
    expect(row(host, "elevenlabs").getAttribute("data-keys-source")).toBe("file");
    expect(row(host, "elevenlabs").querySelector("[data-keys-field]")).toBeNull();
    await click(row(host, "elevenlabs").querySelector("[data-keys-more]"));
    await click(row(host, "elevenlabs").querySelector("[data-keys-menu-item='masked']"));
    expect(clipboard).toEqual([mask(B)]);
  });
}

test("a key opened from another place: Cancel and Escape close its field and leave it closed, and asking again opens it again", async () => {
  serve(answer());
  const node = (seq: number) => <KeysMenuPage onImport={() => {}} focusKey="elevenlabs" focusSeq={seq} />;
  const host = await mount(node(1));
  expect(row(host, "elevenlabs").querySelector("[data-keys-field]")).not.toBeNull();
  await click(row(host, "elevenlabs").querySelector("[data-keys-cancel]"));
  expect(row(host, "elevenlabs").querySelector("[data-keys-field]")).toBeNull();
  await click(row(host, "elevenlabs").querySelector("[data-keys-add]"));
  const input = row(host, "elevenlabs").querySelector<HTMLInputElement>("[data-keys-field] input")!;
  await act(async () => { input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event); });
  await settle();
  expect(row(host, "elevenlabs").querySelector("[data-keys-field]")).toBeNull();
  await act(async () => { root!.render(node(2)); });
  await settle();
  expect(row(host, "elevenlabs").querySelector("[data-keys-field]")).not.toBeNull();
});

test("the bot's token is the one save that waits for its answer, since Telegram has to accept it", async () => {
  let release!: (response: Response) => void;
  const held = new Promise<Response>((resolve) => { release = resolve; });
  serve(answer(), (call) => call.method === "PUT" ? held : undefined);
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await click(row(host, "telegram").querySelector("[data-keys-add]"));
  await type(host, "telegram", `${"9".repeat(9)}:${"6".repeat(35)}`);
  await submit(host, "telegram");
  await settle();
  expect(row(host, "telegram").getAttribute("data-keys-source")).toBe("missing");
  expect(row(host, "telegram").querySelector("[data-keys-field] input")!.hasAttribute("disabled")).toBe(true);
  await act(async () => { release(Response.json({ code: "telegram_refused" }, { status: 409 })); });
  await settle(); await settle();
  expect(row(host, "telegram").querySelector("[data-keys-error='telegram']")).not.toBeNull();
});

const gate = () => {
  const answers: ((response: Response) => void)[] = [];
  return {
    pending: () => new Promise<Response>((resolve) => { answers.push(resolve); }),
    answer: (index: number) => act(async () => { answers[index]!(Response.json({ value: OPENROUTER })); }),
    count: () => answers.length,
  };
};

test("a reveal answer that arrives after Hide cannot show the key again, and a second press before the answer asks for nothing new", async () => {
  const reveals = gate();
  serve(answer(), (call) => call.url.endsWith("/reveal") ? reveals.pending() : undefined);
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  const eye = () => row(host, "openrouter").querySelector<HTMLButtonElement>("[data-keys-eye]")!;
  await click(eye());
  await click(eye());
  expect(reveals.count()).toBe(1);
  await reveals.answer(0);
  await settle();
  expect(row(host, "openrouter").querySelector("[data-keys-revealed]")).not.toBeNull();
  await click(eye());
  expect(row(host, "openrouter").querySelector("[data-keys-revealed]")).toBeNull();
  expect(host.innerHTML).not.toContain(OPENROUTER);
});

test("a reveal answer that arrives after the page is left shows nothing, and a fresh reveal still hides after 30 seconds", async () => {
  const reveals = gate();
  serve(answer(), (call) => call.url.endsWith("/reveal") ? reveals.pending() : undefined);
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await click(row(host, "openrouter").querySelector("[data-keys-eye]"));
  act(() => root?.unmount()); root = undefined;
  await reveals.answer(0);
  expect(document.body.innerHTML).not.toContain(OPENROUTER);

  const realSet = window.setTimeout;
  const timers: { fn: () => void; ms: number }[] = [];
  (window as unknown as { setTimeout: unknown }).setTimeout = (fn: () => void, ms = 0) => { timers.push({ fn, ms }); return timers.length; };
  try {
    const fresh = gate();
    serve(answer(), (call) => call.url.endsWith("/reveal") ? fresh.pending() : undefined);
    const again = await mount(<KeysMenuPage onImport={() => {}} />);
    await act(async () => { row(again, "openrouter").querySelector<HTMLElement>("[data-keys-eye]")!.click(); });
    await fresh.answer(0);
    expect(row(again, "openrouter").querySelector("[data-keys-revealed]")).not.toBeNull();
    const hide = timers.filter((timer) => timer.ms === 30_000).at(-1)!;
    await act(async () => { hide.fn(); });
    expect(row(again, "openrouter").querySelector("[data-keys-revealed]")).toBeNull();
  } finally {
    (window as unknown as { setTimeout: unknown }).setTimeout = realSet;
  }
});

for (const lang of ["en", "uk"] as const) test(`${lang}: a team member sees states only, with no value, no action and no transfer`, async () => {
  setLocale(lang);
  const list = answer({ owner: false });
  serve({ ...list, keys: list.keys.map((entry) => ({ ...entry, masked: null })) });
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  expect(host.querySelector("[data-keys-member]")!.textContent).toBe(translate(lang, "keys.member"));
  expect(row(host, "openrouter").textContent).toContain(translate(lang, "keys.state.file"));
  expect(row(host, "openai").textContent).toContain(translate(lang, "keys.state.envSource"));
  expect(host.querySelector("[data-keys-eye], [data-keys-copy], [data-keys-more], [data-keys-add], [data-keys-copy-all], [data-keys-open-import]")).toBeNull();
});

for (const lang of ["en", "uk"] as const) test(`${lang}: staging shows and copies, and offers no Add, Replace or Import`, async () => {
  setLocale(lang);
  serve(answer({ staging: true }));
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  expect(host.querySelector("[data-keys-staging]")!.textContent).toBe(translate(lang, "keys.staging"));
  expect(host.querySelector("[data-keys-add], [data-keys-open-import]")).toBeNull();
  expect(row(host, "openrouter").querySelector("[data-keys-copy]")).not.toBeNull();
  await click(row(host, "openrouter").querySelector("[data-keys-more]"));
  expect(row(host, "openrouter").querySelector("[data-keys-menu-item='replace']")).toBeNull();
  expect(host.querySelector("[data-keys-copy-all]")).not.toBeNull();
});

test("a list that cannot be read says so with a retry", async () => {
  let fail = true;
  serve(answer(), (call) => call.url === "/api/keys" && fail ? Response.json({ error: "x" }, { status: 500 }) : undefined);
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  expect(host.querySelector("[data-keys-failed]")!.textContent).toContain(translate("en", "keys.loadFailed"));
  fail = false;
  await click(host.querySelector("[data-keys-failed] button"));
  expect(host.querySelector("[data-keys-failed]")).toBeNull();
  expect(host.querySelectorAll("[data-keys-row]")).toHaveLength(6);
});

for (const lang of ["en", "uk"] as const) test(`${lang}: import shows the pasted lines masked and the server's preview, and Apply confirms exactly the rows shown`, async () => {
  setLocale(lang);
  const preview: ImportPreview = {
    rows: [
      { id: "openrouter", kind: "replaces", masked: "sk-or-v1-••••••••3333", was: "sk-or-v1-••••••••0000", revision: "a1b2c3d4e5f6a1b2c3d4e5f6" },
      { id: "openai", kind: "env", masked: "sk-proj-••••••••5555" },
      { id: "elevenlabs", kind: "invalid" },
      { id: "soniox", kind: "new", masked: "••••••••4444" },
      { id: "telegram", kind: "new", masked: "999999999:••••••••6666" },
    ],
    unknown: ["LLV_TOKEN"],
    unparsed: [9],
  };
  serve(answer(), (call) => {
    if (call.url !== "/api/keys/import") return undefined;
    return (call.body as { confirm?: unknown }).confirm ? Response.json({ saved: ["openrouter", "soniox"], unconfirmed: [], failed: [{ id: "telegram", reason: "telegram_refused" }] }) : Response.json(preview);
  });
  const host = await mount(<KeysImportPage />);
  const area = host.querySelector<HTMLTextAreaElement>("[data-keys-import-text]")!;
  const text = `# Delegatus keys · 2026-10-15 · 3\n${envLine("OPENROUTER_API_KEY", PASTED)}\nexport ${envLine("SONIOX_API_KEY", `"${"4".repeat(64)}"`)}`;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(area, text);
    area.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await settle(); await settle();
  expect(calls.filter((call) => call.url === "/api/keys/import")).toEqual([{ url: "/api/keys/import", method: "POST", body: { text } }]);
  expect([...host.querySelectorAll("[data-keys-import-masked] span")].map((line) => line.textContent)).toEqual([
    "# Delegatus keys · 2026-10-15 · 3", "OPENROUTER_API_KEY=••••3333", "SONIOX_API_KEY=••••4444",
  ]);
  expect(host.innerHTML).not.toContain(PASTED);
  expect(host.innerHTML).not.toContain("4".repeat(16));
  expect([...host.querySelectorAll("[data-keys-import-row]")].map((node) => [node.getAttribute("data-keys-import-row"), node.getAttribute("data-keys-import-kind")])).toEqual([
    ["openrouter", "replaces"], ["openai", "env"], ["elevenlabs", "invalid"], ["soniox", "new"], ["telegram", "new"],
  ]);
  expect(host.querySelector("[data-keys-import-row='openrouter']")!.textContent).toContain(translate(lang, "keys.import.replaces", { was: "••••0000" }));
  expect(host.querySelector("[data-keys-import-unknown]")!.textContent).toBe(translate(lang, "keys.import.unknown", { names: "LLV_TOKEN" }));
  expect(host.querySelector("[data-keys-import-unparsed]")!.textContent).toBe(translate(lang, "keys.import.unparsed", { lines: "9" }));
  expect(host.querySelector("[data-keys-import-bot]")!.textContent).toBe(translate(lang, "keys.import.bot"));
  const apply = host.querySelector<HTMLButtonElement>("[data-keys-import-apply]")!;
  expect(apply.textContent).toBe(translate(lang, "keys.import.apply", { count: 3 }));
  await click(apply);
  expect(calls.filter((call) => call.url === "/api/keys/import").at(-1)!.body).toEqual({ text, confirm: {
    openrouter: { kind: "replaces", revision: "a1b2c3d4e5f6a1b2c3d4e5f6" },
    soniox: { kind: "new" },
    telegram: { kind: "new" },
  } });
  expect(host.querySelector("[data-keys-import-done]")!.textContent).toContain(translate(lang, "keys.import.done", { count: 2 }));
  expect(host.querySelector("[data-keys-import-not-saved]")!.textContent).toBe(translate(lang, "keys.import.notSaved", { names: translate(lang, "keys.name.telegram") }));
  /* The pasted text is gone: the field is empty again. */
  expect(host.querySelector<HTMLTextAreaElement>("[data-keys-import-text]")!.value).toBe("");
  expect(host.querySelector("[data-keys-import-preview]")).toBeNull();
});

for (const lang of ["en", "uk"] as const) test(`${lang}: a long list of unknown variables names the first two and counts the rest`, async () => {
  setLocale(lang);
  const unknown = ["LLV_TOKEN", ...Array.from({ length: 30 }, (_, index) => `LLV_NOTE_${String(index + 1).padStart(2, "0")}`)];
  serve(answer(), (call) => call.url === "/api/keys/import" ? Response.json({ rows: [{ id: "soniox", kind: "new", masked: "••••••••4444" }], unknown, unparsed: [] }) : undefined);
  const host = await mount(<KeysImportPage />);
  const area = host.querySelector<HTMLTextAreaElement>("[data-keys-import-text]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(area, `${envLine("SONIOX_API_KEY", "4".repeat(64))}`);
    area.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await settle(); await settle();
  expect(host.querySelector("[data-keys-import-unknown]")!.textContent).toBe(translate(lang, "keys.import.unknownMore", { names: "LLV_TOKEN, LLV_NOTE_01", count: 29 }));
  expect(host.querySelector("[data-keys-import-unknown]")!.textContent).not.toContain("LLV_NOTE_02");
});

test("an import with nothing to write offers no Apply that does something", async () => {
  serve(answer(), (call) => call.url === "/api/keys/import" ? Response.json({ rows: [{ id: "openai", kind: "env", masked: "sk-proj-••••••••5555" }], unknown: [], unparsed: [] }) : undefined);
  const host = await mount(<KeysImportPage />);
  const area = host.querySelector<HTMLTextAreaElement>("[data-keys-import-text]")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(area, `${envLine("OPENAI_API_KEY", OPENAI)}`);
    area.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await settle(); await settle();
  expect(host.querySelector<HTMLButtonElement>("[data-keys-import-apply]")!.disabled).toBe(true);
});

test("a commented assignment or a comment holding a bare key shows no part of the pasted value", async () => {
  serve(answer(), (call) => call.url === "/api/keys/import" ? Response.json({ rows: [], unknown: [], unparsed: [] }) : undefined);
  const host = await mount(<KeysImportPage />);
  const area = host.querySelector<HTMLTextAreaElement>("[data-keys-import-text]")!;
  const text = [`# ${envLine("OPENAI_API_KEY", OPENAI)}`, `# ${PASTED}`, "# Delegatus keys · 2026-10-15 · 1"].join("\n");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!.call(area, text);
    area.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await settle(); await settle();
  expect([...host.querySelectorAll("[data-keys-import-masked] span")].map((line) => line.textContent)).toEqual(["# ••••", "# ••••", "# Delegatus keys · 2026-10-15 · 1"]);
  expect(host.innerHTML).not.toContain(OPENAI.slice(-8));
  expect(host.innerHTML).not.toContain(PASTED.slice(-8));
});

/* ---- Review round: clipboard fallback, replaced reveals, overlapping saves ---- */

test("a clipboard fallback that throws leaves no textarea holding the key, for Copy and for Copy all", async () => {
  const text = `${envLine("OPENROUTER_API_KEY", OPENROUTER)}\n`;
  serve(answer(), (call) => call.url === "/api/keys/export" ? Response.json({ text, count: 1, omitted: [] }) : undefined);
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  const writable = Object.getOwnPropertyDescriptor(dom.navigator, "clipboard")!;
  const exec = (document as unknown as { execCommand?: unknown }).execCommand;
  const seen: string[] = [];
  Object.defineProperty(dom.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
  (document as unknown as { execCommand: unknown }).execCommand = () => {
    seen.push(document.querySelector("textarea")?.value ?? "");
    throw new Error("SecurityError");
  };
  try {
    await click(row(host, "openrouter").querySelector("[data-keys-copy]"));
    await click(host.querySelector("[data-keys-copy-all]"));
    /* The fallback ran with the key in the element, and the element is gone with the key in it. */
    expect(seen).toEqual([OPENROUTER, text]);
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.body.innerHTML).not.toContain(OPENROUTER);
  } finally {
    Object.defineProperty(dom.navigator, "clipboard", writable);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
  }
});

/* The window's timers are captured, and cleared ones never run, so that 30 seconds pass at once. */
async function withTimers<T>(run: (timers: { fn: () => void; ms: number }[]) => Promise<T>) {
  const realSet = window.setTimeout, realClear = window.clearTimeout;
  const timers: { fn: () => void; ms: number }[] = [];
  const win = window as unknown as { setTimeout: unknown; clearTimeout: unknown };
  win.setTimeout = (fn: () => void, ms = 0) => { timers.push({ fn, ms }); return timers.length; };
  win.clearTimeout = (id: number) => { if (timers[id - 1]) timers[id - 1] = { fn: () => {}, ms: -1 }; };
  try { return await run(timers); } finally { win.setTimeout = realSet; win.clearTimeout = realClear; }
}

test("a revealed key whose save is refused after its 30 seconds ran out stays hidden; a new press reads the current key", async () => {
  const puts: Array<(response: Response) => void> = [];
  serve(answer(), (call) => call.method === "PUT" ? new Promise<Response>((resolve) => { puts.push(resolve); }) : undefined);
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await withTimers(async (timers) => {
    await click(row(host, "openrouter").querySelector("[data-keys-eye]"));
    expect(row(host, "openrouter").querySelector("[data-keys-revealed]")).not.toBeNull();
    await click(row(host, "openrouter").querySelector("[data-keys-more]"));
    await click(row(host, "openrouter").querySelector("[data-keys-menu-item='replace']"));
    await type(host, "openrouter", ["sk", "or", "v1", "5".repeat(64)].join("-"));
    await submit(host, "openrouter");
    await settle();
    expect(row(host, "openrouter").querySelector("[data-keys-revealed]")).toBeNull();
    await act(async () => { for (const timer of timers.filter((candidate) => candidate.ms === 30_000)) timer.fn(); });
    await act(async () => { puts[0]!(Response.json({ code: "write_failed" }, { status: 500 })); });
    await settle(); await settle();
    expect(row(host, "openrouter").querySelector("[data-keys-revealed]")).toBeNull();
    expect(host.innerHTML).not.toContain(OPENROUTER);
    const reveals = calls.filter((call) => call.url.endsWith("/reveal")).length;
    await click(row(host, "openrouter").querySelector("[data-keys-eye]"));
    expect(calls.filter((call) => call.url.endsWith("/reveal"))).toHaveLength(reveals + 1);
  });
});

test("a revealed key replaced by one with the same mask is not shown any more", async () => {
  const lookalike = ["sk", "or", "v1", "7".repeat(60) + "0000"].join("-");
  serve(answer(), (call) => call.method === "PUT" ? Response.json(answer()) : undefined);
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await click(row(host, "openrouter").querySelector("[data-keys-eye]"));
  expect(row(host, "openrouter").querySelector("[data-keys-revealed]")).not.toBeNull();
  await click(row(host, "openrouter").querySelector("[data-keys-more]"));
  await click(row(host, "openrouter").querySelector("[data-keys-menu-item='replace']"));
  await type(host, "openrouter", lookalike);
  await submit(host, "openrouter");
  await settle(); await settle();
  expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  expect(row(host, "openrouter").querySelector("[data-keys-revealed]")).toBeNull();
  expect(host.innerHTML).not.toContain(OPENROUTER);
});

test("an older save's snapshot answering late leaves another row's newer settled save alone, while the refresh is still pending", async () => {
  const A = "1".repeat(64), B = "2".repeat(64);
  const puts = new Map<string, (response: Response) => void>();
  const base = answer();
  const rows = (soniox: KeyEntry) => ({ ...base, keys: base.keys.map((entry) => entry.id === "soniox" ? soniox : entry.id === "elevenlabs" ? { ...entry, source: "file" as const, masked: mask(A) } : entry) });
  const soniox: KeyEntry = { id: "soniox", variable: "SONIOX_API_KEY", source: "file", masked: mask(B) };
  let reads = 0;
  serve(base, (call) => {
    if (call.method === "PUT") return new Promise<Response>((resolve) => { puts.set(call.url, resolve); });
    /* The mount read answers; every refresh after it stays in flight. */
    if (call.url === "/api/keys" && ++reads > 1) return new Promise<Response>(() => {});
    return undefined;
  });
  const host = await mount(<KeysMenuPage onImport={() => {}} />);
  await click(row(host, "elevenlabs").querySelector("[data-keys-add]"));
  await type(host, "elevenlabs", A);
  await submit(host, "elevenlabs");
  await click(row(host, "soniox").querySelector("[data-keys-add]"));
  await type(host, "soniox", B);
  await submit(host, "soniox");
  await settle();
  await act(async () => { puts.get("/api/keys/soniox")!(Response.json(rows(soniox))); });
  await settle();
  /* Saved earlier, answered later: its snapshot still has Soniox as it was before. */
  await act(async () => { puts.get("/api/keys/elevenlabs")!(Response.json(rows(base.keys[3]!))); });
  await settle(); await settle();
  expect(row(host, "soniox").getAttribute("data-keys-source")).toBe("file");
  expect(row(host, "elevenlabs").getAttribute("data-keys-source")).toBe("file");
  await click(row(host, "soniox").querySelector("[data-keys-more]"));
  await click(row(host, "soniox").querySelector("[data-keys-menu-item='masked']"));
  expect(clipboard).toEqual([mask(B)]);
});

for (const order of ["oldest first", "newest first"] as const) {
  test(`two saves of an unset key that are both refused (${order}) leave the stored state, with the refusal in the field and no mask of an unsaved value`, async () => {
    const A = "1".repeat(64), B = "2".repeat(64);
    const puts: Array<(response: Response) => void> = [];
    serve(answer(), (call) => call.method === "PUT" ? new Promise<Response>((resolve) => { puts.push(resolve); }) : undefined);
    const host = await mount(<KeysMenuPage onImport={() => {}} />);
    await click(row(host, "elevenlabs").querySelector("[data-keys-add]"));
    await type(host, "elevenlabs", A);
    await submit(host, "elevenlabs");
    await settle();
    await click(row(host, "elevenlabs").querySelector("[data-keys-more]"));
    await click(row(host, "elevenlabs").querySelector("[data-keys-menu-item='replace']"));
    await type(host, "elevenlabs", B);
    await submit(host, "elevenlabs");
    await settle();
    expect(puts).toHaveLength(2);
    for (const index of order === "oldest first" ? [0, 1] : [1, 0]) {
      await act(async () => { puts[index]!(Response.json({ code: "write_failed" }, { status: 500 })); });
      await settle(); await settle();
    }
    expect(row(host, "elevenlabs").getAttribute("data-keys-source")).toBe("missing");
    expect(row(host, "elevenlabs").querySelector("[data-keys-error='failed']")).not.toBeNull();
    expect(row(host, "elevenlabs").querySelector("[data-keys-more], [data-keys-copy]")).toBeNull();
    expect(host.innerHTML).not.toContain(mask(A));
    expect(host.innerHTML).not.toContain(mask(B));
  });
}
