import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";

import { DraftAgentPane, setDraftCwd } from "./DraftAgentPane";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
});

const realFetch = globalThis.fetch;
let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  sessionStorage.clear();
  setLocale("en");
  globalThis.fetch = realFetch;
});

const imageCapability = { supported: true, reason: null, formats: ["image/png"], maxImages: 2, maxRawBytesPerImage: 3, maxEncodedBytesPerRequest: 8 };

/** Stored-profile catalog for both engines (issue #40): Claude has an active
    account, a second signed-in profile, and a signed-out historical one. */
const catalog = {
  claude: {
    active: "anna",
    accounts: [
      { id: "anna", label: "anna", authPresent: true },
      { id: "bob", label: "bob", authPresent: true },
      { id: "carol", label: "carol", authPresent: false },
    ],
  },
  codex: { active: "terra", accounts: [{ id: "terra", label: "terra", authPresent: true }] },
};

function installFetch(posts: Record<string, unknown>[]): void {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/spawn" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return {
        ok: true,
        status: 202,
        json: async () => ({ ok: true, state: "starting", launched: false, path: null, launchId: `launch-${posts.length}`, conversationId: `conversation-${posts.length}`, initialMessage: "pending" }),
      } as Response;
    }
    if (url.startsWith("/api/spawn?")) {
      return { ok: true, json: async () => ({ dirs: ["/repo"], cwd: "/repo", cwdExists: true, spawnTransport: "structured", imageInput: { claude: imageCapability, codex: imageCapability } }) } as Response;
    }
    if (url === "/api/accounts") return { ok: true, json: async () => catalog } as Response;
    if (url === "/api/roles") return { ok: false, json: async () => ({}) } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function mount(draftId: string): HTMLElement {
  setDraftCwd(draftId, "/repo");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<DraftAgentPane draftId={draftId} project="proj" files={[]} onClose={() => {}} onSpawned={() => {}} />));
  return host as unknown as HTMLElement;
}

const click = (element: Element) => flushSync(() => element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
const pill = (host: HTMLElement) => host.querySelector("[data-runtime-pill]") as HTMLButtonElement;
const popover = (selector: string) => document.querySelector(`[data-runtime-popover] ${selector}`) as HTMLElement | null;

/** The pill's own Account panel, the one a conversation's composer opens. */
async function openAccounts(host: HTMLElement): Promise<string[]> {
  click(pill(host));
  click(popover('[data-runtime-value="account"]')!);
  await settle();
  return [...document.querySelectorAll('[data-runtime-popover] [data-runtime-row="account"]')].map((row) => row.getAttribute("data-runtime-value")!);
}

function reactProps<T>(element: Element): T {
  const key = Object.keys(element).find((candidate) => candidate.startsWith("__reactProps$"))!;
  return (element as unknown as Record<string, T>)[key]!;
}

async function launch(host: HTMLElement, prompt: string): Promise<void> {
  const textarea = host.querySelector("textarea")!;
  const props = reactProps<{ onChange: (event: unknown) => void }>(textarea);
  flushSync(() => props.onChange({ target: { value: prompt } }));
  flushSync(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await settle();
}

test("the pill's Account panel lists the engine's signed-in profiles, and the launch runs on the one picked", async () => {
  const posts: Record<string, unknown>[] = [];
  installFetch(posts);
  const host = mount("claude-account-draft");
  await settle();

  /* Before a pick the face names no account; the panel says where the agent starts. */
  expect(pill(host).querySelector("[data-runtime-pill-next-account]")).toBeNull();
  click(pill(host));
  expect(popover("[data-runtime-popover-account]")!.textContent).toBe("starts on anna");
  click(pill(host));

  /* A signed-out profile cannot take a launch and is not offered. */
  expect(await openAccounts(host)).toEqual(["account-anna", "account-bob"]);
  click(popover('[data-runtime-value="account-bob"]')!);
  expect(pill(host).querySelector("[data-runtime-pill-next-account]")!.textContent).toBe("→ bob");
  await launch(host, "Run on the second profile");

  expect(posts).toHaveLength(1);
  expect(posts[0]!.engine).toBe("claude");
  expect(posts[0]!.accountId).toBe("bob");
});

test("a model of another engine re-defaults the launch account to that engine's active profile", async () => {
  const posts: Record<string, unknown>[] = [];
  installFetch(posts);
  const host = mount("engine-flip-draft");
  await settle();

  await openAccounts(host);
  click(popover('[data-runtime-value="account-bob"]')!);
  click(pill(host));
  click(popover('[data-runtime-value="model"]')!);
  click(popover('[data-runtime-value="codex/gpt-6-astra"]')!);
  await settle();

  /* The pick belonged to Claude's catalog: the face drops it, and Codex starts on its own active account. */
  expect(pill(host).textContent).toContain("Codex · 6-Astra");
  expect(pill(host).querySelector("[data-runtime-pill-next-account]")).toBeNull();
  click(pill(host));
  expect(popover("[data-runtime-popover-account]")!.textContent).toBe("starts on terra");
  click(pill(host));

  await launch(host, "Codex launch after the flip");
  expect(posts).toHaveLength(1);
  expect(posts[0]!.engine).toBe("codex");
  expect(posts[0]!.model).toBe("gpt-6-astra");
  expect(posts[0]!.accountId).toBe("terra");
});

test("the ukrainian locale words the pill's default tier and its account line", async () => {
  setLocale("uk");
  const posts: Record<string, unknown>[] = [];
  installFetch(posts);
  const host = mount("uk-account-draft");
  await settle();

  expect(pill(host).textContent).toContain("Claude · Opus 5.5 · Типово");
  click(pill(host));
  expect(popover("[data-runtime-popover-account]")!.textContent).toBe("стартує на anna");
});

/** Two Copilot accounts beside the stored profiles; B is not the active one. */
function installCopilotAccounts(posts: Record<string, unknown>[], accountB: Record<string, unknown> = {}): void {
  installFetch(posts);
  const serve = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/accounts") {
      return { ok: true, json: async () => ({
        ...catalog,
        copilot: { active: "copilot-a", accounts: [
          { id: "copilot-a", label: "Account A", authPresent: true },
          { id: "copilot-b", label: "Account B", authPresent: true, ...accountB },
        ] },
      }) } as Response;
    }
    return serve(input, init);
  }) as typeof fetch;
}

