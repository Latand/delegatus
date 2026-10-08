import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withAccountHolder } from "@/lib/accounts/accountMutation.fixture";
import { ACCOUNT_STORE_BUSY_MESSAGE } from "@/lib/accounts/contentionMessage";
import * as processes from "@/lib/scanner/process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "delegatus-workflow-admission-"));
const envKeys = ["LLV_STATE_DIR", "LLV_CODEX_BINARY", "TMUX_TMPDIR", "PATH", "WORKFLOW_FIXTURE_PID"] as const;
const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
process.env.LLV_STATE_DIR = path.join(root, "state");
process.env.TMUX_TMPDIR = path.join(root, "tmux");
process.env.WORKFLOW_FIXTURE_PID = String(process.pid);
fs.mkdirSync(process.env.LLV_STATE_DIR, { recursive: true });
fs.mkdirSync(process.env.TMUX_TMPDIR, { recursive: true });
const bin = path.join(root, "bin");
fs.mkdirSync(bin);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.LLV_CODEX_BINARY = path.join(bin, "codex");
fs.writeFileSync(process.env.LLV_CODEX_BINARY, "#!/bin/sh\nprintf '[]'\n", { mode: 0o700 });
// External terminal/CLI observations are simulated. The workflow port, tmux
// launch, account queue and durable receipt lifecycle use production code.
fs.writeFileSync(path.join(bin, "tmux"), `#!/bin/sh
case "$1" in
  list-clients|list-sessions) printf '1 agents\\n' ;;
  list-panes) ;;
  new-window) printf '%s\\n' '%9' ;;
  display-message)
    case "$*" in
      *pane_id*) printf '%s\\t%%9\\t%s\\tagents:1.0\\tcodex-new\\tcodex\\n' "$WORKFLOW_FIXTURE_PID" "$WORKFLOW_FIXTURE_PID" ;;
      *window_name*) printf 'codex-new\\tcodex\\tagents:1.0\\n' ;;
      *pane_current_command*) printf 'codex\\n' ;;
      *) printf '%s\\n' "$WORKFLOW_FIXTURE_PID" ;;
    esac ;;
  capture-pane) printf '› \\nContext 99%% used\\n' ;;
  load-buffer) cat >/dev/null ;;
esac
`, { mode: 0o700 });

const { agentRegistry } = await import("@/lib/agent/registry");
const { defaultPorts, tickWorkflows } = await import("./engine");
const { buildWorkflow, loadWorkflows, saveWorkflows } = await import("./store");
const { setCodexShellPolicyReaderForTest } = await import("@/lib/git/codexShellPolicy");
const restorePolicy = setCodexShellPolicyReaderForTest(() => ({}));

afterAll(() => {
  restorePolicy();
  for (const key of envKeys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test.each(["local", "queued", "foreign", "timeout"] as const)("workflow stage admission under a %s holder", async kind => {
  const wf = buildWorkflow({
    id: `workflow-${kind}`, name: "Admission fixture", task: "Inspect the fixture",
    project: "workflow-fixture", repoDir: root, mode: "auto", now: new Date().toISOString(),
    template: { name: "Fixture", finish: "pr", stages: [
      { kind: "implement", scope: "Inspect", agent: { engine: "codex", model: null, effort: null } },
      { kind: "review-loop", reviewer: { engine: "codex", model: null, effort: null },
        fixer: { engine: "codex", model: null, effort: null }, roundLimit: 3, reviewerMode: "headless" },
    ] },
  });
  wf.state = "implementing";
  wf.worktreeDir = root;
  saveWorkflows([wf]);
  const registry = agentRegistry();
  const before = Object.keys(registry.snapshot().receipts);
  // The observed agent shares this fixture's live process identity. No real
  // agent CLI or operator tmux endpoint is touched.
  const observed = spyOn(processes, "agentProcesses").mockReturnValue([
    { pid: process.pid, engine: "codex", cwd: root, argv: ["codex"], tty: 0 },
  ]);
  try {
    await withAccountHolder(kind, () => tickWorkflows([], defaultPorts()));
    const current = loadWorkflows()[0]!;
    const receipts = Object.values(registry.snapshot().receipts).filter(receipt => !before.includes(receipt.launchId));
    if (kind === "timeout") {
      expect(current.state).toBe("needs_decision");
      expect(current.stateDetail).toBe(ACCOUNT_STORE_BUSY_MESSAGE);
      expect(receipts).toHaveLength(0);
    } else {
      expect(current.stateDetail).toBeNull();
      expect(current.state).toBe("implementing");
      expect(current.stageRuns[0]!.paneId).toBe("%9");
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.state).toBe("prompt-delivered");
      await tickWorkflows([], defaultPorts());
      expect(loadWorkflows()[0]!.state).toBe("implementing");
      expect(Object.keys(registry.snapshot().receipts)).toHaveLength(before.length + 1);
    }
  } finally { observed.mockRestore(); }
}, 15_000);
