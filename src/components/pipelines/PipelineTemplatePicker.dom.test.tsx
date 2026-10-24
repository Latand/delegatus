import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";
import { setLocale, translate } from "@/lib/i18n";

import { PipelineTemplatePicker } from "./PipelineTemplatePicker";
import type { PipelineClientResult, PipelineTemplate } from "./pipelineModel";

const dom = new Window({ url: "http://localhost" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage,
});

const realFetch = globalThis.fetch;
const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  localStorage.clear();
  globalThis.fetch = realFetch;
  setLocale("en");
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(node));
  return host;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
}

const pipeline = { id: "pipeline-1" } as Pipeline;

test("checks the selected directory before enabling templates and stays mounted through creation", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (url: string) => {
    requests.push(url);
    return new Response(JSON.stringify({ ok: true, repoDir: "/canonical/repo", gitCommonDir: "/canonical/repo/.git", worktreeParent: "/canonical" }));
  }) as unknown as typeof fetch;
  const created: Array<{ template: PipelineTemplate | null; repoDir: string }> = [];
  let completed: Pipeline | null = null;
  const host = mount(
    <PipelineTemplatePicker
      repoDir="/alias/repo"
      onCreate={async (template, repoDir) => {
        created.push({ template, repoDir });
        return { pipeline };
      }}
      onCreated={(value) => { completed = value; }}
      onClose={() => undefined}
    />,
  );

  const template = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Plan → Build → Review"))!;
  expect(template.disabled).toBe(true);
  expect(host.textContent).toContain("Checking repository");
  await settle();

  expect(requests).toEqual(["/api/pipelines/preflight"]);
  expect((host.querySelector("input") as HTMLInputElement).value).toBe("/canonical/repo");
  expect(template.disabled).toBe(false);
  expect(host.textContent).toContain("architect");
  expect(host.textContent).toContain("builder");
  expect(host.textContent).toContain("⟳ reviewer");

  flushSync(() => template.click());
  expect(host.querySelector("[data-pipeline-picker-state]")?.getAttribute("data-pipeline-picker-state")).toBe("creating");
  await settle();
  expect(created).toEqual([{ template: expect.objectContaining({ id: "planBuildReview" }), repoDir: "/canonical/repo" }]);
  expect(Boolean(completed)).toBe(true);
  expect((completed as Pipeline | null)?.id).toBe(pipeline.id);
});

test("an empty repository directory mounts blocked with a focused input and no phantom spinner", async () => {
  const requests: string[] = [];
  const resolvers = new Map<string, (response: Response) => void>();
  globalThis.fetch = ((_: string, init?: RequestInit) => {
    const repoDir = JSON.parse(String(init?.body)).repoDir as string;
    requests.push(repoDir);
    return new Promise<Response>((resolve) => resolvers.set(repoDir, resolve));
  }) as unknown as typeof fetch;
  const host = mount(
    <PipelineTemplatePicker repoDir="" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => undefined} />,
  );

  const picker = host.querySelector("[data-pipeline-picker-state]")!;
  expect(picker.getAttribute("data-pipeline-picker-state")).toBe("blocked");
  expect(host.textContent).not.toContain(translate("en", "pipelineTemplates.checking"));
  expect(host.querySelector(".animate-spin")).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(translate("en", "pipelinePreflight.empty"));

  const input = host.querySelector("input") as HTMLInputElement;
  expect(input.disabled).toBe(false);
  expect(document.activeElement).toBe(input);
  const template = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Plan → Build → Review"))!;
  expect(template.disabled).toBe(true);

  await settle();
  expect(picker.getAttribute("data-pipeline-picker-state")).toBe("blocked");
  expect(requests).toEqual([]);

  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(translate("en", "pipelineTemplates.retry")))!;
  flushSync(() => retry.click());
  await settle();
  expect(picker.getAttribute("data-pipeline-picker-state")).toBe("blocked");
  expect(host.querySelector(".animate-spin")).toBeNull();
  expect(requests).toEqual([]);

  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "/repo");
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  expect(picker.getAttribute("data-pipeline-picker-state")).toBe("checking");
  await settle();
  expect(host.querySelector(".animate-spin")).not.toBeNull();
  expect(requests).toEqual(["/repo"]);
  resolvers.get("/repo")!(new Response(JSON.stringify({ ok: true, repoDir: "/repo", gitCommonDir: "/repo/.git", worktreeParent: "/" })));
  await settle();
  expect(picker.getAttribute("data-pipeline-picker-state")).toBe("ready");
  expect(host.querySelector(".animate-spin")).toBeNull();
  expect(template.disabled).toBe(false);
});

