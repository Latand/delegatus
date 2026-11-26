import { projectAliasResolver } from "@/lib/projects/aliases";
import { loadTasksByIds } from "@/lib/tasks/store";
import { secretRequestRecords } from "./store";
import { secretError, type SecretRequestRecord } from "./types";
import { secretTarget, type SecretRequestNotice, type SecretRequestView } from "./view";
import { readSecretRequest } from "./write";

const activeBySnapshot = new WeakMap<readonly SecretRequestRecord[], readonly SecretRequestRecord[]>();

function active(rows: readonly SecretRequestRecord[], now: number) {
  if (!rows.length) return [];
  let open = activeBySnapshot.get(rows);
  if (!open) {
    open = rows.filter(row => row.state === "pending" || row.state === "writing");
    activeBySnapshot.set(rows, open);
  }
  return open.filter(row => row.state === "writing" || row.expiresAt > now);
}

function identity(row: SecretRequestRecord, project: string) {
  return { id: row.id, project, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

function notice(row: SecretRequestRecord, project: string): SecretRequestNotice {
  const { destination } = row;
  return { ...identity(row, project), target: secretTarget(destination.path, destination.kind === "env" ? destination.key : undefined) };
}

/** The board needs only the project, count, link target and the name of what it writes to. */
export async function secretRequestNotices(now = Date.now()): Promise<SecretRequestNotice[]> {
  const rows = await secretRequestRecords();
  const open = active(rows, now);
  if (!open.length) return [];
  const canonical = projectAliasResolver();
  return open.map(row => notice(row, canonical(row.project)));
}

export async function operatorSecretRequests(project: string, now = Date.now()): Promise<SecretRequestView[]> {
  const canonical = projectAliasResolver();
  const key = canonical(project);
  const rows = await secretRequestRecords();
  const open = await Promise.all(active(rows, now).filter(row => canonical(row.project) === key).map(async row => {
    if (row.state !== "writing") return row;
    try { return await readSecretRequest(row.id, now, 100); }
    catch (error) {
      console.warn(`[secret-request] ${row.id} recovery ${secretError(error, "secret_request_unavailable").code}`);
      return row;
    }
  }));
  const taskIds = new Set(open.flatMap(row => row?.taskId ? [row.taskId] : []));
  const tasks = new Map((taskIds.size ? loadTasksByIds(taskIds) : [])
    .filter(task => canonical(task.project) === key).map(task => [task.id, task.text.split(/\r?\n/, 1)[0]?.slice(0, 120) ?? ""]));
  return open.flatMap((row): SecretRequestView[] => {
    if (!row || (row.state !== "pending" && row.state !== "writing") || (row.state === "pending" && row.expiresAt <= now)) return [];
    const { requester, destination } = row;
    const previous = rows.reduce<{ id: string; at: number } | undefined>((last, candidate) => {
      if (candidate.state !== "entered" || candidate.enteredAt > now
        || candidate.destination.path !== destination.path || candidate.destination.kind !== destination.kind
        || (destination.kind === "env" && (candidate.destination.kind !== "env" || candidate.destination.key !== destination.key))
        || canonical(candidate.project) !== key) return last;
      return !last || candidate.enteredAt > last.at || candidate.enteredAt === last.at && candidate.id > last.id
        ? { id: candidate.id, at: candidate.enteredAt } : last;
    }, undefined);
    return [{
      ...identity(row, key), state: row.state, purpose: row.purpose, format: row.format, minLength: row.minLength,
      requester: {
        title: requester.title, role: requester.role, engine: requester.engine,
        ...(requester.model ? { model: requester.model } : {}),
        ...(requester.stage ? { stage: { id: requester.stage.stageId, pipelineId: requester.stage.pipelineId } } : {}),
        ...(requester.seat.conversationId !== requester.conversationId && requester.seat.title ? { seatTitle: requester.seat.title } : {}),
      },
      ...(row.taskId ? { task: { id: row.taskId, title: tasks.get(row.taskId) || row.taskId } } : {}),
      destination: {
        kind: destination.kind, path: destination.path, effect: destination.effect, git: destination.git,
        ...(destination.kind === "env" ? { key: destination.key } : {}),
        ...(destination.previous ? { previous: { size: destination.previous.size, modifiedAt: destination.previous.modifiedAt } } : {}),
      },
      destinationRevision: row.destinationRevision,
      ...(previous ? { lastSet: previous } : {}),
      ...(row.refusals.at(-1)?.code === "secret_entry_interrupted" ? { interrupted: true } : {}),
    }];
  });
}
