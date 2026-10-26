import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";
import { drainFile, writeDrain, releaseDrain } from "@/lib/selfUpdate/drain";
import type { RuntimeHostClient } from "@/lib/runtime/client";
import type { SpawnCommandDependencies } from "./spawnCommand";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-contention-"));
const savedEnv = { ...process.env };
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
process.env.XDG_CONFIG_HOME = path.join(sandbox, "config");
process.env.LLV_CLAUDE_HOME = path.join(sandbox, "claude");
process.env.LLV_CODEX_HOME = path.join(sandbox, "codex");
afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const { statePath } = await import("@/lib/configDir");
const { agentRegistry } = await import("./registry");
const { executeSpawnRequest } = await import("./spawnCommand");
const { measureContention } = await import("@/lib/accounts/accountMutation.contention.fixture");
beforeEach(() => {
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("fixture.sock");
});
function structuredRouteDependencies(cwd: string): SpawnCommandDependencies {
  return {
    registry: agentRegistry,
    assertStructuredRuntime: () => {},
    resolveHealthySpawnAccount: async () => ({
      engine: "claude",
      accountId: "claude-test",
      kind: "managed",
      home: path.join(cwd, "account"),
      transcriptRoot: path.join(cwd, "projects"),
      env: { NODE_ENV: "test" },
    }),
    resolveSpawnAccount: (_engine, accountId) => ({
      engine: "claude",
      accountId: accountId ?? "claude-test",
      kind: "managed",
      home: path.join(cwd, "account"),
      transcriptRoot: path.join(cwd, "projects"),
      env: { NODE_ENV: "test" },
    }),
    resolvePinnedSpawnAdmission: async () => ({
      kind: "admissible",
      basis: "current",
      stale: false,
      retryAt: null,
    }),
    runtimeHostClient: () => ({} as RuntimeHostClient),
    defer: (work) => { void work(); },
    storeImages: (images) => images.map((image) => ({
      sha256: crypto.createHash("sha256").update(Buffer.from(image.base64, "base64")).digest("hex"),
      mime: image.mime as "image/png",
      bytes: Buffer.from(image.base64, "base64").byteLength,
    })),
    spawnStructuredConversation: async (input) => ({
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    }),
  };
}

test("a refused anonymous structured spawn preserves the real Git index and writes no handoffs", async () => {
  const { teamStore, resetTeamStoreForTests } = await import("@/lib/team/store");
  const cwd = statePath("anonymous-private-prompt-cwd");
  const directory = path.join(cwd, ".artifacts", "pipeline-stage-inputs");
  fs.mkdirSync(directory, { recursive: true });
  const legacy = "PRIVATE_ANONYMOUS_SENTINEL\n";
  fs.writeFileSync(path.join(directory, "old.md"), legacy);
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.invalid");
  git("config", "commit.gpgSign", "false");
  git("add", "source.ts");
  git("commit", "--quiet", "-m", "fixture base");
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 2;\n");
  git("add", "-A");
  const staged = git("diff", "--cached", "--name-only");
  const previousState = process.env.LLV_STATE_DIR;
  resetTeamStoreForTests();
  process.env.LLV_STATE_DIR = path.join(sandbox, "anonymous-team-state");
  try {
    teamStore().insertMember({ id: "m_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", name: "Owner", role: "owner", status: "active", color: "teal",
      telegram: null, createdAt: new Date().toISOString(), createdBy: "claim", revokedAt: null });
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_${crypto.randomUUID()}`, title: "Anonymous structured launch", engine: "claude", cwd,
        ["prompt"]: "Synthetic oversized fixture\n" + "p".repeat(40_000), mcpServers: [] }),
    }), { ...structuredRouteDependencies(cwd), defer: () => {} });
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("member_required");
    expect(git("diff", "--cached", "--name-only")).toBe(staged);
    expect(git("show", ":source.ts")).toBe("export const value = 2;");
    expect(fs.readdirSync(directory)).toEqual(["old.md"]);
    expect(fs.readFileSync(path.join(directory, "old.md"), "utf8")).toBe(legacy);
    expect(fs.existsSync(path.join(cwd, ".artifacts", ".gitignore"))).toBe(false);
  } finally {
    resetTeamStoreForTests();
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
  }
});

test("spawn catalog resolution leaves admission available", async () => {
  const cwd = statePath("spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  await measureContention("spawn-catalog", async (pause) => {
    const dependencies = structuredRouteDependencies(cwd);
    const resolve = dependencies.resolveSpawnAccount;
    dependencies.resolveSpawnAccount = ((...args: Parameters<typeof resolve>) => {
      void pause();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      return resolve(...args);
    }) as typeof resolve;
    dependencies.defer = () => {};
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_${crypto.randomUUID()}`, title: "Exercise catalog admission", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
    }), dependencies);
    if (response.status !== 202) console.info(await response.clone().json());
    expect(response.status).toBe(202);
  });
});

test("generic spawn cannot create a curator receipt without the pass admission callback", async () => {
  const { claimPass } = await import("@/lib/memory/curation/store");
  const { roleMemoryCollection, newRuleId, roleScope } = await import("@/lib/memory/roleStore");
  const cwd = statePath("generic-curator-spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const project = "generic-curator-fixture";
  const scope = roleScope(project, "builder");
  roleMemoryCollection(true)!.boundedPatch(20, tx => {
    const id = newRuleId(tx);
    const at = new Date().toISOString();
    tx.put({ kind: "rule", id, scope, rule: "Read the current scope before changing a stored rule.", why: "Preserve scoped guidance during review.",
      state: "active", hints: [], source: { project, pipelineId: "fixture", stageId: "build", attempt: 1, roleId: "builder", fixRound: false, conversationId: "conversation_curator_fixture" }, createdAt: at, changedAt: at });
    tx.put({ kind: "scope", scope, revision: 1, history: [], active: [id] });
  });
  const pass = claimPass({ project, repoDir: cwd, now: Date.now() });
  expect(pass).not.toBeNull();
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.resolveHealthySpawnAccount = async () => ({ engine: "codex", accountId: "codex-test", kind: "managed",
    home: path.join(cwd, "codex"), transcriptRoot: path.join(cwd, "codex", "sessions"), env: { NODE_ENV: "test" } });
  dependencies.resolveSpawnAccount = (_engine, accountId) => ({ engine: "codex", accountId: accountId ?? "codex-test", kind: "managed",
    home: path.join(cwd, "codex"), transcriptRoot: path.join(cwd, "codex", "sessions"), env: { NODE_ENV: "test" } });
  const previousCodexBinary = process.env.LLV_CODEX_BINARY;
  const codexBinary = statePath("curator-codex-list-stub");
  fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[{\"name\":\"viewer\"}]'\n");
  fs.chmodSync(codexBinary, 0o755);
  process.env.LLV_CODEX_BINARY = codexBinary;
  let response: Response;
  try {
    response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: pass!.id, title: "Role memory curation", engine: "codex", model: "gpt-6.1-sol", cwd, prompt: "inspect",
        role: "curator", project, mcpServers: [] }),
    }), { ...dependencies, defer: () => {} });
  } finally {
    if (previousCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY;
    else process.env.LLV_CODEX_BINARY = previousCodexBinary;
  }
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "curator_admission_refused" });
  expect(agentRegistry().spawnReceiptForClientAttempt(pass!.id)).toBeNull();
});