test("mount-empty and typed-empty share the same Ukrainian copy", async () => {
  setLocale("uk");
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, repoDir: "/repo", gitCommonDir: "/repo/.git", worktreeParent: "/" }))) as unknown as typeof fetch;
  const emptyHost = mount(
    <PipelineTemplatePicker repoDir="" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => undefined} />,
  );
  const mountedCopy = emptyHost.querySelector('[role="alert"]')?.textContent;
  expect(mountedCopy).toContain(translate("uk", "pipelinePreflight.empty"));

  const typedHost = mount(
    <PipelineTemplatePicker repoDir="/repo" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => undefined} />,
  );
  await settle();
  const input = typedHost.querySelector("input") as HTMLInputElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "");
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await settle();
  expect(typedHost.querySelector('[role="alert"]')?.textContent).toBe(mountedCopy);
});

test("keeps a localized inline admission error and retries the current directory", async () => {
  setLocale("uk");
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    return attempts === 1
      ? new Response(JSON.stringify({ error: "directory does not exist: /missing", code: "missing", field: "repoDir", path: "/missing" }), { status: 400 })
      : new Response(JSON.stringify({ ok: true, repoDir: "/repo", gitCommonDir: "/repo/.git", worktreeParent: "/" }));
  }) as unknown as typeof fetch;
  const host = mount(
    <PipelineTemplatePicker repoDir="/missing" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => undefined} />,
  );
  await settle();

  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain(translate("uk", "pipelinePreflight.missing", { path: "/missing" }));
  expect(alert?.textContent).not.toContain("directory does not exist");
  const template = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(translate("uk", "pipelineTemplates.buildReview")))!;
  expect(template.disabled).toBe(true);

  const retry = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(translate("uk", "pipelineTemplates.retry")))!;
  flushSync(() => retry.click());
  await settle();
  expect(attempts).toBe(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(template.disabled).toBe(false);
});

test("localizes a coded create-time revalidation failure", async () => {
  setLocale("uk");
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, repoDir: "/repo", gitCommonDir: "/repo/.git", worktreeParent: "/" }))) as unknown as typeof fetch;
  const host = mount(
    <PipelineTemplatePicker
      repoDir="/repo"
      onCreate={async () => ({
        code: "git_metadata_unwritable",
        field: "repoDir",
        path: "/repo/.git",
        error: "Git metadata is not writable: /repo/.git",
      })}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  await settle();

  const blank = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(translate("uk", "pipelineTemplates.blank")))!;
  flushSync(() => blank.click());
  await settle();

  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain(translate("uk", "pipelinePreflight.git_metadata_unwritable", { path: "/repo/.git" }));
  expect(alert?.textContent).not.toContain("Git metadata is not writable");
});

test("a stale preflight response cannot replace a newer edited directory", async () => {
  const resolvers = new Map<string, (response: Response) => void>();
  globalThis.fetch = ((_: string, init?: RequestInit) => {
    const repoDir = JSON.parse(String(init?.body)).repoDir as string;
    return new Promise<Response>((resolve) => resolvers.set(repoDir, resolve));
  }) as unknown as typeof fetch;
  let created: PipelineClientResult | null = null;
  const host = mount(
    <PipelineTemplatePicker
      repoDir="/slow"
      onCreate={async (_template, repoDir) => { created = { path: repoDir }; return {}; }}
      onCreated={() => undefined}
      onClose={() => undefined}
    />,
  );
  await Promise.resolve();
  const input = host.querySelector("input") as HTMLInputElement;
  flushSync(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, "/fast");
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  await settle();

  resolvers.get("/fast")!(new Response(JSON.stringify({ ok: true, repoDir: "/canonical/fast", gitCommonDir: "/canonical/fast/.git", worktreeParent: "/canonical" })));
  await settle();
  resolvers.get("/slow")!(new Response(JSON.stringify({ error: "not git", code: "not_git", field: "repoDir", path: "/slow" }), { status: 400 }));
  await settle();

  expect(input.value).toBe("/canonical/fast");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  const blank = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Blank canvas"))!;
  flushSync(() => blank.click());
  await settle();
  expect(JSON.stringify(created)).toBe(JSON.stringify({ path: "/canonical/fast" }));
});

