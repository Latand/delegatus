import { expect, test } from "bun:test";
import { agentCodexPublicationPolicy, agentPublicationIdentityEnv } from "./agentPublicationIdentity";
import os from "node:os";
import path from "node:path";

test.each([
  {},
  { inherit: "core", set: { GIT_AUTHOR_EMAIL: "unsafe", OTHER: "kept" } },
  { include_only: ["PATH", "HOME"], exclude: ["PRIVATE_*"] },
  { filters: { PATH: "include", HOME: "include", "PRIVATE_*": "exclude" } },
  { filters: { "PRIVATE_*": "exclude" } },
])("Codex publication overrides protect identity while preserving filter restrictions", (policy) => {
  const source: NodeJS.ProcessEnv = { NODE_ENV: "test", LLV_PUBLICATION_NAME: "Build Agent", LLV_PUBLICATION_EMAIL: ["no-reply", "build.example.invalid"].join("@") };
  const original = JSON.stringify(policy);
  const override = agentCodexPublicationPolicy(policy, source);
  expect(override.set).toEqual(agentPublicationIdentityEnv(source));
  if ("include_only" in policy) expect(override.include_only).toEqual([...new Set([...policy.include_only!, ...Object.keys(agentPublicationIdentityEnv(source))])]);
  if ("filters" in policy && Object.values(policy.filters!).includes("include")) {
    expect(override.filters).toEqual(Object.fromEntries(Object.keys(agentPublicationIdentityEnv(source)).map((key) => [key, "include"])));
  } else expect(override.filters).toBeUndefined();
  expect(JSON.stringify(policy)).toBe(original);
  expect(override.inherit).toBeUndefined();
  expect(override.exclude).toBeUndefined();
});

test.each([
  { include_only: ["PATH", "HOME"] },
  { filters: { PATH: "include", HOME: "include", "PRIVATE_*": "exclude" } },
])("Codex shell policy forwards the gate priority binding through $policy", policy => {
  const prioritySource = JSON.stringify({ database: "fixture-state.sqlite", taskIds: ["task-one"] });
  const source = {
    NODE_ENV: "test",
    LLV_PUBLICATION_NAME: "Build Agent",
    LLV_PUBLICATION_EMAIL: ["no-reply", "build.example.invalid"].join("@"),
    LLV_GATE_CPU_PRIORITY_SOURCE: prioritySource,
  };
  const result = agentCodexPublicationPolicy(policy, source);
  expect((result.set as Record<string, string>).LLV_GATE_CPU_PRIORITY_SOURCE).toBe(prioritySource);
  if ("include_only" in policy) {
    expect(result.include_only).toContain("LLV_GATE_CPU_PRIORITY_SOURCE");
  } else {
    expect((result.filters as Record<string, string>).LLV_GATE_CPU_PRIORITY_SOURCE).toBe("include");
  }
});


test.each([{ include_only: ["PATH"] }, { filters: { PATH: "include" } }])("Codex shell storage bindings survive configured filters", async policy => {
  const { materializeStructuredHostAccess } = await import("@/lib/runtime/structuredSpawn");
  const access = materializeStructuredHostAccess(false, { ...process.env }, null);
  try {
    const result = agentCodexPublicationPolicy(policy, access.env);
    expect(result.set).toMatchObject({ TMPDIR: access.env.TMPDIR, LLV_EVIDENCE_DIR: access.env.LLV_EVIDENCE_DIR });
    if ("include_only" in policy) expect(result.include_only).toEqual(expect.arrayContaining(["TMPDIR", "LLV_EVIDENCE_DIR"]));
    else expect(result.filters).toMatchObject({ TMPDIR: "include", LLV_EVIDENCE_DIR: "include" });
  } finally { access.cleanup(); }
});

test("Codex shell inclusion filters preserve shared package cache pins", () => {
  const source = { NODE_ENV: "test", BUN_INSTALL_CACHE_DIR: "/machine/bun", UV_CACHE_DIR: "/machine/uv", GOMODCACHE: "/machine/go" };
  const result = agentCodexPublicationPolicy({ include_only: ["PATH", "HOME"] }, source);
  expect(result.set).toMatchObject({ BUN_INSTALL_CACHE_DIR: source.BUN_INSTALL_CACHE_DIR,
    UV_CACHE_DIR: source.UV_CACHE_DIR, GOMODCACHE: source.GOMODCACHE });
  expect(result.include_only).toEqual(expect.arrayContaining(Object.keys(source).filter(key => key !== "NODE_ENV")));
});

test("Codex filtered shell resolves Bun and uv caches after HOME and XDG isolation", async () => {
  const { materializeStructuredHostAccess } = await import("@/lib/runtime/structuredSpawn");
  const access = materializeStructuredHostAccess(false, { ...process.env, HOME: os.homedir() }, null, undefined,
    { pipelineId: "filtered-cache-test", launchId: "filtered-cache-test-launch", retainUntilClose: false });
  try {
    const policy = agentCodexPublicationPolicy({ include_only: ["PATH", "HOME"] }, access.env);
    const effective = { ...access.env, ...(policy.set as NodeJS.ProcessEnv),
      HOME: path.join(os.tmpdir(), "codex-policy-isolated-home"), XDG_CACHE_HOME: path.join(os.tmpdir(), "codex-policy-isolated-xdg") };
    const bun = Bun.spawnSync([process.execPath, "pm", "cache"], { env: effective, stdout: "pipe", stderr: "pipe" });
    expect(bun.exitCode).toBe(0);
    expect(bun.stdout.toString().trim()).toBe(access.env.BUN_INSTALL_CACHE_DIR!);
    const uv = Bun.which("uv");
    if (uv) {
      const result = Bun.spawnSync([uv, "cache", "dir"], { env: effective, stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().trim()).toBe(access.env.UV_CACHE_DIR!);
    }
    expect(policy.include_only).toEqual(expect.arrayContaining(["BUN_INSTALL_CACHE_DIR", "UV_CACHE_DIR", "GOMODCACHE"]));
  } finally { access.cleanup(); }
});
