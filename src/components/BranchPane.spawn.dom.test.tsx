import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-launch-card-"));
process.env.LLV_STATE_DIR = sandbox;
const dom = new Window({ width: 1280, height: 800 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { projectLaunchConversations } = await import("@/lib/agent/spawnProjection");
const { defaultPipelinePorts } = await import("@/lib/pipelines/engine");
const { BranchPane } = await import("./BranchPane");
const { setLocale } = await import("@/lib/i18n");
afterAll(() => { dom.happyDOM.abort(); fs.rmSync(sandbox, { recursive: true, force: true }); });

test("a never-started launch offers dismissal and no resume control (#1972)", () => {
  setLocale("en");
  const registry = new AgentRegistry(path.join(sandbox, "registry.json"));
  const begun = beginLegacySpawnFixture(registry, { engine: "codex", cwd: sandbox, transport: "structured" });
  if (begun.kind !== "created") throw new Error("launch reservation failed");
  const receipt = begun.receipt;
  registry.preserveSpawnArtifactOwnership(receipt.launchId, "structured launch recovery: " + JSON.stringify({
    phase: "unpublished", startedAt: Date.now() - 13 * 3600_000, checks: 2,
    nextTryAt: 0, stopped: true, reason: "runtime host recovery exhausted after 2 checks",
  }));
  // The production engine adapter terminalizes the incident-shaped receipt.
  setAgentRegistryForTests(registry);
  try {
    defaultPipelinePorts().failStageLaunch?.(receipt.launchId, receipt.conversationId,
      "stage launch never started: runtime host recovery exhausted");
  } finally { setAgentRegistryForTests(null); }
  const file = projectLaunchConversations([], registry.readOnlySnapshot()).cards[0]!;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let dismissed = 0;
  try {
    flushSync(() => root.render(<BranchPane file={file} tasks={[]} isRoot onClose={() => { dismissed++; }} />));
    expect(host.textContent).toContain("never started");
    expect(host.querySelector("[data-card-status=running]")).toBeNull();
    expect(host.querySelector("[data-agent-control-strip]")).toBeNull();
    expect(host.querySelector("textarea")).toBeNull();
    const dismiss = host.querySelector("[data-launch-dismiss]") as HTMLButtonElement;
    expect(dismiss).not.toBeNull();
    dismiss.click();
    expect(dismissed).toBe(1);
  } finally { flushSync(() => root.unmount()); host.remove(); }
});
