// destructive-code: only JSON is evaluated; test doubles record only.
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import { guardFixture } from "./destructiveGuard.fixture";
const fixtures: ReturnType<typeof guardFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
for (const engine of ["claude", "codex"]) test(`${engine} PreToolUse contract denies a literal delete and admits an owned delete`, () => {
  const f = guardFixture(); fixtures.push(f);
  const cases = [[`rm -rf '${f.state}'`, true], ["rm -rf \"$UNKNOWN\"/*", true], ['rm -rf "$HOME"', true],
    [`rm -rf '${f.home}/Projects/a/..'/*`, true], [`find '${f.state}' -delete`, true],
    [`rsync --delete '${f.cwd}/' '${f.state}/'`, true], [`mv '${f.cwd}/output' '${f.state}/output'`, true],
    [`mv -vt'${f.state}' '${f.cwd}/output'`, true], [`mv --target-dir='${f.state}' '${f.cwd}/output'`, true],
    [`printf ok > '${f.state}/output'`, true], [`rm --no-preserve-root '${f.cwd}/output'`, true],
    [`cp '${f.cwd}/source' '${f.state}/output'`, true], [`cp -vt'${f.state}' '${f.cwd}/source'`, true], [`dd if='${f.cwd}/source' of='${f.state}/output'`, true],
    [`cp '${f.state}/input' '${f.cwd}/output'`, false], [`dd if='${f.state}/input' of='${f.cwd}/output'`, false], ["rm -rf build", false]] as const;
  for (const [command, denied] of cases) {
    const input = { session_id: "guard-session", turn_id: "guard-turn", transcript_path: f.tmp + "/transcript.jsonl", cwd: f.cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "guard-use", permission_mode: "bypassPermissions", ...(engine === "claude" ? { prompt_id: "guard-prompt", effort: "high" } : { model: "fixture" }) };
    const result = Bun.spawnSync([process.execPath, f.installed.program, "hook"], { cwd: f.cwd, env: f.env, stdin: Buffer.from(JSON.stringify(input)) });
    expect(result.exitCode).toBe(0);
    if (denied) expect(JSON.parse(result.stdout.toString()).hookSpecificOutput.permissionDecision).toBe("deny");
    else expect(result.stdout.toString()).toBe("");
  }
  const rows = fs.readFileSync(f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL!, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows).toHaveLength(cases.filter(([, denied]) => denied).length); expect(rows[0].layer).toBe("hook"); expect(rows[0].caller.sessionId).toBe("guard-session");
});
test("a malformed hook input admits with an error journal record", () => {
  const f = guardFixture(); fixtures.push(f);
  const result = Bun.spawnSync([process.execPath, f.installed.program, "hook"], { cwd: f.cwd, env: f.env, stdin: Buffer.from("{") });
  expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toBe("");
  expect(JSON.parse(fs.readFileSync(f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL!, "utf8")).layer).toBe("error");
});

