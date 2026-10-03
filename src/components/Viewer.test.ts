import { expect, test } from "bun:test";

import { filesApiUrl } from "@/hooks/useFiles";
import { parseConversationHash } from "@/lib/accounts/identity";
import type { FileEntry } from "@/lib/types";

import { OVERVIEW } from "./projectModel";
import { catalogHoldsWithoutPin, filesRequestPin, initialProjectFromState, recognizedFragment, reduceCatalogPin } from "./Viewer";

test("initialProjectFromState reads a direct project hash before polling", () => {
  expect(initialProjectFromState("#p=example-dispatcher", null)).toBe("example-dispatcher");
  expect(initialProjectFromState("#p=space%20project", null)).toBe("space project");
});

test("initialProjectFromState falls back to saved project only without a project hash", () => {
  expect(initialProjectFromState("", "CelestiaCompose")).toBe("CelestiaCompose");
  expect(initialProjectFromState("#f=/tmp/session.jsonl", "CelestiaCompose")).toBe("CelestiaCompose");
  expect(initialProjectFromState("", null)).toBe(OVERVIEW);
});

test("initialProjectFromState treats an artifact fragment like any non-project hash", () => {
  expect(initialProjectFromState("#a=%2Fcheckouts%2Ffigures%2Fdiagram.png", "CelestiaCompose")).toBe("CelestiaCompose");
});

test("recognizedFragment knows every fragment key the app speaks — and refuses everything else", () => {
  for (const known of [
    "",
    "#c=conversation-1",
    "#c=conversation-1#question",
    "#f=%2Fcheckouts%2Fsession.jsonl",
    "#p=My%20Project",
    "#a=%2Fcheckouts%2Ffigures%2Fdiagram.png",
  ]) {
    expect(recognizedFragment(known)).toBeTrue();
  }
  for (const unknown of ["#garbage", "#f=", "#a=", "#x=1", "#=value", "#question"]) {
    expect(recognizedFragment(unknown)).toBeFalse();
  }
});

test("a phone screen's own link is the phone's to open: the desktop still names it unknown (#2105)", () => {
  for (const screen of ["#task=t-1", "#pipeline=lane-1", "#pipelines", "#accounts"]) {
    expect(recognizedFragment(screen, { phone: true })).toBeTrue();
    expect(recognizedFragment(screen)).toBeFalse();
  }
  for (const unknown of ["#task=", "#pipeline=", "#pipelinesx", "#garbage"]) {
    expect(recognizedFragment(unknown, { phone: true })).toBeFalse();
  }
});

test("a resolved capped-out catalog open remains pinned after its hash intent clears", () => {
  const path = "/sessions/capped-out.jsonl";
  const pending = parseConversationHash(`#f=${encodeURIComponent(path)}`);

  expect(filesApiUrl(null, filesRequestPin(pending, path))).toBe(`/api/files?view=summary&path=${encodeURIComponent(path)}`);
  expect(filesApiUrl(null, filesRequestPin(null, path))).toBe(`/api/files?view=summary&path=${encodeURIComponent(path)}`);
});

test("a link the plain catalog resolves sends no pin; one it cannot resolve does", () => {
  const link = parseConversationHash("#c=conversation-1");
  /* The link was just read and the plain catalog has not been asked yet. */
  expect(filesApiUrl(null, filesRequestPin(link, null, false))).toBe("/api/files?view=summary");
  /* The plain catalog answered without it. */
  expect(filesApiUrl(null, filesRequestPin(link, null, true))).toBe("/api/files?view=summary&path=conversation-1");
  const byPath = parseConversationHash(`#f=${encodeURIComponent("/sessions/a.jsonl")}`);
  expect(filesApiUrl(null, filesRequestPin(byPath, null, false))).toBe("/api/files?view=summary");
  expect(filesApiUrl(null, filesRequestPin(byPath, null, true))).toBe(`/api/files?view=summary&path=${encodeURIComponent("/sessions/a.jsonl")}`);
});