test("seat credential capture leaves neighboring spawn, resume and send admission available", async () => {
  const auth = await import("@/lib/accounts/seatAuthCredentials");
  const { executeOrchestratorSeatRequest, productionSeatCommandDependencies } = await import("@/lib/orchestrator/seatCommand");
  const seats = await import("@/lib/orchestrator/seats");
  const { orchestratorSeatFor } = seats;
  const { productionSpawnCommandDependencies } = await import("./spawnCommand");
  const { trackAccountLeases } = await import("@/lib/accounts/accountMutation.contention.fixture");
  const cwd = statePath("seat-credential-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const original = { ...productionSpawnCommandDependencies };
  Object.assign(productionSpawnCommandDependencies, structuredRouteDependencies(cwd), { defer: () => {}, engineReadiness: () => "connected" });
  const leases = trackAccountLeases();
  const observations: boolean[] = [];
  const captureMs: number[] = [];
  const commitMs: number[] = [];
  const commitHeld: boolean[] = [];
  const timeCommit = (commit: () => void) => {
    const started = performance.now();
    commitHeld.push(fs.existsSync(statePath("account-selection.lock")));
    try { commit(); }
    finally { commitMs.push(performance.now() - started); }
  };
  const prepare = seats.prepareOrchestratorSeatAuthCredentialBaseline;
  const record = seats.recordOrchestratorSeatAuthCredentialBaseline;
  // The retained direct facade also measures the reviewed code's inherited
  // callback when this same case runs against the captured commit.
  const commitSpy = typeof prepare === "function"
    ? spyOn(seats, "prepareOrchestratorSeatAuthCredentialBaseline").mockImplementation((...args) => {
      const commit = prepare(...args); return () => timeCommit(commit);
    })
    : spyOn(seats, "recordOrchestratorSeatAuthCredentialBaseline").mockImplementation((...args) => timeCommit(() => record(...args)));
  let neighbors: { exitCode: number; results: unknown; stderr: string } | undefined;
  const stamp = `1:file:${"a".repeat(64)}`;
  const capture = spyOn(auth, "seatAuthCredentialStamp").mockImplementation(() => {
    const started = performance.now();
    observations.push(fs.existsSync(statePath("account-selection.lock")));
    const child = Bun.spawnSync([process.execPath, "-e", `
      await import("./src/lib/testing/fixtureLifetime.ts");
      const { AgentRegistry } = await import("./src/lib/agent/registry");
      const { statePath } = await import("./src/lib/configDir");
      const { withAccountMutationLockAsync } = await import("./src/lib/accounts/accountMutation");
      const registry = new AgentRegistry(statePath("seat-neighbor-registry.json"), undefined, undefined, { sqliteMode: "off" });
      const conversation = registry.ensureConversation("codex", "/fixture/seat-neighbor.jsonl", "default");
      try {
        const results = await Promise.allSettled([
          registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", launchProfile: { title: "Neighbor spawn" } }),
          registry.beginSpawnRequestAsync({ engine: "codex", cwd: "/fixture", transport: "structured", accountId: "default", purpose: "resume-successor", conversationId: conversation.id, origin: { kind: "successor" }, launchProfile: { title: "Neighbor resume" } }),
          withAccountMutationLockAsync(() => registry.holdDelivery(conversation.id, "Neighbor send", "seat-neighbor-send"), { caller: "send" }),
        ]);
        console.log(JSON.stringify(results.map(result => result.status === "fulfilled" ? { status: result.status, kind: result.value.kind ?? "delivery" } : { status: result.status, error: result.reason.message })));
      } finally { registry.close(); }
    `], { cwd: process.cwd(), env: process.env, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    neighbors = { exitCode: child.exitCode, results: JSON.parse(child.stdout.toString()), stderr: child.stderr.toString() };
    captureMs.push(performance.now() - started);
    return stamp;
  });
  try {
    const result = await executeOrchestratorSeatRequest({ project: "seat-credential-contention", cwd, mandate: "Own the fixture board", engine: "claude", model: "sonnet", clientRequestId: `seat_${crypto.randomUUID()}` }, {
      ...productionSeatCommandDependencies, engineReadiness: () => "connected", startBoardReport: () => {}, stampRegistryIdentity: () => {},
    });
    expect(result.status).toBe(202);
    expect(orchestratorSeatFor("seat-credential-contention").active?.authCredentialBaseline).toMatchObject({ engine: "claude", accountId: "claude-test", stamp });
    expect(neighbors).toEqual({ exitCode: 0, stderr: "", results: [
      { status: "fulfilled", kind: "created" }, { status: "fulfilled", kind: "created" }, { status: "fulfilled", kind: "delivery" },
    ] });
    expect(observations).toEqual([false]);
    expect(commitHeld).toEqual([true]);
    expect(leases.holds.length).toBeGreaterThan(0);
  } finally {
    capture.mockRestore(); commitSpy.mockRestore(); leases.stop(); Object.assign(productionSpawnCommandDependencies, original);
    console.info(JSON.stringify({ measurement: "seat spawn credential capture", maxHoldMs: Math.max(0, ...leases.holds), holdMs: leases.holds, captureMs, commitMs, commitHeld, observations, neighbors }));
  }
}, 10_000);

test.each(["catalog", "credentials"] as const)("seat spawn revalidates %s changed during credential capture before committing a baseline or receipt", async change => {
  const auth = await import("@/lib/accounts/seatAuthCredentials");
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const { executeOrchestratorSeatRequest, productionSeatCommandDependencies } = await import("@/lib/orchestrator/seatCommand");
  const { orchestratorSeatFor } = await import("@/lib/orchestrator/seats");
  const { productionSpawnCommandDependencies } = await import("./spawnCommand");
  const cwd = statePath(`seat-${change}-race-cwd`);
  fs.mkdirSync(path.join(cwd, "account"), { recursive: true });
  const original = { ...productionSpawnCommandDependencies };
  Object.assign(productionSpawnCommandDependencies, structuredRouteDependencies(cwd), { defer: () => {}, engineReadiness: () => "connected" });
  const project = `seat-${change}-race`;
  const clientRequestId = `seat_${crypto.randomUUID()}`;
  let captures = 0;
  const capture = spyOn(auth, "seatAuthCredentialStamp").mockImplementation(() => {
    captures++;
    if (change === "catalog") createManagedCodexAccount("Concurrent catalog change");
    else fs.writeFileSync(path.join(cwd, "account", ".credentials.json"), JSON.stringify({ fixture: "x".repeat(captures) }), { mode: 0o600 });
    return `1:file:${"a".repeat(64)}`;
  });
  try {
    const result = await executeOrchestratorSeatRequest({ project, cwd, mandate: "Own the fixture board", engine: "claude", model: "sonnet", clientRequestId }, {
      ...productionSeatCommandDependencies, engineReadiness: () => "connected", startBoardReport: () => {}, stampRegistryIdentity: () => {},
    });
    expect(captures).toBeGreaterThan(0);
    expect(result.status).toBe(503);
    expect(result.body.code).toBe("account_admission_changed");
    expect(agentRegistry().spawnReceiptForClientAttempt(clientRequestId)).toBeNull();
    const seat = orchestratorSeatFor(project);
    expect(seat.active).toBeNull();
    expect(seat.pending?.authCredentialBaseline).toBeUndefined();
    expect(result.body.seat).toMatchObject({ authCredentialBaseline: undefined });
  } finally { capture.mockRestore(); Object.assign(productionSpawnCommandDependencies, original); }
});

test("an oversized structured spawn launches with its full prompt in a stable readable reference", async () => {
  const cwd = statePath("large-spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.invalid");
  git("config", "commit.gpgSign", "false");
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n");
  git("add", "source.ts");
  git("commit", "--quiet", "-m", "fixture base");
  let deliveredPrompt = "";
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.spawnStructuredConversation = async (input) => {
    deliveredPrompt = input.prompt;
    return {
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    };
  };
  const original = `Launch complete role brief\n${"界🙂".repeat(12_000)}`;
  const clientAttemptId = `attempt_${crypto.randomUUID()}`;
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId, title: "Large structured launch", engine: "claude", cwd, prompt: original, mcpServers: [] }),
  });

  const first = await executeSpawnRequest(request(), dependencies);
  expect(first.status).toBe(202);
  expect(Buffer.byteLength(deliveredPrompt, "utf8")).toBeLessThanOrEqual(32_000);
  const file = deliveredPrompt.match(/Full structured first message file: (.+)\n/)?.[1];
  expect(file).toBeDefined();
  expect(fs.readFileSync(file!, "utf8")).toContain(original);
  const firstReference = deliveredPrompt;

  // Replaying the same request takes the durable receipt path and retains the
  // same request payload and content-addressed file reference.
  await executeSpawnRequest(request(), dependencies);
  expect(deliveredPrompt).toBe(firstReference);
  expect(fs.readFileSync(file!, "utf8")).toContain(original);
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 2;\n");
  git("add", "-A");
  git("commit", "--quiet", "-m", "ordinary worker change");
  expect(git("ls-tree", "-r", "--name-only", "HEAD")).toBe("source.ts");
  expect(git("show", "HEAD:source.ts")).toBe("export const value = 2;");
  expect(git("show", "--format=", "HEAD")).not.toContain("Launch complete role brief");
  expect(fs.readFileSync(file!, "utf8")).toContain(original);
});

