import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { AttachTerminalDialog } from "./AttachTerminalDialog";

/* The Terminal dialog fetches the command that reopens the conversation. */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

const file: FileEntry = {
  path: "/c.jsonl", root: "claude-projects", name: "c.jsonl", project: "viewer", title: "c",
  engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
  activity: "live", proc: "running", pid: 12, model: "sonnet", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; document.body.replaceChildren(); });

async function mount(): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  // The dialog fetches its command on mount; settle that microtask inside act so
  // the loading→loaded update is flushed without an out-of-act warning.
  await act(async () => {
    root.render(<AttachTerminalDialog file={file} onClose={() => {}} />);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

test("the dialog requests the attach-command endpoint", async () => {
  const urls: string[] = [];
  globalThis.fetch = ((url: string) => {
    urls.push(String(url));
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ engine: "claude", accountId: "d", accountLabel: "D", cwd: "/x", command: "claude --resume 1", cdCommand: "cd '/x'", fullCommand: "cd '/x' && claude --resume 1" }) } as unknown as Response);
  }) as typeof fetch;

  const { root } = await mount();
  expect(urls.some((u) => u.includes("/api/attach-command"))).toBe(true);
  expect(urls).toHaveLength(1);
  await act(async () => root.unmount());
});
