import fs from "node:fs";
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
export async function holdFinishedRoot(directory: string, pipeline = "retention-lane", check = "") {
  const stat = fs.lstatSync(directory), identity = `${stat.dev}:${stat.ino}`, id = digest([directory, check]);
  const dead = { pid: 2147483646, startIdentity: "fixture-dead", bootEpoch: "fixture-boot" };
  const body = { version: 1 as const, runId: id, manifest: { version: 1 as const, deadline: 1, executionMs: 1, deadlineUptimeMs: 1,
    clockBootEpoch: "fixture-boot", cwd: directory, selection: ["finished"], inputs: [{ root: directory, file: "data", sha256: digest("data") }],
    roots: [{ directory, identity, purpose: "evidence" as const }], outputs: [{ root: directory, file: "result" }],
    completion: { root: directory, file: "complete" }, configurationDigest: digest("fixture") },
    argv: ["fixture"], recorder: dead, wrapper: null, directoryIdentity: identity, startedAt: 1, startedUptimeMs: 1, deadlineUptimeMs: 1 };
  const row = rowSchema.parse({ id, request: id,
    binding: { project: "fixture", pipeline, stage: "build", attempt: 1, launch: "retention-launch", conversation: "fixture",
      session: "fixture", runtimeFence: "fixture", endpoint: "fixture", host: dead },
    log: directory + "/check.log", descriptor: { ...body, descriptorDigest: descriptorDigest(body) }, revision: 1,
    admission: "accepted", reason: "finished fixture", result: null, acknowledgement: null,
    notification: { key: id, conversation: "fixture", path: "fixture", text: "finished", operation: null, state: "delivered", reason: null } });
  const store = new RecordedCheckStore();
  try { await store.write(row, null); } finally { store.close(); }
  return id;
}
