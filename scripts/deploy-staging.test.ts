import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ViewerComposeService } from "../src/runtime-host/candidateContainer";
import { viewerComposeSnapshotPath } from "../src/runtime-host/deploymentArtifacts";
import {
  STAGING_VIEWER_CONTAINER,
  stagingAgentViewerMcpEnvironment,
  stagingImageName,
  stagingStatePaths,
} from "../src/runtime-host/stagingContainer";
import {
  PROD_STATE_EVIDENCE_FILES,
  prodStateChanges,
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

test("issue 1683: agent control resolves the staging Viewer and its credential from what the deploy publishes", () => {
  const { home, context, cleanup } = stagingFixture();
  try {
    const endpoint = "http://127.0.0.1:8899";
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
    /* The operator key a Viewer outside a deployment would accept must not be
       what staging agents send: the staging service's own credential wins. */
    fs.writeFileSync(path.join(home, ".config", "agent-log-viewer", "token"), "operator-machine-value\n");

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
