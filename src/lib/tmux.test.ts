import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { setCodexShellPolicyReaderForTest } from "@/lib/git/codexShellPolicy";
import { parseCodexFeatures, setCodexFeatureReaderForTest } from "@/lib/agent/codexSpawnPolicy";
import { freshSpecFor, resumeSpecForSession, prepareAgentPublicationSpec, withSpawnCapability } from "@/lib/agent/cli";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { agentRegistry } from "@/lib/agent/registry";
import {
  cdCommandForCwd,
  sendShellCommandToPane,
  classifyTmuxAttachSnapshot,
  cleanupTmuxHostIfMatches,
  createSpawnWindow,
  createTmuxEndpointDescriptor,
  killTmuxHostIfMatches,
  interruptTmuxHostIfMatches,
  knownLivePidsFrom,
  legacyClaudeTmuxSpawnRefusal,
  spawnAgentWithPrompt,
  renameTmuxWindowForPid,
  resolveTmuxAttach,
  resolveTmuxEndpointContract,
  selectSpawnedAgentProcess,
  SPAWN_READY_TIMEOUT_MS,
  tmuxAttachCommands,
  tmuxEndpoint,
  verifyTmuxSpawnBinding,
} from "@/lib/tmux";

test("known live pid validation reuses a supplied scanner snapshot", () => {
  const live = knownLivePidsFrom([
    { pid: process.pid, proc: "running" },
    { pid: process.pid, proc: "done" },
    { pid: null, proc: "running" },
  ] as never);

  expect([...live]).toEqual([process.pid]);
});

