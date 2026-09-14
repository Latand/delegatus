#!/usr/bin/env bun

/**
 * Stage deploy entrypoint (#659): deploy the current `stage` head (or an
 * explicit full SHA) to the staging instance on 127.0.0.1:8899.
 *
 *   bun scripts/deploy-staging.ts            # deploy origin/stage head
 *   bun scripts/deploy-staging.ts --revision <40-hex sha>
 *
 * Simple replace, no blue-green: build the image from the resolved revision
 * (the same Dockerfile path and LLV_RUNTIME_HOME build arg prod deployments
 * use), build and stage that revision's Viewer MCP runtime into the staging
 * state dir, remove the previous staging pair, publish the staging release
 * target, start the new pair against the staging state dir, write the
 * staging-release.json record there, and gate on the staging port serving
 * that exact revision to an authenticated caller. A second gate resolves the
 * control endpoint the way a staging stage agent's Viewer MCP server does and
 * requires it to land on staging, never on the production port (#1683).
 * Prod evidence: the script fingerprints prod's state
 * files before and after and fails if the deploy machinery touched
 * viewer-release.json. (Other prod files may legitimately change while the
 * live prod instance keeps working — they are reported, not failed on.)
 *
 * This script runs host-side in the operator's session. The staging
 * instance itself never reads any of the prod paths referenced here.
 */

import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { viewerControlOrigin, viewerControlToken } from "../src/lib/mcp/controlEndpoint";
import type { ViewerMcpRuntimeIdentity, ViewerReleaseIdentity } from "../src/lib/runtime/contracts";
import { stagingReleaseRecord, STAGING_RELEASE_FILE, type StagingReleaseRecord } from "../src/lib/staging";
import {
  viewerCandidateTmuxEnvironment,
  viewerComposeServiceFromConfig,
  viewerComposeServiceUid,
  viewerComposeSnapshotWithoutWakatimeCredential,
} from "../src/runtime-host/candidateContainer";
import { ensureCanonicalMirror } from "../src/runtime-host/canonicalMirror";
import { viewerComposeSnapshotPath } from "../src/runtime-host/deploymentArtifacts";
import { McpRuntimeReleaseStore } from "../src/runtime-host/mcpRuntimeRelease";
import {
  STAGING_FRONT_PORT,
  STAGING_RUNTIME_HOST_CONTAINER,
  STAGING_VIEWER_CONTAINER,
  stagingAgentViewerMcpEnvironment,
  stagingImageBuildArgs,
  stagingImageName,
  stagingRuntimeHostDockerArgs,
  stagingStatePaths,
  stagingViewerDockerArgs,
} from "../src/runtime-host/stagingContainer";
import { withoutWakatimeCredential } from "../src/lib/wakatime/credential";

/** Prod state families the issue forbids staging from touching. */
export const PROD_STATE_EVIDENCE_FILES: ReadonlySet<string> = new Set([
  "viewer-release.json",
  "agent-registry.json",
  "runtime-events.sqlite",
  "board.json",
  "pipelines.json",
  "flows.json",
]);

export interface ProdStateFingerprint {
  digest: string;
  mtimeMs: number;
}

export interface ProdStateChanges {
  unchanged: string[];
  changed: string[];
  /** viewer-release.json is written by deploy machinery alone, so any change
      there is proof the stage deploy leaked into prod; other files change
      whenever the live prod instance works. */
  violation: string | null;
}

