import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { RecordedCheckStore, rowSchema } from "@/lib/recordedChecks/store";
import { digest, descriptorDigest } from "@/lib/recordedChecks/wire";
import { buildPipeline } from "@/lib/pipelines/store";

export function finishedLane(root: string, closedAt: string) {
  const p = buildPipeline({ id: "retention-lane", task: "Retention", project: "fixture", repoDir: root,
    stages: [{ id: "build", kind: "run", prompt: "Fixture", next: null,
      effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } }],
    srcPath: null, srcConversationId: null, now: "2026-10-01T00:00:00Z" });
  p.state = "completed"; p.cursor = null; p.closedAt = closedAt;
  return p;
}

/** Persist through the real writer and reader; no observer or native command
 * is launched by these already-settled custody fixtures. */
export async function holdFinishedRoot(directory: string, pipeline = "retention-lane", check = "", siblings: string[] = [], launch = "retention-launch") {
  const stat = fs.lstatSync(directory), identity = `${stat.dev}:${stat.ino}`, id = digest([directory, check]);
  const dead = { pid: 2147483646, startIdentity: "fixture-dead", bootEpoch: "fixture-boot" };
  const body = { version: 1 as const, runId: id, manifest: { version: 1 as const, deadline: 1, executionMs: 1, deadlineUptimeMs: 1,
    clockBootEpoch: "fixture-boot", cwd: directory, selection: ["finished"], inputs: [{ root: directory, file: "data", sha256: digest("data") }],
    roots: [directory, ...siblings].map(directory => {
      const stat = fs.lstatSync(directory);
      return { directory, identity: `${stat.dev}:${stat.ino}`, purpose: "evidence" as const };
    }), outputs: [{ root: directory, file: "result" }],
    completion: { root: directory, file: "complete" }, configurationDigest: digest("fixture") },
    argv: ["fixture"], recorder: dead, wrapper: null, directoryIdentity: identity, startedAt: 1, startedUptimeMs: 1, deadlineUptimeMs: 1 };
  const row = rowSchema.parse({ id, request: id,
    binding: { project: "fixture", pipeline, stage: "build", attempt: 1, launch, conversation: "fixture",
      session: "fixture", runtimeFence: "fixture", endpoint: "fixture", host: dead },
    log: directory + "/check.log", descriptor: { ...body, descriptorDigest: descriptorDigest(body) }, revision: 1,
    admission: "accepted", reason: "finished fixture", result: null, acknowledgement: null,
    notification: { key: id, conversation: "fixture", path: "fixture", text: "finished", operation: null, state: "delivered", reason: null } });
  const store = new RecordedCheckStore();
  try { await store.write(row, null); } finally { store.close(); }
  return id;
}

/** Names pictures in the report picture index the way a stage report does,
 * with no kept copy: they are then the evidence ledger's links into scratch. */
export function nameInReport(...files: string[]) {
  const root = statePath("report-media"), index = path.join(root, "index.json");
  fs.mkdirSync(root, { recursive: true });
  let rows: unknown[] = [];
  try { rows = JSON.parse(fs.readFileSync(index, "utf8")); } catch { /* A first name starts the index. */ }
  for (const file of files) rows.push({ path: file, file: `${createHash("sha256").update(file).digest("hex")}${path.extname(file).toLowerCase()}`,
    bytes: 1, mtimeMs: 1, at: 1, project: null });
  // A new inode, so a reader holding the previous index reads this one.
  fs.writeFileSync(index + ".next", JSON.stringify(rows)); fs.renameSync(index + ".next", index);
}
