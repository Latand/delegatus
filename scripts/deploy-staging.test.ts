import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { requestRemotePipelineTick } from "../src/lib/pipelines/controllerSignal";
import type { ViewerComposeService } from "../src/runtime-host/candidateContainer";
import { viewerComposeSnapshotPath } from "../src/runtime-host/deploymentArtifacts";
import { McpRuntimeReleaseStore } from "../src/runtime-host/mcpRuntimeRelease";
import {
  STAGING_VIEWER_CONTAINER,
  stagingAgentViewerMcpEnvironment,
  stagingImageName,
  stagingStatePaths,
} from "../src/runtime-host/stagingContainer";
import {
  PROD_STATE_EVIDENCE_FILES,
  prodStateChanges,
  readStagingReleaseTarget,
  retainStagingMcpRuntimes,
  stagingAgentControl,
  stagingRequestHeaders,
  type ProdStateFingerprint,
} from "./deploy-staging";

function fingerprint(digest: string, mtimeMs: number): ProdStateFingerprint {
  return { digest, mtimeMs };
}

test("the prod evidence set covers every state family staging must not touch", () => {
  expect([...PROD_STATE_EVIDENCE_FILES].sort()).toEqual([
    "agent-registry.json",
    "board.json",
    "flows.json",
    "pipelines.json",
    "runtime-events.sqlite",
    "viewer-release.json",
  ]);
});

test("prod state changes distinguish untouched, changed and absent files", () => {
  const before = new Map<string, ProdStateFingerprint | null>([
    ["viewer-release.json", fingerprint("aa", 1)],
    ["board.json", fingerprint("bb", 2)],
    ["pipelines.json", null],
  ]);
  const after = new Map<string, ProdStateFingerprint | null>([
    ["viewer-release.json", fingerprint("aa", 1)],
    ["board.json", fingerprint("cc", 3)],
    ["pipelines.json", null],
  ]);
  const changes = prodStateChanges(before, after);
  expect(changes.unchanged).toEqual(["pipelines.json", "viewer-release.json"]);
  expect(changes.changed).toEqual(["board.json"]);
});

test("a viewer-release change is flagged as a deploy-machinery violation", () => {
  const before = new Map<string, ProdStateFingerprint | null>([["viewer-release.json", fingerprint("aa", 1)]]);
  const after = new Map<string, ProdStateFingerprint | null>([["viewer-release.json", fingerprint("zz", 9)]]);
  expect(prodStateChanges(before, after).violation).toBe("viewer-release.json");
  expect(prodStateChanges(before, before).violation).toBeNull();
});

test("issue 1683: the staging health read carries the service credential when one is configured", () => {
  for (const configured of ["not-a-real-token-value", "  not-a-real-token-value\n"]) {
    const headers = stagingRequestHeaders(configured);
    expect(Object.keys(headers)).toEqual(["authorization"]);
    expect(headers.authorization).toBe("Bearer not-a-real-token-value");
  }
  for (const absent of [undefined, null, "", "   "]) expect(stagingRequestHeaders(absent)).toEqual({});
});

function stagingFixture(): { home: string; context: Parameters<typeof stagingAgentViewerMcpEnvironment>[0]; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "llv-staging-agent-control-"));
  const revision = "e".repeat(40);
  const stateDir = path.join(home, ".config", "agent-log-viewer", "state-staging");
  const service = {
    command: null,
    entrypoint: null,
    environment: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), LLV_TOKEN: "staging-fixture-value" },
    group_add: [],
    image: "agent-log-viewer:node22",
    labels: {},
    network_mode: "host",
    pid: "host",
    profiles: [],
    privileged: false,
    restart: "unless-stopped",
    "user": "1000:1000",
    volumes: [],
    working_dir: "/app",
  } as unknown as ViewerComposeService;
  const context = {
    revision,
    image: stagingImageName(revision),
    service,
    paths: stagingStatePaths(stateDir),
    tmux: { legacyTmuxExternal: "0", tmuxTmpdir: "/tmp" },
  };
  return { home, context, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/* What the deploy publishes before the new pair starts: the staging release
   target and the staging Viewer's compose snapshot, plus an operator key that
   staging agents must not send in place of the staging service's own. */
function publishStagingFixture(home: string, context: ReturnType<typeof stagingFixture>["context"], endpoint: string): void {
  fs.mkdirSync(context.paths.stateDir, { recursive: true });
  fs.writeFileSync(context.paths.releaseTarget, JSON.stringify({
    image: context.image,
    container: STAGING_VIEWER_CONTAINER,
    endpoint,
    revision: context.revision,
  }));
  const snapshot = viewerComposeSnapshotPath(context.paths.stateDir, STAGING_VIEWER_CONTAINER);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, JSON.stringify({ services: { viewer: { environment: context.service.environment } } }));
  fs.writeFileSync(path.join(home, ".config", "agent-log-viewer", "token"), "operator-machine-value\n");
}

