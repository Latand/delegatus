// destructive-code: installations and drift repairs use fake account homes only.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { copyDestructiveGuardAssets } from "../../../scripts/destructive-guard-assets";
import { agentDestructiveGuardEnv, computeDestructivePolicy, destructiveGuardHandler, ensureDestructiveGuard, guardTrust, publishDestructiveGuard } from "./destructiveGuard";
import { guardFixture } from "./destructiveGuard.fixture";
const fixtures: ReturnType<typeof guardFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function fixture() { const f = guardFixture(); fixtures.push(f); return f; }

test("a bundled entry finds its shipped dist assets and never runs the guard CLI as an imported module", async () => {
  const f = fixture(), dist = f.tmp + "/packaged/dist", entry = f.tmp + "/entry.ts";
  fs.mkdirSync(dist, { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.resolve(import.meta.dir, "../../../node_modules")), f.tmp + "/packaged/node_modules", "dir");
  fs.writeFileSync(entry, `import { publishDestructiveGuard } from ${JSON.stringify(path.join(import.meta.dir, "destructiveGuard.ts"))};\nconsole.log(JSON.stringify(publishDestructiveGuard(process.env)));\n`);
  copyDestructiveGuardAssets(path.resolve(import.meta.dir, "../../.."), dist);
  const built = await Bun.build({ entrypoints: [entry], outdir: dist, naming: "packaged-entry.mjs", target: "bun", format: "esm", packages: "external", tsconfig: path.resolve(import.meta.dir, "../../../tsconfig.json") });
  expect(built.success, built.logs.map(log => log.message).join("\n")).toBeTrue();
  f.assertOwned(dist); f.assertOwned(entry);
  const result = Bun.spawnSync([process.execPath, dist + "/packaged-entry.mjs"], { cwd: f.cwd, env: { ...f.env, TMPDIR: f.root, LLV_GATE_TEMP_ROOT: f.root } });
  expect(result.exitCode, result.stderr.toString()).toBe(0); expect(result.stderr.toString()).toBe("");
  const installed = JSON.parse(result.stdout.toString());
  expect(fs.readFileSync(installed.program, "utf8")).toBe(fs.readFileSync(dist + "/agent-guard/destructive-guard.mjs", "utf8"));
  expect(fs.existsSync(f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL!)).toBeFalse();
}, 30_000);

for (const engine of ["claude", "codex"] as const) test(`${engine} account installation preserves personal bytes and repairs drift at the launch boundary`, () => {
  const f = fixture();
  for (const home of [path.join(f.home, engine === "claude" ? ".claude" : ".codex"), path.join(f.home, ".config/delegatus/accounts", engine, "managed")]) {
    const file = path.join(home, engine === "claude" ? "settings.json" : "hooks.json");
    const personal = '"personal": { "keep": true }, "hooks": { "PreToolUse": [{ "matcher": "Read", "hooks": [{ "type": "command", "command": "printf personal" }] }] }';
    fs.writeFileSync(file, `{ ${personal} }`);
    if (engine === "codex") fs.writeFileSync(home + "/config.toml", '# personal bytes\nmodel = "fixture"\n');
    f.assertOwned(home);
    for (const drift of ["none", "remove", "edit", "replace-command", "trust"] as const) {
      if (drift === "remove" || drift === "edit") {
        const value = JSON.parse(fs.readFileSync(file, "utf8"));
        if (drift === "remove") value.hooks.PreToolUse.pop();
        else value.hooks.PreToolUse.at(-1).hooks[0].command += " drift";
        fs.writeFileSync(file, JSON.stringify(value));
      }
      if (drift === "replace-command") {
        const value = JSON.parse(fs.readFileSync(file, "utf8")); value.hooks.PreToolUse.at(-1).hooks[0].command = "printf drifted";
        fs.writeFileSync(file, JSON.stringify(value));
      }
      if (drift === "trust" && engine === "codex") fs.writeFileSync(home + "/config.toml", '# personal bytes\nmodel = "fixture"\n');
      const result = ensureDestructiveGuard({ engine, home, source: f.env });
      expect(result.hook).toBe("account");
      const raw = fs.readFileSync(file, "utf8"), data = JSON.parse(raw);
      if (drift === "none") {
        expect(raw).toContain('"personal": { "keep": true }');
        expect(raw).toContain('{ "matcher": "Read", "hooks": [{ "type": "command", "command": "printf personal" }] }');
      }
      expect(data.personal).toEqual({ keep: true });
      expect(data.hooks.PreToolUse[0].hooks[0].command).toBe("printf personal");
      const group = data.hooks.PreToolUse.at(-1);
      expect(group.hooks[0]).toEqual(destructiveGuardHandler(f.env));
      if (engine === "codex") {
        const config = fs.readFileSync(home + "/config.toml", "utf8");
        expect(config).toContain('# personal bytes\nmodel = "fixture"\n');
        const states = (Bun.TOML.parse(config) as { hooks: { state: Record<string, unknown> } }).hooks.state;
        expect(states[`${fs.realpathSync(file)}:pre_tool_use:${data.hooks.PreToolUse.length - 1}:0`]).toEqual({ enabled: true, trusted_hash: guardTrust(group) });
      }
    }
  }
});

