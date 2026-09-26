import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import { Window } from "happy-dom";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { structuredUserReference } from "@/lib/runtime/codexStructuredUserText";
import type { MessageSender } from "@/lib/team/contract";

import { FeedItem } from "./FeedItem";
import { MessageProvenanceProvider, provenanceLookupFor } from "./messageProvenance";
import type { Item } from "./parse";

/*
 * The sender line (sign-in-and-team §6.7): in a team, each human message
 * names who sent it, reached through the identity the feed already binds a
 * record to its submission with — the Claude ledger's submission id, the
 * Codex marker's delivery token. A message nobody can name draws no line at
 * all.
 */

const dom = new Window({ url: "http://127.0.0.1:8898/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  localStorage: dom.localStorage,
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
});

const MIRA: MessageSender = { memberId: "m_mira", name: "Mira Koval", color: "violet", initials: "MK" };
const OLEH: MessageSender = { memberId: "m_oleh", name: "Oleh", color: "teal", initials: "OL" };
const TS = "2026-09-26T10:00:00.000Z";

function render(node: ReactNode): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  flushSync(() => root!.render(node));
  return container as unknown as HTMLElement;
}

function senderOf(container: HTMLElement): { id: string | null; text: string } | null {
  const line = container.querySelector("[data-message-sender]");
  return line ? { id: line.getAttribute("data-message-sender"), text: line.textContent ?? "" } : null;
}

test("a delivered Claude message names its member through the ledger's submission id", () => {
  const item = { kind: "sysmsg", label: "system", text: "Review the auth seam again", deliveredMessage: { engineMessageId: "uuid-claude-1", ts: TS } } as Item;
  const lookup = provenanceLookupFor({
    messages: { "uuid-claude-1": { origin: "operator", submissionId: "sub-mira-1" } },
    senders: { "sub-mira-1": MIRA },
  }, [item]);
  const container = render(<MessageProvenanceProvider value={lookup}><FeedItem item={item} /></MessageProvenanceProvider>);
  expect(container.querySelector("[data-user-bubble]")?.textContent).toContain("Review the auth seam again");
  expect(senderOf(container)).toEqual({ id: "m_mira", text: "Mira Koval" });
  expect(container.querySelector("[data-member-avatar]")?.getAttribute("data-member-avatar")).toBe("violet");
});

test("a structured Codex message names its member through the marker's delivery token", () => {
  const token = crypto.createHash("sha256").update("operation-oleh-1").digest("hex");
  const item = { kind: "user", ts: TS, text: "Check the Host pin too", structuredUserRef: structuredUserReference(token, true) } as Item;
  const lookup = provenanceLookupFor({ submissions: { [token]: "sub-oleh-1" }, senders: { "sub-oleh-1": OLEH } }, [item]);
  const container = render(<MessageProvenanceProvider value={lookup}><FeedItem item={item} /></MessageProvenanceProvider>);
  expect(senderOf(container)).toEqual({ id: "m_oleh", text: "Oleh" });
});

test("a message nobody can name draws no sender line", () => {
  const item = { kind: "user", ts: TS, text: "sent before the team existed" } as Item;
  const lookup = provenanceLookupFor({ senders: { "sub-mira-1": MIRA } }, [item]);
  const container = render(<MessageProvenanceProvider value={lookup}><FeedItem item={item} /></MessageProvenanceProvider>);
  expect(container.querySelector("[data-user-bubble]")).not.toBeNull();
  expect(senderOf(container)).toBeNull();
  expect(container.textContent).not.toContain("Unknown");
});

test("an agent's relay keeps its internal card and names no person", () => {
  const item = { kind: "sysmsg", label: "system", text: "relayed findings", deliveredMessage: { engineMessageId: "uuid-agent-1", ts: TS } } as Item;
  const lookup = provenanceLookupFor({
    messages: { "uuid-agent-1": { origin: "agent", senderRole: "reviewer", submissionId: "sub-agent-1" } },
    senders: {},
  }, [item]);
  const container = render(<MessageProvenanceProvider value={lookup}><FeedItem item={item} /></MessageProvenanceProvider>);
  expect(container.textContent).toContain("reviewer");
  expect(senderOf(container)).toBeNull();
});
