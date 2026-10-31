import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NextRequest } from "next/server";

import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { persistProjectAliases, projectAliasSnapshot, recordedProjectRemotes } from "@/lib/projects/aliases";
import { createManualProject } from "@/lib/projects/curation";
import { namedProjectDirectory, resolveNamedProject } from "@/lib/projects/nameResolution";
import { projectDirectoryEntries } from "@/lib/transfer/exporter";
import * as scanner from "@/lib/scanner";
import { MEMBER_COOKIE, mintSession } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { createWorkspace } from "@/lib/team/workspaces";
import type { Member } from "@/lib/team/contract";
import { GET, PUT } from "./route";

let root: string;
const prior = process.env.LLV_STATE_DIR;
const ORIGIN = "http://localhost";
const NOW = "2026-10-29T08:00:00.000Z";
const WORKSPACE = `w_${"a".repeat(32)}`;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "project-presentation-route-"));
  process.env.LLV_STATE_DIR = root;
  resetTeamStoreForTests();
});
afterEach(() => {
  resetTeamStoreForTests();
  if (prior === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = prior;
  fs.rmSync(root, { recursive: true, force: true });
});

function request(body: unknown, cookie = `llv_operator=${soloBrowserSession()}`, origin = ORIGIN): NextRequest {
  return new NextRequest(`${ORIGIN}/api/projects/settings`, { method: "PUT", headers: { origin, host: "localhost", cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
}
const read = async (project: string, cookie = "") => (await GET(new NextRequest(`${ORIGIN}/api/projects/settings?project=${project}`, { headers: { cookie } }))).json();

function readAfterRestart(project: string) {
  const child = spawnSync(process.execPath, ["--eval", `
    const { GET } = await import("./src/app/api/projects/settings/route.ts");
    const { NextRequest } = await import("next/server");
    const response = await GET(new NextRequest("http://localhost/api/projects/settings?project=${project}"));
    process.stdout.write(JSON.stringify(await response.json()));
  `], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 20_000 });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

test("rename, rescan, restart, succession and explicit folder reset keep identity intact", async () => {
  const folder = path.join(root, "ExampleFolder");
  fs.mkdirSync(folder);
  const created = createManualProject("Initial label", folder);
  if (!created.ok) throw new Error(created.code);
  const old = created.entry.project;
  expect((await PUT(request({ project: old, name: "  Example display  " }))).status).toBe(200);
  expect(await read(old)).toMatchObject({ project: old, name: "Example display" });
  const target = `repo-${"b".repeat(32)}`;
  expect(persistProjectAliases([{ source: old, target, displayName: "ScannedFolder" }])).toBe(true);
  expect(await read(target)).toMatchObject({ project: target, name: "Example display" });
  // Alias registration never receives the operator's presentation name.
  expect(projectAliasSnapshot().displayNames[target]).toBe("ScannedFolder");
  const directory = () => namedProjectDirectory({ includeActiveSeats: false });
  expect(directory().labels.get(target)).toBe("Example display");
  expect(resolveNamedProject("Example display", directory())).toBe(target);
  const exported = () => projectDirectoryEntries([target], { ...projectAliasSnapshot(), remotes: recordedProjectRemotes() }, new Map());
  expect(exported()[0]?.displayName).toBe("Example display");
  expect(readAfterRestart(target)).toMatchObject({ project: target, name: "Example display" });
  expect((await PUT(request({ project: old, name: null }))).status).toBe(200);
  expect(await read(target)).toMatchObject({ name: null });
  expect(directory().labels.get(target)).toBe("ExampleFolder");
  expect(exported()[0]?.displayName).toBe("ExampleFolder");
  const stored = JSON.parse(fs.readFileSync(path.join(root, "project-presentation.json"), "utf8"));
  expect(stored.projects[target].name).toMatchObject({ value: null, folderName: "ExampleFolder", changedBy: "operator" });
  expect(fs.existsSync(folder)).toBe(true);
});

test("empty, oversized and malformed names refuse the whole request", async () => {
  const project = "example";
  expect((await PUT(request({ project, name: "Valid" }))).status).toBe(200);
  for (const name of ["", "   ", "a".repeat(81), 3, false, {}, []]) {
    expect((await PUT(request({ project, name, bridgeReports: false }))).status).toBe(400);
    expect(await read(project)).toMatchObject({ name: "Valid", bridgeReports: { enabled: true } });
  }
  expect((await PUT(request({ project, name: "a".repeat(80) }))).status).toBe(200);
  expect((await PUT(request({ project, name: "Foreign" }, undefined, "https://example.invalid"))).status).toBe(403);
  expect(await read(project)).toMatchObject({ name: "a".repeat(80) });
});

test("archive and unarchive persist; running or unreadable activity refuses archive", async () => {
  const scan = spyOn(scanner, "listFiles").mockResolvedValue([]);
  try {
    const project = "example";
    expect((await PUT(request({ project, archived: true }))).status).toBe(200);
    expect(scan).toHaveBeenCalledWith({ fresh: true });
    expect(await read(project)).toMatchObject({ archived: true });
    expect(readAfterRestart(project)).toMatchObject({ archived: true });
    expect((await PUT(request({ project, archived: false }))).status).toBe(200);
    expect(await read(project)).toMatchObject({ archived: false });
    expect(readAfterRestart(project)).toMatchObject({ archived: false });
    for (const active of [{ proc: "running", activity: "recent" }, { proc: "idle", activity: "live" }]) {
      scan.mockResolvedValue([{ project, ...active }] as Awaited<ReturnType<typeof scanner.listFiles>>);
      expect((await PUT(request({ project, archived: true }))).status).toBe(409);
      expect(await read(project)).toMatchObject({ archived: false });
    }
    scan.mockRejectedValue(new Error("Activity unavailable"));
    expect((await PUT(request({ project, archived: true }))).status).toBe(503);
    expect(await read(project)).toMatchObject({ archived: false });
    for (const archived of [null, "yes", 1, {}]) expect((await PUT(request({ project, archived }))).status).toBe(400);
  } finally { scan.mockRestore(); }
});

function team() {
  const store = teamStore();
  const cookies: Record<string, string> = {};
  const people = ["owner", "manager", "member", "outsider"].map(role => {
    const member: Member = { id: `m_${role}`, name: role, role: role === "owner" ? "owner" : "member", status: "active", color: "teal", telegram: null, createdAt: NOW, createdBy: "claim", revokedAt: null };
    store.insertMember(member);
    cookies[role] = `${MEMBER_COOKIE}=${mintSession(store, member.id, "claim", { surface: "desktop", browser: "chrome" }).value}`;
    return member;
  });
  createWorkspace(store, people[0]!, { id: WORKSPACE, name: "Example workspace", projects: ["example"] });
  store.putWorkspaceMember(WORKSPACE, "m_manager", "manager", "m_owner", NOW);
  store.putWorkspaceMember(WORKSPACE, "m_member", "member", "m_owner", NOW);
  return { store, cookies };
}

test("exported route enforces owner/manager rights and audits the actual member", async () => {
  const { store, cookies } = team();
  const scan = spyOn(scanner, "listFiles").mockResolvedValue([]);
  try {
    for (const role of ["owner", "manager"]) {
      expect((await PUT(request({ project: "example", name: role, archived: true }, cookies[role]))).status).toBe(200);
      expect(await read("example", cookies[role])).toMatchObject({ name: role, archived: true });
    }
    const calls = scan.mock.calls.length;
    for (const role of ["member", "outsider"]) {
      for (const patch of [{ name: "Forbidden" }, { name: null }, { archived: true }, { archived: false }]) {
        expect((await PUT(request({ project: "example", ...patch }, cookies[role]))).status).toBe(403);
      }
    }
    expect((await PUT(request({ project: "foreign", name: "Forbidden" }, cookies.manager))).status).toBe(403);
    expect((await PUT(request({ project: "example", name: "Anonymous" }, ""))).status).toBe(401);
    expect(scan.mock.calls.length).toBe(calls);
    expect(await read("example", cookies.owner)).toMatchObject({ name: "manager", archived: true });
    expect(store.events({ actions: ["project.renamed"], limit: 10 }).map(event => event.actor)).toEqual([
      { kind: "member", memberId: "m_manager" }, { kind: "member", memberId: "m_owner" },
    ]);
  } finally { scan.mockRestore(); }
});

test("manager revocation during activity verification prevents the final write", async () => {
  const { store, cookies } = team();
  const scan = spyOn(scanner, "listFiles").mockImplementation(async () => {
    store.putWorkspaceMember(WORKSPACE, "m_manager", "member", "m_owner", NOW);
    return [];
  });
  try {
    expect((await PUT(request({ project: "example", name: "Late", archived: true, bridgeReports: false }, cookies.manager))).status).toBe(403);
    expect(await read("example", cookies.owner)).toMatchObject({ name: null, archived: false, bridgeReports: { enabled: true } });
    expect(fs.existsSync(path.join(root, "project-presentation.json"))).toBe(false);
  } finally { scan.mockRestore(); }
});

test("manager revocation while queued for the real settings lock prevents commit", async () => {
  const { store, cookies } = team();
  expect((await PUT(request({ project: "example", name: "Original" }, cookies.manager))).status).toBe(200);
  const { withFileTransaction } = await import("@/lib/state/fileTransaction");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const filename = path.join(root, "project-presentation.json");
  const blocker = withFileTransaction(filename, "Fixture settings lock", async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let stopWatching = () => {};
  const queued = new Promise<void>((resolve, reject) => {
    const directory = `${filename}.write-locks`;
    const watcher = fs.watch(directory, () => {
      if (fs.readdirSync(directory).filter(name => name.endsWith(".json")).length === 2) { stopWatching(); resolve(); }
    });
    const timer = setTimeout(() => { stopWatching(); reject(new Error("The route writer did not enter the settings queue")); }, 10_000);
    stopWatching = () => { watcher.close(); clearTimeout(timer); };
  });
  const pending = PUT(request({ project: "example", name: "Forbidden" }, cookies.manager));
  try {
    await queued;
    store.putWorkspaceMember(WORKSPACE, "m_manager", "member", "m_owner", NOW);
    release.resolve();
    await blocker;
    expect((await pending).status).toBe(403);
    expect(await read("example", cookies.owner)).toMatchObject({ name: "Original" });
    expect(store.events({ actions: ["project.renamed"], limit: 10 })).toHaveLength(1);
  } finally {
    stopWatching();
    release.resolve();
    await blocker;
    await pending;
  }
});

test("a failed durable write reports failure and retains the prior setting", async () => {
  expect((await PUT(request({ project: "example", name: "Original" }))).status).toBe(200);
  const durable = await import("@/lib/state/durableJson");
  const write = spyOn(durable, "writeJsonDurably").mockImplementation(() => { throw new Error("Write refused"); });
  try {
    expect((await PUT(request({ project: "example", name: "Lost" }))).status).toBe(500);
    expect(await read("example")).toMatchObject({ name: "Original" });
  } finally { write.mockRestore(); }
});

test("malformed persisted presentation refuses a write without replacing the source", async () => {
  const filename = path.join(root, "project-presentation.json");
  const bytes = "{incomplete";
  fs.writeFileSync(filename, bytes);
  expect((await PUT(request({ project: "example", name: "Replacement" }))).status).toBe(500);
  expect(fs.readFileSync(filename, "utf8")).toBe(bytes);
});