test("Codex uses canonical trust keys through symlinked homes and preserves a linked shared config", () => {
  const f = fixture(), realHome = path.join(f.home, ".codex"), alias = path.join(f.tmp, "account-link");
  fs.symlinkSync(realHome, alias);
  const shared = path.join(f.home, "shared-config.toml"); fs.writeFileSync(shared, '# shared\nmodel = "fixture"\n');
  fs.symlinkSync(shared, realHome + "/config.toml");
  expect(ensureDestructiveGuard({ engine: "codex", home: alias, source: f.env }).hook).toBe("account");
  expect(fs.lstatSync(realHome + "/config.toml").isSymbolicLink()).toBeTrue();
  fs.appendFileSync(shared, `\n[hooks.state.${JSON.stringify(alias + "/hooks.json:pre_tool_use:0:0")}]\nenabled = true\ntrusted_hash = "drifted"\n`);
  expect(ensureDestructiveGuard({ engine: "codex", home: alias, source: f.env }).hook).toBe("account");
  const config = fs.readFileSync(shared, "utf8");
  expect(config).toContain(JSON.stringify(realHome + "/hooks.json:pre_tool_use:0:0"));
  expect(config).not.toContain(alias + "/hooks.json");
});

for (const [engine, personalTrust] of [["claude", false], ["codex", false], ["codex", true]] as const) test(`${engine} preserves a personal group inserted before its recorded managed group (personal trust: ${personalTrust})`, () => {
  const f = fixture(), home = engine === "claude" ? f.env.CLAUDE_CONFIG_DIR! : f.env.CODEX_HOME!;
  const file = home + (engine === "claude" ? "/settings.json" : "/hooks.json");
  fs.writeFileSync(file, '{ "hooks": { "PreToolUse": [{ "matcher": "Read", "hooks": [] }] } }');
  expect(ensureDestructiveGuard({ engine, home, source: f.env }).hook).toBe("account");
  const personal = '{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "printf personal-insertion", "timeout": 7 }] }';
  const installed = JSON.parse(fs.readFileSync(file, "utf8"));
  const group = installed.hooks.PreToolUse[1];
  fs.writeFileSync(file, `{ "hooks": { "PreToolUse": [${JSON.stringify(installed.hooks.PreToolUse[0])}, ${personal}, ${JSON.stringify(group)}] } }`);
  if (personalTrust) fs.writeFileSync(home + "/config.toml", `[hooks.state.${JSON.stringify(fs.realpathSync(file) + ":pre_tool_use:1:0")}]\nenabled = true\ntrusted_hash = "personal-trust"\n`);
  for (let launch = 0; launch < 2; launch++) {
    expect(ensureDestructiveGuard({ engine, home, source: f.env }).hook).toBe("account");
    const raw = fs.readFileSync(file, "utf8"), data = JSON.parse(raw);
    expect(raw).toContain(personal);
    expect(data.hooks.PreToolUse).toHaveLength(3);
    expect(data.hooks.PreToolUse[1].hooks[0].command).toBe("printf personal-insertion");
    expect(data.hooks.PreToolUse[2]).toEqual(group);
    if (engine === "codex") {
      const config = Bun.TOML.parse(fs.readFileSync(home + "/config.toml", "utf8")) as { hooks: { state: Record<string, unknown> } };
      expect(config.hooks.state[`${fs.realpathSync(file)}:pre_tool_use:1:0`]).toEqual(personalTrust ? { enabled: true, trusted_hash: "personal-trust" } : undefined);
      expect(config.hooks.state[`${fs.realpathSync(file)}:pre_tool_use:2:0`]).toEqual({ enabled: true, trusted_hash: guardTrust(group) });
    }
  }
});

