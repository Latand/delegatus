import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { FILES_CHANGED_EVENT } from "@/lib/filesEvents";

import { DraftAgentPane, setDraftBand, setDraftCwd, setDraftSrc } from "./DraftAgentPane";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
});

const realFetch = globalThis.fetch;
const implementer = {
  path: "/sessions/implementer.jsonl",
  root: "codex-sessions",
  name: "implementer.jsonl",
  project: "proj",
  title: "Implement durable membership",
  engine: "codex",
  kind: "session",
  fmt: "codex",
  parent: null,
  mtime: 1,
  size: 1,
  activity: "idle",
  proc: null,
  pid: null,
  model: null,
  pendingQuestion: null,
  waitingInput: null,
  conversationId: "conversation_019f4906-3f67-7b72-9fbc-9ec3b5ad1325",
} satisfies FileEntry;
const childImplementer = {
  ...implementer,
  path: "/sessions/child-implementer.jsonl",
  name: "child-implementer.jsonl",
  title: "Implement child task",
  parent: implementer.path,
  conversationId: "conversation_019f4906-3f67-7b72-9fbc-9ec3b5ad1326",
} satisfies FileEntry;

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  sessionStorage.clear();
  setLocale("en");
  globalThis.fetch = realFetch;
});

const imageCapability = (supported: boolean, overrides: Record<string, unknown> = {}) => ({
  supported,
  reason: supported ? null : "Unavailable",
  formats: ["image/png"],
  maxImages: 2,
  maxRawBytesPerImage: 3,
  maxEncodedBytesPerRequest: 8,
  ...overrides,
});

const imageNegotiation = (spawnTransport: "tmux" | "structured") => ({
  dirs: ["/repo"],
  cwd: "/repo",
  cwdExists: true,
  spawnTransport,
  imageInput: {
    claude: imageCapability(true),
    codex: imageCapability(true),
  },
});

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const click = (element: Element) => flushSync(() => element.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
const type = (host: HTMLElement, value: string) => {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value } }));
};
const submit = (host: HTMLElement) => flushSync(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
/** A launch seam that never starts an agent: it keeps what each launch asked for and answers a receipt. */
function launchSeam(posts: Record<string, unknown>[], negotiation: Record<string, unknown> = imageNegotiation("structured")) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/spawn" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return { ok: true, status: 202, json: async () => ({ ok: true, state: "starting", launched: false, path: null, launchId: "launch-seam", conversationId: "conversation_seam" }) } as Response;
    }
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => negotiation } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}
function mount(draftId: string, files: FileEntry[] = [], onClose: () => void = () => {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<DraftAgentPane draftId={draftId} project="proj" files={files} onClose={onClose} onSpawned={() => {}} />));
  return host;
}

function auxiliaryResponse(url: string): Response | null {
  if (url === "/api/accounts") return { ok: true, json: async () => ({ codex: { active: "terra", accounts: [] } }) } as Response;
  if (url === "/api/roles") return { ok: false, json: async () => ({}) } as Response;
  return null;
}

test("image capability failure renders localized recovery and retry restores tmux attachments", async () => {
  setLocale("uk");
  let requests = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url.startsWith("/api/spawn?")) {
      requests += 1;
      if (requests === 1) return { ok: false, json: async () => ({}) } as Response;
      return { ok: true, json: async () => imageNegotiation("tmux") } as Response;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<DraftAgentPane draftId="image-retry-tmux" project="proj" files={[]} onClose={() => {}} onSpawned={() => {}} />));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(host.textContent).toContain("Не вдалося завантажити дані про підтримку зображень.");
  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Повторити перевірку")) as HTMLButtonElement;
  expect(retry).toBeTruthy();
  expect((host.querySelector('button[aria-label="Додати картинки до промпта"]') as HTMLButtonElement).disabled).toBe(true);
  flushSync(() => retry.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(requests).toBe(2);
  expect((host.querySelector('button[aria-label="Додати картинки до промпта"]') as HTMLButtonElement).disabled).toBe(false);
});

