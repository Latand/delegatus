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

const shellBoundaries: [string, number][] = [
  ["lsof -ti :12345 |\n  xargs kill", 2],
  ["lsof -ti :12345 | \\\n  xargs kill", 2],
  ["lsof -ti :12345 |\n # lookup continues\n xargs kill", 2],
  ["ls\\\nof -ti :12345 | xargs ki\\\nll", 2],
  ["lsof -ti :12345\nkill 111", 0],
  ['kill "$recorded_pid"', 0],
  ["cat <<'EOF'\npkill -f fixture-server\n$(killall fixture-server)\nEOF", 0],
  ['cat <<"EOF"\npkill fixture-server\nEOF', 0],
  ["cat <<\\EOF\npkill fixture-server\nEOF", 0],
  ["cat <<-'EOF'\n\tpkill fixture-server\n\tEOF\nkill 111", 0],
  ["cat <<'EOF'\npkill fixture-server\nEOF\npkill fixture-server", 2],
  ["cat <<EOF\npkill fixture-server\nEOF", 0],
  ["cat <<EOF\n$(pkill fixture-server)\nEOF", 2],
  ["cat <<EOF\n'$(pkill fixture-server)'\nEOF", 2],
  ["cat <<EOF\n`killall fixture-server`\nEOF", 2],
  ["cat <<EOF\n\\$(pkill fixture-server)\nEOF", 0],
  ["cat <<'FIRST' <<SECOND\n$(pkill fixture-server)\nFIRST\npkill fixture-server\nSECOND", 0],
  ["bash <<'EOF'\npkill fixture-server\nEOF", 2],
  ["cat <<'EOF' | bash\npkill fixture-server\nEOF", 2],
  ["cat <<'EOF' |\npkill fixture-server\nEOF\nbash", 2],
  ["cat <<'EOF' |\npkill fixture-server\nEOF\ncat", 0],
  ["cat <<EOF\nEO\\\nF\npkill fixture-server", 2],
  ['cat <<"E\\OF"\npkill fixture-server\nE\\OF\npkill fixture-server', 2],
  ['cat <<"E\\OF"\npkill fixture-server\nE\\OF', 0],
  ["cat <<'EOF'; kill 111\npkill fixture-server\nEOF", 0],
  ["cat <<'EOF'\n$(pkill fixture-server)\nEOF\necho $(pkill fixture-server)", 2],
  ["cat <<'EOF'>fixture-output\npkill fixture-server\nEOF\npkill fixture-server", 2],
  ["cat <<'EOF'>fixture-output\npkill fixture-server\nEOF", 0],
  ["bash fixture-script <<'EOF'\npkill fixture-server\nEOF", 0],
  ["bash -s fixture-script <<'EOF'\npkill fixture-server\nEOF", 2],
  ["bash >fixture-output <<'EOF'\npkill fixture-server\nEOF", 2],
  ["bash <<'EOF' >fixture-output\npkill fixture-server\nEOF", 2],
  ["bash 2> fixture-output <<'EOF'\npkill fixture-server\nEOF", 2],
  ["2>fixture-output bash <<'EOF'\npkill fixture-server\nEOF", 2],
  ["bash 2>&1 <<'EOF'\npkill fixture-server\nEOF", 2],
  ["bash &>fixture-output <<'EOF'\npkill fixture-server\nEOF", 2],
  ["bash 0<<'EOF'\npkill fixture-server\nEOF", 2],
  ["bash {output}>fixture-output <<'EOF'\npkill fixture-server\nEOF", 2],
  ["bash >>'fixture output' <<'EOF'\npkill fixture-server\nEOF", 2],
  ["bash >'-c' <<'EOF'\npkill fixture-server\nEOF", 2],
  ["cat <<'EOF' | bash >fixture-output\npkill fixture-server\nEOF", 2],
  ["bash >fixture-output fixture-script <<'EOF'\npkill fixture-server\nEOF", 0],
  ["bash fixture-script 2>fixture-output <<'EOF'\npkill fixture-server\nEOF", 0],
  ["bash '2'>fixture-output <<'EOF'\npkill fixture-server\nEOF", 0],
  ["echo >$(pkill fixture-server)", 2],
  ["lsof -ti :12345 | (xargs kill)", 2],
  ["lsof -ti :12345 | (\n xargs kill\n)", 2],
  ["lsof -ti :12345 | ( (xargs kill) )", 2],
  ["lsof -ti :12345 | (echo ready; xargs kill)", 2],
  ["lsof -ti :12345 | { xargs kill; }", 2],
  ['lsof -ti :12345 | (cat); kill "$recorded_pid"', 0],
  ['lsof -ti :12345 | (cat)\nkill "$recorded_pid"', 0],
  ['lsof -ti :12345; (kill "$recorded_pid")', 0],
  ["values=(pkill fixture-server)", 0],
  ["values=(killall fixture-server)", 0],
  ["values=(pkill killall); kill 111", 0],
  ["values=(\n pkill fixture-server\n killall fixture-server\n)", 0],
  ["values=(\n # fixture )\n pkill fixture-server\n)", 0],
  ["values+=(pkill fixture-server)", 0],
  ["values=($(pkill fixture-server))", 2],
  ['values=("$(killall fixture-server)")', 2],
  ["values=(`pkill fixture-server`)", 2],
  ["values=('$(pkill fixture-server)')", 0],
  ["values=(pkill fixture-server); pkill fixture-server", 2],
  ["echo > >(pkill fixture-server)", 2],
  ["cat <(killall fixture-server)", 2],
  ["values=(>(pkill fixture-server))", 2],
  ["values=(<(killall fixture-server))", 2],
  ["values=('>(pkill fixture-server)')", 0],
  ["cat <<EOF\n>(pkill fixture-server)\nEOF", 0],
  ["bash > >(cat) <<'EOF'\npkill fixture-server\nEOF", 2],
  ["lsof -ti :12345 | bash -c 'xargs kill'", 2],
  ["lsof -ti :12345 | (bash -c 'xargs kill')", 2],
  ["lsof -ti :12345 | (echo $(xargs kill))", 2],
  ["lsof -ti :12345 | bash -c 'echo ready; xargs kill'", 2],
  ['lsof -ti :12345 | (cat); bash -c \'kill "$recorded_pid"\'', 0],
  ["values=($((pkill)))", 0],
  ["values=($((killall)))", 0],
  ["echo $((killall))", 0],
  ["values=($(( $(pkill fixture-server) )))", 2],
];

// Feed both engine payload shapes to the installed hook; never execute the input.
test.each(shellBoundaries)("hook respects shell boundaries: %s (exit %s)", async (command, code) => {
  expect(forbiddenProcessCleanup(command)).toBe(code === 2);
  for (const tool_input of [{ command }, { cmd: command }]) {
    const child = Bun.spawn(["sh", "-c", installedHook()], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child.stdin.write(JSON.stringify({ tool_input }));
    child.stdin.end();
    const stderr = new Response(child.stderr).text();
    expect(await child.exited).toBe(code);
    if (code === 2) expect(await stderr).toContain("PID-only");
    else expect(await stderr).toBe("");
  }
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