function pickCopilot(host: HTMLElement): void {
  click(pill(host));
  click(popover('[data-runtime-value="model"]')!);
  click(popover('[data-runtime-value="copilot/auto"]')!);
}

test("a Copilot draft chooses its account in the pill, and the launch runs on the one picked", async () => {
  const posts: Record<string, unknown>[] = [];
  installCopilotAccounts(posts);
  const host = mount("copilot-account-draft");
  await settle();
  pickCopilot(host);

  click(pill(host));
  expect(popover("[data-runtime-popover-account]")!.textContent).toBe("starts on Account A");
  click(pill(host));
  expect(await openAccounts(host)).toEqual(["account-copilot-a", "account-copilot-b"]);
  expect(popover('[data-runtime-value="account-copilot-a"]')!.getAttribute("aria-checked")).toBe("true");
  click(popover('[data-runtime-value="account-copilot-b"]')!);
  expect(pill(host).querySelector("[data-runtime-pill-next-account]")!.textContent).toBe("→ Account B");
  click(pill(host));
  expect(popover("[data-runtime-popover-account]")!.textContent).toBe("starts on Account B");
  click(pill(host));

  await launch(host, "Run on the second Copilot account");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ engine: "copilot", model: "auto", accountId: "copilot-b" });
});

test("on the phone a Copilot draft's sheet lists its accounts and marks the one the launch goes to", async () => {
  const posts: Record<string, unknown>[] = [];
  installCopilotAccounts(posts);
  const desktop = dom.matchMedia;
  (dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
    matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  try {
    const host = mount("copilot-phone-draft");
    await settle();
    click(pill(host));
    const sheetRow = (label: string) => [...document.querySelectorAll("[data-runtime-sheet] [data-runtime-sheet-row]")].find((entry) => entry.textContent === label) as HTMLElement;
    click(sheetRow("Copilot · Auto"));
    const accounts = () => [...document.querySelectorAll("[data-runtime-sheet-accounts] [data-runtime-sheet-row]")] as HTMLElement[];
    expect(accounts().map((entry) => [entry.textContent, entry.getAttribute("aria-checked")])).toEqual([["Account A", "true"], ["Account B", "false"]]);
    click(accounts()[1]!);
    expect(accounts().map((entry) => entry.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    click(document.querySelector("[data-runtime-sheet-close]")!);

    await launch(host, "Run on the second Copilot account");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ engine: "copilot", accountId: "copilot-b" });
  } finally {
    (dom as unknown as { matchMedia: unknown }).matchMedia = desktop;
  }
});

test("a Copilot draft on a signed-out account opens that account's sign-in instead of launching", async () => {
  const posts: Record<string, unknown>[] = [];
  installCopilotAccounts(posts, { auth: { state: "signed_out" } });
  sessionStorage.setItem("llvDraftPane:copilot-signed-out-draft:engine", "copilot");
  sessionStorage.setItem("llvDraftPane:copilot-signed-out-draft:accountId", "copilot-b");
  const requests: unknown[] = [];
  const listen = (event: Event) => requests.push((event as CustomEvent).detail);
  window.addEventListener("llv:open-accounts", listen);
  try {
    const host = mount("copilot-signed-out-draft");
    await settle();

    const blocked = host.querySelector('[data-testid="composer-send-blocked"]')!;
    expect(blocked.textContent).toContain("Account B is signed out of Copilot.");
    /* An account that cannot take a launch is not offered; the one chosen before it signed out stays the way back. */
    expect(await openAccounts(host)).toEqual(["account-copilot-b", "account-copilot-a"]);
    click(pill(host));
    click([...blocked.querySelectorAll("button")].find((button) => button.textContent === "Sign in to Copilot first")!);
    expect(requests).toEqual([{ engine: "copilot", accountId: "copilot-b" }]);
    await launch(host, "Should not start");
    expect(posts).toHaveLength(0);
  } finally {
    window.removeEventListener("llv:open-accounts", listen);
  }
});

/* #2170: the engine readiness preflight. A newcomer's only Claude account,
   «Main», is signed out; the launcher used to offer it as «Main · active»,
   send, fail, and move the task. */
for (const locale of ["en", "uk"] as const) {
  test(`a draft on a signed-out account opens that account's sign-in instead of launching, and launches once it signs in (${locale})`, async () => {
    setLocale(locale);
    const posts: Record<string, unknown>[] = [];
    installFetch(posts);
    let signedIn = false;
    const serve = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      if (String(input) === "/api/accounts") {
        return { ok: true, json: async () => ({
          claude: { active: "default", accounts: [{ id: "default", label: "Main", authPresent: signedIn, auth: { state: signedIn ? "authenticated" : "signed_out" } }] },
          codex: { active: "", accounts: [] },
        }) } as Response;
      }
      return serve(input, init);
    }) as typeof fetch;
    const requests: unknown[] = [];
    const listen = (event: Event) => requests.push((event as CustomEvent).detail);
    window.addEventListener("llv:open-accounts", listen);
    try {
      const host = mount("signed-out-draft");
      await settle();

      const blocked = host.querySelector('[data-testid="composer-send-blocked"]');
      expect(blocked?.textContent).toContain(locale === "en" ? "Main is signed out of Claude." : "Main: потрібен вхід у Claude.");
      const action = [...blocked!.querySelectorAll("button")].find((button) => button.textContent === (locale === "en" ? "Sign in to Claude first" : "Спершу увійдіть у Claude"));
      expect(action).toBeTruthy();

      /* Enter (the form submit) opens the sign-in too, and nothing is launched. */
      await launch(host, "Add a delete command");
      expect(posts).toEqual([]);
      expect(requests).toEqual([{ engine: "claude", accountId: "default" }]);
      flushSync(() => action!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
      expect(requests).toHaveLength(2);

      /* The sign-in lands; the next catalog read lifts the block. */
      signedIn = true;
      flushSync(() => window.dispatchEvent(new dom.Event("focus") as unknown as Event));
      await settle();
      expect(host.querySelector('[data-testid="composer-send-blocked"]')).toBeNull();
      await launch(host, "Add a delete command");
      expect(posts).toHaveLength(1);
      expect(posts[0]!.accountId).toBe("default");
    } finally {
      window.removeEventListener("llv:open-accounts", listen);
    }
  });
}