test("malformed capability retry adopts structured image limits, and the pill's model list moves the draft to another engine", async () => {
  let requests = 0;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    const auxiliary = auxiliaryResponse(url);
    if (auxiliary) return auxiliary;
    if (url.startsWith("/api/spawn?")) {
      requests += 1;
      if (requests === 1) return { ok: true, json: async () => ({ dirs: ["/repo"], spawnTransport: "structured", imageInput: { claude: { supported: true } } }) } as Response;
      return { ok: true, json: async () => imageNegotiation("structured") } as Response;
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
  const host = mount("image-retry-structured");
  await settle();

  const retry = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Retry image check")) as HTMLButtonElement;
  expect(retry).toBeTruthy();
  click(retry);
  await settle();
  expect((host.querySelector('button[aria-label="Add images to the prompt"]') as HTMLButtonElement).disabled).toBe(false);

  const textarea = host.querySelector("textarea")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
  flushSync(() => props.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => ({ name: "large.png", type: "image/png", size: 4 }) }] },
    preventDefault() {},
  }));
  expect(host.textContent).toContain("Image exceeds this host's");

  /* The engine is chosen with the model, in the runtime pill's own list. */
  click(host.querySelector("[data-runtime-pill]")!);
  click(document.querySelector('[data-runtime-popover] [data-runtime-value="model"]')!);
  click(document.querySelector('[data-runtime-popover] [data-runtime-value="codex/gpt-6-astra"]')!);
  await settle();
  expect(host.querySelector("[data-runtime-pill]")!.textContent).toContain("Codex · 6-Astra");
  expect(sessionStorage.getItem("llvDraftPane:image-retry-structured:engine")).toBe("codex");
  expect((host.querySelector('button[aria-label="Add images to the prompt"]') as HTMLButtonElement).disabled).toBe(false);
});

test("the form is the composer alone: no role, directory, select or radio, and the cursor is in the field", async () => {
  launchSeam([]);
  setDraftCwd("plain-draft", "/repo");
  const host = mount("plain-draft", [implementer]);
  await settle();

  expect(host.querySelectorAll("textarea")).toHaveLength(1);
  expect(host.querySelectorAll("[data-runtime-pill]")).toHaveLength(1);
  expect(host.querySelectorAll('button[aria-label="Launch the agent"]')).toHaveLength(1);
  expect(host.querySelectorAll('select, [role="radio"], [role="radiogroup"], details, input:not([type="file"])')).toHaveLength(0);
  expect(host.querySelector("[data-directory-trigger]")).toBeNull();
  expect(host.textContent).not.toContain("/repo");
  /* A launch carries images and no other file, so the picker is the image one. */
  expect(host.querySelector('input[type="file"]')!.getAttribute("accept")).toBe("image/*");
  expect(document.activeElement).toBe(host.querySelector("textarea"));
  /* With no tier chosen the face says the engine's default; none is sent. */
  expect(host.querySelector("[data-runtime-pill]")!.textContent).toContain("Claude · Opus 5.5 · Default");
});

test("Send launches at once in the directory the draft was opened with, with what the pill shows and no role", async () => {
  const posts: Record<string, unknown>[] = [];
  launchSeam(posts);
  let filesRefreshes = 0;
  const onFilesChanged = () => { filesRefreshes += 1; };
  window.addEventListener(FILES_CHANGED_EVENT, onFilesChanged);
  setDraftCwd("launch-draft", "/repos/atlas");
  setDraftBand("launch-draft", "task:task-7");
  const host = mount("launch-draft");
  await settle();

  click(host.querySelector("[data-runtime-pill]")!);
  click(document.querySelector('[data-runtime-popover] [data-runtime-value="tier-high"]')!);
  expect(host.querySelector("[data-runtime-pill]")!.textContent).toContain("Claude · Opus 5.5 · High");
  type(host, "Compare the two export screens");
  submit(host);
  await settle();

  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ engine: "claude", model: "opus", effort: "high", cwd: "/repos/atlas", taskId: "task-7", prompt: "Compare the two export screens" });
  /* The receipt names the launch and its conversation, so the board reads its files again at once. */
  expect(filesRefreshes).toBe(1);
  window.removeEventListener(FILES_CHANGED_EVENT, onFilesChanged);
  for (const dropped of ["role", "roleParams", "reviews", "confirm"]) expect(posts[0]).not.toHaveProperty(dropped);
  /* From the press the pane is the conversation: the first message as a row above the loading shape, and
     no sentence about the launch while all is well. */
  const opening = host.querySelector("[data-draft-opening]")!;
  expect(opening.querySelector("[data-message-row]")!.textContent).toContain("Compare the two export screens");
  expect(opening.querySelectorAll('[data-skeleton="feed"]')).toHaveLength(1);
  expect(host.textContent).not.toContain("waiting for the conversation");
  expect(host.textContent).not.toContain("confirming the agent");
});

