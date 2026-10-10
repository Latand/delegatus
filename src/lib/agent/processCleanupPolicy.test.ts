import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyClaudeSpawnPolicy } from "./spawnPolicy";
import { forbiddenProcessCleanup } from "./processCleanupPolicy";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const forbidden = [
  "pkill -f fixture-server", "killall fixture-server", "fuser -k 12345/tcp",
  "lsof -ti :12345 | xargs kill", "kill $(lsof -ti :12345)", "kill `pgrep fixture-server`",
  "/usr/bin/pkill fixture-server", "sudo killall fixture-server", "fuser -vk 12345/tcp",
  "bash -lc 'pkill fixture-server'", "rtk proxy pkill fixture-server",
  "command /usr/bin/pkill fixture-server", "env VAR=1 killall fixture-server",
  "fuser --kill 12345/tcp", "lsof -ti :12345 | kill", "pgrep fixture-server | xargs kill",
  'kill "$(lsof -ti :12345)"', "kill $(cat recorded-processes)", "echo $(pkill fixture-server)",
  "sudo -n pkill fixture-server", "sudo -u fixture killall fixture-server", "timeout -s TERM 5 pkill fixture-server",
];

test.each(forbidden)("classifies forbidden shell commands: %s", command => {
  expect(forbiddenProcessCleanup(command)).toBe(true);
});

test.each(["kill 111", "kill -TERM 111", 'kill "$recorded_pid"', "echo 'pkill fixture-server'", "printf '%s' killall", "lsof -i :12345; kill 111", "pgrep fixture-server", "command -v pkill", "# pkill fixture-server\nkill 111"])("allows PID cleanup and inert text: %s", command => {
  expect(forbiddenProcessCleanup(command)).toBe(false);
});

function installedHook(allowSubagents = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-policy-")); roots.push(root);
  const original = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "user-hook" }] }] } });
  fs.writeFileSync(path.join(root, "settings.json"), original);
  const installed = applyClaudeSpawnPolicy(root, { allowSubagents });
  const profile = JSON.parse(fs.readFileSync(installed.settingsPath, "utf8"));
  expect(fs.readFileSync(path.join(root, "settings.json"), "utf8")).toBe(original);
  const bash = profile.hooks.PreToolUse.find((group: { matcher: string }) => group.matcher === "Bash");
  expect(bash, "Every managed Claude launch needs the PID-only guard").toBeDefined();
  return bash.hooks[0].command as string;
}

// Commands are hook input only. None of the forbidden commands is executed.
test.each(forbidden)("Claude refuses process cleanup before execution: %s", async command => {
  const child = Bun.spawn(["sh", "-c", installedHook()], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }));
  child.stdin.end();
  const stderr = new Response(child.stderr).text();
  expect(await child.exited).toBe(2);
  expect(await stderr).toContain("PID-only");
  expect(await stderr).toContain("port 0");
});

test.each([false, true])("recorded-PID cleanup remains allowed (subagents: %s)", async allowSubagents => {
  const standIn = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdout: "ignore", stderr: "ignore" });
  try {
    const hook = installedHook(allowSubagents);
    for (const command of [`kill ${standIn.pid}`, `kill -TERM ${standIn.pid}`, 'kill "$recorded_pid"', "lsof -i :12345", "echo 'pkill fixture-server'"]) {
      const child = Bun.spawn(["sh", "-c", hook], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }));
      child.stdin.end();
      const stderr = await new Response(child.stderr).text();
      expect(stderr, command).toBe("");
      expect(await child.exited).toBe(0);
    }
  } finally { standIn.kill(); await standIn.exited; }
});

test.each([false, true])("hook suppression refuses managed launches (subagents: %s)", allowSubagents => {
  for (const setting of ["disableAllHooks", "allowManagedHooksOnly"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-policy-")); roots.push(root);
    fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ [setting]: true }));
    expect(() => applyClaudeSpawnPolicy(root, { allowSubagents })).toThrow(setting);
  }
});

test.each([{ cmd: "pkill fixture-server" }, { command: ["bash", "-lc", "killall fixture-server"] }])("Codex hook input uses the same guard: %j", async tool_input => {
  const child = Bun.spawn(["sh", "-c", installedHook()], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(JSON.stringify({ tool_name: "exec_command", tool_input }));
  child.stdin.end();
  expect(await child.exited).toBe(2);
  expect(await new Response(child.stderr).text()).toContain("PID-only");
});
