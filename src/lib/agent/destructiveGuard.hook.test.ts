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
    [`printf ok > '${f.state}/output'`, true], [`rm --no-preserve-root '${f.cwd}/output'`, true], ["rm -rf build", false]] as const;
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
