import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import {
  emptyLaunchProfile,
  launchProfileCodexSandbox,
  launchProfileEngineReadOnly,
} from "@/lib/accounts/migration/contracts";
import { reconcileMigrationInventory } from "@/lib/accounts/migration/coordinator";
import { AgentRegistry } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import {
  materializeStructuredHostAccess,
  structuredHostAccessPolicy,
} from "./structuredSpawn";

test.each([
  { readOnly: false, sandbox: "full", codexSandbox: "danger-full-access" },
  { readOnly: false, sandbox: "restricted", codexSandbox: "workspace-write" },
  { readOnly: true, sandbox: "full", codexSandbox: "danger-full-access" },
  { readOnly: true, sandbox: "restricted", codexSandbox: "workspace-write" },
] as const)(
  "materializes repository readOnly=$readOnly independently from sandbox=$sandbox",
  ({ readOnly, sandbox, codexSandbox }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-access-profile-"));
    const sourceEnv = {
      NODE_ENV: "test" as const,
      HOME: path.join(directory, "home"),
      XDG_CONFIG_HOME: path.join(directory, "config"),
      TMPDIR: path.join(directory, "caller-tmp"),
    };
    try {
      expect(structuredHostAccessPolicy({ readOnly, sandbox })).toEqual({ readOnly, sandbox });
      expect(launchProfileEngineReadOnly({ readOnly, sandbox })).toBeFalse();
      expect(launchProfileCodexSandbox({ readOnly, sandbox })).toBe(codexSandbox);
      const materialized = materializeStructuredHostAccess(
        { readOnly, sandbox },
        sourceEnv,
        "capability",
        directory,
      );
      expect(materialized.codex).toEqual(sandbox === "restricted" ? {
        sandbox: codexSandbox,
        permissionProfile: "llv-stage",
        permissionProfileConfig: `permissions.llv-stage={extends=":workspace",filesystem={${JSON.stringify(materialized.scratchDirectory)}="write",${JSON.stringify(materialized.env.LLV_EVIDENCE_DIR)}="write"}}`,
      } : { sandbox: codexSandbox });
      /* Every pipeline stage gets its own scratch TMPDIR, and it goes with the
         host (#1957). */
      expect(path.dirname(materialized.scratchDirectory!)).toBe(directory);
      expect(materialized.env.TMPDIR).toBe(path.join(materialized.scratchDirectory!, "tmp"));
      expect(materialized.host.releaseCleanup).toBe(materialized.cleanup);
      if (sandbox === "full") {
        /* Claude's background-task root stays where the Viewer scans it. */
        expect(materialized.env.CLAUDE_CODE_TMPDIR).toBe(sourceEnv.TMPDIR);
      }
      fs.writeFileSync(path.join(materialized.env.TMPDIR!, "export.tar"), "reviewed head");
      materialized.cleanup();
      expect(fs.existsSync(materialized.scratchDirectory!)).toBeFalse();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("legacy read-only launch profiles retain their pre-axis engine sandbox on adoption", () => {
  expect(structuredHostAccessPolicy({ readOnly: true, sandbox: null })).toBeTrue();
  expect(launchProfileEngineReadOnly({ readOnly: true, sandbox: null })).toBeTrue();
  expect(launchProfileCodexSandbox({ readOnly: true, sandbox: null })).toBe("read-only");
});

test("full-access stages pin package caches before isolating their working directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stage-cache-access-"));
  const scratch = path.join(root, "scratch");
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const bunInstall = path.join(root, "bun-install");
  const bunCache = path.join(root, "bun-cache");
  const uvCache = path.join(root, "uv-cache");
  const explicit = { BUN_INSTALL_CACHE_DIR: bunCache, UV_CACHE_DIR: uvCache };
  const originalState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  try {
    const cases = [
      { env: {}, bun: path.join(home, ".bun"), uv: path.join(home, ".cache", "uv") },
      { env: { XDG_CACHE_HOME: xdg }, bun: path.join(xdg, ".bun"), uv: path.join(xdg, "uv") },
      { env: { XDG_CACHE_HOME: xdg, BUN_INSTALL: bunInstall }, bun: bunInstall, uv: path.join(xdg, "uv") },
    ];
    const owner = { pipelineId: "stage-cache", launchId: "stage-cache-launch", retainUntilClose: false };
    for (const { env, bun, uv } of cases) {
      const full = materializeStructuredHostAccess(false, { HOME: home, ...env }, null, scratch, owner);
      expect(full.env.BUN_INSTALL_CACHE_DIR).toBe(path.join(bun, "install", "cache"));
      expect(full.env.UV_CACHE_DIR).toBe(uv);
    }
    const source = { HOME: home, XDG_CACHE_HOME: xdg, BUN_INSTALL: bunInstall, ...explicit };
    const full = materializeStructuredHostAccess(false, source, null, scratch, owner);
    expect(full.env).toMatchObject(explicit);
    const restricted = materializeStructuredHostAccess(true, source, null, scratch, owner);
    expect(restricted.env.BUN_INSTALL_CACHE_DIR).toBeUndefined();
    expect(restricted.env.UV_CACHE_DIR).toBeUndefined();
  } finally {
    if (originalState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = originalState;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resume successors preserve both explicit pipeline access axes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-access-resume-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, {
      sqliteMode: "off",
    });
    const sourcePath = path.join(directory, "source.jsonl");
    const snapshot = registry.reconcileConversations([{
      engine: "codex",
      path: sourcePath,
      accountId: "account-a",
      launchProfile: emptyLaunchProfile({
        cwd: directory,
        title: "Preserve pipeline runtime profile",
        readOnly: true,
        sandbox: "restricted",
      }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-08-31T00:00:00.000Z",
    }]);
    const conversation = Object.values(snapshot.conversations)[0];
    if (!conversation) throw new Error("source conversation was not reconciled");

    const resumed = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      conversationId: conversation.id,
      purpose: "resume-successor",
      origin: { kind: "successor" },
      launchProfile: {},
    });
    if (resumed.kind !== "created") throw new Error("resume successor was not created");
    expect(resumed.receipt.launchProfile).toMatchObject({
      readOnly: true,
      sandbox: "restricted",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("inventory preserves both access axes from a pending structured launch receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-access-inventory-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, {
      sqliteMode: "off",
    });
    const pathname = path.join(directory, "pending-stage.jsonl");
    fs.writeFileSync(pathname, "{}\n");
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      expectedArtifactPath: pathname,
      launchProfile: emptyLaunchProfile({
        cwd: directory,
        title: "Recover pending pipeline stage",
        readOnly: false,
        sandbox: "restricted",
      }),
    });
    if (begun.kind !== "created") throw new Error("pending stage receipt was not created");
    const stat = fs.statSync(pathname);
    const entry: FileEntry = {
      path: pathname,
      root: "codex-sessions",
      name: path.basename(pathname),
      project: "repo",
      title: "Pending pipeline stage",
      engine: "codex",
      kind: "session",
      fmt: "codex",
      parent: null,
      mtime: stat.mtimeMs / 1000,
      size: stat.size,
      activity: "recent",
      activityReason: "jsonl_turn_completed",
      derivationComplete: true,
      proc: null,
      pid: null,
      model: "gpt-5.6-sol",
      pendingQuestion: null,
      waitingInput: null,
    };

    await reconcileMigrationInventory(registry, [entry], { deferBoardRepair: true });

    expect(registry.conversationForPath(pathname)?.generations.at(-1)?.launchProfile).toMatchObject({
      readOnly: false,
      sandbox: "restricted",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