test("ordinary Git commits exclude private structured prompts under tracked inclusion rules", async () => {
  const envKeys = ["LLV_SPAWN_TRANSPORT", "LLV_STRUCTURED_HOSTS", "LLV_RUNTIME_EVENTS", "LLV_RUNTIME_HOST_SOCKET", "NEXT_PUBLIC_RUNTIME_UI"] as const;
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("private-prompt-runtime.sock");
  process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  const cwd = statePath("private-prompt-publication-cwd");
  const ignoreDir = path.join(cwd, ".artifacts", "pipeline-stage-inputs");
  fs.mkdirSync(ignoreDir, { recursive: true });
  fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(ignoreDir, ".gitignore"), "!*.md\n");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "noreply@example.com");
  git("config", "commit.gpgSign", "false");
  git("add", "source.ts", ".artifacts/pipeline-stage-inputs/.gitignore");
  git("commit", "--quiet", "-m", "fixture base");

  let deliveredPrompt = "";
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.spawnStructuredConversation = async (input) => {
    deliveredPrompt = input.prompt;
    return {
      ok: true,
      target: null,
      path: null,
      effectivePermissionMode: input.spec.launchProfile?.permissionMode ?? "default",
      launchId: input.receipt.launchId,
      conversationId: input.receipt.conversationId,
      launched: true,
      retrySafe: false,
      initialMessage: "delivered",
      state: "settled",
    };
  };
  const privatePrompt = `Private controller input\n${"Sensitive worker brief. ".repeat(2_000)}`.trim();
  try {
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_${crypto.randomUUID()}`, title: "Private structured launch", engine: "claude", cwd, prompt: privatePrompt, mcpServers: [] }),
    }), dependencies);

    expect(response.status).toBe(202);
    const privateFile = deliveredPrompt.match(/Full structured first message file: (.+)\n/)?.[1];
    expect(privateFile).toBeDefined();
    expect(fs.readFileSync(privateFile!, "utf8")).toBe(privatePrompt);
    const ignoreContents = fs.readFileSync(path.join(ignoreDir, ".gitignore"), "utf8");
    expect(ignoreContents.startsWith("!*.md\n")).toBe(true);
    expect(ignoreContents.trimEnd().endsWith("*")).toBe(true);
    git("restore", "--", ".artifacts/pipeline-stage-inputs/.gitignore");
    fs.writeFileSync(path.join(cwd, "source.ts"), "export const value = 2;\n");
    git("add", "-A");
    git("commit", "--quiet", "-m", "ordinary worker commit");

    const committedFiles = git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n");
    expect(committedFiles).toContain("source.ts");
    expect(committedFiles.filter((file) => file.startsWith(".artifacts/pipeline-stage-inputs/") && !file.endsWith("/.gitignore"))).toEqual([]);
    expect(committedFiles).not.toContain(path.relative(cwd, privateFile!).split(path.sep).join("/"));
    expect(git("show", "--format=", "HEAD")).not.toContain(privatePrompt);
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
});

test("a catalog generation change cannot admit the previously selected home", async () => {
  const { createManagedCodexAccount } = await import("@/lib/accounts/codex");
  const cwd = statePath("changed-catalog-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const dependencies = structuredRouteDependencies(cwd);
  const resolve = dependencies.resolveSpawnAccount;
  let reads = 0;
  dependencies.resolveSpawnAccount = (...args) => {
    const account = resolve(...args);
    reads++;
    if (reads === 1) {
      createManagedCodexAccount("Concurrent catalog mutation");
      return account;
    }
    return { ...account, home: path.join(cwd, "replacement") };
  };
  dependencies.defer = () => { throw new Error("stale catalog must not launch"); };
  const clientAttemptId = `attempt_${crypto.randomUUID()}`;
  const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId, title: "Reject stale catalog", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
  }), dependencies);
  expect(reads).toBe(2);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: "The account changed while preparing the launch; try again shortly.",
    code: "account_admission_changed",
    retrySafe: true,
    retryable: true,
  });
  expect(agentRegistry().spawnReceiptForClientAttempt(clientAttemptId)).toBeNull();
});

test("automatic target admission refuses a changed pool after account evidence without reserving a launch", async () => {
  const { accountProjectBindings } = await import("@/lib/accounts/projectBindings");
  const { BINDINGS_SOURCE } = await import("@/lib/accounts/accountsStore");
  const { seedAccountSource } = await import("@/lib/accounts/accountsStoreFixture");
  const cwd = statePath("automatic-target-cwd"); fs.mkdirSync(cwd, { recursive: true });
  const dependencies = structuredRouteDependencies(cwd);
  let entered!: () => void, resume!: () => void;
  const collecting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const nativeResolve = dependencies.resolveHealthySpawnAccount;
  dependencies.resolveHealthySpawnAccount = async (...args) => { entered(); await gate; return nativeResolve(...args); };
  dependencies.assertAccountAdmission = () => { accountProjectBindings(); };
  let dispatches = 0;
  dependencies.defer = () => { dispatches++; };
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [] });
  const id = `attempt_${crypto.randomUUID()}`;
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId: id, title: "Automatic target", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
  });
  const pending = executeSpawnRequest(request(), dependencies);
  await Promise.race([collecting, pending.then(() => { throw new Error("spawn did not wait for evidence"); })]);
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: "damaged" }); resume();
  const refused = await pending;
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toContain("account-project-bindings.json");
  expect(agentRegistry().spawnReceiptForClientAttempt(id)).toBeNull(); expect(dispatches).toBe(0);
  // Deliberate operator launches do not acquire the automatic pool restriction.
  delete dependencies.assertAccountAdmission;
  expect((await executeSpawnRequest(request(), dependencies)).status).toBe(202);
  expect(dispatches).toBe(1);
  seedAccountSource(BINDINGS_SOURCE, { schemaVersion: 1, bindings: [] });
});

test.each(["dependency", "forwarded", "scheduled"] as const)("autonomous %s spawn rechecks update admission after account evidence, while manual and receipt replay remain allowed", async (source) => {
  const cwd = statePath("autonomous-admission-cwd"); fs.mkdirSync(cwd, { recursive: true });
  process.env.LLV_SPAWN_TRANSPORT = "structured"; process.env.LLV_STRUCTURED_HOSTS = "1";
  process.env.LLV_RUNTIME_EVENTS = "1"; process.env.NEXT_PUBLIC_RUNTIME_UI = "1";
  process.env.LLV_RUNTIME_HOST_SOCKET = statePath("fixture.sock");
  let held = false, entered!: () => void, resume!: () => void;
  const collecting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const dependencies = structuredRouteDependencies(cwd) as SpawnCommandDependencies & { autonomousAdmissionHeld: () => boolean };
  if (source === "dependency") dependencies.autonomousAdmissionHeld = () => held;
  if (source === "scheduled") Object.assign(dependencies, (await import("@/lib/telegram/reportSpawn")).reportSpawnOverrides(() => true, "scheduled"));
  dependencies.defer = () => {};
  const nativeResolve = dependencies.resolveHealthySpawnAccount;
  dependencies.resolveHealthySpawnAccount = async (...args) => { entered(); await gate; return nativeResolve(...args); };
  const request = (id: string, autonomous = source === "forwarded") => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json", ...(autonomous ? { "x-llv-autonomous-spawn": "1" } : {}) },
    body: JSON.stringify({ clientAttemptId: id, title: "Autonomous admission", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
  });
  const id = `attempt_${crypto.randomUUID()}`;
  const pending = executeSpawnRequest(request(id), dependencies);
  await Promise.race([collecting, pending.then(async response => { throw new Error(`spawn returned before account evidence: ${response.status} ${JSON.stringify(await response.clone().json())}`); })]); held = true; writeDrain(drainFile(), { id: "forwarded-admission", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true }); resume();
  const refused = await pending;
  expect(refused.status).toBe(503); expect(await refused.json()).toMatchObject({ code: "AUTO_UPDATE_DRAIN" });
  expect(agentRegistry().spawnReceiptForClientAttempt(id)).toBeNull();
  held = false; releaseDrain(drainFile(), "forwarded-admission");
  expect((await executeSpawnRequest(request(id), dependencies)).status).toBe(202);
  const receipt = agentRegistry().spawnReceiptForClientAttempt(id)!;
  held = true; writeDrain(drainFile(), { id: "forwarded-admission", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
  expect((await executeSpawnRequest(request(id), dependencies)).status).toBe(202);
  expect(agentRegistry().spawnReceiptForClientAttempt(id)!.launchId).toBe(receipt.launchId);
  const manual = structuredRouteDependencies(cwd); manual.defer = () => {};
  expect((await executeSpawnRequest(request(`attempt_${crypto.randomUUID()}`, false), manual)).status).toBe(202);
  releaseDrain(drainFile(), "forwarded-admission");
});


test.each(["existing", "account-lock"] as const)("scheduled report launch respects %s drain and rechecks downstream admission", async (seam) => {
  const { launchReportConversation } = await import("@/lib/telegram/reportSpawn");
  const { productionSpawnCommandDependencies } = await import("./spawnCommand");
  const { procBackend } = await import("@/lib/proc");
  const cwd = statePath("report-lock-cwd"); fs.mkdirSync(cwd, { recursive: true });
  const originalDependencies = { ...productionSpawnCommandDependencies };
  const oldCodexBinary = process.env.LLV_CODEX_BINARY;
  const codexBinary = path.join(cwd, "codex-list-stub");
  fs.writeFileSync(codexBinary, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
  process.env.LLV_CODEX_BINARY = codexBinary;
  const fixture = structuredRouteDependencies(cwd);
  const resolveAccount = fixture.resolveSpawnAccount;
  fixture.resolveSpawnAccount = (...args) => ({ ...resolveAccount(...args), engine: "codex", accountId: "report-fixture" });
  fixture.resolveHealthySpawnAccount = async () => fixture.resolveSpawnAccount("codex", "report-fixture");
  let dispatches = 0;
  const dispatch = fixture.spawnStructuredConversation;
  fixture.spawnStructuredConversation = async input => { dispatches++; return dispatch(input); };
  Object.assign(productionSpawnCommandDependencies, fixture);
  const attempt = `attempt_${crypto.randomUUID()}`;
  const input = { trigger: "scheduled" as const, grantActive: () => true, body: { clientAttemptId: attempt, title: "Scheduled report fixture", engine: "codex", cwd, prompt: "inspect", mcpServers: [] } };
  const lock = statePath("account-selection.lock");
  const write = fs.writeFileSync;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  let blocked = false;
  try {
    if (seam === "existing") {
      writeDrain(drainFile(), { id: "report-account-lock", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
      expect(await launchReportConversation(input)).toMatchObject({ status: 503, body: { code: "AUTO_UPDATE_DRAIN" } });
      expect(agentRegistry().spawnReceiptForClientAttempt(attempt)).toBeNull(); expect(dispatches).toBe(0);
      releaseDrain(drainFile(), "report-account-lock");
    }
    fs.writeFileSync = ((file, data, ...rest) => {
      write(file, data, ...rest);
      if (!blocked && typeof file === "string" && file.endsWith(".json") && typeof data === "string" && data.includes('"holder":"spawn admission"')) {
        blocked = true;
        write(lock, JSON.stringify({ pid: process.pid, startIdentity: procBackend.processIdentity(process.pid), ns: fs.readlinkSync("/proc/self/ns/pid"), token: "report-lock-fixture", holder: "fixture hold", acquiredAt: Date.now() }));
        entered();
      }
    }) as typeof fs.writeFileSync;
    const pending = launchReportConversation(input);
    await Promise.race([waiting, pending.then(() => { throw new Error("launch never waited for account admission"); })]);
    writeDrain(drainFile(), { id: "report-account-lock", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    fs.rmSync(lock); fs.writeFileSync = write;
    expect(await pending).toMatchObject({ status: 503, body: { code: "AUTO_UPDATE_DRAIN" } });
    expect(agentRegistry().spawnReceiptForClientAttempt(attempt)).toBeNull(); expect(dispatches).toBe(0);
    releaseDrain(drainFile(), "report-account-lock");
    expect((await launchReportConversation(input)).status).toBe(202);
    for (let i = 0; i < 100 && dispatches === 0; i++) await Bun.sleep(10);
    expect(dispatches).toBe(1);
    const receipt = agentRegistry().spawnReceiptForClientAttempt(attempt)!;
    writeDrain(drainFile(), { id: "report-account-lock", target: "a".repeat(40), since: new Date().toISOString(), until: 0, persistent: true });
    expect((await launchReportConversation(input)).status).toBe(202);
    expect(agentRegistry().spawnReceiptForClientAttempt(attempt)?.launchId).toBe(receipt.launchId);
    expect((await launchReportConversation({ ...input, trigger: "manual", body: { ...input.body, clientAttemptId: `attempt_${crypto.randomUUID()}` } })).status).toBe(202);
  } finally {
    fs.writeFileSync = write;
    if (oldCodexBinary === undefined) delete process.env.LLV_CODEX_BINARY; else process.env.LLV_CODEX_BINARY = oldCodexBinary;
    if (blocked && fs.existsSync(lock) && JSON.parse(fs.readFileSync(lock, "utf8")).token === "report-lock-fixture") fs.rmSync(lock);
    releaseDrain(drainFile(), "report-account-lock"); Object.assign(productionSpawnCommandDependencies, originalDependencies);
  }
});

test.each(["recovered", "expired", "refused", "conflict", "revoked", "terminal", "superseded", "released"] as const)("direct spawn handover: %s", async (outcome) => {
  const { RuntimeHostUnavailableError } = await import("@/lib/runtime/client");
  const cwd = statePath(`direct-handover-${outcome}`);
  fs.mkdirSync(cwd, { recursive: true });
  const dependencies = structuredRouteDependencies(cwd);
  const spawn = dependencies.spawnStructuredConversation;
  const launches: string[] = [];
  let deferred: Promise<void> | undefined;
  let slept = 0;
  let authorized = true;
  dependencies.authorizeAutonomousLaunch = () => {
    if (!authorized) throw new Error("authorization revoked");
  };
  dependencies.defer = work => { deferred = work(); };
  dependencies.runtimeAdmissionRetry = {
    deadlineMs: 750,
    now: () => slept,
    sleep: async ms => {
      slept += ms;
      if (outcome === "revoked") authorized = false;
      if (outcome === "superseded" || outcome === "released") {
        const { AgentRegistry } = await import("./registry");
        const secondWriter = new AgentRegistry(agentRegistry().filename, undefined, undefined, { resolveBackendIdentity: true });
        try {
          if (outcome === "superseded") {
            expect((await secondWriter.failStructuredSpawnOffLoop(launches[0], "settled during handover")).claimed).toBe(true);
          } else {
            const receipt = secondWriter.spawnRecoverySnapshot(launches).receipts[launches[0]];
            expect(secondWriter.releaseStartingStructuredSpawn(receipt.launchId, receipt.admissionOwner!).released).toBe(true);
          }
        }
        finally { secondWriter.close(); }
      }
    },
  };
  dependencies.spawnStructuredConversation = async input => {
    launches.push(input.receipt.launchId);
    if (outcome === "refused") throw new RuntimeHostUnavailableError("authentication denied", "UNAUTHORIZED");
    if (outcome === "conflict") throw new RuntimeHostUnavailableError("idempotency key already belongs to another request", "conflict");
    if (outcome === "terminal") {
      await input.registry.failStructuredSpawnOffLoop(input.receipt.launchId, "launch already failed");
      throw new RuntimeHostUnavailableError("runtime host is unavailable");
    }
    if (outcome === "expired" || launches.length < 3) throw new RuntimeHostUnavailableError("runtime host is unavailable");
    return spawn(input);
  };
  const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST",
    headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId: `attempt_direct_handover_${outcome}`, title: "Direct handover", engine: "claude", cwd, prompt: "Continue the task", mcpServers: [] }),
  }), dependencies);
  expect(response.status).toBe(202);
  await deferred;
  const retried = outcome === "recovered" || outcome === "expired";
  expect(launches).toHaveLength(retried ? 3 : 1);
  expect(new Set(launches).size).toBe(1);
  expect(slept).toBe(retried ? 750 : ["revoked", "superseded", "released"].includes(outcome) ? 250 : 0);
  const receipt = agentRegistry().spawnRecoverySnapshot(launches).receipts[launches[0]];
  expect(receipt.state === "failed").toBe(outcome !== "recovered" && outcome !== "released");
});

test.each([true, false])("direct admission concurrent replay waits for durable publication (runtime: %s)", async runtimeAvailable => {
  const { AgentRegistry } = await import("./registry");
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const cwd = statePath(`direct-publication-replay-${runtimeAvailable}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), () => true);
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.registry = () => registry;
  let available = true;
  const client = {
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => journal.executeOperation(command),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => journal.transitionOperation(...args),
    append: async (...args: Parameters<RuntimeHostClient["append"]>) => journal.append(...args),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    snapshot: async () => journal.snapshot(), operationStatus: async (id: string) => journal.operationResult(id),
  } as RuntimeHostClient;
  dependencies.runtimeHostClient = () => available ? client : null;
  dependencies.runtimeAdmissionRetry = { now: () => 0 };
  let deferred = 0;
  dependencies.defer = () => { deferred++; };
  let stores = 0;
  const storeImages = dependencies.storeImages;
  dependencies.storeImages = images => { stores++; return storeImages(images); };
  let entered!: () => void;
  let release!: () => void;
  const publishing = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  let launchId = "";
  const write = registry.deliveryWriteOrBusy.bind(registry);
  registry.deliveryWriteOrBusy = (async (...args: Parameters<typeof registry.deliveryWriteOrBusy>) => {
    if (args[0].label === "registry.queueStructuredAdmission") {
      launchId = args[0].operationId!;
      entered();
      await held;
    }
    return write(...args);
  }) as typeof registry.deliveryWriteOrBusy;
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId: `attempt_direct_publication_${runtimeAvailable}`, title: "Durable launch publication", engine: "claude", cwd, prompt: "Continue the task", mcpServers: [] }),
  });
  const { procBackend } = await import("@/lib/proc");
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue({ ramTotal: 8 * 1024 ** 3, ramAvailable: 4 * 1024 ** 3, swapTotal: 0, swapUsed: 0 });
  let settled = false;
  const primary = executeSpawnRequest(request(), dependencies).then(response => { settled = true; return response; });
  try {
    await Promise.race([publishing, primary.then(() => { throw new Error("launch did not reach its publication barrier"); })]);
    const owner = registry.spawnReceipt(launchId)!.admissionOwner;
    expect(owner).not.toBeNull();
    expect(registry.claimStartingStructuredSpawn(launchId).claimed).toBe(false);
    available = runtimeAvailable;
    const replay = await executeSpawnRequest(request(), dependencies);
    expect(replay.status).toBe(503);
    expect(await replay.json()).toMatchObject({ code: "spawn_preparing", retryable: true, launchId });
    expect(settled).toBe(false);
    expect(registry.spawnReceipt(launchId)).toMatchObject({ state: "starting", admissionOwner: owner, queuedPinnedSpawn: null });
    expect(deferred).toBe(0);
    release();
    const accepted = await primary;
    expect(accepted.status).toBe(202);
    expect((await accepted.json()).launchId).toBe(launchId);
    const queue = registry.spawnReceipt(launchId)!.queuedPinnedSpawn;
    expect(queue).toMatchObject({ prompt: "Continue the task", admissionDeadlineAt: new Date(600_000).toISOString() });
    available = false;
    const durableReplay = await executeSpawnRequest(request(), dependencies);
    expect(durableReplay.status).toBe(202);
    expect((await durableReplay.json()).launchId).toBe(launchId);
    expect(registry.spawnReceipt(launchId)!.queuedPinnedSpawn).toEqual(queue);
    expect(deferred).toBe(1);
    expect(stores).toBe(1);
  } finally {
    release();
    try { await primary; }
    finally { memory.mockRestore(); journal.close(); registry.close(); }
  }
});

