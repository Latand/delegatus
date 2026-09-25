import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { FILES_CHANGED_EVENT } from "@/lib/filesEvents";

import { useProjectCuration, type UseProjectCuration } from "./useProjectCuration";

const dom = new Window({ url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
const overrides: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map<string, { present: boolean; value: unknown }>();

beforeAll(() => {
  for (const [key, value] of Object.entries(overrides)) {
    savedGlobals.set(key, { present: key in globals, value: globals[key] });
    globals[key] = value;
  }
});

afterAll(() => {
  for (const [key, saved] of savedGlobals) {
    if (saved.present) globals[key] = saved.value;
    else delete globals[key];
  }
  dom.close();
});

async function mountCuration(): Promise<{ curation: () => UseProjectCuration; unmount: () => void }> {
  let latest: UseProjectCuration | null = null;
  function Probe() {
    latest = useProjectCuration([], []);
    return null;
  }
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => { root.render(<Probe />); });
  return { curation: () => latest!, unmount: () => act(() => root.unmount()) };
}

/* #2167: "Create orchestrator" read the new project's folder from the files
   feed, which learned of the project only on its next poll, so a press right
   after "Create project" went out with no folder at all. */
test("a created project asks the files feed to refresh at once", async () => {
  const originalFetch = globalThis.fetch;
  let refreshes = 0;
  const onRefresh = () => { refreshes += 1; };
  dom.addEventListener(FILES_CHANGED_EVENT, onRefresh);
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true, project: "dir-atlas", displayName: "Atlas", root: "/work/atlas", createdAt: 1_700_000_000,
  }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const mounted = await mountCuration();
  try {
    let outcome: unknown = null;
    await act(async () => { outcome = await mounted.curation().createProject("Atlas", "/work/atlas"); });

    expect(outcome).toEqual({ ok: true, project: "dir-atlas", root: "/work/atlas" });
    expect(refreshes).toBe(1);
    expect(mounted.curation().createdCatalog).toEqual([expect.objectContaining({ project: "dir-atlas", projectRoot: "/work/atlas" })]);
  } finally {
    mounted.unmount();
    dom.removeEventListener(FILES_CHANGED_EVENT, onRefresh);
    globalThis.fetch = originalFetch;
  }
});

/* The guide's "Open another folder" reads the created folder from the outcome;
   an answer that names none leaves the key out rather than inventing one. */
test("a created project whose answer names no folder carries no root", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    ok: true, project: "dir-atlas", displayName: "Atlas", createdAt: 1_700_000_000,
  }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  const mounted = await mountCuration();
  try {
    let outcome: unknown = null;
    await act(async () => { outcome = await mounted.curation().createProject("Atlas", "/work/atlas"); });

    expect(outcome).toEqual({ ok: true, project: "dir-atlas" });
    expect(Object.hasOwn(outcome as object, "root")).toBe(false);
  } finally {
    mounted.unmount();
    globalThis.fetch = originalFetch;
  }
});

test("a refused create leaves the files feed alone", async () => {
  const originalFetch = globalThis.fetch;
  let refreshes = 0;
  const onRefresh = () => { refreshes += 1; };
  dom.addEventListener(FILES_CHANGED_EVENT, onRefresh);
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "DUPLICATE_PROJECT" }), { status: 409 })) as unknown as typeof fetch;
  const mounted = await mountCuration();
  try {
    let outcome: unknown = null;
    await act(async () => { outcome = await mounted.curation().createProject("Atlas", "/work/atlas"); });

    expect(outcome).toMatchObject({ ok: false, code: "DUPLICATE_PROJECT" });
    expect(refreshes).toBe(0);
  } finally {
    mounted.unmount();
    dom.removeEventListener(FILES_CHANGED_EVENT, onRefresh);
    globalThis.fetch = originalFetch;
  }
});