export function prodStateChanges(
  before: Map<string, ProdStateFingerprint | null>,
  after: Map<string, ProdStateFingerprint | null>,
): ProdStateChanges {
  const unchanged: string[] = [];
  const changed: string[] = [];
  for (const [name, fingerprint] of [...before.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const current = after.get(name) ?? null;
    const same = fingerprint === null
      ? current === null
      : current !== null && current.digest === fingerprint.digest && current.mtimeMs === fingerprint.mtimeMs;
    (same ? unchanged : changed).push(name);
  }
  return { unchanged, changed, violation: changed.includes("viewer-release.json") ? "viewer-release.json" : null };
}

function collectProdState(prodStateDir: string): Map<string, ProdStateFingerprint | null> {
  const fingerprints = new Map<string, ProdStateFingerprint | null>();
  for (const name of PROD_STATE_EVIDENCE_FILES) {
    const filename = path.join(prodStateDir, name);
    try {
      const stat = fs.statSync(filename);
      const digest = crypto.createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
      fingerprints.set(name, { digest, mtimeMs: stat.mtimeMs });
    } catch {
      fingerprints.set(name, null);
    }
  }
  return fingerprints;
}

/** Headers for a request to the staging Viewer. The staging service inherits
    LLV_TOKEN from the compose configuration and authenticates every connection,
    loopback included, so an unauthenticated health read can only answer 403
    (#1683). The token never appears in a log line or an error. */
export function stagingRequestHeaders(token: string | null | undefined): Record<string, string> {
  const credential = token?.trim();
  return credential ? { authorization: `Bearer ${credential}` } : {};
}

export interface StagingAgentControl {
  origin: string;
  /** Whether a credential resolved; the value itself is never returned. */
  authenticated: boolean;
  headers: Record<string, string>;
}

/** Resolve the control endpoint and credential exactly as a staging stage
    agent's Viewer MCP server does, from the environment it inherits, and refuse
    unless the endpoint is the staging Viewer. Before #1683 this resolved to
    127.0.0.1:8898: agents on staging read and acted on production. */
export function stagingAgentControl(
  agentEnvironment: Readonly<Record<string, string>>,
  stagingEndpoint: string,
): StagingAgentControl {
  const origin = viewerControlOrigin(agentEnvironment);
  if (origin !== new URL(stagingEndpoint).origin) {
    throw new Error(`staging agent Viewer MCP control resolves to ${origin}, not the staging endpoint ${stagingEndpoint}`);
  }
  const token = viewerControlToken(agentEnvironment, origin);
  return { origin, authenticated: token !== null, headers: stagingRequestHeaders(token) };
}

export type StagingReleaseTargetReading =
  | { state: "absent" }
  | { state: "unreadable" }
  | { state: "present"; mcpRuntime: ViewerMcpRuntimeIdentity | null };

/** What a staging release target names, read leniently: the prune below only
    needs to know which MCP runtime it keeps alive, and refuses to prune at all
    when it cannot tell. */
export function readStagingReleaseTarget(filename: string): StagingReleaseTargetReading {
  let raw: string;
  try {
    raw = fs.readFileSync(filename, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "absent" } : { state: "unreadable" };
  }
  try {
    const target = JSON.parse(raw) as { mcpRuntime?: unknown } | null;
    if (!target || typeof target !== "object" || Array.isArray(target)) return { state: "unreadable" };
    if (target.mcpRuntime === undefined) return { state: "present", mcpRuntime: null };
    const runtime = target.mcpRuntime as Partial<ViewerMcpRuntimeIdentity> | null;
    if (!runtime || typeof runtime !== "object" || typeof runtime.source !== "string") return { state: "unreadable" };
    if (runtime.source === "managed" && (typeof runtime.releaseId !== "string" || !/^[a-z0-9-]+$/.test(runtime.releaseId))) {
      return { state: "unreadable" };
    }
    return { state: "present", mcpRuntime: runtime as ViewerMcpRuntimeIdentity };
  } catch {
    return { state: "unreadable" };
  }
}

/** Each staging deploy copies a revision's MCP bundle and production
    node_modules (about 600 MB) into the staging state dir. After a deploy has
    passed its gates, keep the runtime the staging release target names now and
    the one the target named before this deploy, the rollback's, and remove the
    rest. The store is rooted in the staging state dir, so nothing outside it is
    touched. A target that cannot be read, before or after, prunes nothing. */
export function retainStagingMcpRuntimes(
  store: McpRuntimeReleaseStore,
  releaseTargetFile: string,
  previous: StagingReleaseTargetReading,
): { pruned: boolean; retained: string[] } {
  const current = readStagingReleaseTarget(releaseTargetFile);
  if (current.state !== "present" || current.mcpRuntime?.source !== "managed" || previous.state === "unreadable") {
    return { pruned: false, retained: [] };
  }
  const retained = [current.mcpRuntime, previous.state === "present" ? previous.mcpRuntime : null]
    .filter((runtime): runtime is ViewerMcpRuntimeIdentity => runtime?.source === "managed");
  store.retainOnly(retained);
  return { pruned: true, retained: [...new Set(retained.map((runtime) => runtime.releaseId!))] };
}

function writeComposeSnapshot(filename: string, snapshot: string): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, snapshot, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filename);
}

