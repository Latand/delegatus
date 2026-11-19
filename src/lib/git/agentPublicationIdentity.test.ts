import { expect, test } from "bun:test";
import { agentCodexPublicationPolicy, agentPublicationIdentityEnv } from "./agentPublicationIdentity";

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


test.each([{ include_only: ["PATH"] }, { filters: { PATH: "include" } }])("Codex shell attempt and cache bindings preserve budget refusal through $policy", async policy => {
  const { materializeStructuredHostAccess } = await import("@/lib/runtime/structuredSpawn");
  const { agentArtifactCacheEnv } = await import("@/lib/runtime/agentConfigSandbox");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const access = materializeStructuredHostAccess(false, { ...process.env }, null);
  const attempt = fs.mkdtempSync(path.join(os.tmpdir(), "codex-policy-attempt-"));
  try {
    const stat = fs.statSync(attempt);
    const source: NodeJS.ProcessEnv = { ...access.env, ...agentArtifactCacheEnv(access.env), LLV_ATTEMPT_TIMING_ROOT: attempt,
      LLV_ATTEMPT_TIMING_ROOT_IDENTITY: `${stat.dev}:${stat.ino}`, LLV_ATTEMPT_TMP_MAX_BYTES: "1" };
    fs.mkdirSync(path.join(attempt, "tmp"));
    fs.writeFileSync(path.join(attempt, "tmp", "allocation"), Buffer.alloc(4096));
    const result = agentCodexPublicationPolicy(policy, source);
    const bindings = result.set as Record<string, string>;
    expect(bindings).toMatchObject({
      TMPDIR: source.TMPDIR,
      LLV_EVIDENCE_DIR: source.LLV_EVIDENCE_DIR,
      LLV_ATTEMPT_TIMING_ROOT: attempt,
      LLV_ATTEMPT_TIMING_ROOT_IDENTITY: `${stat.dev}:${stat.ino}`,
      LLV_ATTEMPT_TMP_MAX_BYTES: "1",
      UV_CACHE_DIR: source.UV_CACHE_DIR,
      BUN_INSTALL_CACHE_DIR: source.BUN_INSTALL_CACHE_DIR,
    });
    const included = "include_only" in result
      ? new Set(result.include_only as string[])
      : new Set(Object.keys(result.filters as Record<string, string>));
    const shellEnv: NodeJS.ProcessEnv = {
      NODE_ENV: source.NODE_ENV,
      PATH: source.PATH,
      ...Object.fromEntries(Object.entries(bindings).filter(([key]) => included.has(key))),
    };
    expect(shellEnv).toMatchObject(bindings);
    expect(shellEnv.PATH).toBe(source.PATH);
    if ("include_only" in policy) {
      expect(result.include_only).toEqual(expect.arrayContaining(Object.keys(bindings)));
    } else {
      expect(result.filters).toMatchObject(Object.fromEntries(Object.keys(bindings).map(key => [key, "include"])));
    }
    const check = spawnSync(process.execPath, [path.resolve("scripts/attempt-tmp-budget.ts")], { env: shellEnv, encoding: "utf8" });
    expect(check.status).toBe(73);
    expect(check.stderr).toContain("Refusing another check/export");
  } finally {
    access.cleanup();
    fs.rmSync(attempt, { recursive: true, force: true });
  }
});