test("invalid publication settings reject before creating a tmux pane or spawn receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-identity-tmux-"));
  const calls = path.join(root, "calls");
  const keys = ["PATH", "LLV_PUBLICATION_EMAIL", "DELEGATUS_PUBLICATION_EMAIL", "LLV_TEST_TMUX_CALLS"];
  const previous = keys.map((key) => process.env[key]);
  fs.writeFileSync(path.join(root, "tmux"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LLV_TEST_TMUX_CALLS"\nexit 1\n', { mode: 0o755 });
  Object.assign(process.env, {
    PATH: `${root}${path.delimiter}${process.env.PATH}`,
    LLV_PUBLICATION_EMAIL: "invalid", DELEGATUS_PUBLICATION_EMAIL: "invalid",
    LLV_TEST_TMUX_CALLS: calls,
  });
  try {
    const spec = {
      command: "codex-fixture", cwd: root, windowName: "fixture", engine: "codex" as const,
      launchProfile: emptyLaunchProfile({ cwd: root, title: "Publication preflight" }),
    };
    await expect(spawnAgentWithPrompt(spec, "begin")).rejects.toThrow("Invalid agent publication identity");
    expect(fs.existsSync(calls)).toBe(false);
    expect(Object.values(agentRegistry().snapshot().receipts).filter((receipt) => receipt.cwd === root)).toHaveLength(0);
    const receipt = agentRegistry().beginSpawn(spec.engine, root, spec.launchProfile);
    await expect(spawnAgentWithPrompt(spec, "begin", receipt)).rejects.toThrow("Invalid agent publication identity");
    expect(agentRegistry().snapshot().receipts[receipt.launchId]?.state).toBe("failed");
    expect(fs.existsSync(calls)).toBe(false);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("renameTmuxWindowForPid guards", () => {
  test("a non-positive pid never touches tmux", async () => {
    expect(await renameTmuxWindowForPid(0, "Name")).toBeNull();
    expect(await renameTmuxWindowForPid(-1, "Name")).toBeNull();
  });

  test("a title that collapses to blank never touches tmux", async () => {
    expect(await renameTmuxWindowForPid(1234, "   ")).toBeNull();
  });
});

describe("cdCommandForCwd", () => {
  test("quotes paths with spaces for a shell cd command", () => {
    expect(cdCommandForCwd("/home/user/project with spaces")).toBe("cd -- '/home/user/project with spaces'");
  });

  test("escapes single quotes in cwd paths", () => {
    expect(cdCommandForCwd("/home/user/it's here")).toBe("cd -- '/home/user/it'\\''s here'");
  });
});

test("reports the configured tmux endpoint", () => {
  expect(tmuxEndpoint()).toBe(process.env.TMUX_TMPDIR || "/tmp");
});

describe("tmux endpoint ownership", () => {
  test("keeps legacy delivery available and reports a stale migration marker", () => {
    expect(resolveTmuxEndpointContract({
      configuredTmpdir: "/tmp",
      externalFlag: "0",
      migrationComplete: true,
      uid: 1000,
    })).toEqual({
      external: false,
      tmuxTmpdir: "/tmp",
      health: {
        status: "degraded",
        code: "migration-marker-endpoint-mismatch",
        configuredTmpdir: "/tmp",
        expectedTmpdir: "/run/user/1000/agent-log-viewer",
        message: "A migration completion marker exists while the Viewer is using /tmp. Legacy tmux delivery remains active; remove the stale marker or complete the supervisor migration.",
      },
    });

    expect(resolveTmuxEndpointContract({
      configuredTmpdir: "/run/user/1000/agent-log-viewer",
      externalFlag: "1",
      migrationComplete: true,
      uid: 1000,
    })).toEqual({
      external: true,
      tmuxTmpdir: "/run/user/1000/agent-log-viewer",
      health: { status: "healthy" },
    });
  });
});

describe("spawn pane fencing", () => {
  const endpoint = createTmuxEndpointDescriptor("/run/user/1000/agent-log-viewer", 1000);
  const server = { pid: 900, startIdentity: "900:start" };

  test("clears an unapproved ambient API key from the tmux server before spawn", async () => {
    const pluginKey = ["EXAMPLE", "PLUGIN", "API", "KEY"].join("_");
    const previous = process.env[pluginKey];
    process.env[pluginKey] = "private-fixture";
    const calls: string[][] = [];
    try {
      await expect(createSpawnWindow({ session: "agents", cwd: "/repo", windowName: "worker", endpoint, server }, {
        runTmux: async (args) => {
          calls.push(args);
          return args[0] === "list-panes"
            ? { code: 1, stdout: "", stderr: "snapshot unavailable" }
            : { code: 0, stdout: "", stderr: "" };
        },
        processIdentity: () => null,
      })).rejects.toThrow("snapshot unavailable");
      expect(calls[0]).toEqual(["set-environment", "-gu", pluginKey]);
    } finally {
      if (previous === undefined) delete process.env[pluginKey];
      else process.env[pluginKey] = previous;
    }
  });

  test("uses the pane id created by new-window while foreign idle panes exist and coordinates renumber", async () => {
    let display = "agents:3.0";
    const calls: string[][] = [];
    const deps = {
      runTmux: async (args: string[]) => {
        calls.push(args);
        if (args[0] === "list-panes") return { code: 0, stdout: "%1\n%2\n", stderr: "" };
        if (args[0] === "new-window") return { code: 0, stdout: "%9\n", stderr: "" };
        return { code: 0, stdout: `900\t%9\t109\t${display}\tcodex-new\tzsh\n`, stderr: "" };
      },
      processIdentity: (pid: number) => `${pid}:start`,
    };

    const binding = await createSpawnWindow({
      session: "agents",
      cwd: "/repo",
      windowName: "codex-new",
      endpoint,
      server,
    }, deps);
    expect(binding).toMatchObject({ paneId: "%9", panePid: { pid: 109 }, target: "%9", display: "agents:3.0" });
    expect(calls.find((args) => args[0] === "list-panes")).toContain("#{pane_id}");
    expect(calls.flat()).not.toContain("agents:1.0");
    expect(calls.flat()).not.toContain("agents:2.0");

    display = "agents:1.0";
    const current = await verifyTmuxSpawnBinding(binding, endpoint, deps);
    expect(current).toMatchObject({ paneId: "%9", panePid: 109, display: "agents:1.0" });
  });

  test("rejects the shim's legacy underscore-normalized output", async () => {
    const deps = {
      runTmux: async (args: string[]) => args[0] === "list-panes"
        ? { code: 0, stdout: "%1\n%2\n", stderr: "" }
        : { code: 0, stdout: "%9_agents:3.0_109_extra\n", stderr: "" },
      processIdentity: (pid: number) => `${pid}:start`,
    };
    await expect(createSpawnWindow({
      session: "agents",
      cwd: "/repo",
      windowName: "codex-new",
      endpoint,
      server,
    }, deps)).rejects.toThrow("invalid pane id");

    const dockerfile = fs.readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8");
    expect(dockerfile).not.toContain("normalized=$(sed -E");
  });

  test("rejects a pane id that existed before new-window", async () => {
    const deps = {
      runTmux: async (args: string[]) => args[0] === "list-panes"
        ? { code: 0, stdout: "%1\n%2\n", stderr: "" }
        : { code: 0, stdout: "%2\n", stderr: "" },
      processIdentity: (pid: number) => `${pid}:start`,
    };
    await expect(createSpawnWindow({
      session: "agents",
      cwd: "/repo",
      windowName: "codex-new",
      endpoint,
      server,
    }, deps)).rejects.toThrow("pre-existing pane id");
  });

  test("rejects a server flip between new-window and pane verification", async () => {
    const deps = {
      runTmux: async (args: string[]) => {
        if (args[0] === "list-panes") return { code: 0, stdout: "%1\n%2\n", stderr: "" };
        if (args[0] === "new-window") return { code: 0, stdout: "%9\n", stderr: "" };
        return { code: 0, stdout: "901\t%9\t109\tagents:3.0\tcodex-new\tzsh\n", stderr: "" };
      },
      processIdentity: (pid: number) => `${pid}:start`,
    };
    await expect(createSpawnWindow({
      session: "agents",
      cwd: "/repo",
      windowName: "codex-new",
      endpoint,
      server,
    }, deps)).rejects.toThrow("server changed");
  });

  test("selects only the booted agent beneath the created pane", () => {
    const processes = [
      { pid: 201, engine: "codex" as const, argv: ["codex"], cwd: "/repo", tty: 1 },
      { pid: 202, engine: "codex" as const, argv: ["codex"], cwd: "/repo", tty: 1 },
      { pid: 209, engine: "codex" as const, argv: ["codex"], cwd: "/repo", tty: 1 },
    ];
    const parents = new Map([[201, 101], [202, 102], [209, 109], [101, 900], [102, 900], [109, 900]]);
    expect(selectSpawnedAgentProcess(109, "codex", "/repo", processes, (pid) => parents.get(pid) ?? null)?.pid).toBe(209);
    expect(selectSpawnedAgentProcess(110, "codex", "/repo", processes, (pid) => parents.get(pid) ?? null)).toBeNull();
  });

  test("keeps polling through account-home transcript creation latency", () => {
    expect(SPAWN_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
  });
});

describe("endpoint-aware attach commands", () => {
  test("describes default and external supervisor sockets deterministically", () => {
    expect(createTmuxEndpointDescriptor("/tmp", 1000)).toEqual({
      kind: "tmux-tmpdir",
      tmuxTmpdir: "/tmp",
      socketName: "default",
      socketPath: "/tmp/tmux-1000/default",
    });
    expect(createTmuxEndpointDescriptor("/run/user/1000/agent-log-viewer", 1000).socketPath).toBe(
      "/run/user/1000/agent-log-viewer/tmux-1000/default",
    );
  });

  test("builds exact interactive and read-only commands", () => {
    const endpoint = createTmuxEndpointDescriptor("/run/user/1000/agent-log-viewer", 1000);
    expect(tmuxAttachCommands(endpoint, "agents:2.0")).toEqual({
      command: "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -t 'agents:2.0'",
      readOnlyCommand: "TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -r -t 'agents:2.0'",
    });
  });

  test("quotes punctuation and shell-injection-shaped values", () => {
    const endpoint = createTmuxEndpointDescriptor("/run/user/1000/agent log's", 1000);
    const target = "agents:2.0;$(touch pwned) `echo nope` ü space's";
    const commands = tmuxAttachCommands(endpoint, target);
    expect(commands.command).toBe(
      "TMUX_TMPDIR='/run/user/1000/agent log'\\''s' tmux attach-session -t 'agents:2.0;$(touch pwned) `echo nope` ü space'\\''s'",
    );
    expect(() => tmuxAttachCommands(endpoint, "agents:2.0\nnext")).toThrow("unsafe control character");
    expect(() => tmuxAttachCommands(createTmuxEndpointDescriptor("/tmp\0bad", 1000), "agents:2.0")).toThrow("unsafe control character");
  });
});

describe("attach identity classification", () => {
  const expected = {
    tmuxServerPid: 900,
    tmuxServerStartIdentity: "900:one",
    paneId: "%11",
    panePid: 100,
    paneStartIdentity: "100:one",
  };

  test("accepts a renumbered display coordinate with stable identities", () => {
    expect(classifyTmuxAttachSnapshot(expected, {
      tmuxServerPid: 900,
      tmuxServerStartIdentity: "900:one",
      paneId: "%11",
      panePid: 100,
      paneStartIdentity: "100:one",
      target: "agents:8.0",
    })).toBe("ok");
  });

  test("rejects a vanished or replaced pane and PID reuse", () => {
    expect(classifyTmuxAttachSnapshot(expected, {
      tmuxServerPid: 900,
      tmuxServerStartIdentity: "900:one",
      paneId: "%12",
      panePid: 101,
      paneStartIdentity: "101:one",
      target: "agents:2.0",
    })).toBe("stale-pane");
    expect(classifyTmuxAttachSnapshot(expected, {
      tmuxServerPid: 900,
      tmuxServerStartIdentity: "900:one",
      paneId: "%11",
      panePid: 100,
      paneStartIdentity: "100:two",
      target: "agents:2.0",
    })).toBe("stale-pane");
  });

  test("rejects a restarted server even when tmux reuses a pane id", () => {
    expect(classifyTmuxAttachSnapshot(expected, {
      tmuxServerPid: 901,
      tmuxServerStartIdentity: "901:one",
      paneId: "%11",
      panePid: 100,
      paneStartIdentity: "100:one",
      target: "agents:2.0",
    })).toBe("server-restarted");
  });
});

describe("resolveTmuxAttach", () => {
  const expected = {
    tmuxServerPid: 900,
    tmuxServerStartIdentity: "900:one",
    paneId: "%11",
    panePid: 100,
    paneStartIdentity: "100:one",
  };
  const endpoint = createTmuxEndpointDescriptor("/run/user/1000/agent-log-viewer", 1000);

  test("reports stale-pane when a healthy server no longer has the pane", async () => {
    const calls: Array<{ args: string[]; endpointPath: string }> = [];
    const result = await resolveTmuxAttach(expected, endpoint, {
      runTmux: async (args, _input, seenEndpoint) => {
        calls.push({ args, endpointPath: seenEndpoint?.socketPath ?? "" });
        if (calls.length === 1) return { code: 0, stdout: "900\n", stderr: "" };
        return { code: 1, stdout: "", stderr: "can't find pane: %11\n" };
      },
      processIdentity: (pid) => (pid === 900 ? "900:one" : pid === 100 ? "100:one" : null),
    });

    expect(result).toEqual({ ok: false, reason: "stale-pane" });
    expect(calls).toEqual([
      { args: ["display-message", "-p", "#{pid}"], endpointPath: endpoint.socketPath },
      {
        args: [
          "display-message",
          "-p",
          "-t",
          "%11",
          "#{pid}\t#{pane_id}\t#{pane_pid}\t#{session_name}:#{window_index}.#{pane_index}",
        ],
        endpointPath: endpoint.socketPath,
      },
    ]);
  });

  test("keeps pane probe transport and generic command failures unverifiable", async () => {
    for (const paneProbe of [
      async () => { throw new Error("socket read failed"); },
      async () => ({ code: 1, stdout: "", stderr: "lost server\n" }),
    ]) {
      let calls = 0;
      const result = await resolveTmuxAttach(expected, endpoint, {
        runTmux: async () => {
          calls += 1;
          if (calls === 1) return { code: 0, stdout: "900\n", stderr: "" };
          return paneProbe();
        },
        processIdentity: (pid) => (pid === 900 ? "900:one" : null),
      });
      expect(result).toEqual({ ok: false, reason: "tmux-unavailable" });
    }
  });

  test("reports server-restarted before resolving a pane missing from the new server", async () => {
    const calls: Array<{ args: string[]; endpointPath: string }> = [];
    const result = await resolveTmuxAttach(expected, endpoint, {
      runTmux: async (args, _input, seenEndpoint) => {
        calls.push({ args, endpointPath: seenEndpoint?.socketPath ?? "" });
        return { code: 0, stdout: "901\n", stderr: "" };
      },
      processIdentity: (pid) => (pid === 901 ? "901:one" : null),
    });

    expect(result).toEqual({ ok: false, reason: "server-restarted" });
    expect(calls).toEqual([
      { args: ["display-message", "-p", "#{pid}"], endpointPath: endpoint.socketPath },
    ]);
  });
});

describe("cleanupTmuxHostIfMatches", () => {
  const host = {
    kind: "tmux" as const,
    endpoint: "/run/user/1000/agent-log-viewer",
    server: { pid: 900, startIdentity: "900:one" },
    paneId: "%11",
    panePid: { pid: 100, startIdentity: "100:one" },
    windowName: "migration",
    agent: { pid: 101, startIdentity: "101:one" },
    argv: ["claude"],
  };

  test("confirms explicit pane absence and retries unverifiable pane probes", async () => {
    for (const [paneProbe, expected] of [
      [async () => ({ code: 1, stdout: "", stderr: "can't find pane: %11\n" }), "absent"],
      [async () => { throw new Error("socket read failed"); }, "unverifiable"],
      [async () => ({ code: 1, stdout: "", stderr: "lost server\n" }), "unverifiable"],
    ] as const) {
      let calls = 0;
      const result = await cleanupTmuxHostIfMatches(host, {
        runTmux: async () => {
          calls += 1;
          if (calls === 1) return { code: 0, stdout: "900\n", stderr: "" };
          return paneProbe();
        },
        processIdentity: (pid) => (pid === 900 ? "900:one" : null),
      });
      expect(result).toBe(expected);
    }
  });

  test("retries when required server or pane process identity is unavailable", async () => {
    for (const missingIdentityPid of [900, 100]) {
      let calls = 0;
      const result = await cleanupTmuxHostIfMatches(host, {
        runTmux: async () => {
          calls += 1;
          if (calls === 1) return { code: 0, stdout: "900\n", stderr: "" };
          return { code: 0, stdout: "900\t%11\t100\tagents:2.0\n", stderr: "" };
        },
        processIdentity: (pid) => {
          if (pid === missingIdentityPid) return null;
          if (pid === 900) return "900:one";
          if (pid === 100) return "100:one";
          return null;
        },
      });
      expect(result).toBe("unverifiable");
      expect(calls).toBe(missingIdentityPid === 900 ? 1 : 2);
    }
  });
});

describe("killTmuxHostIfMatches", () => {
  const host = {
    kind: "tmux" as const,
    endpoint: "/run/user/1000/agent-log-viewer",
    server: { pid: 900, startIdentity: "900:one" },
    paneId: "%11",
    panePid: { pid: 100, startIdentity: "100:one" },
    windowName: "worker",
    agent: { pid: 101, startIdentity: "101:one" },
    argv: ["codex"],
  };

  test("interrupt preserves the host and refuses changed or incomplete identities", async () => {
    for (const mismatch of [false, true, "missing"] as const) {
      const calls: string[][] = [];
      const result = await interruptTmuxHostIfMatches(host, {
        runTmux: async (args) => {
          calls.push(args);
          return { code: 0, stdout: args[0] === "display-message" ? "900\t%11\t100\tagents:2.0\tworker\tzsh\n" : "", stderr: "" };
        },
        processIdentity: (pid) => pid === 101 && mismatch ? mismatch === "missing" ? null : "101:other" : `${pid}:one`,
        argv: () => ["codex"], pidAlive: () => true,
        parentPid: (pid) => pid === 101 ? 100 : pid === 100 ? 900 : null,
      });
      expect(result).toBe(mismatch === false);
      const effects = calls.filter((args) => args[0] === "if-shell");
      expect(effects).toHaveLength(mismatch === false ? 1 : 0);
      if (!mismatch) expect(effects[0]).toContain("send-keys -t %11 Escape");
      expect(calls.flat().some((arg) => arg.includes("kill-pane"))).toBe(false);
    }
  });

  test("kills by stable pane id and waits for the pane process tree to exit", async () => {
    let killed = false;
    const calls: string[][] = [];
    const result = await killTmuxHostIfMatches(host, {
      runTmux: async (args) => {
        calls.push(args);
        if (args[0] === "display-message") {
          return killed
            ? { code: 1, stdout: "", stderr: "can't find pane: %11" }
            : { code: 0, stdout: "900\t%11\t100\tagents:2.0\tworker\tzsh\n", stderr: "" };
        }
        killed = true;
        return { code: 0, stdout: "", stderr: "" };
      },
      processIdentity: (pid) => `${pid}:one`,
      argv: () => ["codex"],
      pidAlive: (pid) => !killed && (pid === 100 || pid === 101),
      parentPid: (pid) => pid === 101 ? 100 : pid === 100 ? 900 : null,
      sleep: async () => {},
      maxVerifyAttempts: 2,
    });

    expect(result).toBe(true);
    expect(calls.find((args) => args[0] === "if-shell")).toContain("%11");
  });

  test("reports failure while the killed pane's agent process remains alive", async () => {
    const result = await killTmuxHostIfMatches(host, {
      runTmux: async (args) => args[0] === "display-message"
        ? { code: 0, stdout: "900\t%11\t100\tagents:2.0\tworker\tzsh\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
      processIdentity: (pid) => `${pid}:one`,
      argv: () => ["codex"],
      pidAlive: () => true,
      parentPid: (pid) => pid === 101 ? 100 : pid === 100 ? 900 : null,
      sleep: async () => {},
      maxVerifyAttempts: 2,
    });

    expect(result).toBe(false);
  });

  test("rejects an exec-replaced agent whose live argv differs from registry evidence", async () => {
    let killCommands = 0;
    const result = await killTmuxHostIfMatches(host, {
      runTmux: async (args) => {
        if (args[0] === "if-shell") killCommands += 1;
        return { code: 0, stdout: "900\t%11\t100\tagents:2.0\tworker\tzsh\n", stderr: "" };
      },
      processIdentity: (pid) => `${pid}:one`,
      argv: () => ["bash", "external-task"],
      pidAlive: () => true,
      parentPid: (pid) => pid === 101 ? 100 : pid === 100 ? 900 : null,
      sleep: async () => {},
      maxVerifyAttempts: 2,
    });

    expect(result).toBe(false);
    expect(killCommands).toBe(0);
  });

  test("rejects destructive kills when any recorded process identity is unavailable", async () => {
    for (const candidate of [
      { ...host, server: { ...host.server, startIdentity: null } },
      { ...host, panePid: { ...host.panePid, startIdentity: null } },
      { ...host, agent: { ...host.agent, startIdentity: null } },
    ]) {
      let killCommands = 0;
      expect(await killTmuxHostIfMatches(candidate, {
        runTmux: async (args) => {
          if (args[0] === "if-shell") killCommands += 1;
          return { code: 0, stdout: "900\t%11\t100\tagents:2.0\tworker\tzsh\n", stderr: "" };
        },
        processIdentity: (pid) => `${pid}:one`,
        argv: () => ["codex"],
        pidAlive: () => true,
        parentPid: (pid) => pid === 101 ? 100 : pid === 100 ? 900 : null,
        sleep: async () => {},
        maxVerifyAttempts: 2,
      })).toBe(false);
      expect(killCommands).toBe(0);
    }
  });
});

describe("structured transport prohibits legacy tmux Claude launches", () => {
  const withStructuredTransport = async (run: () => Promise<void>) => {
    const previous = process.env.LLV_SPAWN_TRANSPORT;
    process.env.LLV_SPAWN_TRANSPORT = "structured";
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
      else process.env.LLV_SPAWN_TRANSPORT = previous;
    }
  };

  test("refuses interactive Claude specs and settles a terminal retryable receipt", async () => {
    await withStructuredTransport(async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "llv-no-tmux-claude-"));
      const spec = freshSpecFor("claude", cwd);
      spec.launchProfile = emptyLaunchProfile({
        ...spec.launchProfile,
        cwd,
        title: "Verify structured Claude refusal",
      });
      await expect(spawnAgentWithPrompt(spec, "hello")).rejects.toThrow(
        /structured transport prohibits legacy tmux Claude launches/,
      );
      const receipts = Object.values(agentRegistry().snapshot().receipts)
        .filter((receipt) => receipt.engine === "claude" && receipt.cwd === cwd);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.state).toBe("failed");
      expect(receipts[0]!.error).toMatch(/structured transport prohibits legacy tmux Claude launches/);
      fs.rmSync(cwd, { recursive: true, force: true });
    });
  });

  test("the receipt fallback rejects a titleless launch before actuation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "llv-titleless-fallback-"));
    const spec = {
      command: "codex",
      cwd,
      windowName: "codex-new",
      engine: "codex" as const,
      launchProfile: emptyLaunchProfile({ cwd }),
    };
    await expect(spawnAgentWithPrompt(spec, "hello")).rejects.toThrow(
      "title is required for every new spawn",
    );
    const receipts = Object.values(agentRegistry().snapshot().receipts)
      .filter((receipt) => receipt.cwd === cwd);
    expect(receipts).toHaveLength(0);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test("refusal covers interactive resume specs and spares the migration print-mode fork and tmux transport", () => {
    const interactive = { command: "claude --dangerously-skip-permissions", cwd: "/tmp", windowName: "claude-resume", engine: "claude" as const };
    expect(legacyClaudeTmuxSpawnRefusal(interactive, "structured")).toMatch(/structured transport prohibits/);
    expect(legacyClaudeTmuxSpawnRefusal(interactive, "tmux")).toBeNull();
    expect(legacyClaudeTmuxSpawnRefusal({ ...interactive, engine: "codex" as const }, "structured")).toBeNull();
    expect(legacyClaudeTmuxSpawnRefusal({ engine: "claude" as const, printMode: true }, "structured")).toBeNull();
  });
});

// A real private tmux endpoint drives the same sender as fresh, resume and
// recovery. The fake CLI captures argv; it never uses an account or a model.
for (const shell of ["bash", "zsh"]) {
  test.skipIf(spawnSync("tmux", ["-V"]).status !== 0 || spawnSync(shell, ["--version"]).status !== 0)(`${shell} slow prompts receive complete denied and granted Codex argv`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tmux-command-"));
  // Unix socket names must fit even when the gate nests a long TMPDIR.
  const socketRoot = fs.mkdtempSync("/tmp/llv-tmux-socket-");
  const socket = path.join(socketRoot, "socket");
  const output = path.join(root, "argv.json");
  const ready = path.join(root, "ready");
  const threadId = ["0".repeat(8), "0000", "4000", "8000", "0".repeat(12)].join("-");
  const binary = path.join(root, "codex");
  const saved = { ...process.env };
  const restoreShell = setCodexShellPolicyReaderForTest(() => ({}));
  const restore = setCodexFeatureReaderForTest(() => parseCodexFeatures([
    "multi_agent stable true", "multi_agent_v2 stable true",
    ...Array.from({ length: 110 }, (_, i) => `future_worker_${i} stable true`),
  ].join("\n")));
  const run = async (args: string[]) => {
    const result = spawnSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await Bun.sleep(20); }
    throw new Error("private tmux shell did not deliver fixture argv");
  };
  let serverPid: number | undefined;
  try {
    fs.writeFileSync(binary, `#!/bin/sh\nif [ "$3" = mcp ]; then printf "[]"; exit; fi\nfor arg do [ "$arg" = app-server ] && exit 1; done\nexec '${process.execPath}' -e 'require("fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(1)))' -- "$@"\n`, { mode: 0o700 });
    const rc = shell === "bash" ? path.join(root, "bashrc") : path.join(root, ".zshrc");
    fs.writeFileSync(rc, shell === "bash"
      ? `HISTFILE=/dev/null\nPS1='fixture> '\nPROMPT_COMMAND='sleep 0.05; touch ${ready}'\n`
      : `HISTFILE=/dev/null\nPS1='fixture> '\nprecmd() { sleep 0.05; touch ${ready}; }\n`);
    Object.assign(process.env, { PATH: `${root}${path.delimiter}${process.env.PATH}`, LLV_CODEX_BINARY: binary, LLV_CODEX_HOME: root, ZDOTDIR: root });
    for (const allowSubagents of [false, true]) for (const resume of [false, true]) {
      fs.rmSync(output, { force: true }); fs.rmSync(ready, { force: true });
      const shellCommand = shell === "bash" ? `bash --noprofile --rcfile '${rc}' -i` : "zsh -i";
      const created = await run(["new-session", "-d", "-s", "fixture", shellCommand]);
      expect(created.code).toBe(0);
      serverPid = Number((await run(["display-message", "-p", "#{pid}"])).stdout.trim());
      await waitFor(() => fs.existsSync(ready));
      await Bun.sleep(30);
      const spec = resume
        ? resumeSpecForSession("codex", threadId, root, root, { allowSubagents })!
        : freshSpecFor("codex", root, { allowSubagents, codexHome: root });
      const prepared = withSpawnCapability(await prepareAgentPublicationSpec(spec), "c".repeat(43));
      if (!allowSubagents) expect(Buffer.byteLength(prepared.command)).toBeGreaterThan(4096);
      const expected = spawnSync("bash", ["-c", prepared.command], { cwd: root, encoding: "utf8" });
      if (expected.status !== 0) throw new Error(expected.stderr);
      expect(expected.status).toBe(0);
      const expectedArgv = JSON.parse(fs.readFileSync(output, "utf8"));
      fs.rmSync(output);
      await sendShellCommandToPane("fixture:0.0", root, prepared.command, run);
      await waitFor(() => fs.existsSync(output));
      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toEqual(expectedArgv);
      expect(expectedArgv).toContain(`agents.enabled=${allowSubagents}`);
      if (!allowSubagents) expect(expectedArgv.filter((arg: string) => arg === "--disable")).toHaveLength(112);
      if (resume) expect(expectedArgv.slice(-2)).toEqual(["resume", threadId]);
      expect(await run(["kill-session", "-t", "fixture"])).toMatchObject({ code: 0 });
      serverPid = undefined;
    }
  } finally {
    if (serverPid) { try { process.kill(serverPid, "SIGTERM"); } catch { /* private server exited */ } }
    fs.rmSync(socketRoot, { recursive: true, force: true });
    restore(); restoreShell();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
}

test("a refused tmux command delivery removes its private host-visible file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-tmux-file-"));
  const previousHome = process.env.HOME;
  const previousShim = process.env.LLV_DOCKER_NSENTER_SHIMS;
  Object.assign(process.env, { HOME: root, LLV_DOCKER_NSENTER_SHIMS: "1" });
  const directory = path.join(root, ".cache", "delegatus", "tmux-commands");
  const command = `printf '%s' '${"x".repeat(5000)}'`;
  try {
    for (const failAt of [1, 2, 3, 4]) {
      let call = 0;
      await expect(sendShellCommandToPane("%1", root, command, async () => {
        const files = fs.readdirSync(directory);
        expect(files).toHaveLength(1);
        const filename = path.join(directory, files[0]);
        expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(filename, "utf8")).toContain(command);
        return { code: ++call === failAt ? 1 : 0, stdout: "", stderr: "pane changed" };
      })).rejects.toThrow("pane changed");
      expect(fs.readdirSync(directory)).toEqual([]);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousShim === undefined) delete process.env.LLV_DOCKER_NSENTER_SHIMS; else process.env.LLV_DOCKER_NSENTER_SHIMS = previousShim;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
