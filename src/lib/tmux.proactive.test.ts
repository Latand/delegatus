import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Each child loads the real adapter with a scripted tmux transport. Authority
// changes while that transport is awaited; no real pane or process is started.
for (const decision of ["reject", "edit"] as const) {
  test.each(["adopted", "before-window", "before-boot", "before-prompt"] as const)(`tmux adapter retains receipt authority across waits (${decision}): %s`, async seam => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tmux-authority-"));
    const script = `
      import { mock } from "bun:test";
      import { EventEmitter } from "node:events";
      import { PassThrough } from "node:stream";
      import fs from "node:fs";
      const childProcess = await import("node:child_process");
      const cli = await import("@/lib/agent/cli");
      const scanner = await import("@/lib/scanner/process");
      const { agentRegistry } = await import("@/lib/agent/registry");
      const { emptyLaunchProfile } = await import("@/lib/accounts/migration/contracts");
      const { admitProactiveTask, decideProactiveTask, proactiveDecisionToken } = await import("@/lib/tasks/proactive");
      const { candidate, context, authority, NOW } = await import("@/lib/tasks/proactive.fixture");
      const { loadTasks, mutateTasks } = await import("@/lib/tasks/store");
      const { patchTask } = await import("@/lib/tasks/commands");
      const cwd = process.env.LLV_STATE_DIR;
      fs.mkdirSync(cwd, { recursive: true });
      const { task } = await admitProactiveTask(candidate("adapter"), context(), undefined, authority());
      await decideProactiveTask(task.id, "adopt", "operator", proactiveDecisionToken(task), undefined, () => new Date(NOW).toISOString());
      const registry = agentRegistry();
      const begun = registry.beginSpawnRequest({ engine: "codex", cwd, transport: "tmux", taskIds: [task.id],
        clientAttemptId: "adapter-authority", origin: { kind: "operator" },
        launchProfile: emptyLaunchProfile({ cwd, title: "Retain the accepted outcome" }) });
      if (begun.kind !== "created") throw Error("expected reservation");
      let revoked = false, marked = false, booted = false, prompt = false, bufferLoaded = false;
      const effects = [];
      const revoke = async () => {
        revoked = true;
        if (${JSON.stringify(decision)} === "reject") await decideProactiveTask(task.id, "reject", "operator", proactiveDecisionToken(task));
        else mutateTasks(tasks => {
          const result = patchTask(tasks, task.id, { details: "Changed scope during adapter wait" });
          if (!result.ok) throw Error(result.error);
          return { tasks: result.tasks, result: null };
        });
      };
      mock.module("@/lib/agent/cli", () => ({ ...cli, prepareAgentPublicationSpec: async spec => spec }));
      mock.module("@/lib/scanner/process", () => ({ ...scanner,
        agentProcesses: () => [{ pid: process.pid, engine: "codex", cwd, argv: ["codex"], tty: 1 }] }));
      mock.module("node:child_process", () => ({ ...childProcess, spawn: (command, args, options) => {
        if (command !== "tmux") return childProcess.spawn(command, args, options);
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        queueMicrotask(async () => {
          try {
            const name = args[0];
            const paneRead = name === "display-message" && args.includes("-t");
            if (!revoked && (${JSON.stringify(seam)} === "before-window" && name === "list-panes"
              || ${JSON.stringify(seam)} === "before-boot" && paneRead && marked && !booted
              || ${JSON.stringify(seam)} === "before-prompt" && paneRead && bufferLoaded)) await revoke();
            let output = "";
            if (name === "list-clients") output = "1 agents";
            if (name === "new-window") { effects.push("window"); output = "%9"; }
            if (name === "set-option") marked = true;
            if (name === "display-message") output = paneRead
              ? [process.pid, "%9", process.pid, "agents:9.0", "authority", booted ? "codex" : "bash"].join("\\t")
              : String(process.pid);
            if (name === "send-keys" && args.some(arg => arg.includes("codex"))) { effects.push("boot"); booted = true; }
            if (name === "load-buffer") bufferLoaded = true;
            if (name === "paste-buffer") { effects.push("prompt"); prompt = true; }
            if (name === "capture-pane") output = prompt ? "Working (esc to interrupt)" : "› \\nContext 100% left";
            child.stdout.write(output + "\\n"); child.emit("close", 0);
          } catch (error) { child.emit("error", error); }
        });
        return child;
      } }));
      const { spawnAgentWithPrompt } = await import("@/lib/tmux");
      let error = null;
      try { await spawnAgentWithPrompt({ engine: "codex", cwd, command: "codex", windowName: "authority",
        launchProfile: begun.receipt.launchProfile }, "Inspect the retained outcome", begun.receipt); }
      catch (cause) { error = String(cause); }
      console.log("RESULT " + JSON.stringify({ effects, revoked, error,
        state: registry.spawnReceiptForClientAttempt("adapter-authority").state,
        pane: registry.spawnReceiptForClientAttempt("adapter-authority").pane !== null,
        host: registry.spawnReceiptForClientAttempt("adapter-authority").verifiedHost !== null,
        retained: loadTasks().some(row => row.id === task.id) }));
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000,
      env: { ...process.env, HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
        TMPDIR: root, LLV_STATE_DIR: path.join(root, "state"), LLV_SPAWN_TRANSPORT: "tmux",
        LLV_LEGACY_TMUX_EXTERNAL: "0", DELEGATUS_AGENT_CPU: "off" },
    });
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toMatchObject({ code: 0 });
      const result = JSON.parse(stdout.split("RESULT ")[1]!);
      expect(result.retained).toBe(true);
      expect(result.revoked).toBe(seam !== "adopted");
      expect(result.effects).toEqual(seam === "adopted" ? ["window", "boot", "prompt"]
        : seam === "before-window" ? [] : seam === "before-boot" ? ["window"] : ["window", "boot"]);
      expect(result.pane).toBe(seam !== "before-window");
      expect(result.host).toBe(seam === "adopted" || seam === "before-prompt");
      if (seam === "adopted") {
        expect(result.error).toBeNull();
        expect(result.state).toBe("prompt-delivered");
      }
      else {
        expect(result.error).toContain(decision === "reject" ? "rejected" : "disabled");
        // The registry retains a created pane and a verified host for recovery.
        expect(result.state).toBe(seam === "before-window" ? "failed" : seam === "before-boot" ? "conflicted" : "host-verified");
      }
    } finally {
      if (child.exitCode === null) child.kill();
      await child.exited;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
