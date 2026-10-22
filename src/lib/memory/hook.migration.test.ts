import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retireLegacyCodexMemoryHooks } from "./hookMigration";
import { codexMemoryHookConfig } from "./hook";

for (const layout of ["pretty", "compact"] as const) test(`upgrade removes every legacy port and preserves personal bytes (${layout})`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-migration-"));
  const home = path.join(root, "codex"), backup = path.join(root, "backup");
  const directory = path.join(home, ".llv", "hooks");
  fs.mkdirSync(directory, { recursive: true });
  const native = '{ "command" : "personal-command", "type" : "command", "timeout" : 7 }';
  const ownFiles = ["a".repeat(12), "b".repeat(12), "c".repeat(12)].map(hash => path.join(directory, `shared-memory-${hash}.mjs`));
  for (const file of ownFiles) fs.writeFileSync(file, "Legacy synthetic hook source");
  const trustFile = path.join(directory, `shared-memory-trust-${"d".repeat(12)}.mjs`);
  fs.writeFileSync(trustFile, "Legacy synthetic setup source");
  const temporaryFile = ownFiles[0] + "." + ["12345678", "1234", "4234", "8234", "123456789abc"].join("-") + ".tmp";
  fs.writeFileSync(temporaryFile, "Interrupted legacy synthetic hook source");
  const personalFile = path.join(directory, "personal.mjs"); fs.writeFileSync(personalFile, "Personal source");
  const groups = [native, ...ownFiles.map(file => JSON.stringify({ type: "command", command: `bun '${file}' 2>/dev/null || true`, timeout: 2 }))].map(handler => `{ "hooks" : [ ${handler} ] }`);
  const source = layout === "pretty" ? `{
  "hooks": { "UserPromptSubmit": [
    ${groups.join(",\n    ")}
  ] },
  "personal" : "preserve spacing"
}
` : `{"hooks":{"UserPromptSubmit":[${groups.join(",")}]},"personal":"preserve spacing"}`;
  fs.writeFileSync(path.join(home, "hooks.json"), source);
  const personalTable = `[hooks.state.${JSON.stringify(home + "/hooks.json:user_prompt_submit:0:0")}]
# personal comment
trusted_hash = "personal-hash"
enabled = true
`;
  const tables = ownFiles.map((_, i) => `[hooks.state.${JSON.stringify(home + `/hooks.json:user_prompt_submit:${i + 1}:0`)}]
trusted_hash = "legacy-hash"
`).join("\n");
  const personalConfig = 'model = "personal-model" # keep this exactly\n\n' + personalTable;
  fs.writeFileSync(path.join(home, "config.toml"), personalConfig + "\n" + tables);
  try {
    await retireLegacyCodexMemoryHooks(home, backup);
    const hooks = fs.readFileSync(path.join(home, "hooks.json"), "utf8");
    expect(hooks).toContain(native);
    expect(hooks).not.toContain("shared-memory-");
    expect(JSON.parse(hooks).hooks.UserPromptSubmit.flatMap((group: { hooks: unknown[] }) => group.hooks)).toEqual([JSON.parse(native)]);
    const config = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    expect(config).toContain(personalConfig);
    expect(config).not.toContain("legacy-hash");
    for (const file of [...ownFiles, trustFile, temporaryFile]) expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(personalFile, "utf8")).toBe("Personal source");
    await retireLegacyCodexMemoryHooks(home, backup);
    expect(fs.readFileSync(path.join(home, "hooks.json"), "utf8")).toBe(hooks);
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toBe(config);
    expect(fs.readdirSync(backup).length).toBeGreaterThan(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("orphaned legacy trust is retired from the generated command's declaration hash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-orphan-"));
  const home = path.join(root, "codex"), directory = path.join(home, ".llv", "hooks"); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `shared-memory-${"b".repeat(12)}.mjs`); fs.writeFileSync(file, "Legacy source");
  const command = `bun '${file}' 2>/dev/null || true`;
  const hash = Object.values(codexMemoryHookConfig({ type: "command", command, timeout: 2, additionalContextLimit: 40000 }).state)[0].trusted_hash;
  fs.writeFileSync(path.join(home, "config.toml"), `model="personal-model"\n[hooks.state.${JSON.stringify(home + "/hooks.json:user_prompt_submit:3:0")}]\ntrusted_hash=${JSON.stringify(hash)}\n`);
  try {
    await retireLegacyCodexMemoryHooks(home, path.join(root, "backup"));
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toBe('model="personal-model"\n');
    expect(fs.existsSync(file)).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a personal hooks.json symlink with no legacy hook stays byte for byte", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-personal-link-"));
  const home = path.join(root, "codex"); fs.mkdirSync(home);
  const personal = path.join(root, "personal.json"), source = '{ "hooks" : { "UserPromptSubmit" : [] } }\n';
  fs.writeFileSync(personal, source); fs.symlinkSync(personal, path.join(home, "hooks.json"));
  try {
    await retireLegacyCodexMemoryHooks(home, path.join(root, "backup"));
    expect(fs.readFileSync(personal, "utf8")).toBe(source);
    expect(fs.lstatSync(path.join(home, "hooks.json")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(root, "backup"))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a commented personal TOML table after legacy trust retains its enabled setting and text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-toml-comments-"));
  const home = path.join(root, "codex"), directory = path.join(home, ".llv", "hooks"); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `shared-memory-${"c".repeat(12)}.mjs`); fs.writeFileSync(file, "Legacy source");
  fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `bun '${file}' 2>/dev/null || true` }] }] } }));
  const personal = '# Personal table comment\n[mcp_servers.personal] # keep this\ncommand = "personal-command"\nenabled = true\n'
    + `notes = '''\n[hooks.state.${JSON.stringify(home + "/hooks.json:user_prompt_submit:0:0")}]\nenabled = false\n'''\n`;
  fs.writeFileSync(path.join(home, "config.toml"), `[hooks.state.${JSON.stringify(home + "/hooks.json:user_prompt_submit:0:0")}]\ntrusted_hash="legacy"\n` + personal);
  try {
    await retireLegacyCodexMemoryHooks(home, path.join(root, "backup"));
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toBe(personal);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("startup migration runs before host adoption and remains clean in a new process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-startup-"));
  const homes = [path.join(root, "home", ".codex"), path.join(root, "accounts", "codex", "account-a"), path.join(root, "shared", "codex", "retired", "account-b")];
  for (const home of homes) {
    const directory = path.join(home, ".llv", "hooks"); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `shared-memory-${"a".repeat(12)}.mjs`); fs.writeFileSync(file, "Legacy synthetic source");
    fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `bun '${file}' 2>/dev/null || true` }] }] } }));
    fs.writeFileSync(path.join(home, "config.toml"), `[hooks.state.${JSON.stringify(home + "/hooks.json:user_prompt_submit:0:0")}]\ntrusted_hash="legacy"\n`);
  }
  const entry = path.resolve("src/lib/viewerInstrumentation.ts");
  const script = `import { completeViewerRuntimeActivation } from ${JSON.stringify(entry)};
    import fs from "node:fs";
    await completeViewerRuntimeActivation({ initializeOperatorCapability: async () => {},
      publishHotStateActivation: () => {}, publishViewerReleaseReady: () => {}, startControllers: async () => {},
      startStructuredHosts: () => {
        for (const home of ${JSON.stringify(homes)}) {
          if (fs.readFileSync(home + "/hooks.json", "utf8").includes("shared-memory-")) throw Error("host started before migration");
          if (fs.readFileSync(home + "/config.toml", "utf8").includes("legacy")) throw Error("legacy trust survived startup");
        }
      } });`;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, HOME: path.join(root, "home"),
        CODEX_HOME: homes[0], LLV_CODEX_HOME: homes[0], XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: path.join(root, "state"),
        TMPDIR: root, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" }, stdout: "pipe", stderr: "pipe" });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(code, stderr).toBe(0);
    }
    for (const home of homes) expect(fs.readdirSync(path.join(home, ".llv", "hooks"))).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("managed account config symlinks retain their shared personal file and retire each account's trust", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-shared-config-"));
  const personal = path.join(root, "personal.toml");
  const original = 'model = "personal-model" # keep bytes\n';
  const homes = [path.join(root, "account-a"), path.join(root, "account-b")];
  let config = original;
  for (const home of homes) {
    const directory = path.join(home, ".llv", "hooks"); fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `shared-memory-${"f".repeat(12)}.mjs`); fs.writeFileSync(file, "Legacy source");
    fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `bun '${file}' 2>/dev/null || true` }] }] } }));
    config += `[hooks.state.${JSON.stringify(home + "/hooks.json:user_prompt_submit:0:0")}]\ntrusted_hash="legacy"\n`;
    fs.symlinkSync(personal, path.join(home, "config.toml"));
  }
  fs.writeFileSync(personal, config);
  try {
    for (const home of homes) await retireLegacyCodexMemoryHooks(home, path.join(root, "backup"));
    expect(fs.readFileSync(personal, "utf8")).toBe(original);
    for (const home of homes) expect(fs.lstatSync(path.join(home, "config.toml")).isSymbolicLink()).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("personal hooks in a mixed group keep their original declarations and trust records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-mixed-"));
  const home = path.join(root, "codex"), directory = path.join(home, ".llv", "hooks"); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `shared-memory-${"a".repeat(12)}.mjs`); fs.writeFileSync(file, "Legacy source");
  const native = '{ "type" : "command", "command" : "personal-one" }';
  const second = '{ "type" : "command", "command" : "personal-two" }';
  fs.writeFileSync(path.join(home, "hooks.json"), `{"hooks":{"UserPromptSubmit":[{"hooks":[${JSON.stringify({ type: "command", command: `bun '${file}' 2>/dev/null || true` })},${native},${second}]}]}}`);
  const personalConfig = [1, 2].map(index => `[hooks.state.${JSON.stringify(home + `/hooks.json:user_prompt_submit:0:${index}`)}]\ntrusted_hash="personal-${index}"\n`).join("\n");
  fs.writeFileSync(path.join(home, "config.toml"), personalConfig);
  try {
    await retireLegacyCodexMemoryHooks(home, path.join(root, "backup"));
    const hooks = fs.readFileSync(path.join(home, "hooks.json"), "utf8");
    expect(hooks).toContain(native); expect(hooks).toContain(second);
    const config = fs.readFileSync(path.join(home, "config.toml"), "utf8"); expect(config).toContain(personalConfig);
    const state = (Bun.TOML.parse(config) as { hooks: { state: Record<string, { trusted_hash: string }> } }).hooks.state;
    const groups = JSON.parse(hooks).hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    for (const [group, entry] of groups.entries()) for (const [handler, value] of entry.hooks.entries()) {
      const key = `${home}/hooks.json:user_prompt_submit:${group}:${handler}`;
      expect(state[key]?.trusted_hash).toBe(value.command === "personal-one" ? "personal-1" : "personal-2");
    }
    await retireLegacyCodexMemoryHooks(home, path.join(root, "backup"));
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toBe(config);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const failure of ["invalid JSON", "invalid TOML", "backup refused", "linked hook"] as const) test(`migration preserves all inputs when ${failure}, then retries after repair`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-hook-retry-"));
  const home = path.join(root, "codex"), backup = path.join(root, "backup");
  const directory = path.join(home, ".llv", "hooks"); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `shared-memory-${"e".repeat(12)}.mjs`); fs.writeFileSync(file, "Legacy source");
  const hooksFile = path.join(home, "hooks.json"), configFile = path.join(home, "config.toml");
  const validHooks = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `bun '${file}' 2>/dev/null || true` }] }] } });
  fs.writeFileSync(hooksFile, failure === "invalid JSON" ? "broken JSON" : validHooks);
  fs.writeFileSync(configFile, failure === "invalid TOML" ? "[broken TOML" : 'model="personal-model"\n');
  if (failure === "backup refused") fs.writeFileSync(backup, "Block backup directory creation");
  if (failure === "linked hook") { fs.renameSync(file, path.join(root, "personal.mjs")); fs.symlinkSync(path.join(root, "personal.mjs"), file); }
  try {
    const before = [fs.readFileSync(hooksFile, "utf8"), fs.readFileSync(configFile, "utf8")];
    await expect(retireLegacyCodexMemoryHooks(home, backup)).rejects.toThrow();
    expect(fs.readFileSync(hooksFile, "utf8")).toBe(before[0]);
    expect(fs.readFileSync(configFile, "utf8")).toBe(before[1]);
    expect(fs.readFileSync(file, "utf8")).toBe("Legacy source");
    if (failure === "backup refused") fs.unlinkSync(backup);
    if (failure === "linked hook") { fs.unlinkSync(file); fs.writeFileSync(file, "Legacy source"); }
    fs.writeFileSync(hooksFile, validHooks); fs.writeFileSync(configFile, 'model="personal-model"\n');
    await retireLegacyCodexMemoryHooks(home, backup);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(configFile, "utf8")).toBe('model="personal-model"\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
