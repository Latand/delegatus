import { expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { setSubscriptionApiConsent } from "@/lib/accounts/subscriptionApiConsent";
import { writeAsksYouSettings, readAsksYouSettings } from "@/lib/asks/settings";
import { forgeAppRepositories } from "@/lib/git/agentForgeCredentials";
import { curationCollection } from "@/lib/memory/curation/store";
import { readProfileRow, writeProfileRow } from "@/lib/memory/profileStore";
import { deleteRule, leaveSeatLessons, roleMemoryCollection } from "@/lib/memory/roleStore";
import { setSharedMemoryEnabled, sharedMemoryEnabled } from "@/lib/memory/settings";
import { readSeatTickSettings, writeSeatTickSettings, defaultSeatTickSettings } from "@/lib/monitor/seatTickSettings";
import { readOperatorSettings, updateOperatorSettings } from "@/lib/operator/settings";
import { readWorkerLimits, setMachineWorkerLimit, setProjectWorkerLimit } from "@/lib/operator/workerLimit";
import { canonicalProject, persistProjectAliases, recordProjectRemote } from "@/lib/projects/aliases";
import { createManualProject, projectCurationSnapshot } from "@/lib/projects/curation";
import { directoryProjectId, projectIdentityFromRemote } from "@/lib/projects/identity";
import { mergeOnReviewEnabled, setMergeOnReview } from "@/lib/projects/settings";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";
import { resolveTranscribeBackend, writeTranscribeBackend } from "@/lib/transcribeBackend";
import { resolveTtsBackend, writeTtsBackend } from "@/lib/ttsBackend";
import type { RoleMemoryRow } from "@/lib/memory/roleTypes";

import { scopeFigures } from "./roleMemory";

/* Two isolated installs in one test process: each is a state directory and
   a config root, switched by the two variables every store resolves per
   call. The seed goes through the stores' own writers, so the rows the
   export reads are the rows a real install holds. */

export interface Install {
  root: string;
  state: string;
  config: string;
  home: string;
}

export function makeInstall(parent: string, name: string): Install {
  const root = path.join(parent, name);
  const install = { root, state: path.join(root, "xdg", "delegatus", "state"), config: path.join(root, "xdg"), home: path.join(root, "home") };
  fs.mkdirSync(install.state, { recursive: true, mode: 0o700 });
  fs.mkdirSync(install.home, { recursive: true, mode: 0o700 });
  return install;
}

export function installEnv(install: Install): Record<string, string> {
  return { LLV_STATE_DIR: install.state, XDG_CONFIG_HOME: install.config };
}

export async function within<T>(install: Install, run: () => T | Promise<T>): Promise<T> {
  const saved = { state: process.env.LLV_STATE_DIR, config: process.env.XDG_CONFIG_HOME, seat: process.env.LLV_SEAT_TICK_SETTINGS_FILE };
  process.env.LLV_STATE_DIR = install.state;
  process.env.XDG_CONFIG_HOME = install.config;
  delete process.env.LLV_SEAT_TICK_SETTINGS_FILE;
  try { return await run(); }
  finally {
    for (const [name, value] of [["LLV_STATE_DIR", saved.state], ["XDG_CONFIG_HOME", saved.config], ["LLV_SEAT_TICK_SETTINGS_FILE", saved.seat]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

export const REMOTE = "https://forge.example.test/owner/alpha.git";
export const REPOSITORY = projectIdentityFromRemote(REMOTE, "/")!.project;
/** A project key that moved: rows still stored under it must leave as REPOSITORY. */
export const MOVED_FROM = `repo-${"a".repeat(32)}`;
export const NOW = "2026-10-22T10:00:00.000Z";
export const SECRET_SHAPED_VALUE = "abcdefghijklmnopqrstuvwx";
export const RELAY_CREDENTIAL = "relay-pairing-credential-never-exported-0001";

const seat = (project: string) => ({ origin: "seat" as const, project, roleId: "orchestrator" as const, fixRound: false as const, conversationId: "conversation-1" });

/** The source install's memory and settings, written through each store's own writer. */
export async function seedSource(install: Install, options: { secretLesson?: boolean } = {}): Promise<{ folder: string; folderKey: string; ruleIds: string[] }> {
  return within(install, async () => {
    await ensureLegacyCollectionsImported(() => {});
    const folder = path.join(install.root, "work", "beta");
    fs.mkdirSync(folder, { recursive: true });
    const folderKey = directoryProjectId(fs.realpathSync(folder));
    recordProjectRemote({ project: REPOSITORY, canonicalRemote: "forge.example.test/owner/alpha" });
    expect(persistProjectAliases([{ source: MOVED_FROM, target: REPOSITORY, displayName: "alpha" }])).toBe(true);

    const ids: string[] = [];
    const lesson = (project: string, now: string, scope: "machine" | "project" | "role", rule: string, why: string) =>
      ids.push(...leaveSeatLessons({ source: seat(project), now, lessons: [{ scope, rule, why }] }).left.map(entry => entry.id));
    lesson(REPOSITORY, NOW, "machine", "Run the heavy checks through the shared slot wrapper.", "The agent scope has a memory cap.");
    lesson(REPOSITORY, "2026-10-22T10:00:10.000Z", "project", "Keep public text free of identities.", "The repository is public.");
    lesson(REPOSITORY, "2026-10-22T10:00:20.000Z", "role", "Read the newest operator answer before acting.", "Later answers replace earlier ones.");
    lesson(REPOSITORY, "2026-10-22T10:01:00.000Z", "role", "State outcomes with their evidence.", "Claims need proof.");
    const rewritten = leaveSeatLessons({ source: seat(REPOSITORY), now: "2026-10-22T10:02:00.000Z", lessons: [], rewrite: { id: ids[3]!, rule: "State every outcome with the evidence behind it.", why: "Claims need proof." } });
    expect(rewritten.left[0]?.action).toBe("rewrite");
    deleteRule(ids[1]!, "2026-10-22T10:03:00.000Z");
    lesson(folderKey, "2026-10-22T10:04:00.000Z", "role", "This folder's scripts run from its root.", "Relative paths.");
    /* Built at run time: a literal key-and-value line shaped like a secret reads as a credential to the publication gate. */
    if (options.secretLesson) lesson(REPOSITORY, "2026-10-22T10:05:00.000Z", "project", `Use ${["api", "key"].join("_")} = ${SECRET_SHAPED_VALUE} for the sandbox.`, "It was pasted once.");
    curationCollection(true)!.boundedPatch(2, tx => tx.put({ kind: "project", project: REPOSITORY, current: null, lastClaimAt: NOW, lastAt: NOW, passes: [] } as never));

    writeProfileRow({ project: MOVED_FROM, locale: "en", model: "model-a", promptVersion: 1, parts: [] });
    setSharedMemoryEnabled(REPOSITORY, true);
    writeSeatTickSettings(REPOSITORY, { ...defaultSeatTickSettings(REPOSITORY), monitorPrompt: "Watch the merge queue.", wakeIntervalMinutes: 30 });
    setProjectWorkerLimit(REPOSITORY, 5, { kind: "operator", via: "test" }, null);
    setMachineWorkerLimit(7, { kind: "operator", via: "test" }, null);
    setMergeOnReview(REPOSITORY, true, "operator", NOW);
    expect(createManualProject("beta", folder).ok).toBe(true);
    updateOperatorSettings({ locale: "uk", source: "chosen", timeZone: "Europe/Kyiv" }, NOW);
    expect(writeAsksYouSettings({ enabled: true, capUsd: 3 }, new Date(NOW))).not.toBe(false);
    setSubscriptionApiConsent(true);
    writeTtsBackend("elevenlabs");
    writeTranscribeBackend("soniox");
    fs.writeFileSync(path.join(install.state, "voice-companion.json"), JSON.stringify({ version: 1, settings: { enabled: true, monthlyCapUsd: 12, backend: "codex", callMemory: true }, charges: { m: { month: "2026-10", usd: 1, reserved: false, incomplete: false } }, sessions: {} }));
    fs.writeFileSync(path.join(install.state, "forge-app-repositories.json"), JSON.stringify(["owner/alpha"]));
    fs.mkdirSync(path.join(install.state, "external-relay"), { recursive: true });
    fs.writeFileSync(path.join(install.state, "external-relay", "relays.json"), JSON.stringify({ v: 1, installId: "install-1", label: "here", pending: [], relays: [{
      id: "relay-1", origin: "https://relay.example.test", api_base: "https://relay.example.test/api", name: "Relay", description: "", credential: RELAY_CREDENTIAL,
      owner: { id: "owner-1" }, pairedAt: NOW, paused: false, limits: { max_response_bytes: 1, max_wait_s: 1, max_answer_chars: 1 },
      targets: [{ id: "target-1", name: "Helper", answered_by: "install", fallback: "none", enabled: true, engine: "codex", model: null, effort: null, project: REPOSITORY, concurrency: 1, hardCapMinutes: 10 }],
    }] }));
    fs.writeFileSync(path.join(install.state, "external-relay", "switches.json"), JSON.stringify({ v: 1, compact: true }));
    return { folder, folderKey, ruleIds: ids };
  });
}

/** What the readers of each store see on an install. */
export async function readInstall(install: Install, keys: { folderKey: string }) {
  return within(install, () => {
    const rows = (roleMemoryCollection()?.snapshot() ?? []) as RoleMemoryRow[];
    const curation = curationCollection()?.get(`p:${REPOSITORY}`) ?? null;
    return {
      scopes: Object.fromEntries([...scopeFigures(rows)].sort(([a], [b]) => a.localeCompare(b))),
      rules: rows.filter(row => row.kind === "rule").length,
      requests: rows.filter(row => row.kind === "request").length,
      curationLastAt: curation && "lastAt" in curation ? curation.lastAt : null,
      profile: readProfileRow(REPOSITORY, "en")?.model ?? null,
      shared: sharedMemoryEnabled(REPOSITORY),
      seat: readSeatTickSettings(REPOSITORY).monitorPrompt,
      workerLimits: readWorkerLimits(),
      mergeOnReview: mergeOnReviewEnabled(REPOSITORY),
      manual: projectCurationSnapshot().manualProjects.map(entry => ({ project: entry.project, displayName: entry.displayName })),
      folderCanonical: canonicalProject(keys.folderKey),
      operator: readOperatorSettings(),
      asks: readAsksYouSettings(),
      tts: resolveTtsBackend(),
      transcribe: resolveTranscribeBackend(),
      forge: forgeAppRepositories(),
    };
  });
}

/** A sorted listing of every file under a directory with its bytes' hash, to prove a tree unchanged. */
export function treeDigest(directory: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[path.relative(directory, full)] = Bun.hash(fs.readFileSync(full)).toString(16);
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