test("Escape and the close button both close while the picker is idle", async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, repoDir: "/repo", gitCommonDir: "/repo/.git", worktreeParent: "/" }))) as unknown as typeof fetch;
  let closed = 0;
  const host = mount(
    <PipelineTemplatePicker repoDir="/repo" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => { closed += 1; }} />,
  );
  await settle();
  const close = host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!;
  flushSync(() => close.click());
  flushSync(() => window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event));
  expect(closed).toBe(2);
});


test("initialization refusal keeps the server's concrete reason visible", async () => {
  const reason = "initialization refused for the Delegatus state directory";
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: reason, code: "initialization_refused", path: "/project" }), { status: 403 })) as unknown as typeof fetch;
  const host = mount(<PipelineTemplatePicker repoDir="/project" onCreate={async () => ({})} onCreated={() => undefined} onClose={() => undefined} />);
  await settle();
  expect(host.textContent).toContain(reason);
  expect(host.querySelector("[data-pipeline-picker-state]")?.getAttribute("data-pipeline-picker-state")).toBe("blocked");
});

/* A pasted PR or issue link (docs/research/competitors-2026-10.md rank 4). */
const PR_SOURCE = {
  kind: "pr", repository: "owner/project", number: 41, url: "https://github.com/owner/project/pull/41",
  title: "Teach the picker links", state: "open", base: { branch: "release" },
  head: { branch: "feature/links", sha: "a".repeat(40), repository: "contributor/project", remote: "contributor", fork: true, maintainerCanModify: false },
  tasks: [
    { id: "task-new", text: "Newest linked task", updatedAt: "2026-10-22T09:00:00Z" },
    { id: "task-old", text: "Older linked task", updatedAt: "2026-10-20T09:00:00Z" },
  ],
  request: { task: "PR #41: Teach the picker links", spec: "Source: https://github.com/owner/project/pull/41", baseBranch: "release",
    delivery: { branch: "refs/heads/feature/links", remote: "contributor", pr: 41, prRepository: "owner/project" } },
  attachLink: null,
};

function paste(input: HTMLInputElement, value: string): void {
  flushSync(() => {
    input.dispatchEvent(new dom.Event("paste", { bubbles: true }) as unknown as Event);
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
}

/** The link is read in a passive effect and a timer: wait for its state, bounded. */
async function linkState(host: HTMLElement, phase: string): Promise<Element> {
  for (let round = 0; round < 20; round += 1) {
    const found = host.querySelector(`[data-pipeline-link-state='${phase}']`);
    if (found) return found;
    await settle();
  }
  throw new Error(`link state ${phase} never rendered: ${host.querySelector("[data-pipeline-link-state]")?.getAttribute("data-pipeline-link-state") ?? "none"}`);
}

function linkFetch(answer: (link: string) => { status: number; body: unknown }, seen: Array<{ url: string; body: unknown }>, hold?: Promise<void>) {
  return (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, body });
    if (url === "/api/pipelines/preflight") return new Response(JSON.stringify({ ok: true, repoDir: "/canonical/repo", gitCommonDir: "/canonical/repo/.git", worktreeParent: "/canonical" }));
    await hold;
    const { status, body: json } = answer(body.link);
    return new Response(JSON.stringify(json), { status });
  }) as unknown as typeof fetch;
}

