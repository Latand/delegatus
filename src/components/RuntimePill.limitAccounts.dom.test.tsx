import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { setLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { RuntimePill } from "./RuntimePill";

/*
 * Mobile v2 lane 5 (#1439) — the «Next message» sheet at an account's limit
 * (README §4.2's limit row, §4.4, and the critique's P2-8 rule).
 *
 * With the account walled, offering only Model and Reasoning is offering
 * nothing: whatever the operator picks, the next message still cannot go. So
 * the sheet leads with an Account group, and the rule P2-8 is about is which
 * rows may become the launch target:
 *
 *   the blocked account  — inert, and it names its wall;
 *   an authenticated one — `ready`, one tap moves future launches there;
 *   one not signed in    — the device sign-in, and NOT a launch target, because
 *                          an account whose credentials have not come back
 *                          cannot take a message.
 */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent,
  PointerEvent: dom.MouseEvent,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: true,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/** Three invented Claude accounts: a ready one, the walled one, a signed-out
    one — deliberately NOT in the order the sheet must show them, so the row
    that names the wall having to come first is what the ordering asserts. */
const ACCOUNTS = [
  { id: "acct-two", label: "Account two", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
  { id: "acct-one", label: "Account one", kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null },
  { id: "acct-three", label: "Account three", kind: "managed", authPresent: false, authHealth: "signed_out", loginPending: false, loginState: "idle", deviceAuth: null },
];

const calls: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;

/** The account future launches use. A select moves it and the next read of the
    accounts payload answers with it, exactly as the server does — otherwise a
    refresh right after the tap puts the old answer back and the sheet's mark
    for it looks stuck. */
let active = "acct-one";

beforeEach(() => {
  setLocale("en");
  calls.length = 0;
  active = "acct-one";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "string" ? input : (input as URL).toString());
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url, body });
    if (url === "/api/accounts") {
      return new Response(JSON.stringify({ claude: { active, accounts: ACCOUNTS, migration: null, autoBalance: null } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/accounts/claude/active") && body?.mode === "select" && typeof body.id === "string") active = body.id;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

/** Resets at 16:40 local, expressed as the epoch the projection reads. */
function resetAt(): number {
  const at = new Date();
  at.setHours(16, 40, 0, 0);
  return Math.floor(at.getTime() / 1000);
}

const limitedFile: FileEntry = {
  path: "/claude-limit.jsonl", root: "claude-projects", name: "claude-limit.jsonl", project: "viewer",
  title: "Migrate accounts to the new binding", engine: "claude", kind: "session", fmt: "claude",
  parent: null, mtime: 1, size: 1, activity: "live", proc: "running", pid: 11,
  conversationId: "conversation_limit_1439", model: "opus", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
  rateLimit: { source: "account", accountId: "acct-one", window: "session", resetAt: resetAt() },
} as FileEntry;

async function openSheet(file: FileEntry = limitedFile): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<RuntimePill file={file} surface="live-root" />);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    (host.querySelector("[data-runtime-pill]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 5));
  });
  return { host, root };
}

/* The sheet is portalled to the document's body (#1795) — inside the phone's
   conversation pane an ancestor establishes a containing block and `fixed`
   was measured against the PANE — so its rows are looked for in the document
   rather than under the mount, exactly as the popover's are. */
const rows = () => [...document.querySelectorAll("[data-runtime-sheet-account]")] as HTMLButtonElement[];

test("the chip names the wall instead of a reasoning tier the next message cannot use", async () => {
  const { host, root } = await openSheet();
  const chip = host.querySelector("[data-runtime-pill]")!;
  expect(chip.textContent).toContain("acct-one at limit");
  expect(chip.querySelector("span")!.className).toContain("warning");
  await act(async () => root.unmount());
});

test("the sheet leads with the accounts, the blocked one first and naming its reset", async () => {
  const { root } = await openSheet();
  const listed = rows();
  expect(listed.map((row) => row.getAttribute("data-runtime-sheet-account"))).toEqual(["acct-one", "acct-two", "acct-three"]);
  expect(listed.map((row) => row.getAttribute("data-runtime-account-state")))
    .toEqual(["limit", "ready", "needs-sign-in"]);
  expect(listed[0]!.textContent).toContain("limit · resets 16:40");
  /* The wall is a fact, not an action. */
  expect(listed[0]!.disabled).toBe(true);
  /* And it comes BEFORE Model — reading order is the order of usefulness. */
  const groups = [...document.querySelectorAll("[data-runtime-sheet-accounts], [role=\"radiogroup\"]")];
  expect(groups[0]!.hasAttribute("data-runtime-sheet-accounts")).toBe(true);
  await act(async () => root.unmount());
});

test("an authenticated account is `ready`, and one tap moves the next launch there", async () => {
  const { root } = await openSheet();
  const ready = rows()[1]!;
  expect(ready.textContent).toContain("ready");
  expect(ready.disabled).toBe(false);
  await act(async () => {
    ready.click();
    await new Promise((r) => setTimeout(r, 5));
  });
  const select = calls.find((call) => call.url.endsWith("/api/accounts/claude/active"));
  expect(select).toBeTruthy();
  expect(select!.body).toMatchObject({ id: "acct-two", mode: "select" });
  await act(async () => root.unmount());
});

test("a signed-out account opens the device sign-in and never becomes the launch target", async () => {
  const { root } = await openSheet();
  const signedOut = rows()[2]!;
  expect(signedOut.textContent).toContain("sign in");
  expect(signedOut.getAttribute("aria-label")).toContain("takes no message until it returns");
  await act(async () => {
    signedOut.click();
    await new Promise((r) => setTimeout(r, 5));
  });
  /* The sign-in was started… */
  const login = calls.find((call) => (call.body as { action?: string } | null)?.action === "retry");
  expect(login).toBeTruthy();
  expect(login!.body).toMatchObject({ action: "retry", id: "acct-three" });
  /* …and no launch moved to it: P2-8, the whole point of the rule. */
  expect(calls.some((call) => call.url.endsWith("/api/accounts/claude/active"))).toBe(false);
  await act(async () => root.unmount());
});

/* #1795: the group is no longer the limit's own. The operator could not see
   which account a conversation was running on anywhere on the phone, and could
   not move the next message to another one unless the current one had already
   hit its wall — so the group leads every sheet, the conversation's own account
   is named and marked, and only the WORDING is the limit's. */
test("with no limit the account group is still there, naming the account the conversation runs on", async () => {
  const onAccountTwo = { ...limitedFile, path: "/accounts/claude/acct-two/projects/repo/session.jsonl", rateLimit: null } as FileEntry;
  const { host, root } = await openSheet(onAccountTwo);
  const group = document.querySelector("[data-runtime-sheet-accounts]");
  expect(group).not.toBeNull();
  /* It says which account this conversation runs on, in the group's own head… */
  expect(group!.querySelector("[data-runtime-sheet-account-current]")!.textContent).toContain("acct-two");
  /* …its row carries the same word, and the account the NEXT message will go
     to — a different fact, held by the accounts store — is the checked, inert
     one. Every other authenticated account is a one-tap select, this
     conversation's own included: moving back has to be reachable too. */
  const listed = rows();
  expect(listed.map((row) => row.getAttribute("data-runtime-sheet-account"))).toEqual(["acct-two", "acct-one", "acct-three"]);
  expect(listed.map((row) => row.getAttribute("data-runtime-account-state")))
    .toEqual(["current", "ready", "needs-sign-in"]);
  expect(listed.map((row) => row.getAttribute("data-runtime-account-next"))).toEqual([null, "true", null]);
  expect(listed[0]!.textContent).toContain("current");
  expect(listed[0]!.disabled).toBe(false);
  expect(listed[1]!.textContent).toContain("next message");
  expect(listed[1]!.disabled).toBe(true);
  /* And the chip is the ordinary model · reasoning face, unchanged. */
  expect(host.querySelector("[data-runtime-pill]")!.textContent).toContain("· high");
  await act(async () => root.unmount());
});

test("tapping another authenticated account with no limit sends the same select the accounts screen sends", async () => {
  /* Running on the account the engine is launching from, so the tap is a real
     move rather than a re-pick of what the store already holds. */
  const onAccountOne = { ...limitedFile, path: "/accounts/claude/acct-one/projects/repo/session.jsonl", rateLimit: null } as FileEntry;
  const { root } = await openSheet(onAccountOne);
  const ready = rows().find((row) => row.getAttribute("data-runtime-sheet-account") === "acct-two")!;
  expect(ready.getAttribute("data-runtime-account-state")).toBe("ready");
  await act(async () => {
    ready.click();
    await new Promise((r) => setTimeout(r, 5));
  });
  const select = calls.find((call) => call.url.endsWith("/api/accounts/claude/active"));
  expect(select).toBeTruthy();
  expect(select!.body).toMatchObject({ id: "acct-two", mode: "select" });
  /* And the tap SHOWS: the mark for where the next message goes moves onto the
     row that was tapped, and that row stops offering a second identical tap
     (#1795 critique P1 — one select left, and nothing on screen changed). */
  const after = rows();
  expect(after.find((row) => row.getAttribute("data-runtime-sheet-account") === "acct-two")!.getAttribute("data-runtime-account-next")).toBe("true");
  expect(after.find((row) => row.getAttribute("data-runtime-sheet-account") === "acct-one")!.getAttribute("data-runtime-account-next")).toBeNull();
  expect(after.find((row) => row.getAttribute("data-runtime-sheet-account") === "acct-two")!.disabled).toBe(true);
  /* The conversation still runs where it always ran: that mark does not move. */
  expect(after.find((row) => row.getAttribute("data-runtime-sheet-account") === "acct-one")!.textContent).toContain("current");
  await act(async () => root.unmount());
});

test("the sheet is mounted under the document body, not inside the pane that hosts the pill", async () => {
  /* A pane with its own containing block — a transform is one — is exactly
     what clipped the sheet on the phone (#1795). The portal is what keeps the
     sheet measured against the viewport, so this pins where it mounts. */
  const pane = document.createElement("div");
  pane.style.transform = "translateZ(0)";
  document.body.append(pane);
  const host = document.createElement("div");
  pane.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<RuntimePill file={limitedFile} surface="live-root" />);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    (host.querySelector("[data-runtime-pill]") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 5));
  });
  const sheet = document.querySelector("[data-runtime-sheet]")!;
  expect(sheet).not.toBeNull();
  /* Its backdrop is a direct child of the body: nothing between it and the
     viewport can clip it. */
  expect(sheet.parentElement!.parentElement).toBe(document.body as unknown as HTMLElement);
  expect(pane.contains(sheet as unknown as Node)).toBe(false);
  /* And the way out is visible: a close control that is not the backdrop. */
  const close = sheet.querySelector("[data-runtime-sheet-close]") as HTMLButtonElement;
  expect(close).not.toBeNull();
  expect(close.getAttribute("aria-label")).toBe("Close");
  await act(async () => {
    close.click();
    await new Promise((r) => setTimeout(r, 5));
  });
  expect(document.querySelector("[data-runtime-sheet]")).toBeNull();
  await act(async () => root.unmount());
});