test("issue 1683: agent control resolves the staging Viewer and its credential from what the deploy publishes", () => {
  const { home, context, cleanup } = stagingFixture();
  try {
    const endpoint = "http://127.0.0.1:8899";
    publishStagingFixture(home, context, endpoint);

    const control = stagingAgentControl(stagingAgentViewerMcpEnvironment(context), endpoint);
    expect(control.origin).toBe(endpoint);
    expect(control.authenticated).toBe(true);
    expect(Object.keys(control.headers)).toEqual(["authorization"]);
    expect(control.headers.authorization).toBe("Bearer staging-fixture-value");
  } finally {
    cleanup();
  }
});

test("issue 1683: agent control refuses an environment that resolves to the production port", () => {
  const { home, context, cleanup } = stagingFixture();
  try {
    const inheritedBefore = { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), LLV_STATE_DIR: context.paths.stateDir };
    expect(() => stagingAgentControl(inheritedBefore, "http://127.0.0.1:8899"))
      .toThrow("staging agent Viewer MCP control resolves to http://127.0.0.1:8898, not the staging endpoint http://127.0.0.1:8899");
  } finally {
    cleanup();
  }
});

test("issue 1685: a staging agent's pipeline tick reaches the staging Viewer with the staging credential", async () => {
  const { home, context, cleanup } = stagingFixture();
  try {
    publishStagingFixture(home, context, "http://127.0.0.1:8899");
    const requests: Array<{ url: string; credential: string | null }> = [];
    await requestRemotePipelineTick(async (input, init) => {
      requests.push({ url: String(input), credential: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }, stagingAgentViewerMcpEnvironment(context));
    expect(requests).toEqual([{ url: "http://127.0.0.1:8899/api/pipelines/tick", credential: "Bearer staging-fixture-value" }]);
  } finally {
    cleanup();
  }
});

/* The deploy's MCP runtime steps for one revision, in its order: stage the
   prepared package, read the target this deploy replaces, publish the new
   target, and prune once the gates have passed. */
function deployStagingRuntime(root: string, store: McpRuntimeReleaseStore, targetFile: string, revision: string): void {
  const source = path.join(root, `source-${revision.slice(0, 4)}`);
  fs.mkdirSync(path.join(source, "dist"), { recursive: true });
  fs.mkdirSync(path.join(source, "node_modules", "fixture"), { recursive: true });
  fs.writeFileSync(path.join(source, "dist", "mcp-server.mjs"), `export const revision = "${revision}";\n`);
  fs.writeFileSync(path.join(source, "node_modules", "fixture", "index.js"), "module.exports = 1;\n");
  fs.writeFileSync(path.join(source, "package.json"), "{}\n");
  const mcpRuntime = store.stagePreparedPackage(source, `staging-${revision}`, revision);
  const previous = readStagingReleaseTarget(targetFile);
  store.publishReleaseTarget(targetFile, {
    image: stagingImageName(revision),
    container: STAGING_VIEWER_CONTAINER,
    endpoint: "http://127.0.0.1:8899",
    revision,
    mcpRuntime,
  });
  retainStagingMcpRuntimes(store, targetFile, previous);
}

test("review round: three staging deploys keep at most two MCP runtimes, the named one among them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-staging-mcp-retention-"));
  try {
    const stateDir = path.join(root, "state-staging");
    const prodReleases = path.join(root, "state", "mcp-runtime", "releases", "deploy-production-runtime");
    fs.mkdirSync(prodReleases, { recursive: true });
    const store = new McpRuntimeReleaseStore({ stateDir, stableRuntimeRoot: path.join(stateDir, "mcp-runtime") });
    const releases = path.join(stateDir, "mcp-runtime", "releases");
    const targetFile = stagingStatePaths(stateDir).releaseTarget;
    const named = () => {
      const reading = readStagingReleaseTarget(targetFile);
      return reading.state === "present" ? reading.mcpRuntime?.releaseId : undefined;
    };
    const namedBefore: string[] = [];
    for (const revision of ["a".repeat(40), "b".repeat(40), "c".repeat(40)]) {
      deployStagingRuntime(root, store, targetFile, revision);
      const present = fs.readdirSync(releases).sort();
      expect(present.length).toBeLessThanOrEqual(2);
      expect(present).toContain(named()!);
      namedBefore.push(named()!);
    }
    expect(fs.readdirSync(releases).sort()).toEqual([namedBefore[1]!, namedBefore[2]!].sort());
    expect(fs.existsSync(prodReleases)).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("review round: an unreadable previous staging target prunes nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-staging-mcp-retention-"));
  try {
    const stateDir = path.join(root, "state-staging");
    const store = new McpRuntimeReleaseStore({ stateDir, stableRuntimeRoot: path.join(stateDir, "mcp-runtime") });
    const releases = path.join(stateDir, "mcp-runtime", "releases");
    const targetFile = stagingStatePaths(stateDir).releaseTarget;
    deployStagingRuntime(root, store, targetFile, "a".repeat(40));
    deployStagingRuntime(root, store, targetFile, "b".repeat(40));
    fs.writeFileSync(targetFile, "{ not json");
    expect(retainStagingMcpRuntimes(store, targetFile, { state: "absent" })).toEqual({ pruned: false, retained: [] });
    const unreadable = readStagingReleaseTarget(targetFile);
    expect(unreadable).toEqual({ state: "unreadable" });
    deployStagingRuntime(root, store, targetFile, "c".repeat(40));
    expect(fs.readdirSync(releases)).toHaveLength(3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