async function command(argv: string[], options: { cwd?: string } = {}): Promise<string> {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: withoutWakatimeCredential(process.env),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error((stderr.trim() || `${argv[0]} failed`).slice(0, 1000));
  return stdout.trim();
}

interface DeployOptions {
  revision: string | null;
}

function parseOptions(argv: string[]): DeployOptions {
  const options: DeployOptions = { revision: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--revision") {
      const value = argv[index + 1] ?? "";
      if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("--revision requires a full 40-character commit SHA");
      options.revision = value;
      index += 1;
      continue;
    }
    throw new Error(`unsupported argument: ${argv[index]}`);
  }
  return options;
}

function writeReleaseRecord(filename: string, record: StagingReleaseRecord): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(stagingReleaseRecord(record), null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, filename);
}

async function containerGone(container: string): Promise<void> {
  try { await command(["docker", "container", "rm", "-f", container]); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("No such container") && !message.includes("No such object")) throw error;
  }
}

async function waitForStagingRevision(
  endpoint: string,
  revision: string,
  headers: Record<string, string>,
  timeoutMs = 180_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "staging endpoint did not answer";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/api/staging`, { headers, signal: AbortSignal.timeout(5_000) });
      if (response.ok) {
        const payload = await response.json() as { staging?: unknown; revision?: unknown };
        if (payload.staging === true && payload.revision === revision) return;
        last = `staging endpoint reported staging=${String(payload.staging)} revision=${String(payload.revision)}`;
      } else {
        last = `staging endpoint returned HTTP ${response.status}`;
      }
    } catch (error) {
      last = error instanceof Error ? error.message : "staging endpoint fetch failed";
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`staging health gate failed: ${last}`);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const prodStateDir = path.join(configRoot, "agent-log-viewer", "state");
  const stagingStateDir = process.env.LLV_STAGING_STATE_DIR || path.join(configRoot, "agent-log-viewer", "state-staging");
  const paths = stagingStatePaths(stagingStateDir);
  const remote = process.env.LLV_VIEWER_CANONICAL_REMOTE || "https://github.com/Latand/live-log-viewer-next.git";
  const endpoint = `http://127.0.0.1:${STAGING_FRONT_PORT}`;

  const before = collectProdState(prodStateDir);

  /* Staging keeps its own mirror under its own state dir; the prod
     deployments mirror stays untouched. */
  const deploymentDir = path.join(stagingStateDir, "deployments");
  const mirrorDir = path.join(deploymentDir, "canonical.git");
  await ensureCanonicalMirror({ deploymentDir, mirrorDir, remote }, { run: (argv) => command(argv) });
  const requested = options.revision ? `${options.revision}^{commit}` : "refs/heads/stage^{commit}";
  const revision = await command(["git", "--git-dir", mirrorDir, "rev-parse", "--verify", requested]);
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("stage revision did not resolve to a commit SHA");

  const image = stagingImageName(revision);
  const sourceDir = path.join(deploymentDir, "stage-source", "source");
  fs.rmSync(path.dirname(sourceDir), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(sourceDir), { recursive: true, mode: 0o700 });
  await command(["git", "--git-dir", mirrorDir, "worktree", "prune"]);
  await command(["git", "--git-dir", mirrorDir, "worktree", "add", "--detach", sourceDir, revision]);
  /* Staging's MCP releases live in its own state dir. No stable launcher is
     installed from here: the operator's launcher belongs to prod deployments. */
  const mcpRuntimeStore = new McpRuntimeReleaseStore({
    stateDir: stagingStateDir,
    stableRuntimeRoot: path.join(stagingStateDir, "mcp-runtime"),
  });
  const hotStateBackend = fs.existsSync(path.join(sourceDir, "src", "lib", "state", "hotStateAuthority.ts"))
    ? "sqlite-v1" as const
    : undefined;
  let service;
  let composeSnapshot: string;
  let mcpRuntime: ViewerMcpRuntimeIdentity;
  try {
    const composeConfig = await command([
      "docker", "compose", "--project-directory", sourceDir, "-f", path.join(sourceDir, "docker-compose.yml"),
      "--profile", "*", "config", "--format", "json",
    ]);
    composeSnapshot = viewerComposeSnapshotWithoutWakatimeCredential(composeConfig);
    service = viewerComposeServiceFromConfig(composeSnapshot);
    await command(stagingImageBuildArgs({ revision, image, sourceDir, runtimeHome: service.environment.HOME }));
    await command([process.execPath, "install", "--frozen-lockfile", "--production"], { cwd: sourceDir });
    await command([process.execPath, "run", "build:mcp"], { cwd: sourceDir });
    mcpRuntime = mcpRuntimeStore.stagePreparedPackage(sourceDir, `staging-${revision}`, revision);
  } finally {
    try { await command(["git", "--git-dir", mirrorDir, "worktree", "remove", "--force", sourceDir]); }
    catch { fs.rmSync(sourceDir, { recursive: true, force: true }); }
  }

  /* The host tmux supervisor migration marker lives in prod state; reading it
     here (operator-side) keeps the staging containers on the same tmux
     transport as prod without the staging instance touching prod state. */
  const tmux = viewerCandidateTmuxEnvironment(prodStateDir, viewerComposeServiceUid(service), {
    legacyTmuxExternal: service.environment.LLV_LEGACY_TMUX_EXTERNAL || "0",
    tmuxTmpdir: service.environment.TMUX_TMPDIR || "/tmp",
  });
  const context = { revision, image, service, paths, tmux };

  fs.mkdirSync(stagingStateDir, { recursive: true, mode: 0o700 });
  await containerGone(STAGING_VIEWER_CONTAINER);
  await containerGone(STAGING_RUNTIME_HOST_CONTAINER);
  /* Published before the new pair starts, so the arriving Viewer owns the
     target from its first request and moves the hot-state authority to this
     revision itself; a target written after start fences every hot-state write
     until the authority catches up. The compose snapshot is where an agent's
     MCP server finds the staging Viewer's credential. */
  writeComposeSnapshot(viewerComposeSnapshotPath(stagingStateDir, STAGING_VIEWER_CONTAINER), composeSnapshot);
  const previousTarget = readStagingReleaseTarget(paths.releaseTarget);
  const releaseTarget: ViewerReleaseIdentity = {
    image,
    container: STAGING_VIEWER_CONTAINER,
    endpoint,
    revision,
    ...(hotStateBackend ? { hotStateBackend } : {}),
    mcpRuntime,
  };
  mcpRuntimeStore.publishReleaseTarget(paths.releaseTarget, releaseTarget);
  await command(stagingRuntimeHostDockerArgs(context));
  await command(stagingViewerDockerArgs(context));

  const record: StagingReleaseRecord = {
    revision,
    image,
    endpoint,
    containers: { viewer: STAGING_VIEWER_CONTAINER, runtimeHost: STAGING_RUNTIME_HOST_CONTAINER },
    deployedAt: new Date().toISOString(),
  };
  writeReleaseRecord(path.join(stagingStateDir, STAGING_RELEASE_FILE), record);

  await waitForStagingRevision(endpoint, revision, stagingRequestHeaders(service.environment.LLV_TOKEN));

  const agentControl = stagingAgentControl(stagingAgentViewerMcpEnvironment(context), endpoint);
  if (service.environment.LLV_TOKEN?.trim() && !agentControl.authenticated) {
    throw new Error("staging agent Viewer MCP control resolved no credential for the staging Viewer");
  }
  await waitForStagingRevision(agentControl.origin, revision, agentControl.headers, 30_000);

  const changes = prodStateChanges(before, collectProdState(prodStateDir));
  if (changes.violation) {
    throw new Error(`stage deploy touched prod ${changes.violation} — investigate before trusting this staging instance`);
  }
  /* The deploy has passed every gate; a failed prune is reported, never a failed deploy. */
  let mcpRuntimeRetention: ReturnType<typeof retainStagingMcpRuntimes> | { pruned: false; error: string };
  try {
    mcpRuntimeRetention = retainStagingMcpRuntimes(mcpRuntimeStore, paths.releaseTarget, previousTarget);
  } catch (error) {
    mcpRuntimeRetention = { pruned: false, error: error instanceof Error ? error.message : "MCP runtime prune failed" };
  }
  console.log(JSON.stringify({
    ...record,
    mcpRuntime,
    agentControl: { origin: agentControl.origin, authenticated: agentControl.authenticated },
    mcpRuntimeRetention,
    prodState: changes,
  }, null, 2));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "stage deploy failed");
    process.exit(1);
  }
}
