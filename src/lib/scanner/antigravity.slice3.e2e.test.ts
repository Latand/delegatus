import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import { buildFeed, type Item } from "@/components/feed/parse";
import { resourceWorkerRequestProblem } from "@/lib/resourceWorkerRequest";
import { projectForCwd } from "@/lib/scanner/describe";
import { discoverFilesWithProjectCatalog } from "@/lib/scanner/discover";
import { indexTranscriptSources, searchTranscripts } from "@/lib/search/transcriptSearch";
import { readSession } from "@/lib/session/reader";
import { projectTimeline } from "@/lib/timeline";
import type { RootKey } from "@/lib/types";
import { compactText } from "@/lib/view/compactText";

const RUN_REAL_AGY_E2E = process.env.AGY_E2E === "1";

function collectDescendantPids(rootPid: number): Set<number> {
  const pids = new Set<number>([rootPid]);
  if (process.platform !== "linux") return pids;
  try {
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pids.has(pid)) continue;
        try {
          const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
          const closeParen = stat.lastIndexOf(")");
          if (closeParen < 0) continue;
          const fields = stat.slice(closeParen + 2).split(" ");
          const ppid = Number(fields[1]);
          if (pids.has(ppid)) {
            pids.add(pid);
            changed = true;
          }
        } catch { /* exited */ }
      }
    }
  } catch { /* /proc unavailable */ }
  return pids;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function makeWritableRecursive(dir: string): void {
  if (!fs.existsSync(dir)) return;
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      fs.chmodSync(dir, 0o700);
      for (const entry of fs.readdirSync(dir)) makeWritableRecursive(path.join(dir, entry));
    } else {
      fs.chmodSync(dir, 0o600);
    }
  } catch { /* best effort */ }
}

function passwdHomeDir(): string {
  if (process.platform === "linux" && typeof process.getuid === "function") {
    const uid = String(process.getuid());
    try {
      for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
        const fields = line.split(":");
        if (fields[2] === uid && fields[5]) return fields[5];
      }
    } catch { /* fall back */ }
  }
  return os.userInfo().homedir;
}

function copyLoginFileReadOnly(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o400);
  return true;
}

function assertAndCreateBwrapSpawner(sandbox: string, operatorPasswdHome: string) {
  const bwrapBin = "/usr/bin/bwrap";
  if (process.platform !== "linux" || !fs.existsSync(bwrapBin)) {
    throw new Error("kernel write-confinement proof requires /usr/bin/bwrap on Linux");
  }
  const baseArgs = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--bind", sandbox, sandbox,
    "--die-with-parent",
    "--",
  ];
  const probeTarget = path.join(operatorPasswdHome, ".gemini", `llv-bwrap-s3-probe-${crypto.randomUUID().slice(0, 8)}`);
  const check = spawnSync(bwrapBin, [...baseArgs, "sh", "-c", `touch "$1"`, "_", probeTarget], {
    encoding: "utf8",
    timeout: 5_000,
  });
  expect(check.status).not.toBe(0);
  expect(fs.existsSync(probeTarget)).toBe(false);
  return (command: string, args: string[], options: import("node:child_process").SpawnOptionsWithoutStdio) =>
    spawn(bwrapBin, [...baseArgs, command, ...args], options);
}

