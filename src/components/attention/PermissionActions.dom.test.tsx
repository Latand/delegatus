import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import type { FileEntry } from "@/lib/types";

import { AttentionCard } from "../runtime/AttentionCard";
import type { RuntimeAttention } from "../runtime/runtimeModel";
import { resetDismissalOverlayForTests, useDismissalOverlay } from "./dismissalOverlay";
import { PermissionActions } from "./PermissionActions";

/*
 * Allow once / Deny on a Needs-you row are drawn at once (audit B3): the row
 * and the count leave on the press, a refusal brings the row back with its
 * buttons and the reason, and a held request takes no second answer.
 */

const dom = new Window({ url: "http://localhost/" });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node,
  HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement, Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
});
dom.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof dom.matchMedia;

const roots: Root[] = [];
const realFetch = globalThis.fetch;
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  resetDismissalOverlayForTests();
  globalThis.fetch = realFetch;
  setLocale("en");
});

const file = (): FileEntry => ({
  path: "/projects/atlas/conversation.jsonl", conversationId: "conversation-1", mtime: 1_700_000_000,
  pendingPermission: { id: "request-1", tool: "Bash", command: "rm -rf .next", reason: null, reasonType: "safetyCheck", since: "2026-10-16T10:00:00.000Z" },
} as unknown as FileEntry);

/** The polled list as the Viewer reads it, a count beside the rows, and each row's controls. */
function Rows({ files }: { files: FileEntry[] }) {
  const { files: shown } = useDismissalOverlay(files, []);
  const asking = shown.filter((entry) => entry.pendingPermission);
  return <div><span data-count>{asking.length}</span>{asking.map((entry) => <div key={entry.path} data-row><PermissionActions file={entry} /></div>)}</div>;
}

type Held = { resolve: (response: Response) => void; reject: (error: Error) => void };
function holdFetch() {
  const calls: { url: string; body: unknown }[] = [];
  const held: Held[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "null")) });
    return new Promise<Response>((resolve, reject) => { held.push({ resolve, reject }); });
  }) as typeof fetch;
  return { calls, held };
}

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(node));
}
const count = () => document.querySelector("[data-count]")?.textContent;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

test("Allow once leaves the row and the count at once, while the request is still held, and sends once", async () => {
  const { calls, held } = holdFetch();
  const files = [file()];
  await mount(<Rows files={files} />);
  expect(count()).toBe("1");
  const allow = document.querySelector<HTMLButtonElement>("[data-permission-allow]")!;
  await act(async () => { allow.click(); allow.click(); });
  expect(count()).toBe("0");
  expect(document.querySelector("[data-permission-actions]")).toBeNull();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toMatchObject({ action: "permission", decision: "allow", requestId: "request-1", operationId: "permission:request-1:allow" });
  await act(async () => { held[0]!.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })); });
  await settle();
  expect(count()).toBe("0");
  expect(calls).toHaveLength(1);
});

test("a refused Deny brings the row back with both buttons and the reason in it", async () => {
  const { held } = holdFetch();
  await mount(<Rows files={[file()]} />);
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-permission-deny]")!.click(); });
  expect(count()).toBe("0");
  await act(async () => { held[0]!.resolve(new Response(JSON.stringify({ ok: false, error: "HOST_GONE" }), { status: 409 })); });
  await settle();
  expect(count()).toBe("1");
  const row = document.querySelector("[data-permission-actions]")!;
  expect(row.querySelector<HTMLButtonElement>("[data-permission-allow]")!.disabled).toBe(false);
  expect(row.querySelector<HTMLButtonElement>("[data-permission-deny]")!.disabled).toBe(false);
  expect(row.querySelector("[role=alert]")?.textContent).toBe(en["attention.permissionFailed"].replace("{error}", "HOST_GONE"));
});

test("a lost Allow brings the row back with the network's words", async () => {
  const { held } = holdFetch();
  await mount(<Rows files={[file()]} />);
  await act(async () => { document.querySelector<HTMLButtonElement>("[data-permission-allow]")!.click(); });
  await act(async () => { held[0]!.reject(new Error("network down")); });
  await settle();
  expect(count()).toBe("1");
  expect(document.querySelector("[data-permission-actions] [role=alert]")?.textContent).toContain("network down");
});

const approval = {
  id: "attention-1", kind: "permission", state: "open", unowned: false,
  request: { title: "Run a command", command: "rm -rf .next", protocol: { engine: "claude" } },
} as unknown as RuntimeAttention;

test("a conversation's attention card draws the given answer in place of its controls", async () => {
  await mount(<AttentionCard attention={approval} answered={en["runtime.attention.allowOnce"]} onApprove={() => undefined} onDeny={() => undefined} />);
  expect(document.querySelector("[data-attention-answered]")?.textContent).toBe(en["runtime.attention.answered"].replace("{answer}", en["runtime.attention.allowOnce"]));
  expect([...document.querySelectorAll("button")].map((button) => button.textContent?.trim())).not.toContain(en["runtime.attention.deny"]);
});
