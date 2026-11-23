import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale } from "@/lib/i18n";
import { PipelineStageRuntimeRow } from "./PipelineStageRuntimeRow";

const dom = new Window({ url: "http://localhost/" });
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event });
const realFetch = globalThis.fetch;
let root: Root;
let host: HTMLDivElement;
afterEach(async () => { if (root) await act(async () => root.unmount()); host?.remove(); globalThis.fetch = realFetch; });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function mount(variant: "menu" | "sheet") {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<PipelineStageRuntimeRow project="repo-runtime" variant={variant} />));
  return host.querySelector("select")!;
}
async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => { select.value = value; select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event); });
}

for (const [locale, variant] of [["en", "menu"], ["uk", "sheet"]] as const) {
  test(`${variant} reads, changes optimistically and rolls back with an error (${locale})`, async () => {
    setLocale(locale);
    let reply!: (value: Response) => void;
    const writes: unknown[] = [];
    globalThis.fetch = (async (_url, init) => {
      if (!init?.method) return json({ pipelineStageRuntime: "local" });
      writes.push(JSON.parse(init.body as string));
      return new Promise<Response>(resolve => { reply = resolve; });
    }) as typeof fetch;
    const select = await mount(variant);
    expect(select.value).toBe("local");
    await choose(select, "codex-cloud");
    expect(select.value).toBe("codex-cloud");
    expect(writes).toEqual([{ project: "repo-runtime", pipelineStageRuntime: "codex-cloud" }]);
    await act(async () => reply(json({ error: "unavailable" }, 500)));
    expect(select.value).toBe("local");
    expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    await choose(select, "codex-cloud");
    await act(async () => reply(json({ pipelineStageRuntime: "codex-cloud" })));
    expect(select.value).toBe("codex-cloud");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
}

test("rapid selections serialize writes and a failed later choice returns to the confirmed runtime", async () => {
  const replies: ((value: Response) => void)[] = [];
  globalThis.fetch = (async (_url, init) => !init?.method ? json({ pipelineStageRuntime: "local" }) : new Promise<Response>(resolve => replies.push(resolve))) as typeof fetch;
  const select = await mount("menu");
  await choose(select, "codex-cloud");
  await choose(select, "local");
  expect(select.value).toBe("local"); expect(replies).toHaveLength(1);
  await act(async () => replies[0]!(json({ pipelineStageRuntime: "codex-cloud" })));
  expect(replies).toHaveLength(2);
  await act(async () => replies[1]!(json({}, 403)));
  expect(select.value).toBe("codex-cloud");
  expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
});

for (const variant of ["menu", "sheet"] as const) {
  test(`a successful last queued selection clears the earlier failure (${variant})`, async () => {
    const replies: ((value: Response) => void)[] = [];
    const writes: unknown[] = [];
    globalThis.fetch = (async (_url, init) => {
      if (!init?.method) return json({ pipelineStageRuntime: "local" });
      writes.push(JSON.parse(init.body as string));
      return new Promise<Response>(resolve => replies.push(resolve));
    }) as typeof fetch;
    const select = await mount(variant);
    await choose(select, "codex-cloud");
    await choose(select, "local");
    expect(select.value).toBe("local");
    expect(replies).toHaveLength(1);
    await act(async () => replies[0]!(json({}, 500)));
    expect(select.value).toBe("local");
    expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(replies).toHaveLength(2);
    await act(async () => replies[1]!(json({ pipelineStageRuntime: "local" })));
    expect(writes).toEqual([
      { project: "repo-runtime", pipelineStageRuntime: "codex-cloud" },
      { project: "repo-runtime", pipelineStageRuntime: "local" },
    ]);
    expect(select.value).toBe("local");
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
}

test("a failed read leaves the selector disabled and offers a retry", async () => {
  globalThis.fetch = (async () => json({}, 503)) as unknown as typeof fetch;
  const select = await mount("sheet");
  expect(select.disabled).toBe(true);
  globalThis.fetch = (async () => json({ pipelineStageRuntime: "codex-cloud" })) as unknown as typeof fetch;
  await act(async () => host.querySelector("button")!.click());
  expect(select.disabled).toBe(false); expect(select.value).toBe("codex-cloud");
});

test("a late reply from the previous project cannot change the new project's selector", async () => {
  let finish!: (value: Response) => void;
  globalThis.fetch = (async (_url, init) => !init?.method ? json({ pipelineStageRuntime: "local" }) : new Promise<Response>(resolve => { finish = resolve; })) as typeof fetch;
  const select = await mount("menu");
  await choose(select, "codex-cloud");
  await act(async () => root.render(<PipelineStageRuntimeRow project="repo-other" variant="menu" />));
  const nextSelect = host.querySelector("select")!;
  expect(nextSelect.value).toBe("local");
  await act(async () => finish(json({}, 500)));
  expect(nextSelect.value).toBe("local");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("closing the menu keeps every accepted selection queued for its original project", async () => {
  const replies: ((value: Response) => void)[] = [];
  const writes: unknown[] = [];
  globalThis.fetch = (async (_url, init) => {
    if (!init?.method) return json({ pipelineStageRuntime: "local" });
    writes.push(JSON.parse(init.body as string));
    return new Promise<Response>(resolve => replies.push(resolve));
  }) as typeof fetch;
  const select = await mount("menu");
  await choose(select, "codex-cloud");
  await choose(select, "local");
  await act(async () => root.render(<div />));
  await act(async () => replies[0]!(json({ pipelineStageRuntime: "codex-cloud" })));
  expect(replies).toHaveLength(2);
  await act(async () => replies[1]!(json({ pipelineStageRuntime: "local" })));
  expect(writes).toEqual([
    { project: "repo-runtime", pipelineStageRuntime: "codex-cloud" },
    { project: "repo-runtime", pipelineStageRuntime: "local" },
  ]);
});

test("reopening the same project serializes new choices behind the closed menu's queue", async () => {
  let stored = "local";
  const replies: { runtime: string; finish: (value: Response) => void }[] = [];
  globalThis.fetch = (async (_url, init) => {
    if (!init?.method) return json({ pipelineStageRuntime: stored });
    const runtime = JSON.parse(init.body as string).pipelineStageRuntime;
    return new Promise<Response>(finish => replies.push({ runtime, finish }));
  }) as typeof fetch;
  let released = 0;
  const finish = async () => {
    const reply = replies[released++]!;
    stored = reply.runtime;
    await act(async () => reply.finish(json({ pipelineStageRuntime: stored })));
  };
  try {
    const select = await mount("menu");
    await choose(select, "codex-cloud");
    await choose(select, "local");
    await act(async () => root.render(<div />));
    await act(async () => root.render(<PipelineStageRuntimeRow project="repo-runtime" variant="menu" />));
    const reopened = host.querySelector("select")!;
    await choose(reopened, "codex-cloud");
    expect(replies).toHaveLength(1);
    await finish();
    expect(reopened.value).toBe("codex-cloud");
    await finish();
    expect(reopened.value).toBe("codex-cloud");
    await finish();
    expect(replies.map(reply => reply.runtime)).toEqual(["codex-cloud", "local", "codex-cloud"]);
    expect(reopened.value).toBe(stored);
  } finally {
    while (released < replies.length) await finish();
  }
});

test("a reopened idle menu reads external changes after its previous writes settle", async () => {
  let stored = "local", reads = 0;
  globalThis.fetch = (async (_url, init) => {
    if (init?.method) stored = JSON.parse(init.body as string).pipelineStageRuntime;
    else reads++;
    return json({ pipelineStageRuntime: stored });
  }) as typeof fetch;
  const select = await mount("menu");
  await choose(select, "codex-cloud");
  await act(async () => root.render(<div />));
  stored = "local";
  await act(async () => root.render(<PipelineStageRuntimeRow project="repo-runtime" variant="menu" />));
  expect(host.querySelector("select")!.value).toBe("local");
  expect(reads).toBe(2);
});

test("a read from a closed menu cannot replace a reopened menu's newer read", async () => {
  const reads: ((value: Response) => void)[] = [];
  globalThis.fetch = (() => new Promise<Response>(resolve => reads.push(resolve))) as unknown as typeof fetch;
  await mount("menu");
  await act(async () => root.render(<div />));
  await act(async () => root.render(<PipelineStageRuntimeRow project="repo-runtime" variant="menu" />));
  await act(async () => reads[1]!(json({ pipelineStageRuntime: "codex-cloud" })));
  await act(async () => reads[0]!(json({ pipelineStageRuntime: "local" })));
  expect(host.querySelector("select")!.value).toBe("codex-cloud");
});