test.each(["pending", "setup", "setup-expired"] as const)("direct admission replay preserves its budget past the host setup window: %s", async phase => {
  const { AgentRegistry } = await import("./registry");
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { procBackend } = await import("@/lib/proc");
  const cwd = statePath(`direct-replay-deployment-budget-${phase}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"));
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.registry = () => registry;
  const client = {
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => journal.executeOperation(command),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => journal.transitionOperation(...args),
    append: async (...args: Parameters<RuntimeHostClient["append"]>) => journal.append(...args),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    snapshot: async () => journal.snapshot(), operationStatus: async (id: string) => journal.operationResult(id),
  } as RuntimeHostClient;
  dependencies.runtimeHostClient = () => client;
  dependencies.defer = () => {};
  let clock = Date.now();
  dependencies.runtimeAdmissionRetry = { now: () => clock };
  const time = spyOn(Date, "now").mockImplementation(() => clock);
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue({ ramTotal: 8 * 1024 ** 3, ramAvailable: 4 * 1024 ** 3, swapTotal: 0, swapUsed: 0 });
  const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
    method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify({ clientAttemptId: `attempt_direct_replay_budget_${phase}`, title: "Replay during runtime handover", engine: "claude", cwd, prompt: "Continue the task", mcpServers: [] }),
  });
  try {
    const accepted = await executeSpawnRequest(request(), dependencies);
    expect(accepted.status).toBe(202);
    const { launchId } = await accepted.json();
    const original = registry.spawnReceipt(launchId)!;
    registry.releaseStartingStructuredSpawn(launchId, original.admissionOwner!);
    clock = Date.parse(original.createdAt) + 6 * 60_000;
    expect(clock).toBeLessThan(Date.parse(original.queuedPinnedSpawn!.admissionDeadlineAt!));
    const replay = await executeSpawnRequest(request(), dependencies);
    expect(replay.status).toBe(202);
    expect((await replay.json()).launchId).toBe(launchId);
    expect(registry.spawnReceipt(launchId)).toMatchObject({ state: "starting", error: null, queuedPinnedSpawn: original.queuedPinnedSpawn });
    expect(journal.snapshot().sessions).toHaveLength(0);
    if (phase === "pending") return;
    // The fixture discards replay's deferred executor to model its exit too.
    registry.releaseStartingStructuredSpawn(launchId, registry.spawnReceipt(launchId)!.admissionOwner!);
    const { spawnStructuredConversation, recoverPendingStructuredSpawns, terminalizeStaleStructuredSpawns, reconcileStructuredSpawnReplay } = await import("@/lib/runtime/structuredSpawn");
    const { FakeEngineHost } = await import("@/lib/runtime/fixtures/fakeEngineHost");
    const { claudeTranscriptPath } = await import("./transcript");
    const { captureProcessIdentity } = await import("@/lib/processIdentity");
    let starts = 0;
    let messages = 0;
    const setupProbe: { outcome: "fresh" | "expired" | null } = { outcome: null };
    const recovery = { now: () => clock, resolveSpawnAccount: dependencies.resolveSpawnAccount,
      spawnStructuredConversation: async (input: Parameters<typeof spawnStructuredConversation>[0]) => spawnStructuredConversation(input, {
        now: () => clock,
        startHost: async () => {
          starts++;
          // The old receipt is six minutes old while this actual setup is new.
          await recoverPendingStructuredSpawns(registry, client, { now: () => clock });
          await terminalizeStaleStructuredSpawns(registry, client, { now: () => clock });
          expect((await reconcileStructuredSpawnReplay(launchId, registry, client, { now: () => clock })).state).toBe("starting");
          const second = new AgentRegistry(registry.filename);
          try {
            expect(second.spawnReceipt(launchId)).toMatchObject({ hostSetupStartedAt: new Date(clock).toISOString(), queuedPinnedSpawn: null });
          } finally { second.close(); }
          const admittedReplay = await executeSpawnRequest(request(), dependencies);
          expect(admittedReplay.status).toBe(202);
          expect((await admittedReplay.json()).launchId).toBe(launchId);
          setupProbe.outcome = "fresh";
          if (phase === "setup-expired") {
            clock += 5 * 60_000;
            expect((await reconcileStructuredSpawnReplay(launchId, registry, client, { now: () => clock })).state).toBe("failed");
            setupProbe.outcome = "expired";
            throw new Error("fixture host setup reached its separate deadline");
          }
          const sessionId = input.spec.transcript ? path.basename(input.spec.transcript, ".jsonl")
            : ["21500000", "0000", "4000", "8000", "000000000002"].join("-");
          const transcript = input.spec.transcript ?? claudeTranscriptPath(cwd, sessionId, input.account.transcriptRoot);
          fs.mkdirSync(path.dirname(transcript), { recursive: true });
          fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "fixture" } }) + "\n");
          return Object.assign(new FakeEngineHost(), { identity: { sessionId }, onStateChange: () => () => {} });
        },
        bindHost: async (registry, key, host, owner, epoch) => {
          const health = await host.health();
          registry.setStructuredHostClaimed(key, {
            kind: "claude-broker", endpoint: health.endpoint, process: captureProcessIdentity(process.pid),
            eventCursor: 0, protocolVersion: "fake", writerClaimEpoch: epoch, activeTurnRef: null, pendingAttention: [], activeFlags: [],
          }, "idle", owner, epoch);
          return () => {};
        },
        publishHost: async () => async () => {},
        deliverFirst: async () => { messages++; },
      }) };
    await recoverPendingStructuredSpawns(registry, client, recovery);
    expect(starts).toBe(1);
    expect(setupProbe.outcome).toBe(phase === "setup" ? "fresh" : "expired");
    expect(messages).toBe(phase === "setup" ? 1 : 0);
    expect(registry.spawnReceipt(launchId)!.state).toBe(phase === "setup" ? "completed" : "failed");
    await terminalizeStaleStructuredSpawns(registry, client, recovery);
    expect(starts).toBe(1);
  } finally { time.mockRestore(); memory.mockRestore(); journal.close(); registry.close(); }
});

async function realRuntimeAdmission(outcome: "recovered" | "expired" | "legacy-recovered" | "legacy-expired" | "legacy-busy" | "release-refused" | "defer-takeover" | "payload-takeover" | "owner-exit" | "startup-deferred" | "ack-lost" | "owner-released" | "settled" | "command-release" | "recovery-takeover" | "resolution-takeover" | "authorize-release" | "fallback" | "fallback-staged" | "replayed-pin" | "cleanup" | "cleanup-refused" | "watchdog") {
  const legacy = outcome === "legacy-recovered" || outcome === "legacy-expired" || outcome === "legacy-busy";
  const expired = outcome === "expired" || outcome === "legacy-expired";
  const fallback = outcome === "fallback" || outcome === "fallback-staged";
  const { RuntimeJournal } = await import("@/runtime-host/journal");
  const { RuntimeHostUnavailableError } = await import("@/lib/runtime/client");
  const { spawnStructuredConversation, recoverPendingStructuredSpawns, terminalizeStaleStructuredSpawns } = await import("@/lib/runtime/structuredSpawn");
  const { DEPLOY_ADMISSION_BUDGET_MS } = await import("@/lib/runtime/admissionBudget");
  const { FakeEngineHost } = await import("@/lib/runtime/fixtures/fakeEngineHost");
  const { claudeTranscriptPath } = await import("./transcript");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const processIdentity = await import("@/lib/processIdentity");
  const { procBackend } = await import("@/lib/proc");
  const restart = process.env.LLV_ADMISSION_RESTART_FIXTURE
    ? JSON.parse(fs.readFileSync(process.env.LLV_ADMISSION_RESTART_FIXTURE, "utf8")) as { cwd: string; result: string; ledger: string; phase: string; expired: boolean }
    : null;
  const cwd = restart?.cwd ?? statePath(`real-direct-handover-${outcome}`);
  fs.mkdirSync(cwd, { recursive: true });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const dependencies = structuredRouteDependencies(cwd);
  const { AgentRegistry } = await import("./registry");
  const registry = new AgentRegistry(path.join(cwd, "agent-registry.json"));
  dependencies.registry = () => registry;
  if (outcome === "release-refused" || outcome === "legacy-busy") {
    let refused = false;
    const write = registry.deliveryWrite.bind(registry);
    registry.deliveryWrite = (async (...args: Parameters<typeof registry.deliveryWrite>) => {
      if (!refused && args[0].label === (outcome === "release-refused" ? "spawn.admission.release" : "spawn.begin-queued-admission")) {
        refused = true;
        return { acquired: false };
      }
      return write(...args);
    }) as typeof registry.deliveryWrite;
  }
  if (outcome === "defer-takeover") {
    let claimed = false;
    const write = registry.deliveryWriteOrBusy.bind(registry);
    registry.deliveryWriteOrBusy = (async (...args: Parameters<typeof registry.deliveryWriteOrBusy>) => {
      const result = await write(...args);
      if (!claimed && args[0].label === "spawn.defer-admission" && result === true) {
        claimed = true;
        expect(registry.claimStartingStructuredSpawn(args[0].operationId!).claimed).toBe(true);
      }
      return result;
    }) as typeof registry.deliveryWriteOrBusy;
  }
  let terminalClaims = 0;
  const fail = registry.failStructuredSpawnOffLoop.bind(registry);
  registry.failStructuredSpawnOffLoop = async (...args) => {
    const result = await fail(...args);
    if (result.claimed) {
      terminalClaims++;
      if (restart) fs.appendFileSync(restart.ledger, "failed\n");
    }
    return result;
  };
  const memory = spyOn(procBackend, "systemMemory").mockReturnValue({ ramTotal: 8 * 1024 ** 3, ramAvailable: 4 * 1024 ** 3, swapTotal: 0, swapUsed: 0 });
  let clock = restart?.phase === "recover" ? (restart.expired ? 600_001 : 60_000) : 0;
  const startedAt = Date.now();
  const realDeadline = outcome === "watchdog" && process.env.LLV_ADMISSION_PROBE === "deadline";
  const time = () => outcome === "watchdog" ? Date.now() : clock;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatTicks = 0;
  let starts = 0;
  let cleanups = 0;
  let invocations = 0;
  let launchId = "";
  let messages = 0;
  let releaseOnce = true;
  const operations: string[] = [];
  let deferred: Promise<void> | undefined;
  const takeOverAdmission = () => {
    const receipt = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
    registry.releaseStartingStructuredSpawn(launchId, receipt.admissionOwner!);
    const capture = spyOn(processIdentity, "captureProcessIdentity").mockReturnValue({
      ...captureProcessIdentity(process.pid), startIdentity: "fixture-successor-admission",
    });
    try { expect(registry.claimStartingStructuredSpawn(launchId).claimed).toBe(true); }
    finally { capture.mockRestore(); }
  };
  if (outcome === "payload-takeover") {
    const write = registry.deliveryWriteOrBusy.bind(registry);
    registry.deliveryWriteOrBusy = (async (...args: Parameters<typeof registry.deliveryWriteOrBusy>) => {
      if (args[0].label === "registry.queueStructuredAdmission") {
        launchId = args[0].operationId!;
        takeOverAdmission();
      }
      return write(...args);
    }) as typeof registry.deliveryWriteOrBusy;
  }
  const resolveSpawnAccount = dependencies.resolveSpawnAccount;
  dependencies.resolveSpawnAccount = (...args) => {
    if (outcome === "resolution-takeover" && clock >= 60_000 && releaseOnce) {
      releaseOnce = false;
      takeOverAdmission();
      throw new Error("account lookup refused after admission takeover");
    }
    return resolveSpawnAccount(...args);
  };
  const client = {
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => {
      if (!command.operationId) throw new Error("fixture admission requires an operation id");
      operations.push(command.operationId);
      if (outcome === "watchdog" && (operations.length === 1 || realDeadline)) {
        if (operations.length === 1) {
          process.stdout.write("ADMISSION_WAITING\n");
          heartbeat = setInterval(() => { heartbeatTicks++; process.stdout.write("ADMISSION_HEARTBEAT\n"); }, 10);
        }
        throw new RuntimeHostUnavailableError("runtime host is unavailable");
      }
      if (outcome === "watchdog" && heartbeatTicks === 0) {
        process.stdout.write("ADMISSION_LOOP_BLOCKED\n");
        throw new Error("server loop did not run unrelated work during admission backoff");
      }
      if (outcome === "ack-lost" && clock < 60_000) {
        journal.executeOperation(command);
        throw new RuntimeHostUnavailableError("runtime host is unavailable");
      }
      if (outcome !== "watchdog" && (expired || clock < 60_000)) throw new RuntimeHostUnavailableError("runtime host is unavailable");
      const result = journal.executeOperation(command);
      if ((outcome === "command-release" || outcome === "recovery-takeover") && releaseOnce) {
        releaseOnce = false;
        if (outcome === "recovery-takeover") {
          takeOverAdmission();
          throw new RuntimeHostUnavailableError("reply lost after admission takeover");
        }
        const receipt = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
        registry.releaseStartingStructuredSpawn(launchId, receipt.admissionOwner!);
      }
      return result;
    },
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => journal.transitionOperation(...args),
    append: async (...args: Parameters<RuntimeHostClient["append"]>) => journal.append(...args),
    operationStatus: async id => journal.operationResult(id),
    effectBatch: async (kinds, after) => journal.effectBatch(100, kinds, after),
    snapshot: async () => journal.snapshot(),
  } as RuntimeHostClient;
  dependencies.runtimeHostClient = () => client;
  dependencies.defer = work => { if (!legacy && outcome !== "owner-exit" && (restart?.phase !== "accept" || restart.expired)) deferred = work(); };
  dependencies.runtimeAdmissionRetry = outcome === "watchdog" ? (realDeadline ? { deadlineMs: 750 } : undefined) : { now: time, sleep: async ms => { clock += ms; } };
  dependencies.spawnStructuredConversation = async input => {
    invocations++;
    launchId = input.receipt.launchId;
    return spawnStructuredConversation({ ...input, ...(outcome === "authorize-release" ? { authorize: async () => {
      await Promise.resolve();
      if (releaseOnce) {
        releaseOnce = false;
        const second = new AgentRegistry(registry.filename);
        try { second.releaseStartingStructuredSpawn(launchId, input.receipt.admissionOwner!); }
        finally { second.close(); }
      }
    } } : {}) }, {
      now: time,
      ...(outcome === "watchdog" ? {} : { sleep: async (ms: number) => {
        clock += ms;
        if ((outcome === "owner-released" || outcome === "settled") && operations.length === 1) {
          const second = new AgentRegistry(registry.filename);
          try {
            if (outcome === "settled") await second.failStructuredSpawnOffLoop(launchId, "settled by another writer");
            else second.releaseStartingStructuredSpawn(launchId, input.receipt.admissionOwner!);
          } finally { second.close(); }
        }
      } }),
      startHost: async () => {
        starts++;
        expect(input.account.accountId).toBe("claude-test");
        if (outcome === "cleanup" || outcome === "cleanup-refused") {
          const { StructuredHostAdoptionCleanupError } = await import("@/lib/runtime/engineHost");
          const host = new FakeEngineHost();
          host.release = async () => { cleanups++; if (outcome === "cleanup-refused") throw new Error("fixture cleanup refused"); };
          throw new StructuredHostAdoptionCleanupError("fixture host setup failed", host);
        }
        if (restart) fs.appendFileSync(restart.ledger, "host\n");
        const sessionId = input.spec.transcript ? path.basename(input.spec.transcript, ".jsonl")
          : ["21500000", "0000", "4000", "8000", "000000000001"].join("-");
        const transcript = input.spec.transcript ?? claudeTranscriptPath(cwd, sessionId, input.account.transcriptRoot);
        fs.mkdirSync(path.dirname(transcript), { recursive: true });
        fs.writeFileSync(transcript, JSON.stringify({ type: "user", message: { role: "user", content: "fixture" } }) + "\n");
        return Object.assign(new FakeEngineHost(), { identity: { sessionId }, onStateChange: () => () => {} });
      },
      bindHost: async (registry, key, host, owner, epoch) => {
        const state = await host.health();
        registry.setStructuredHostClaimed(key, {
          kind: "claude-broker", endpoint: state.endpoint, process: captureProcessIdentity(process.pid),
          eventCursor: 0, protocolVersion: "fake", writerClaimEpoch: epoch, activeTurnRef: null,
          pendingAttention: [], activeFlags: [],
        }, "idle", owner, epoch);
        return () => {};
      },
      publishHost: async () => async () => {},
      deliverFirst: async input => {
        messages++;
        if (restart) fs.appendFileSync(restart.ledger, `spawn_${input.receipt.launchId}\n`);
        expect(input.receipt.launchId).toBe(launchId);
        expect(input.prompt).toContain("Continue the task");
        if (outcome === "fallback-staged") return "held";
      },
    });
  };
  try {
    if (restart?.phase === "recover") {
      const accepted = JSON.parse(fs.readFileSync(restart.result, "utf8")) as { launchId: string; conversationId: string; deadline: string; cause?: string };
      launchId = accepted.launchId;
      const options = { now: time, resolveSpawnAccount: dependencies.resolveSpawnAccount, spawnStructuredConversation: dependencies.spawnStructuredConversation };
      await recoverPendingStructuredSpawns(registry, client, options);
      await terminalizeStaleStructuredSpawns(registry, client, options);
      const receipt = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
      expect(String(receipt.conversationId)).toBe(accepted.conversationId);
      expect(receipt.state).toBe(restart.expired ? "failed" : "completed");
      if (restart.expired) expect(receipt.error).toBe(accepted.cause!);
      expect(receipt.queuedPinnedSpawn).toBeNull();
      return;
    }
    const request = () => new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST",
      headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: `attempt_real_direct_${outcome}`, title: "Runtime handover", engine: "claude", cwd, prompt: "Continue the task", mcpServers: [], ...(fallback ? { accountId: "requested-account" } : legacy || outcome === "replayed-pin" ? { accountId: "claude-test" } : {}) }),
    });
    const response = await executeSpawnRequest(request(), dependencies);
    expect(response.status).toBe(202);
    await deferred;
    if (restart?.phase === "accept") {
      const body = await response.json();
      const receipt = registry.spawnRecoverySnapshot([body.launchId]).receipts[body.launchId];
      expect(receipt.accountPin).toBe(false);
      expect(receipt.queuedPinnedSpawn?.prompt).toContain("Continue the task");
      fs.writeFileSync(restart.result, JSON.stringify({ launchId: receipt.launchId, conversationId: receipt.conversationId,
        deadline: receipt.queuedPinnedSpawn!.admissionDeadlineAt, cause: receipt.queuedPinnedSpawn!.lastAdmissionError }));
      return;
    }
    if (outcome === "watchdog") {
      if (realDeadline) {
        const receipt = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
        expect(receipt.state).toBe("starting");
        const deadline = Date.parse(receipt.queuedPinnedSpawn!.admissionDeadlineAt!);
        await new Promise(resolve => setTimeout(resolve, Math.max(1, deadline - Date.now() + 1)));
        await recoverPendingStructuredSpawns(registry, client, { resolveSpawnAccount: dependencies.resolveSpawnAccount,
          spawnStructuredConversation: dependencies.spawnStructuredConversation });
        expect(registry.spawnRecoverySnapshot([launchId]).receipts[launchId].state).toBe("failed");
        expect(terminalClaims).toBe(1);
      }
      expect(starts).toBe(realDeadline ? 0 : 1);
      expect(messages).toBe(realDeadline ? 0 : 1);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      process.stdout.write("ADMISSION_COMPLETED\n");
      return;
    }
    const responseBody = await response.json();
    launchId = responseBody.launchId;
    let receipt = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
    if (legacy) {
      registry.queuePinnedSpawn(launchId, { ...receipt.queuedPinnedSpawn!, admissionDeadlineAt: undefined }, "Waiting for capacity");
      registry.releaseStartingStructuredSpawn(launchId, receipt.admissionOwner!);
      const options = { now: () => clock,
        resolveSpawnAccount: dependencies.resolveSpawnAccount, resolvePinnedSpawnAdmission: dependencies.resolvePinnedSpawnAdmission,
        spawnStructuredConversation: dependencies.spawnStructuredConversation };
      await terminalizeStaleStructuredSpawns(registry, client, options);
      if (outcome === "legacy-busy") {
        const pending = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
        expect(pending.state).toBe("starting");
        expect(pending.queuedPinnedSpawn?.admissionDeadlineAt).toBeUndefined();
        expect(pending.admissionOwner).toBeNull();
        expect(operations).toHaveLength(0);
        await terminalizeStaleStructuredSpawns(registry, client, options);
      }
      receipt = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
    }
    if (outcome === "settled") {
      expect(receipt.state).toBe("failed");
      expect(receipt.error).toBe("settled by another writer");
      expect(receipt.queuedPinnedSpawn).toBeNull();
      expect(starts).toBe(0);
      expect(messages).toBe(0);
      expect(operations).toHaveLength(1);
      return;
    }
    expect(receipt.state).toBe("starting");
    expect(receipt.accountPin).toBe(legacy || fallback || outcome === "replayed-pin");
    if (fallback) {
      expect(receipt.accountId).toBe("requested-account");
      expect(receipt.queuedPinnedSpawn?.launchAccountId).toBe("claude-test");
    }
    const expectedTitle = fallback ? receipt.queuedPinnedSpawn!.spec.launchProfile!.title : "Runtime handover";
    expect(receipt.queuedPinnedSpawn?.prompt).toContain("Continue the task");
    expect(() => registry.queuePinnedSpawn(launchId, { ...receipt.queuedPinnedSpawn!, accountId: "different-account" }, "Launch")).toThrow("conflicts");
    expect(() => registry.queuePinnedSpawn(launchId, { ...receipt.queuedPinnedSpawn!, admissionDeadlineAt: "invalid" }, "Launch")).toThrow("conflicts");
    expect(receipt.queuedPinnedSpawn?.admissionDeadlineAt).toBe(new Date(DEPLOY_ADMISSION_BUDGET_MS).toISOString());
    if (outcome !== "owner-exit" && outcome !== "defer-takeover" && outcome !== "payload-takeover") expect(receipt.admissionOwner).toBeNull();
    if (outcome === "defer-takeover") expect(receipt.admissionOwner).toEqual(captureProcessIdentity(process.pid));
    if (outcome === "payload-takeover") expect(receipt.admissionOwner?.startIdentity).toBe("fixture-successor-admission");
    if (outcome === "replayed-pin") {
      const healthy = dependencies.resolveHealthySpawnAccount;
      dependencies.resolveHealthySpawnAccount = async (...args) => ({ ...await healthy(...args),
        requestedAdmission: { kind: "retry-at", reason: "hard-limit", stale: false, retryAt: "2099-01-01T00:00:00.000Z" } });
      const replay = await executeSpawnRequest(request(), dependencies);
      expect(replay.status).toBe(202);
      const current = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
      expect(current.queuedPinnedSpawn).toEqual(receipt.queuedPinnedSpawn);
    }
    if (outcome === "owner-exit" || outcome === "defer-takeover" || outcome === "payload-takeover") {
      expect(invocations).toBe(outcome === "defer-takeover" ? 1 : 0);
      registry.releaseStartingStructuredSpawn(launchId, receipt.admissionOwner!);
    } else {
      expect(invocations).toBe(outcome === "legacy-busy" ? 2 : 1);
      expect(clock).toBeLessThan(60_000);
    }
    const recovery = { now: () => clock, resolveSpawnAccount: dependencies.resolveSpawnAccount,
      spawnStructuredConversation: dependencies.spawnStructuredConversation };
    clock = 60_000;
    let finalCause: string | undefined;
    if (outcome === "startup-deferred") {
      const commands = operations.length;
      await recoverPendingStructuredSpawns(registry, client, { ...recovery, actuateQueuedSpawns: false });
      expect(operations).toHaveLength(commands);
      expect(starts).toBe(0);
      expect(messages).toBe(0);
      expect(registry.spawnRecoverySnapshot([launchId]).receipts[launchId].queuedPinnedSpawn).not.toBeNull();
    }
    await recoverPendingStructuredSpawns(registry, client, recovery);
    if (outcome === "cleanup" || outcome === "cleanup-refused") {
      const receipt = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
      expect(receipt.state).toBe(outcome === "cleanup" ? "failed" : "starting");
      if (outcome === "cleanup") expect(receipt.error).toBe("fixture host setup failed");
      expect(receipt.queuedPinnedSpawn).toBeNull();
      expect(starts).toBe(1);
      expect(cleanups).toBe(1);
      expect(messages).toBe(0);
      await terminalizeStaleStructuredSpawns(registry, client, recovery);
      expect(starts).toBe(1);
      expect(cleanups).toBe(1);
      return;
    }
    if (outcome === "command-release" || outcome === "recovery-takeover" || outcome === "resolution-takeover") {
      expect(registry.spawnRecoverySnapshot([launchId]).receipts[launchId].state).toBe("starting");
      expect(starts).toBe(0);
      if (outcome === "recovery-takeover" || outcome === "resolution-takeover") {
        const current = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
        expect(current.admissionOwner?.startIdentity).toBe("fixture-successor-admission");
        registry.releaseStartingStructuredSpawn(launchId, current.admissionOwner!);
      }
      await recoverPendingStructuredSpawns(registry, client, recovery);
    }
    if (outcome === "fallback-staged") {
      const staged = registry.spawnRecoverySnapshot([launchId]);
      const pending = staged.receipts[launchId];
      expect(pending.state).toBe("path-pending");
      expect(staged.entries[`claude:${pending.key!.sessionId}`].accountId).toBe("claude-test");
      expect(registry.conversation(pending.conversationId)!.generations.at(-1)?.accountId).toBe("claude-test");
      // Publish the fake host before acknowledging its original first message.
      await client.append({ scope: { type: "session", id: pending.conversationId }, kind: "session-status",
        payload: { conversationId: pending.conversationId, sessionKey: pending.key, hostKind: "claude-broker",
          host: "hosted", turn: "idle", provenance: "structured", accountId: "claude-test", cwd,
          artifactPath: pending.artifactPath, capabilities: { steer: true, structuredAttention: true }, activeTurnId: null } });
      const message = journal.executeOperation({ kind: "send", operationId: `spawn_message_${launchId}`,
        idempotencyKey: `spawn_${launchId}`, conversationId: pending.conversationId, text: "Continue the task" });
      expect(message.receipt.status).toBe("queued");
      journal.transitionOperation(`spawn_message_${launchId}`, "delivered");
      const { recoverStagedStructuredLaunch } = await import("@/lib/runtime/structuredSpawn");
      const { stagedLaunchRecovery } = await import("@/lib/runtime/stagedRecovery");
      const progress = stagedLaunchRecovery(pending)!;
      await recoverStagedStructuredLaunch(launchId, registry, client, { now: () => progress.nextTryAt });
    }
    if (expired) {
      receipt = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
      expect(receipt.state).toBe("starting");
      expect(receipt.queuedPinnedSpawn?.admissionDeadlineAt).toBe(new Date(DEPLOY_ADMISSION_BUDGET_MS).toISOString());
      finalCause = receipt.queuedPinnedSpawn?.lastAdmissionError;
      clock = DEPLOY_ADMISSION_BUDGET_MS;
      await recoverPendingStructuredSpawns(registry, client, recovery);
    }
    receipt = registry.spawnRecoverySnapshot([launchId]).receipts[launchId];
    expect(new Set(operations)).toEqual(new Set([launchId]));
    expect(starts).toBe(expired ? 0 : 1);
    expect(messages).toBe(expired ? 0 : 1);
    expect(receipt.state).toBe(expired ? "failed" : "completed");
    if (expired) {
      expect(finalCause).toBe("runtime host is unavailable");
      expect(receipt.error).toBe(finalCause!);
    }
    expect(receipt.queuedPinnedSpawn).toBeNull();
    expect(receipt.launchProfile.title).toBe(expectedTitle);
    if (!expired) {
      const snapshot = registry.spawnRecoverySnapshot([launchId]);
      const entry = snapshot.entries[`claude:${receipt.key!.sessionId}`];
      const conversation = registry.conversation(receipt.conversationId)!;
      expect(entry.launchProfile?.title).toBe(expectedTitle);
      expect(conversation.generations.at(-1)?.launchProfile.title).toBe(expectedTitle);
      expect(entry.accountId).toBe("claude-test");
      expect(conversation.generations.at(-1)?.accountId).toBe("claude-test");
      if (fallback) {
        expect(receipt.accountId).toBe("requested-account");
        expect(conversation.pinnedAccountId).toBe("requested-account");
      }
    }
    await terminalizeStaleStructuredSpawns(registry, client, recovery);
    expect(starts).toBe(expired ? 0 : 1);
    expect(messages).toBe(expired ? 0 : 1);
    expect(journal.snapshot().sessions.filter(row => row.conversationId === receipt.conversationId)).toHaveLength(expired ? 0 : 1);
    expect(terminalClaims).toBe(expired ? 1 : 0);
  } finally {
    try { await deferred; }
    finally { clearInterval(heartbeat); journal.close(); registry.close(); memory.mockRestore(); }
  }
}

test.each(["recovered", "expired", "legacy-recovered", "legacy-expired", "legacy-busy", "release-refused", "defer-takeover", "payload-takeover", "owner-exit", "startup-deferred", "ack-lost", "owner-released", "settled", "command-release", "recovery-takeover", "resolution-takeover", "authorize-release", "fallback", "fallback-staged", "replayed-pin", "cleanup", "cleanup-refused"] as const)("direct spawn uses real runtime admission: %s", realRuntimeAdmission);

// The parent bounds this real admission loop even when the child's event loop
// cannot run a test timeout. Controls replace only the production timer seam.
test.skipIf(!process.env.LLV_ADMISSION_PROBE)("direct admission watchdog child", async () => {
  const mode = process.env.LLV_ADMISSION_PROBE;
  const original = globalThis.setTimeout;
  if (mode === "blocking" || mode === "blocking-backoff" || mode === "unbounded") {
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 250) {
        if (mode === "blocking") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        if (mode === "blocking-backoff") {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
          callback(...args);
          return original(() => {}, 0);
        }
        return original(() => {}, 60_000);
      }
      return original(callback, delay, ...args);
    }) as typeof setTimeout;
  }
  try { await realRuntimeAdmission("watchdog"); }
  finally { globalThis.setTimeout = original; }
});

test.each(["responsive", "deadline", "blocking", "blocking-backoff", "unbounded"] as const)("independently supervised direct admission: %s", async mode => {
  let waiting = false;
  let heartbeats = 0;
  let completed = false;
  let expired = false;
  let blockedLoop = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const child = Bun.spawn([process.execPath, "test", "--timeout=20000", "--test-name-pattern", "^direct admission watchdog child$", import.meta.path], {
    env: { ...process.env, LLV_ADMISSION_PROBE: mode }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const output = (async () => {
    let pending = "";
    const reader = child.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += new TextDecoder().decode(value);
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (line === "ADMISSION_WAITING") {
          waiting = true;
          deadline = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 1500);
        }
        if (line === "ADMISSION_HEARTBEAT") heartbeats++;
        if (line === "ADMISSION_LOOP_BLOCKED") blockedLoop = true;
        if (line === "ADMISSION_COMPLETED") { completed = true; clearTimeout(deadline); }
      }
    }
  })();
  const stderr = new Response(child.stderr).text();
  const startupDeadline = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 15_000);
  try {
    const code = await child.exited;
    const errors = await stderr;
    await output;
    expect({ waiting, errors: waiting ? "" : errors }).toEqual({ waiting: true, errors: "" });
    expect(waiting).toBe(true);
    if (mode === "responsive" || mode === "deadline") {
      expect({ code, expired, errors: code === 0 ? "" : errors }).toEqual({ code: 0, expired: false, errors: "" });
      expect(completed).toBe(true);
      expect(heartbeats).toBeGreaterThan(0);
    } else if (mode === "blocking-backoff") {
      expect(expired).toBe(false);
      expect(completed).toBe(false);
      expect(blockedLoop).toBe(true);
      expect(code).not.toBe(0);
    } else {
      expect(expired).toBe(true);
      expect(completed).toBe(false);
      if (mode === "blocking") expect(heartbeats).toBe(0);
      else expect(heartbeats).toBeGreaterThan(0);
    }
  } finally { clearTimeout(deadline); clearTimeout(startupDeadline); }
});


test.skipIf(!process.env.LLV_ADMISSION_RESTART_FIXTURE)("direct admission restart child", async () => {
  await realRuntimeAdmission("recovered");
});

test.each([{ outcome: "recovered", expired: false }, { outcome: "expired", expired: true }])("direct admission payload and budget survive real process exits: $outcome", async ({ expired }) => {
  const cwd = statePath(`admission-restart-${expired}`);
  fs.mkdirSync(cwd, { recursive: true });
  const result = path.join(cwd, "accepted.json");
  const ledger = path.join(cwd, "delivery.log");
  const fixture = path.join(cwd, "fixture.json");
  fs.writeFileSync(ledger, "");
  for (const phase of ["accept", "recover", "recover"]) {
    fs.writeFileSync(fixture, JSON.stringify({ cwd, result, ledger, phase, expired }));
    const child = Bun.spawn([process.execPath, "test", "--timeout=20000", "--test-name-pattern", "^direct admission restart child$", import.meta.path], {
      env: { ...process.env, LLV_ADMISSION_RESTART_FIXTURE: fixture }, stdin: "ignore", stdout: "ignore", stderr: "pipe",
    });
    const errors = new Response(child.stderr).text();
    const timer = setTimeout(() => child.kill("SIGTERM"), 25_000);
    try {
      const code = await child.exited;
      const stderr = await errors;
      expect({ code, error: code === 0 ? "" : stderr }).toEqual({ code: 0, error: "" });
    } finally { clearTimeout(timer); }
  }
  const accepted = JSON.parse(fs.readFileSync(result, "utf8")) as { launchId: string; deadline: string; cause?: string };
  expect(accepted.deadline).toBe(new Date(600_000).toISOString());
  expect(accepted.cause).toBe(expired ? "runtime host is unavailable" : undefined);
  expect(fs.readFileSync(ledger, "utf8")).toBe(expired ? "failed\n" : `host\nspawn_${accepted.launchId}\n`);
});

test.each(["json", "sqlite"] as const)("quota setup restores its title with current restrictions and ownership: %s", async storage => {
  const { AgentRegistry } = await import("./registry");
  const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const cwd = statePath(`quota-setup-title-${storage}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined,
    { sqliteMode: storage === "json" ? "off" : "sqlite" });
  try {
    const profile = emptyLaunchProfile({ cwd, title: "Continue queued work", readOnly: true, mcpServers: [] });
    const begun = registry.beginSpawnRequest({ engine: "claude", cwd, transport: "structured",
      accountId: "account-a", accountPin: true, launchProfile: profile });
    if (begun.kind !== "created") throw new Error("fixture reservation failed");
    const owner = begun.receipt.admissionOwner!;
    expect(owner).not.toBeNull();
    registry.queuePinnedSpawn(begun.receipt.launchId, {
      version: 1, accountId: "account-a", retryAt: "2026-10-24T00:00:00.000Z", locale: "en",
      admissionDeadlineAt: "2026-10-24T00:10:00.000Z", prompt: "Continue the task", imageRefs: [],
      parentArtifactPath: null, pipelineSourceConversationId: null,
      spec: { engine: "claude", command: "claude", cwd, windowName: "quota", launchProfile: { ...profile, readOnly: false } },
    }, "Waiting for capacity");
    const queued = registry.spawnReceipt(begun.receipt.launchId)!;
    expect(() => registry.beginStructuredHostSetup(begun.receipt.launchId,
      { ...captureProcessIdentity(process.pid), startIdentity: "different-owner" }, 1)).toThrow("ownership changed");
    expect(registry.spawnReceipt(begun.receipt.launchId)).toEqual(queued);
    registry.beginStructuredHostSetup(begun.receipt.launchId, owner, 2);
    const admitted = registry.spawnReceipt(begun.receipt.launchId)!;
    expect(admitted.queuedPinnedSpawn).toBeNull();
    expect(admitted.hostSetupStartedAt).toBe(new Date(2).toISOString());
    expect(admitted.launchProfile).toEqual({ ...queued.launchProfile, title: "Continue queued work" });
    expect(admitted.launchProfile.readOnly).toBe(true);
  } finally { registry.close(); }
});