/** Every accessible name and visible line of the draft, its popover and its sheet that speaks of a conversation's next message. */
function nextMessageNames(): string[] {
  const names: string[] = [];
  for (const root of document.querySelectorAll("[data-draft-pane], [data-runtime-popover], [data-runtime-sheet]")) {
    for (const element of [root, ...root.querySelectorAll("*")]) {
      const name = element.getAttribute("aria-label");
      if (name) names.push(name);
    }
    names.push(root.textContent ?? "");
  }
  return names.filter((name) => /next message|наступне повідомлення/i.test(name));
}

for (const locale of ["en", "uk"] as const) {
  test(`a new agent's runtime control names what the launch starts with, never a next message (${locale})`, async () => {
    setLocale(locale);
    installFetch([]);
    const host = mount(`draft-names-${locale}`);
    await settle();
    expect(pill(host).getAttribute("aria-label")).toStartWith(locale === "en" ? "Model and reasoning the new agent starts with — " : "Модель і міркування, з якими стартує новий агент — ");
    expect(await openAccounts(host)).toEqual(["account-anna", "account-bob"]);
    expect(document.querySelector("[data-runtime-popover]")!.getAttribute("aria-label")).toBe(locale === "en" ? "Model and reasoning the new agent starts with" : "Модель і міркування, з якими стартує новий агент");
    expect(nextMessageNames()).toEqual([]);
  });

  test(`on the phone the new agent's sheet names its accounts by the launch, never a next message (${locale})`, async () => {
    setLocale(locale);
    installFetch([]);
    const desktop = dom.matchMedia;
    (dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
      matches: true, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    });
    try {
      const host = mount(`draft-sheet-names-${locale}`);
      await settle();
      click(pill(host));
      await settle();
      const rows = () => [...document.querySelectorAll("[data-runtime-sheet] [data-runtime-sheet-account]")].map((row) => [row.getAttribute("data-runtime-sheet-account"), row.getAttribute("aria-label")]);
      expect(rows()).toEqual(locale === "en"
        ? [["anna", "anna"], ["bob", "Start the agent on bob"], ["carol", "Sign in to carol — it takes no message until it returns"]]
        : [["anna", "anna"], ["bob", "Запустити агента на bob"], ["carol", "Увійти в carol — він не бере повідомлень, доки не повернеться"]]);
      expect(nextMessageNames()).toEqual([]);
    } finally {
      (dom as unknown as { matchMedia: unknown }).matchMedia = desktop;
    }
  });
}