test("an open conversation the plain catalog holds is not pinned", () => {
  const held = { path: "/sessions/held.jsonl", conversationId: "conversation-held" } as FileEntry;
  const archived = { ...held, path: "/sessions/old.jsonl", archived: true } as FileEntry;
  const unpinned = new Set([held.path, archived.path]);
  expect(catalogHoldsWithoutPin(held, unpinned)).toBeTrue();
  expect(catalogHoldsWithoutPin({ ...held, path: "/sessions/beyond-the-cap.jsonl" } as FileEntry, unpinned)).toBeFalse();

  let state = reduceCatalogPin(null, { kind: "resolve", path: held.path, conversationId: held.conversationId, unpinned: true });
  expect(state).toEqual({ path: held.path, hydrated: true, conversationId: "conversation-held", requested: false });
  /* What the catalog request names is what the pin asks for, nothing else. */
  expect(filesRequestPin(null, state?.requested ? state.path : null)).toBeNull();

  state = reduceCatalogPin(state, { kind: "files", paths: new Set([held.path]), pending: false });
  expect(state?.requested).toBeFalse();
});

test("a conversation that drops out of a confirmed catalog asks for itself once, then releases", () => {
  const path = "/sessions/aged-out.jsonl";
  let state = reduceCatalogPin(null, { kind: "resolve", path, conversationId: "conversation-aged", unpinned: true });
  state = reduceCatalogPin(state, { kind: "files", paths: new Set(["/sessions/other.jsonl"]), pending: false });
  expect(state).toEqual({ path, hydrated: true, conversationId: "conversation-aged", requested: true });
  expect(filesApiUrl(null, filesRequestPin(null, state?.requested ? state.path : null))).toBe(`/api/files?view=summary&path=${encodeURIComponent(path)}`);
  /* The pinned payload still lacks it: gone for good. */
  expect(reduceCatalogPin(state, { kind: "files", paths: new Set(["/sessions/other.jsonl"]), pending: false })).toBeNull();
  /* The pinned payload carries it: it stays. */
  expect(reduceCatalogPin(state, { kind: "files", paths: new Set([path]), pending: false })?.requested).toBeTrue();
});

test("catalog pin lifecycle releases on close and on disappearance after hydration", () => {
  const path = "/sessions/capped-out.jsonl";
  let state = reduceCatalogPin(null, { kind: "open", path });
  expect(state).toEqual({ path, hydrated: false, conversationId: null, requested: true });
  state = reduceCatalogPin(state, { kind: "resolve", path });
  expect(state).toEqual({ path, hydrated: true, conversationId: null, requested: true });
  expect(reduceCatalogPin(state, { kind: "release", path })).toBeNull();

  state = reduceCatalogPin(state, { kind: "files", paths: new Set(), pending: false });
  expect(state).toBeNull();
});

test("a migrated catalog pin follows the current generation and releases from its close action", () => {
  const predecessor = "/sessions/predecessor.jsonl";
  const successor = "/sessions/successor.jsonl";
  let state = reduceCatalogPin(null, { kind: "resolve", path: predecessor, conversationId: "conversation-1" });
  state = reduceCatalogPin(state, {
    kind: "files",
    paths: new Set([predecessor, successor]),
    pending: false,
    currentPath: successor,
  });

  expect(state).toEqual({ path: successor, hydrated: true, conversationId: "conversation-1", requested: true });
  expect(reduceCatalogPin(state, { kind: "release", path: successor })).toBeNull();
});

test("REGRESSION: the Viewer renders no operator ceremony — no gate, no paste field, no unlock", async () => {
  /* The screenshot the operator rejected: an "Operator key" affordance sitting in
     the shell, and a voice control that answered 403 until it was used. The gate
     component is gone; this reads the Viewer's own source so reintroducing any
     paste/unlock surface — under whatever name — fails here rather than on a
     screenshot two rounds later. */
  const source = await Bun.file(new URL("./Viewer.tsx", import.meta.url)).text();

  expect(source).not.toContain("OperatorKeyGate");
  expect(source).not.toContain("operatorHeaders");
  expect(source).not.toContain("hasOperatorCredential");
  for (const ceremony of ["operator.keyPrompt", "operator.keyApply", "type=\"password\""]) {
    expect(source).not.toContain(ceremony);
  }
  /* What stays: the eraser for what earlier rounds left in the profile. */
  expect(source).toContain("purgeLegacyOperatorCredential");
});

test("REGRESSION: no surface in the app asks for an operator key any more", async () => {
  /* The copy went with the component. A translation key that still exists is a
     surface waiting to be rendered. */
  for (const locale of ["en", "uk"]) {
    const source = await Bun.file(new URL(`../lib/i18n/${locale}.ts`, import.meta.url)).text();
    expect(source).not.toContain("operator.key");
  }
});