test("a pasted PR resolves against the admitted checkout, shows base, head and fork, and drafts on the chosen task", async () => {
  const seen: Array<{ url: string; body: unknown }> = [];
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = linkFetch(() => ({ status: 200, body: { ok: true, repoDir: "/canonical/repo", source: PR_SOURCE } }), seen, held);
  const created: unknown[][] = [];
  const host = mount(
    <PipelineTemplatePicker repoDir="/alias/repo" onCreate={async (...args) => { created.push(args); return { pipeline }; }} onCreated={() => undefined} onClose={() => undefined} />,
  );
  await settle();
  paste(host.querySelector<HTMLInputElement>("[data-pipeline-link-input]")!, "https://github.com/owner/project/pull/41");
  const blank = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Blank canvas"))!;
  /* While the link is read, no plain draft can be made by accident. */
  await linkState(host, "resolving");
  expect(blank.disabled).toBe(true);
  release();
  const preview = await linkState(host, "resolved");

  expect(seen.map((entry) => entry.url)).toEqual(["/api/pipelines/preflight", "/api/pipelines/source"]);
  expect(seen[1]!.body).toEqual({ link: "https://github.com/owner/project/pull/41", repoDir: "/canonical/repo" });
  expect(preview.textContent).toContain("PR #41");
  expect(preview.textContent).toContain("Teach the picker links");
  expect(preview.textContent).toContain("owner/project");
  expect(preview.textContent).toContain("release");
  expect(preview.textContent).toContain("feature/links · aaaaaaa");
  expect(host.querySelector("[data-pipeline-link-fork]")?.textContent).toBe("fork contributor/project · contributor");
  expect(host.querySelector("[data-pipeline-link-warning]")?.textContent).toContain("does not allow maintainer edits");
  const radios = [...host.querySelectorAll<HTMLInputElement>("[data-pipeline-link-task] input[type='radio']")];
  expect(radios.map((radio) => radio.value)).toEqual(["task-new", "task-old", ""]);
  expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
  expect(host.querySelector("[data-pipeline-link-task]")?.textContent).toContain("Older linked task");
  flushSync(() => radios[1]!.click());
  expect(radios.map((radio) => radio.checked)).toEqual([false, true, false]);
  expect(blank.disabled).toBe(false);
  flushSync(() => blank.click());
  await settle();
  expect(created).toEqual([[null, "/canonical/repo", { source: PR_SOURCE, taskId: "task-old" }]]);
});

test("a refused link keeps templates disabled with the reason in the operator's language, until the link is cleared", async () => {
  setLocale("uk");
  const seen: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = linkFetch(() => ({ status: 409, body: { ok: false, code: "merged", error: "PR #41 in owner/project is already merged", params: { repository: "owner/project", number: 41 } } }), seen);
  const created: unknown[][] = [];
  const host = mount(
    <PipelineTemplatePicker repoDir="/alias/repo" onCreate={async (...args) => { created.push(args); return { pipeline }; }} onCreated={() => undefined} onClose={() => undefined} />,
  );
  await settle();
  const input = host.querySelector<HTMLInputElement>("[data-pipeline-link-input]")!;
  paste(input, "https://github.com/owner/project/pull/41");
  const refusal = await linkState(host, "refused");
  expect(refusal.getAttribute("role")).toBe("alert");
  expect(refusal.textContent).toBe(translate("uk", "pipelineLink.refused.merged", { repository: "owner/project", number: 41 }));
  expect(refusal.textContent).toContain("уже злито");
  const blank = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(translate("uk", "pipelineTemplates.blank")))!;
  expect(blank.disabled).toBe(true);

  paste(input, "");
  for (let round = 0; round < 20 && host.querySelector("[data-pipeline-link-state]"); round += 1) await settle();
  expect(host.querySelector("[data-pipeline-link-state]")).toBeNull();
  expect(blank.disabled).toBe(false);
  flushSync(() => blank.click());
  await settle();
  /* Cleared: an ordinary draft, with no link source. */
  expect(created).toEqual([[null, "/canonical/repo"]]);
  expect(seen.filter((entry) => entry.url === "/api/pipelines/source")).toHaveLength(1);
});

