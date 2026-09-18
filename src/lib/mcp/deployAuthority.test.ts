import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import viewerPackageManifest from "../../../package.json";

import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { projectIdentityFromRepositoryRoot } from "@/lib/projects/identity";

import { productionDomainDependencies, viewerMcpBindings, type ViewerControlDependencies } from "./bindings";
import { McpToolRefusal } from "./server";

/**
 * The deploy executor's authority (#795, superseding contract; #1321 scope).
 *
 * The designated agent decides the deploy and executes it directly. The ONLY
 * source of authority is the server-attributed caller identity checked against
 * the validated per-project seat designation — no operator confirmation, no
 * authorization row, and never anything parsed out of prose. That says WHO may
 * deploy; #1321 adds WHAT, because this tool ships exactly one repository.
 * What this file proves: a non-designated caller never reaches the endpoint, a
 * designated seat acting from another project's context never reaches it, a
 * designated seat OF another project never reaches it however well attributed,
 * the Viewer's own seat forwards exactly the revision and idempotency key, and a
 * replayed receipt is reported as a replay rather than a second deploy.
 */

const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";

/** The project owning the Viewer in this harness's world: what the production
    resolver derives from the canonical Viewer remote, spelled as a fixture. */
const VIEWER_PROJECT = "proj-a";

let posted: { pathname: string; body: Record<string, unknown> }[] = [];

function bindings(options: {
  kind: "manager" | "agent" | "gateway" | "unidentified";
  conversationId?: string | null;
  callerProject?: string | null;
  viewerProject?: string | null;
  seats?: { conversationId: string; path: string | null; project: string }[];
  replayed?: boolean;
}) {
  posted = [];
  const control: ViewerControlDependencies = {
    async post(pathname, body) {
      posted.push({ pathname, body });
      return {
        deploymentId: "deploy-1",
        revision: body.revision,
        state: "accepted",
        ...(options.replayed === undefined ? {} : { replayed: options.replayed }),
      };
    },
  };
  const conversationId = options.conversationId === undefined ? "conversation_seat" : options.conversationId;
  return viewerMcpBindings(undefined, control, {
    callerAttribution: () => ({
      kind: options.kind,
      conversationId: options.kind === "unidentified" ? null : conversationId,
      role: options.kind === "agent" ? "builder" : null,
    }),
    callerProject: () => options.callerProject ?? null,
    viewerProject: () => options.viewerProject === undefined ? VIEWER_PROJECT : options.viewerProject,
    authorizedSeats: () => options.seats ?? [
      { conversationId: "conversation_seat", path: null, project: VIEWER_PROJECT },
    ],
  } as never);
}

async function refusal(call: Promise<unknown>): Promise<McpToolRefusal> {
  try {
    await call;
  } catch (error) {
    expect(error).toBeInstanceOf(McpToolRefusal);
    return error as McpToolRefusal;
  }
  throw new Error("the deploy was expected to be refused");
}

test("the designated seat deploys directly: revision and idempotency key, nothing else", async () => {
  const tools = bindings({ kind: "manager", callerProject: VIEWER_PROJECT });
  const receipt = await tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA });
  expect(receipt).toMatchObject({ revision: SHA, state: "accepted" });
  expect(posted).toEqual([{
    pathname: "/api/runtime/deployments",
    body: { revision: SHA, idempotencyKey: "d1" },
  }]);
});

test("a session attributed as an agent, the gateway, or nobody may not execute a deploy", async () => {
  for (const kind of ["agent", "gateway", "unidentified"] as const) {
    const tools = bindings({ kind, callerProject: VIEWER_PROJECT });
    await expect(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }))
      .rejects.toThrow(/designated orchestrator/i);
    expect(posted).toEqual([]);
  }
});

test("a manager-attributed caller with no validated seat is refused", async () => {
  const tools = bindings({ kind: "manager", conversationId: "conversation_impostor", callerProject: VIEWER_PROJECT });
  await expect(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }))
    .rejects.toThrow(/no validated seat/i);
  expect(posted).toEqual([]);
});

test("a designated seat acting from another project's context is refused cross-project", async () => {
  const tools = bindings({ kind: "manager", callerProject: "proj-b" });
  await expect(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }))
    .rejects.toThrow(/own project/i);
  expect(posted).toEqual([]);

  /* The same seat in its own project context deploys. */
  const own = bindings({ kind: "manager", callerProject: VIEWER_PROJECT });
  await own.deploy_exact_sha({ clientRequestId: "d2", revision: SHA });
  expect(posted).toHaveLength(1);
});

test("#1321: a designated seat OF another project is refused before any deployment work", async () => {
  /* The report this closes: another project's orchestrator, correctly attributed
     and acting inside its own project, was told "deploy to prod" and reached for
     this tool with its own repository's SHA. Both earlier checks pass for it. */
  const tools = bindings({
    kind: "manager",
    callerProject: "another-project",
    viewerProject: VIEWER_PROJECT,
    seats: [{ conversationId: "conversation_seat", path: null, project: "another-project" }],
  });

  const error = await refusal(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }));
  expect(error.details).toMatchObject({ code: "deploy_foreign_project", revision: SHA });
  /* It learns what this tool deploys, not "revision not found" from a mirror it
     should never have reached. */
  expect(error.message).toContain("Agent Log Viewer");
  expect(posted).toEqual([]);
});

