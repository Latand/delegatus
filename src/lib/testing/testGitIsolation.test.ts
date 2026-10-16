import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Replay the removed repair fixture's rev-parse -> write path, with a synthetic
// inherited guard. Even the red control can only touch this test's own root.
test.each(["node", "node-no-home", "bun", "bun-object", "bun-sync", "bun-sync-object", "bun-sync-default"])("preload confines fixture hook writes with inherited launch config: %s", (runner) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-isolation-"));
  try {
    const inherited = path.join(root, "inherited-hooks");
    fs.mkdirSync(inherited);
    const hook = path.join(inherited, "pre-push");
    fs.writeFileSync(hook, "inherited guard body\n");
    const home = path.join(root, "launch-home"); fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, ".gitconfig"), `[core]\n hooksPath = ${inherited.replaceAll("\\", "/")}\n`);
    fs.writeFileSync(path.join(root, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(path.resolve("test-preload.ts"))}]\n`);
    fs.writeFileSync(path.join(root, "fixture.test.ts"), `
      import { test, expect } from "bun:test";
      import { spawnSync } from "node:child_process";
      import fs from "node:fs"; import path from "node:path"; import os from "node:os";
      test("fixture hook remains private", async () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), "fixture-repo-"));
        const git = async (...args) => {
          if (${JSON.stringify(runner)}.startsWith("node")) {
            const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
            expect(r.status, r.stderr).toBe(0); return r.stdout.trim();
          }
          const mode = ${JSON.stringify(runner)};
          const options = { cwd: repo, stdout: "pipe", stderr: "pipe" };
          const r = mode === "bun-sync-default" ? Bun.spawnSync(["git", "-C", repo, ...args])
            : mode === "bun-sync-object" ? Bun.spawnSync({ cmd: ["git", ...args], ...options })
            : mode === "bun-sync" ? Bun.spawnSync(["git", ...args], options)
            : mode === "bun-object" ? Bun.spawn({ cmd: ["git", ...args], ...options })
            : Bun.spawn(["git", ...args], options);
          if (mode.startsWith("bun-sync")) { expect(r.exitCode).toBe(0); return r.stdout.toString().trim(); }
          const output = await new Response(r.stdout).text(); expect(await r.exited).toBe(0); return output.trim();
        };
        await git("init", "-q");
        const hooks = path.resolve(repo, await git("rev-parse", "--git-path", "hooks"));
        fs.mkdirSync(hooks, { recursive: true });
        fs.writeFileSync(path.join(hooks, "pre-push"), "fixture refusal\\n");
        expect(hooks).toBe(path.join(repo, ".git", "hooks"));
        const { agentPublicationIdentityEnv } = await import(${JSON.stringify(path.resolve("src/lib/git/agentPublicationIdentity.ts"))});
        const guard = agentPublicationIdentityEnv(process.env).LLV_AGENT_GIT_GUARD_DIR;
        expect(path.relative(os.tmpdir(), guard).startsWith("..")).toBe(false);
        expect(process.env.LLV_STAGE_GIT_RECEIPT).toBeUndefined();
        expect(process.env.LLV_AGENT_GIT_GUARD_DIR).toBeUndefined();
      });
    `);
    const result = spawnSync(process.execPath, ["test", "./fixture.test.ts"], { cwd: root, encoding: "utf8", timeout: 30_000,
      env: { ...process.env, LLV_STATE_DIR: undefined, HOME: runner === "node-no-home" ? undefined : home, XDG_CONFIG_HOME: home, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: inherited, LLV_AGENT_GIT_GUARD_DIR: inherited, LLV_STAGE_GIT_RECEIPT: path.join(root, "foreign-receipt") } });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.readFileSync(hook, "utf8")).toBe("inherited guard body\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