test("managed Claude homes without settings keep the shared capability default", () => {
  const f = fixture(), home = path.join(f.home, ".config/delegatus/accounts/claude/managed");
  expect(ensureDestructiveGuard({ engine: "claude", home, source: f.env }).hook).toBe("per-launch");
  expect(fs.existsSync(home + "/settings.json")).toBeFalse();
});

for (const engine of ["claude", "codex"] as const) test(`${engine} preserves a personal replacement at the removed managed group's recorded position`, () => {
  const f = fixture(), home = engine === "claude" ? f.env.CLAUDE_CONFIG_DIR! : f.env.CODEX_HOME!;
  const file = home + (engine === "claude" ? "/settings.json" : "/hooks.json");
  expect(ensureDestructiveGuard({ engine, home, source: f.env }).hook).toBe("account");
  const personal = '{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "printf personal-replacement", "timeout": 10 }] }';
  fs.writeFileSync(file, `{ "hooks": { "PreToolUse": [${personal}] } }`);
  if (engine === "codex") fs.writeFileSync(home + "/config.toml", `[hooks.state.${JSON.stringify(fs.realpathSync(file) + ":pre_tool_use:0:0")}]\nenabled = true\ntrusted_hash = "personal-trust"\n`);
  expect(ensureDestructiveGuard({ engine, home, source: f.env }).hook).toBe("account");
  const raw = fs.readFileSync(file, "utf8"), groups = JSON.parse(raw).hooks.PreToolUse;
  expect(raw).toContain(personal); expect(groups).toHaveLength(2);
  expect(groups[1].hooks).toEqual([destructiveGuardHandler(f.env)]);
  if (engine === "codex") {
    const states = (Bun.TOML.parse(fs.readFileSync(home + "/config.toml", "utf8")) as { hooks: { state: Record<string, unknown> } }).hooks.state;
    expect(states[`${fs.realpathSync(file)}:pre_tool_use:0:0`]).toEqual({ enabled: true, trusted_hash: "personal-trust" });
  }
});