function hook(f: ReturnType<typeof guardFixture>, engine: string, cwd: string, command: string, env: Record<string, string | undefined>) {
  const input = { session_id: "manual-session", transcript_path: f.tmp + "/manual.jsonl", cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "manual-use", ...(engine === "claude" ? { prompt_id: "manual-prompt" } : { model: "fixture" }) };
  const result = Bun.spawnSync([process.execPath, f.installed.program, "hook"], { cwd: f.tmp, env, stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).not.toContain("guard error");
  return result.stdout.toString() ? JSON.parse(result.stdout.toString()).hookSpecificOutput.permissionDecision : "allow";
}
/** The manual cases need the catalog alone: the fixture's operator list also seals its fake home. */
function manualFixture() {
  const f = guardFixture(); fixtures.push(f);
  fs.writeFileSync(f.installed.policyFile, JSON.stringify({ ...f.policy, sealed: f.policy.sealed.filter(entry => entry.path !== f.home) }));
  const project = f.home + "/Projects/a", other = f.home + "/Projects/b";
  fs.mkdirSync(project + "/.git"); fs.mkdirSync(project + "/src");
  for (const name of ["a.txt", "notes.txt", "a"]) fs.writeFileSync(project + "/" + name, "owned");
  // Account handlers carry only these two variables (destructiveGuardHandler).
  const account = { PATH: f.env.PATH, HOME: f.home, LLV_DESTRUCTIVE_GUARD_POLICY: f.env.LLV_DESTRUCTIVE_GUARD_POLICY, LLV_DESTRUCTIVE_GUARD_JOURNAL: f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL };
  return { f, project, other, account };
}
const ownWork = ["rm -rf dist", "mv a.txt b.txt", "rm notes.txt", "echo hi > out.txt", "cp a b", "cd src && rm -rf ../dist"];
for (const engine of ["claude", "codex"]) test(`${engine} manual session owns the project it works in and nothing else`, () => {
  const { f, project, other, account } = manualFixture();
  for (const cwd of [project, project + "/src"]) for (const command of ownWork) expect(hook(f, engine, cwd, command, account), `${cwd}: ${command}`).toBe("allow");
  for (const command of [`rm -rf '${other}'`, `echo hi > '${other}/x'`, "rm -rf ~/.ssh", `rm -rf '${f.state}'`, "cd ~/.claude && : > .credentials.json", "rm -rf ~", "cd .. && rm -rf b"]) {
    expect(hook(f, engine, project, command, account), command).toBe("deny");
  }
  // A session in the home owns no root there; the home itself stays refused.
  expect(hook(f, engine, f.home, "rm -rf ~/notes", account)).toBe("allow");
  expect(hook(f, engine, f.home, "rm -rf Projects", account)).toBe("deny");
  // A launched agent never gains the project its tool call happens to run in.
  expect(hook(f, engine, other, "rm -rf dist", f.env as Record<string, string>)).toBe("deny");
  // A launch with no working tree (an operator terminal) marks itself and owns the session's project.
  const terminal = { ...f.env, LLV_DESTRUCTIVE_GUARD_OWN: f.tmp, LLV_DESTRUCTIVE_GUARD_SESSION_ROOT: "1" } as Record<string, string>;
  for (const command of ownWork) expect(hook(f, engine, project, command, terminal), command).toBe("allow");
  expect(hook(f, engine, project, `rm -rf '${other}'`, terminal)).toBe("deny");
});
test("the nested wrapper of a terminal launch owns its working project only when the launch is marked", () => {
  const { f, project, other } = manualFixture();
  fs.mkdirSync(other + "/build"); f.assertOwned(project); f.assertOwned(other);
  const run = (cwd: string, args: string[], session: boolean) => Bun.spawnSync([f.installed.directory + "/slow-rm", ...args], { cwd, stdout: "pipe", stderr: "pipe",
    env: { ...f.env, LLV_DESTRUCTIVE_GUARD_OWN: f.tmp, LLV_DESTRUCTIVE_GUARD_FAST: f.tmp, ...(session ? { LLV_DESTRUCTIVE_GUARD_SESSION_ROOT: "1" } : {}) } });
  expect(run(project, ["-f", "notes.txt"], false).exitCode).toBe(1);
  expect(fs.existsSync(project + "/notes.txt")).toBeTrue();
  expect(run(project, ["-f", "notes.txt"], true).exitCode).toBe(0);
  expect(fs.existsSync(project + "/notes.txt")).toBeFalse();
  expect(run(project, ["-rf", other + "/build"], true).exitCode).toBe(1);
  expect(fs.existsSync(other + "/build")).toBeTrue();
});
test("cd into an account directory and ANSI-C quoting are refused through the real hook", () => {
  const f = guardFixture(); fixtures.push(f);
  for (const engine of ["claude", "codex"]) {
    for (const command of ["cd ~/.claude && : > .credentials.json", "cd ~/.claude && unlink .credentials.json", "echo $'it\\'s' > ~/.claude/.credentials.json", "rm -rf ~/.claude; echo $'it\\'s'"]) {
      expect(hook(f, engine, f.cwd, command, f.env as Record<string, string>), command).toBe("deny");
    }
    for (const command of ["cd sub && rm -rf build", "printf $'a\\tb\\n'"]) expect(hook(f, engine, f.cwd, command, f.env as Record<string, string>), command).toBe("allow");
  }
  const rows = fs.readFileSync(f.env.LLV_DESTRUCTIVE_GUARD_JOURNAL!, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.filter(row => row.layer === "error")).toEqual([]);
  expect(rows).toHaveLength(8);
});