test("an issue with no linked task says the draft gets its own task and a new branch", async () => {
  const issue = { ...PR_SOURCE, kind: "issue", number: 7, title: "Links should start work", head: null, tasks: [], attachLink: "owner/project#7",
    request: { task: "Issue #7: Links should start work", spec: "Source: x", baseBranch: "trunk" }, base: { branch: "trunk" } };
  globalThis.fetch = linkFetch(() => ({ status: 200, body: { ok: true, repoDir: "/canonical/repo", source: issue } }), []);
  const host = mount(<PipelineTemplatePicker repoDir="/alias/repo" onCreate={async () => ({ pipeline })} onCreated={() => undefined} onClose={() => undefined} />);
  await settle();
  paste(host.querySelector<HTMLInputElement>("[data-pipeline-link-input]")!, "https://github.com/owner/project/issues/7");
  const preview = await linkState(host, "resolved");
  expect(preview.getAttribute("data-pipeline-link-source")).toBe("issue");
  expect(preview.textContent).toContain("Issue #7");
  expect(preview.textContent).toContain("a new pipeline branch");
  expect(host.querySelector("[data-pipeline-link-task]")).toBeNull();
  expect(host.querySelector("[data-pipeline-link-no-task]")?.textContent).toContain("the draft gets its own task");
});

test("a late answer for an earlier link cannot replace the answer for the link now in the field", async () => {
  const pending = new Map<string, () => void>();
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url === "/api/pipelines/preflight") return new Response(JSON.stringify({ ok: true, repoDir: "/canonical/repo", gitCommonDir: "/canonical/repo/.git", worktreeParent: "/canonical" }));
    const { link } = JSON.parse(String(init?.body)) as { link: string };
    await new Promise<void>((resolve) => pending.set(link, resolve));
    const number = Number(link.split("/").at(-1));
    return new Response(JSON.stringify({ ok: true, repoDir: "/canonical/repo", source: { ...PR_SOURCE, number, title: `Title ${number}` } }));
  }) as unknown as typeof fetch;
  const host = mount(<PipelineTemplatePicker repoDir="/alias/repo" onCreate={async () => ({ pipeline })} onCreated={() => undefined} onClose={() => undefined} />);
  await settle();
  const input = host.querySelector<HTMLInputElement>("[data-pipeline-link-input]")!;
  paste(input, "https://github.com/owner/project/pull/1");
  for (let round = 0; round < 20 && !pending.has("https://github.com/owner/project/pull/1"); round += 1) await settle();
  paste(input, "https://github.com/owner/project/pull/2");
  for (let round = 0; round < 20 && !pending.has("https://github.com/owner/project/pull/2"); round += 1) await settle();
  pending.get("https://github.com/owner/project/pull/2")!();
  expect((await linkState(host, "resolved")).textContent).toContain("Title 2");
  pending.get("https://github.com/owner/project/pull/1")!();
  for (let round = 0; round < 5; round += 1) await settle();
  const shown = host.querySelector("[data-pipeline-link-state='resolved']")!.textContent;
  expect(shown).toContain("Title 2");
  expect(shown).not.toContain("Title 1");
});