test("published guard bytes, mode and replaced symlinks are repaired without touching link targets", () => {
  const f = fixture(), file = path.join(f.installed.directory, "rm"), sentinel = f.tmp + "/sentinel";
  fs.writeFileSync(sentinel, "owned sentinel");
  for (const drift of ["bytes", "mode", "symlink"]) {
    if (drift === "bytes") fs.writeFileSync(file, "edited");
    if (drift === "mode") fs.chmodSync(file, 0o777);
    if (drift === "symlink") { f.assertOwned(file); fs.unlinkSync(file); fs.symlinkSync(sentinel, file); }
    publishDestructiveGuard(f.env);
    expect(fs.lstatSync(file).isSymbolicLink()).toBeFalse(); expect(fs.statSync(file).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("owned sentinel");
  }
});

test("a shared policy retains every project and the last valid configured roots", () => {
  const f = fixture(), file = path.join(f.state, "destructive-guard-protected.json");
  fs.writeFileSync(file, JSON.stringify(["~/private-data", f.tmp + "/shared-secret"]));
  const options = { home: f.home, projects: [f.cwd], accounts: [], cwd: f.cwd };
  const first = computeDestructivePolicy(f.env, options);
  expect(first.sealed).toContainEqual({ path: f.cwd, kind: "another project" });
  expect(first.configured).toEqual([f.home + "/private-data", f.tmp + "/shared-secret"]);
  fs.writeFileSync(file, "invalid");
  const second = computeDestructivePolicy(f.env, { ...options, previous: first });
  expect(second.configured).toEqual(first.configured);
  expect(second.digest).toBe(first.digest);
});

test("a project registration cannot downgrade state into an own-project exception", () => {
  const f = fixture();
  const policy = computeDestructivePolicy(f.env, { home: f.home, projects: [f.state], accounts: [] });
  expect(policy.sealed.find(entry => entry.path === f.state)?.kind).toBe("the Delegatus state directory");
});

test("launch environment binds the actual cwd and real journal using serializable string values", () => {
  const f = fixture(), env = agentDestructiveGuardEnv(f.env, { cwd: f.cwd });
  expect(env.PATH?.split(path.delimiter)[0]).toBe(f.installed.directory);
  expect(env.LLV_DESTRUCTIVE_GUARD_OWN?.split(":" )).toContain(f.cwd);
  expect(env.LLV_DESTRUCTIVE_GUARD_JOURNAL).toBe(f.state + "/destructive-guard/refusals.ndjson");
  expect(Object.values(env).every(value => typeof value === "string")).toBeTrue();
  expect(agentDestructiveGuardEnv({ ...f.env, LLV_DESTRUCTIVE_GUARD_BUN: undefined, LLV_DOCKER_NSENTER_SHIMS: "1" }, { cwd: f.cwd }).LLV_DESTRUCTIVE_GUARD_BUN).toBe("bun");
});

for (const engine of ["claude", "codex"] as const) test(`${engine} preserves personal handlers when retiring a mixed managed group`, () => {
  const f = fixture(), home = engine === "claude" ? f.env.CLAUDE_CONFIG_DIR! : f.env.CODEX_HOME!;
  const file = home + (engine === "claude" ? "/settings.json" : "/hooks.json");
  const personal = '{ "type": "command", "command": "printf personal", "timeout": 7 }';
  const old = destructiveGuardHandler(f.env);
  fs.writeFileSync(file, `{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [${personal}, ${JSON.stringify(old)}] }] } }`);
  if (engine === "codex") {
    const key = `${fs.realpathSync(file)}:pre_tool_use:0:1`;
    fs.writeFileSync(home + "/config.toml", `[hooks.state.${JSON.stringify(key)}]\nenabled = true\ntrusted_hash = "old"\n`);
  }
  expect(ensureDestructiveGuard({ engine, home, source: f.env }).hook).toBe("account");
  const raw = fs.readFileSync(file, "utf8"), data = JSON.parse(raw);
  expect(raw).toContain(personal);
  expect(data.hooks.PreToolUse[0].hooks[0].command).toBe("printf personal");
  expect(data.hooks.PreToolUse.at(-1).hooks).toEqual([old]);
  if (engine === "codex") {
    const config = Bun.TOML.parse(fs.readFileSync(home + "/config.toml", "utf8")) as { hooks: { state: Record<string, { enabled: boolean }> } };
    expect(config.hooks.state[`${fs.realpathSync(file)}:pre_tool_use:0:1`]!.enabled).toBeFalse();
  } else expect(data.hooks.PreToolUse[0].hooks).toHaveLength(1);
});