describe.skipIf(!RUN_REAL_AGY_E2E)("in-process Antigravity Slice 3 board/scanner/search E2E with real agy (AGY_E2E=1)", () => {
  test("runs a real tool-calling agy turn in bwrap, then scans, renders feed, reads session, projects timeline/compactText, and searches transcripts", async () => {
    const t0 = performance.now();
    const envKeys = [
      "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
      "LLV_STATE_DIR", "LLV_STATE_OWNER", "TMPDIR", "TMP", "TEMP",
    ] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const key of envKeys) savedEnv[key] = process.env[key];
    const operatorHome = passwdHomeDir();

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-agy-s3-e2e-"));
    const tempHome = path.join(sandbox, "home");
    const xdgConfig = path.join(sandbox, "xdg-config");
    const xdgCache = path.join(sandbox, "xdg-cache");
    const xdgData = path.join(sandbox, "xdg-data");
    const xdgState = path.join(sandbox, "xdg-state");
    const stateDir = path.join(xdgConfig, "agent-log-viewer", "state");
    const antigravityHome = path.join(xdgConfig, "agent-log-viewer", "accounts", "antigravity", "default");
    const tempTmp = path.join(sandbox, "tmp");
    const workspace = path.join(sandbox, "repo");
    for (const dir of [tempHome, xdgConfig, xdgCache, xdgData, xdgState, stateDir, antigravityHome, tempTmp, workspace]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const operatorGemini = path.join(operatorHome, ".gemini");
    const nativeHome = path.join(antigravityHome, "native-home");
    fs.mkdirSync(nativeHome, { recursive: true, mode: 0o700 });
    for (const rel of [
      "google_accounts.json",
      "oauth_creds.json",
      "antigravity-cli/oauth_creds.json",
      "antigravity-cli/google_accounts.json",
      "antigravity-cli/settings.json",
    ]) {
      copyLoginFileReadOnly(path.join(operatorGemini, rel), path.join(tempHome, ".gemini", rel));
      copyLoginFileReadOnly(path.join(operatorGemini, rel), path.join(nativeHome, ".gemini", rel));
    }

    const gitInit = spawnSync("git", ["init", "-q"], { cwd: workspace, encoding: "utf8" });
    expect(gitInit.status).toBe(0);
    const fileToken = "SLICE3-FILE-TOKEN-9284";
    const replyToken = "SLICE3-REPLY-TOKEN-4107";
    fs.writeFileSync(path.join(workspace, "slice3-probe.txt"), `${fileToken}\n`, "utf8");

    const confinedSpawnProcess = assertAndCreateBwrapSpawner(sandbox, operatorHome);

    process.env.HOME = tempHome;
    process.env.XDG_CONFIG_HOME = xdgConfig;
    process.env.XDG_CACHE_HOME = xdgCache;
    process.env.XDG_DATA_HOME = xdgData;
    process.env.XDG_STATE_HOME = xdgState;
    process.env.LLV_STATE_DIR = stateDir;
    process.env.LLV_STATE_OWNER = "test";
    process.env.TMPDIR = tempTmp;
    process.env.TMP = tempTmp;
    process.env.TEMP = tempTmp;

    const allTrackedPids = new Set<number>();
    let host: import("@/lib/runtime/antigravityAcpHost").AntigravityAcpHost | null = null;

    try {
      const [{ AntigravityAcpHost }, { FileRuntimeEventStore }, { resolveAntigravityBinary }] = await Promise.all([
        import("@/lib/runtime/antigravityAcpHost"),
        import("@/lib/runtime/eventStore"),
        import("@/lib/agent/cli"),
      ]);

      const binary = resolveAntigravityBinary();
      expect(binary).toBeTruthy();

      const eventStore = new FileRuntimeEventStore(path.join(stateDir, "structured-host-events"));
      host = await AntigravityAcpHost.start({
        cwd: workspace,
        antigravityHome,
        accountId: "default",
        model: "gemini-3.8-flash",
        effort: "low",
        allowAll: true,
        viewerMcpServer: null,
        mcpServers: [],
        binary: binary!,
        spawnProcess: confinedSpawnProcess,
        eventStore,
        env: { ...process.env },
      });

      const initialHealth = await host.health();
      if (initialHealth.pid) {
        for (const pid of collectDescendantPids(initialHealth.pid)) allTrackedPids.add(pid);
      }

      const transcriptPath = host.identity.path;
      expect(transcriptPath).toBeTruthy();
      expect(transcriptPath.startsWith(path.join(antigravityHome, "sessions"))).toBe(true);

      const prompt = `Read the file slice3-probe.txt in the current working directory using your file-reading tool, then reply with a single line containing the exact token from that file and ${replyToken}.`;
      const sent = await host.send({
        id: `s3-turn-${crypto.randomUUID().slice(0, 8)}`,
        text: prompt,
        images: [],
        origin: { kind: "operator" },
      });
      expect(sent.outcome).toBe("turn-started");

      let turnCompleted = false;
      const stream = host.attach(0)[Symbol.asyncIterator]();
      const deadline = Date.now() + 90_000;
      while (!turnCompleted && Date.now() < deadline) {
        const next = await Promise.race([
          stream.next(),
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), Math.max(100, deadline - Date.now()))),
        ]);
        const h = await host.health();
        if (h.pid) for (const pid of collectDescendantPids(h.pid)) allTrackedPids.add(pid);
        if (next.done || !next.value) {
          if (h.status === "idle" || h.status === "dead") break;
          continue;
        }
        if (next.value.kind === "turn-ended") {
          turnCompleted = next.value.status === "completed";
          break;
        }
      }
      await stream.return?.();
      expect(turnCompleted).toBe(true);

      const healthBeforeRelease = await host.health();
      if (healthBeforeRelease.pid) {
        for (const pid of collectDescendantPids(healthBeforeRelease.pid)) allTrackedPids.add(pid);
      }
      await host.release();
      host = null;

      /* Verify zero orphan processes before exercising the read stack. */
      const reapDeadline = Date.now() + 5_000;
      while ([...allTrackedPids].some(isPidAlive) && Date.now() < reapDeadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const surviving = [...allTrackedPids].filter(isPidAlive);
      expect(surviving).toEqual([]);

      /* 1. Real scanner discovery & project grouping */
      const roots: Record<RootKey, string> = {
        "codex-sessions": path.join(sandbox, "empty-codex"),
        "claude-projects": path.join(sandbox, "empty-claude"),
        "claude-tasks": path.join(sandbox, "empty-tasks"),
        "openclaw-sessions": path.join(sandbox, "empty-openclaw"),
        "copilot-sessions": path.join(sandbox, "empty-copilot"),
        "antigravity-sessions": path.join(antigravityHome, "sessions"),
      };
      const scan = await discoverFilesWithProjectCatalog(roots, undefined, { persist: false });
      const entry = scan.files.find((f) => f.path === transcriptPath);
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({
        engine: "antigravity",
        fmt: "antigravity",
        root: "antigravity-sessions",
        kind: "session",
        project: projectForCwd(workspace),
      });
      expect(entry!.title.length).toBeGreaterThan(0);

      /* 2. Real feed rendering */
      const rawLines = fs.readFileSync(transcriptPath!, "utf8").split("\n").filter(Boolean);
      const feed = buildFeed(entry!, rawLines, true, "");
      const users = feed.items.filter((item): item is Extract<Item, { kind: "user" }> => item.kind === "user");
      const prose = feed.items.filter((item): item is Extract<Item, { kind: "prose" }> => item.kind === "prose");
      const tools = feed.items.filter((item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool");
      const svc = feed.items.filter((item): item is Extract<Item, { kind: "svc" }> => item.kind === "svc");
      expect(users.some((u) => u.text.includes(replyToken))).toBe(true);
      expect(prose.some((p) => p.engine === "antigravity" && p.text.includes(fileToken) && p.text.includes(replyToken))).toBe(true);
      expect(tools.length).toBeGreaterThanOrEqual(1);
      expect(tools.some((t) => t.status === "ok")).toBe(true);
      expect(svc.length).toBeGreaterThanOrEqual(1);

      /* 3. Real session reader, compactText, and projectTimeline */
      const session = readSession(transcriptPath!, "antigravity");
      expect(session.engine).toBe("antigravity");
      expect(session.messages.some((m) => m.role === "user" && m.text.includes(replyToken))).toBe(true);
      expect(session.messages.some((m) => m.role === "assistant" && m.text.includes(fileToken) && m.text.includes(replyToken))).toBe(true);
      expect(session.tools.some((t) => t.kind === "tool_call")).toBe(true);
      expect(session.tools.some((t) => t.kind === "tool_result")).toBe(true);

      const compact = compactText(entry!, 5, 1_000, 4_096);
      expect(compact.messages.some((m) => m.role === "assistant" && m.text.includes(fileToken))).toBe(true);

      const timeline = projectTimeline([entry!], entry!.project, 20);
      expect(timeline.some((event) => event.kind === "user")).toBe(true);
      expect(timeline.some((event) => event.kind === "turn")).toBe(true);

      /* 4. Real FTS5 transcript indexing & search */
      const stat = fs.statSync(transcriptPath!);
      const indexed = await indexTranscriptSources([{
        path: transcriptPath!,
        project: entry!.project,
        engine: "antigravity",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }], { complete: true });
      expect(indexed.failures).toEqual([]);
      expect(indexed.messagesIndexed).toBeGreaterThanOrEqual(2);

      const fileHit = searchTranscripts({ query: fileToken });
      expect(fileHit.items).toMatchObject([
        expect.objectContaining({ engine: "antigravity", speaker: "assistant", transcriptPath }),
      ]);
      const replyHit = searchTranscripts({ query: replyToken, speaker: "assistant" });
      expect(replyHit.items).toMatchObject([
        expect.objectContaining({ engine: "antigravity", speaker: "assistant", transcriptPath }),
      ]);

      /* 5. Resource worker request contract accepts the real scanned entry */
      expect(resourceWorkerRequestProblem({
        type: "collect",
        fresh: false,
        identityEpoch: null,
        files: [{
          path: entry!.path,
          parent: entry!.parent,
          title: entry!.title,
          project: entry!.project,
          activity: entry!.activity,
          mtime: entry!.mtime,
          engine: entry!.engine,
          pid: entry!.pid,
          proc: entry!.proc,
          conversationId: entry!.conversationId ?? null,
        }],
        hosts: [],
      })).toBeNull();

      console.log(
        `[agy-slice3-e2e] PASS in ${((performance.now() - t0) / 1000).toFixed(2)}s, records=${rawLines.length}, tools=${tools.length}, messages=${session.messages.length}`,
      );
    } finally {
      if (host) {
        try { await host.release(); } catch { /* ignore */ }
      }
      for (const pid of allTrackedPids) {
        try { process.kill(pid, "SIGKILL"); } catch { /* exited */ }
      }
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      makeWritableRecursive(sandbox);
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 120_000);
});