test("an issue draft whose attach failed stays open with the reason, and Retry attaches to that same draft", async () => {
  setLocale("uk");
  const issue = { ...PR_SOURCE, kind: "issue", number: 7, title: "Links should start work", head: null, tasks: [], attachLink: "owner/project#7",
    request: { task: "Issue #7: Links should start work", spec: "Source: x", baseBranch: "trunk" }, base: { branch: "trunk" } };
  const patches: Array<{ url: string; body: unknown }> = [];
  const attachAnswers = [{ status: 503, body: { error: "the store is busy" } }, { status: 200, body: { pipeline } }];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === "/api/pipelines/preflight") return new Response(JSON.stringify({ ok: true, repoDir: "/canonical/repo", gitCommonDir: "/canonical/repo/.git", worktreeParent: "/canonical" }));
    if (url === "/api/pipelines/source") return new Response(JSON.stringify({ ok: true, repoDir: "/canonical/repo", source: issue }));
    patches.push({ url, body });
    const answer = attachAnswers.shift()!;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;
  const createCalls: unknown[][] = [];
  const createdDrafts: Pipeline[] = [];
  const host = mount(
    <PipelineTemplatePicker repoDir="/alias/repo"
      onCreate={async (...args) => { createCalls.push(args); return { pipeline, warning: "attach refused by the server" }; }}
      onCreated={(draft) => createdDrafts.push(draft)} onClose={() => undefined} />,
  );
  await settle();
  paste(host.querySelector<HTMLInputElement>("[data-pipeline-link-input]")!, "https://github.com/owner/project/issues/7");
  await linkState(host, "resolved");
  const blank = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(translate("uk", "pipelineTemplates.blank")))!;
  flushSync(() => blank.click());
  await settle();

  /* The draft exists: the picker stays open, names the failure, and cannot make a second draft. */
  const alert = () => host.querySelector("[data-pipeline-link-attach-failed]");
  expect(createCalls).toHaveLength(1);
  expect(createdDrafts).toEqual([]);
  expect(alert()?.getAttribute("role")).toBe("alert");
  expect(alert()?.textContent).toContain(translate("uk", "pipelineLink.attachFailed", { link: "owner/project#7", error: "attach refused by the server" }));
  expect(blank.disabled).toBe(true);
  expect(host.querySelector<HTMLInputElement>("[data-pipeline-link-input]")!.disabled).toBe(true);
  expect(host.querySelector("[data-pipeline-link-state='resolved']")).not.toBeNull();

  /* A failed retry shows the new reason and keeps the draft. */
  const retry = () => host.querySelector<HTMLButtonElement>("[data-pipeline-link-attach-retry]")!;
  flushSync(() => retry().click());
  for (let round = 0; round < 20 && !alert()?.textContent?.includes("the store is busy"); round += 1) await settle();
  expect(alert()?.textContent).toContain("the store is busy");
  expect(createdDrafts).toEqual([]);

  /* A successful retry attaches the issue to the same draft and hands it on once. */
  flushSync(() => retry().click());
  for (let round = 0; round < 20 && !createdDrafts.length; round += 1) await settle();
  expect(createdDrafts).toEqual([pipeline]);
  expect(createCalls).toHaveLength(1);
  expect(patches).toEqual([1, 2].map(() => ({ url: "/api/pipelines/pipeline-1", body: { action: "attach-link", link: "owner/project#7", kind: "issue" } })));
});

test("an issue draft whose attach failed can be opened without the link", async () => {
  const issue = { ...PR_SOURCE, kind: "issue", number: 7, head: null, tasks: [], attachLink: "owner/project#7",
    request: { task: "Issue #7", spec: "Source: x", baseBranch: "trunk" }, base: { branch: "trunk" } };
  globalThis.fetch = linkFetch(() => ({ status: 200, body: { ok: true, repoDir: "/canonical/repo", source: issue } }), []);
  const createdDrafts: Pipeline[] = [];
  const host = mount(<PipelineTemplatePicker repoDir="/alias/repo" onCreate={async () => ({ pipeline, warning: "offline" })} onCreated={(draft) => createdDrafts.push(draft)} onClose={() => undefined} />);
  await settle();
  paste(host.querySelector<HTMLInputElement>("[data-pipeline-link-input]")!, "https://github.com/owner/project/issues/7");
  await linkState(host, "resolved");
  flushSync(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Blank canvas"))!.click());
  for (let round = 0; round < 20 && !host.querySelector("[data-pipeline-link-attach-skip]"); round += 1) await settle();
  flushSync(() => host.querySelector<HTMLButtonElement>("[data-pipeline-link-attach-skip]")!.click());
  expect(createdDrafts).toEqual([pipeline]);
});

test("a same-repository PR whose origin pushes elsewhere shows where the lane pushes", async () => {
  const source = { ...PR_SOURCE, head: { ...PR_SOURCE.head, repository: "owner/project", remote: "https://github.com/owner/project.git", fork: false, maintainerCanModify: null } };
  globalThis.fetch = linkFetch(() => ({ status: 200, body: { ok: true, repoDir: "/canonical/repo", source } }), []);
  const host = mount(<PipelineTemplatePicker repoDir="/alias/repo" onCreate={async () => ({ pipeline })} onCreated={() => undefined} onClose={() => undefined} />);
  await settle();
  paste(host.querySelector<HTMLInputElement>("[data-pipeline-link-input]")!, "https://github.com/owner/project/pull/41");
  await linkState(host, "resolved");
  expect(host.querySelector("[data-pipeline-link-fork]")).toBeNull();
  expect(host.querySelector("[data-pipeline-link-push]")?.textContent).toBe("owner/project · https://github.com/owner/project.git");
});