test("a handoff carries its source and its parent into the launch, and no field comes back for them", async () => {
  const posts: Record<string, unknown>[] = [];
  launchSeam(posts, { ...imageNegotiation("structured"), cwd: "/repos/source-checkout" });
  setDraftSrc("handoff-draft", implementer.path, implementer.conversationId);
  setDraftCwd("handoff-draft", "/repos/guess");
  const host = mount("handoff-draft", [implementer]);
  await settle();

  /* The source rides in the first message, which is what the new agent reads, and the draft starts on its engine. */
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toContain(implementer.path);
  expect(host.querySelector("[data-runtime-pill]")!.textContent).toContain("Codex");
  expect(host.querySelectorAll('select, [role="radio"], input:not([type="file"])')).toHaveLength(0);
  submit(host);
  await settle();

  expect(posts).toHaveLength(1);
  /* The source's own directory, answered by the server, replaces the board's guess. */
  expect(posts[0]).toMatchObject({ engine: "codex", src: implementer.path, parentConversationId: implementer.conversationId, cwd: "/repos/source-checkout" });
});

test("a draft whose project folder is not known refuses the launch in words and asks for no path", async () => {
  const posts: Record<string, unknown>[] = [];
  /* The suggestions name directories, as the server does when it knows none for the project. */
  launchSeam(posts, { ...imageNegotiation("structured"), dirs: ["/home/someone"], cwd: null });
  /* `/` is what the board seeds while the project's folder is unresolved. */
  setDraftCwd("lost-draft", "/");
  const host = mount("lost-draft");
  await settle();

  const blocked = host.querySelector('[data-testid="composer-send-blocked"]')!;
  expect(blocked.textContent).toContain("This project's folder is not known yet");
  expect((host.querySelector('button[aria-label^="This project\'s folder"]') as HTMLButtonElement).disabled).toBe(true);
  expect(host.querySelectorAll('input:not([type="file"]), select')).toHaveLength(0);
  type(host, "Start anyway");
  submit(host);
  await settle();
  expect(posts).toHaveLength(0);
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Start anyway");

  /* The board finds the folder: the same draft launches there. */
  const { resolveSystemDraftCwd } = await import("./DraftAgentPane");
  flushSync(() => { resolveSystemDraftCwd("lost-draft", "/repos/found"); });
  expect(host.querySelector('[data-testid="composer-send-blocked"]')).toBeNull();
  submit(host);
  await settle();
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ cwd: "/repos/found" });
});

test("Escape in the empty field puts the draft away; with a prompt typed it does not", async () => {
  launchSeam([]);
  setDraftCwd("escape-draft", "/repo");
  let closed = 0;
  const host = mount("escape-draft", [], () => { closed += 1; });
  await settle();
  const escape = () => flushSync(() => host.querySelector("textarea")!.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event));

  type(host, "half a thought");
  escape();
  expect(closed).toBe(0);
  type(host, "");
  escape();
  expect(closed).toBe(1);
});

test("an admitted structured spawn adopts its provisional card in the same mount", async () => {
  const posts: Record<string, unknown>[] = [];
  const spawned: FileEntry[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/spawn" && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return {
        ok: true,
        status: 202,
        json: async () => ({
          ok: true,
          state: "starting",
          launched: false,
          path: null,
          launchId: "launch-fast",
          conversationId: "conversation_fast",
          initialMessage: "pending",
        }),
      } as Response;
    }
    if (url.startsWith("/api/spawn?")) return { ok: true, json: async () => ({ dirs: ["/repo"] }) } as Response;
    if (url === "/api/accounts") return { ok: true, json: async () => ({ codex: { active: "terra", accounts: [] } }) } as Response;
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  setDraftCwd("fast-draft", "/repo");
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (files: FileEntry[]) => flushSync(() => root!.render(
    <DraftAgentPane
      draftId="fast-draft"
      project="proj"
      files={files}
      onClose={() => {}}
      onSpawned={(file) => spawned.push(file)}
    />,
  ));
  render([]);
  await settle();

  type(host, "Start immediately");
  submit(host);
  await settle();

  expect(posts).toHaveLength(1);
  const provisional = {
    ...implementer,
    path: "spawn:launch-fast",
    name: "spawn:launch-fast",
    title: "Codex",
    conversationId: "conversation_fast",
    spawn: {
      launchId: "launch-fast",
      clientAttemptId: null,
      accountId: "terra",
      state: "starting",
      initialMessage: "pending",
      retrySafe: false,
      error: null,
    },
  } satisfies FileEntry;
  render([provisional]);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(spawned).toEqual([provisional]);
  expect(posts).toHaveLength(1);
});