test.each(["own", "foreign", "forged", "takeover", "transport"] as const)("staged fallback account settlement fences writer evidence: %s", async evidence => {
  const { AgentRegistry } = await import("./registry");
  const { recordActualSpawnAccountOffLoop } = await import("./spawnAccountSettlement");
  const { captureProcessIdentity } = await import("@/lib/processIdentity");
  const cwd = statePath(`staged-fallback-account-${evidence}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"));
  try {
    const begun = registry.beginSpawnRequest({ engine: "claude", cwd, transport: evidence === "transport" ? "tmux" : "structured",
      accountId: "account-a", accountPin: true, launchProfile: { cwd, title: "Continue fallback work" } });
    if (begun.kind !== "created") throw new Error("fixture reservation failed");
    const key = { engine: "claude" as const, sessionId: ["21500000", "0000", "4000", "8000", "000000000002"].join("-") };
    const artifactPath = path.join(cwd, `${key.sessionId}.jsonl`);
    const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
      key, cwd, artifactPath, accountId: "account-b", status: "idle", host: null,
      structuredHost: { kind: "claude-broker", endpoint: "fake", process: captureProcessIdentity(process.pid),
        eventCursor: 0, protocolVersion: "fake", writerClaimEpoch: 1, activeTurnRef: null, pendingAttention: [], activeFlags: [] },
      claimEpoch: 1, claimOwner: "fixture-writer", pendingAction: "spawn",
    });
    if (staged.kind !== "settled") throw new Error(staged.code);
    if (evidence !== "transport") {
      expect(staged.entry.accountId).toBe("account-b");
      expect(staged.conversation.generations.at(-1)?.accountId).toBe("account-b");
    }
    if (evidence === "takeover") {
      const write = registry.deliveryWriteBatchOrBusy.bind(registry);
      registry.deliveryWriteBatchOrBusy = (async (...args: Parameters<typeof registry.deliveryWriteBatchOrBusy>) => {
        const entry = registry.spawnRecoverySnapshot([begun.receipt.launchId]).entries[`claude:${key.sessionId}`];
        registry.upsert({ ...entry, claimOwner: "successor-writer", claimEpoch: 2,
          structuredHost: { ...entry.structuredHost!, writerClaimEpoch: 2 } });
        return write(...args);
      }) as typeof registry.deliveryWriteBatchOrBusy;
    }
    if (evidence === "foreign") registry.upsert({ ...registry.spawnRecoverySnapshot([begun.receipt.launchId]).entries[`claude:${key.sessionId}`], structuredHostOperationId: "different-operation" });
    await recordActualSpawnAccountOffLoop(registry, begun.receipt,
      evidence === "takeover" || evidence === "foreign" ? "account-c" : "account-b", artifactPath);
    if (evidence === "takeover") {
      const snapshot = registry.spawnRecoverySnapshot([begun.receipt.launchId]);
      expect(snapshot.entries[`claude:${key.sessionId}`]).toMatchObject({ accountId: "account-b", claimOwner: "successor-writer", claimEpoch: 2 });
      expect(registry.conversation(begun.receipt.conversationId)!.generations.at(-1)?.accountId).toBe("account-b");
      return;
    }
    const before = registry.spawnRecoverySnapshot([begun.receipt.launchId]);
    const actual = before.entries[`claude:${key.sessionId}`];
    const result = registry.recoverStructuredSpawnFromEvidence(begun.receipt.launchId,
      evidence === "forged" ? { ...actual, accountId: "account-c" } : undefined);
    expect(result.kind).toBe(evidence === "foreign" || evidence === "transport" ? "conflict" : "settled");
    const after = registry.spawnRecoverySnapshot([begun.receipt.launchId]);
    if (evidence === "foreign" || evidence === "transport") expect(after).toEqual(before);
    expect(after.entries[`claude:${key.sessionId}`].accountId).toBe("account-b");
    expect(registry.conversation(begun.receipt.conversationId)!.generations.at(-1)?.accountId).toBe("account-b");
    expect(registry.conversation(begun.receipt.conversationId)!.pinnedAccountId).toBe("account-a");
    expect(after.receipts[begun.receipt.launchId].accountId).toBe("account-a");
  } finally { registry.close(); }
});


test("spawn dispatch holds no delivery record writer", async () => {
  const { AgentRegistry } = await import("./registry");
  const { Database } = await import("bun:sqlite");
  const cwd = statePath("unlocked-spawn-cwd");
  fs.mkdirSync(cwd, { recursive: true });
  const filename = path.join(cwd, "registry.json");
  const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
  const peer = new Database(filename.replace(/\.json$/, ".sqlite"));
  const dependencies = structuredRouteDependencies(cwd);
  dependencies.registry = () => registry;
  const dispatch = dependencies.spawnStructuredConversation;
  let calls = 0;
  dependencies.spawnStructuredConversation = async input => {
    peer.exec("PRAGMA busy_timeout = 0");
    peer.exec("BEGIN IMMEDIATE");
    try { calls++; return await dispatch(input); }
    finally { peer.exec("ROLLBACK"); }
  };
  // Await the deferred work so the assertion covers the actual dispatch seam.
  let work: Promise<unknown> | undefined;
  dependencies.defer = callback => { work = callback(); };
  try {
    const response = await executeSpawnRequest(new NextRequest("http://127.0.0.1/api/spawn", {
      method: "POST", headers: { origin: "http://127.0.0.1", "sec-fetch-site": "same-origin", host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ clientAttemptId: "unlocked-dispatch", title: "Writer-free dispatch", engine: "claude", cwd, prompt: "inspect", mcpServers: [] }),
    }), dependencies);
    expect(response.status).toBe(202);
    await work;
    expect(calls).toBe(1);
  } finally { peer.close(); registry.close(); }
});