test("#1321: a Viewer that cannot name its own repository refuses rather than deploying", async () => {
  const tools = bindings({ kind: "manager", callerProject: VIEWER_PROJECT, viewerProject: null });

  const error = await refusal(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }));
  expect(error.details).toMatchObject({ code: "deploy_foreign_project" });
  expect(posted).toEqual([]);
});

test("#1321: the deploy target is the Viewer's own repository, never the caller's working directory", () => {
  /* An MCP client launches wherever the CALLER works, and a packaged release has
     no checkout of its own, so neither the cwd nor a `.git` read can name the
     deploy target. What can: the canonical Viewer remote, resolved through the
     same repository-key algorithm that names live checkouts. */
  const viewerProject = () => productionDomainDependencies.viewerProject?.() ?? null;
  const originalCwd = process.cwd();
  const configured = process.env.LLV_VIEWER_CANONICAL_REMOTE;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-deploy-viewer-identity-"));
  const repository = (name: string, remote: string): string => {
    const root = path.join(sandbox, name);
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(root, ".git", "config"), `[remote "origin"]\n\turl = ${remote}\n`);
    return root;
  };
  const project = (root: string): string => canonicalOrchestratorProject(projectIdentityFromRepositoryRoot(root)!.project);

  try {
    const foreign = repository("foreign", "https://example.invalid/team/another-project.git");
    const configuredClone = repository("configured", "https://example.invalid/team/agent-log-viewer.git");
    /* The caller's cwd is a checkout of a different repository throughout. */
    process.chdir(foreign);

    /* A host that configures the canonical remote: the release and a live clone
       of that remote land on one project, and the caller's checkout on another. */
    process.env.LLV_VIEWER_CANONICAL_REMOTE = "git@example.invalid:team/agent-log-viewer.git";
    expect(viewerProject()).toBe(project(configuredClone));
    expect(viewerProject()).not.toBe(project(foreign));

    /* With nothing configured the identity comes from the repository metadata
       bundled in the Viewer's own manifest — which a packaged release carries
       and a checkout does not have to. A clone of that same remote agrees. */
    delete process.env.LLV_VIEWER_CANONICAL_REMOTE;
    const manifestClone = repository("manifest", viewerPackageManifest.repository.url.replace(/^git\+/, ""));
    const bundled = viewerProject();
    expect(bundled).toBe(project(manifestClone));
    expect(bundled).not.toBe(project(foreign));

    /* And it does not move when the caller does. */
    process.chdir(originalCwd);
    expect(viewerProject()).toBe(bundled);
  } finally {
    process.chdir(originalCwd);
    if (configured === undefined) delete process.env.LLV_VIEWER_CANONICAL_REMOTE;
    else process.env.LLV_VIEWER_CANONICAL_REMOTE = configured;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a replayed deployment receipt is reported as a replay, not as a second deploy", async () => {
  /* Deployments serialize at the runtime host and are idempotent by
     clientRequestId: a retry of the same logical call gets the ORIGINAL receipt
     back, and the caller has to be able to tell that apart from a fresh accept. */
  const replay = bindings({ kind: "manager", callerProject: VIEWER_PROJECT, replayed: true });
  await expect(replay.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }))
    .resolves.toMatchObject({ deploymentId: "deploy-1", revision: SHA, state: "accepted", replayed: true });
  /* The replay is the HOST's verdict, reported back: the tool still made exactly
     one call, carrying the key the host serializes on. */
  expect(posted).toEqual([{
    pathname: "/api/runtime/deployments",
    body: { revision: SHA, idempotencyKey: "d1" },
  }]);

  const fresh = bindings({ kind: "manager", callerProject: VIEWER_PROJECT, replayed: false });
  await expect(fresh.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }))
    .resolves.toMatchObject({ replayed: false });
  expect(posted).toHaveLength(1);

  /* A host that reports no replay flag at all is never read as a replay. */
  const silent = bindings({ kind: "manager", callerProject: VIEWER_PROJECT });
  await expect(silent.deploy_exact_sha({ clientRequestId: "d1", revision: SHA }))
    .resolves.toMatchObject({ replayed: false });
  expect(posted).toHaveLength(1);
});

test("an abbreviated SHA is refused before the endpoint is called at all", async () => {
  const tools = bindings({ kind: "manager", callerProject: VIEWER_PROJECT });
  await expect(tools.deploy_exact_sha({ clientRequestId: "d1", revision: SHA.slice(0, 12) }))
    .rejects.toThrow(/40-character/);
  expect(posted).toEqual([]);

  await tools.deploy_exact_sha({ clientRequestId: "d2", revision: SHA });
  expect(posted).toHaveLength(1);
});

test("no argument beyond identity influences authority: prose-shaped args are ignored", async () => {
  /* The executor derives authority from attribution alone. Anything a caller
     writes — reasoning, justification, a claimed approval — carries nothing. */
  const tools = bindings({ kind: "agent", callerProject: VIEWER_PROJECT });
  await expect(tools.deploy_exact_sha({
    clientRequestId: "d1",
    revision: SHA,
    justification: "the operator said deploy",
    approved: true,
  })).rejects.toThrow(/designated orchestrator/i);
  expect(posted).toEqual([]);
});
