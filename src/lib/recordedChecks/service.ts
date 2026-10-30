import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipelineRecordReader, withPipelineStartupAdmission } from "@/lib/pipelines/store";
import { agentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { captureProcessIdentity, processIdentityMayRun, sameRecordedProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { verifiedCodexSocketOwner } from "@/lib/runtime/codexSocketTransport";
import { AttemptTempStore } from "@/lib/runtime/attemptTempRetention";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { statePath } from "@/lib/configDir";
import { currentSeat } from "@/lib/orchestrator/seatChannel";
import { descriptorSchema, descriptorDigest, readEnvelope, writeEnvelope, physical, verifyManifest, ownedFile, fileDigest, retainFile, evidenceStamp, requiredConfigurationRoot, digest, custodyClock, terminalSchema, reportSchema, completionSchema, type Descriptor, type Manifest, type ProducerReport } from "./wire";
import { openRecordedChecks, type Binding, type CheckRow, type CheckResult } from "./store";
import { withRecordedHostFence } from "./hostFence";
import { wakeRecordedChecks } from "./signal";

export function callingAttempt(conversationId: string): Binding {
  const registry = agentRegistry();
  const conversation = registry.conversation(conversationId as ViewerConversationId);
  const generation = conversation?.generations.at(-1);
  const members = registry.conversationMemberships(conversationId as ViewerConversationId).filter(member => member.kind === "pipeline");
  if (!conversation || conversation.engine !== "codex" || conversation.supersededBy || !generation || members.length !== 1) throw new Error("recorded check requires one current Codex stage");
  const member = members[0]!;
  const pipeline = pipelineRecordReader(member.containerId).read();
  const run = pipeline?.runs.find(run => run.stageId === member.stageId);
  const attempt = run?.attempts.at(-1);
  const stage = pipeline?.stages.find(stage => stage.id === member.stageId);
  const entry = registry.readOnlySnapshot().entries[sessionKeyId({ engine: "codex", sessionId: generation.id })];
  const host = entry?.structuredHost;
  if (!pipeline || !attempt || !stage || stage.kind !== "run" || !["running", "needs_decision"].includes(pipeline.state)
    || pipeline.cursor?.stageId !== stage.id || pipeline.closedAt || pipeline.activationCloseRequested
    || !["running", "needs_decision"].includes(attempt.state)
    || attempt.historical || !attempt.launchId || registry.spawnReceipt(attempt.launchId)?.key?.sessionId !== generation.id || attempt.conversationId !== conversation.id
    || attempt.sessionId !== generation.id || member.round !== attempt.n || member.slot !== `${stage.id}:${attempt.n}`
    || !host?.process || host.kind !== "codex-app-server" || entry?.pendingAction || entry?.structuredTerminationCaptureId || entry?.structuredTerminationSurvivors?.length
    || !host.process.startIdentity || !host.process.bootEpoch || !verifiedCodexSocketOwner({ endpoint: host.endpoint, process: host.process })) throw new Error("recorded check native custody is unavailable");
  return { project: pipeline.project, pipeline: pipeline.id, stage: stage.id, attempt: attempt.n,
    launch: attempt.launchId, conversation: conversation.id, session: generation.id, endpoint: host.endpoint,
    host: { pid: host.process.pid, startIdentity: host.process.startIdentity, bootEpoch: host.process.bootEpoch },
    runtimeFence: digest([pipeline.controlGeneration, stage, attempt.definition, attempt.startedAt, attempt.effectiveRole, attempt.launchId]) };
}

function descendant(pid: number, parent: number): boolean {
  const seen = new Set<number>();
  for (let count = 0; count < 128 && pid > 1 && !seen.has(pid); count++) {
    if (pid === parent) return true;
    seen.add(pid); pid = procBackend.readPpid(pid) ?? 0;
  }
  return false;
}
function sameDescriptor(descriptor: Descriptor, directory: string) {
  const { descriptorDigest: expected, wrapper: _wrapper, ...input } = descriptor;
  if (descriptor.deadlineUptimeMs !== descriptor.manifest.deadlineUptimeMs
    || descriptor.recorder.bootEpoch !== descriptor.manifest.clockBootEpoch
    || descriptorDigest(input) !== expected || physical(directory) !== descriptor.directoryIdentity) throw new Error("recorded check descriptor identity changed");
  const fresh = descriptorSchema.parse(readEnvelope(path.join(directory, "descriptor.json")));
  if (digest(fresh) !== digest(descriptor)) throw new Error("recorded check descriptor was replaced");
}
export function verifyLiveCustody(binding: Binding, descriptor: Descriptor, directory: string) {
  sameDescriptor(descriptor, directory);
  if (!verifiedCodexSocketOwner({ endpoint: binding.endpoint, process: binding.host })
    || !processIdentityMayRun(descriptor.recorder) || !descendant(descriptor.recorder.pid, binding.host.pid)
    || !descriptor.wrapper || !processIdentityMayRun(descriptor.wrapper)
    || !descendant(descriptor.wrapper.pid, descriptor.recorder.pid)) throw new Error("recorded check recorder custody is unknown");
  const configuration = requiredConfigurationRoot({
    LLV_AGENT_SANDBOX_ROOT: procBackend.readEnvVar(descriptor.recorder.pid, "LLV_AGENT_SANDBOX_ROOT") ?? undefined,
    XDG_CONFIG_HOME: procBackend.readEnvVar(descriptor.recorder.pid, "XDG_CONFIG_HOME") ?? undefined,
  });
  if (configuration && !descriptor.manifest.roots.some(root => root.purpose === "configuration" && root.directory === configuration))
    throw new Error("recorded check omitted its native configuration dependency");
  if (fs.existsSync(path.join(directory, "running"))) {
    const report = readEnvelope(path.join(directory, "supervisor.json"));
    // Import the strict producer decoder only once the supervisor has dispatched.
    const parsed = reportSchema.parse(report);
    if (parsed.runId !== descriptor.runId || parsed.descriptorDigest !== descriptor.descriptorDigest
      || !processIdentityMayRun(parsed.supervisor)
      || procBackend.readEnvVar(parsed.supervisor.pid, "LLV_RECORDED_CHECK_ID") !== descriptor.runId) throw new Error("recorded check supervisor proof is unavailable");
    if (parsed.kind === "service" || parsed.service) {
      const service = parsed.service;
      if (!service || !service.invocation || !service.cgroup.endsWith("/" + service.unit)
        || procBackend.readEnvVar(parsed.supervisor.pid, "INVOCATION_ID") !== service.invocation
        || !fs.readFileSync(`/proc/${parsed.supervisor.pid}/cgroup`, "utf8").split("\n").includes(`0::${service.cgroup}`)) throw new Error("recorded check service invocation is unknown");
    } else if (!descendant(parsed.supervisor.pid, descriptor.wrapper.pid)) throw new Error("recorded check supervisor is foreign");
    return parsed;
  }
  return null;
}

function verifyRoots(manifest: Manifest, binding: Binding, temps: AttemptTempStore) {
  for (const root of manifest.roots) {
    const owner = temps.owner(root.directory);
    if (!owner || owner.pipelineId !== binding.pipeline || owner.launchId !== binding.launch || owner.identity !== root.identity
      || physical(root.directory) !== root.identity || fs.existsSync(attemptTempJournalPath(root.directory))
      || (root.purpose === "configuration") !== path.basename(root.directory).startsWith("llv-stage-config-")) throw new Error("recorded check root has no matching creation receipt");
  }
}
export type HandoffPorts = { binding(conversation: string): Binding; verify(binding: Binding, descriptor: Descriptor, directory: string): ProducerReport | null | void;
  observe(id: string): Promise<void> };

export async function handoffRecordedCheck(conversation: string, requestKey: string, ticket: string, ports: HandoffPorts, preparingId?: string): Promise<CheckRow> {
  const binding = ports.binding(conversation), registry = agentRegistry();
  const key = { engine: "codex" as const, sessionId: binding.session };
  const admitted = await registry.withOperationLock(key, captureProcessIdentity(process.pid), () => withRecordedHostFence(binding.host, async () => {
    const temps = new AttemptTempStore();
    try {
      return await withFileTransactionAsync(temps.filename + ".sweep", "recorded-check handoff", async () => {
        const log = path.resolve(ticket), directory = `${log}.gate`;
        const store = await openRecordedChecks();
        try {
          const reservation = preparingId ? store.get(preparingId) : null;
          if (preparingId && (!reservation || reservation.admission !== "preparing" || reservation.binding.conversation !== conversation)) throw new Error("recorded check preparation changed");
          const request = reservation?.request ?? digest([conversation, requestKey]);
          const prior = store.byRequest(request);
          if (prior) {
            if (prior.log !== log || digest(prior.binding) !== digest(binding)) throw new Error("recorded check request belongs to another admission");
            if (prior.admission !== "preparing") return prior;
          }
          const descriptor = prior?.descriptor ?? descriptorSchema.parse(readEnvelope(path.join(directory, "descriptor.json")));
          let assertSources: (() => void) | undefined;
          const assertAuthority = () => {
            if (descriptor.deadlineUptimeMs <= custodyClock()) throw new Error("recorded check original deadline expired before admission");
            if (digest(ports.binding(conversation)) !== digest(binding)) throw new Error("recorded check stage or native owner changed");
            verifyRoots(descriptor.manifest, binding, temps);
            sameDescriptor(descriptor, directory);
            assertSources?.();
          };
          verifyRoots(descriptor.manifest, binding, temps);
          if (!descriptor.manifest.roots.some(root => root.purpose === "evidence" && log.startsWith(root.directory + path.sep))) throw new Error("recorded check ticket is outside its evidence roots");
          if (descriptor.deadlineUptimeMs <= custodyClock()) throw new Error("recorded check original deadline expired");
          let row: CheckRow = prior ?? { id: descriptor.runId, request, binding, log, descriptor, revision: 1, admission: "preparing", reason: "verifying native custody",
            result: null, notification: null, acknowledgement: null, observerFault: null, custody: [] };
          if (!prior) await store.write(row, null, assertAuthority);
          try {
            assertSources = await verifyManifest(descriptor.manifest);
            assertAuthority();
            const custody = ports.verify(binding, descriptor, directory);
            row = { ...row, revision: row.revision + 1, admission: "accepted", reason: "native custody accepted", custody: custody ? [custody] : [] };
            await withPipelineStartupAdmission(async available => {
              if (!available) throw new Error("recorded check final stage authority is unavailable");
              await store.write(row, row.revision - 1, () => { assertAuthority(); ports.verify(binding, descriptor, directory); });
            }, "recorded check final custody", undefined, true);
          } catch (error) {
            const current = store.get(row.id)!;
            row = { ...current, revision: current.revision + 1, admission: "refused", reason: (error instanceof Error ? error.message : "custody unknown").slice(0, 1024) };
            await store.write(row, current.revision);
          }
          return store.get(row.id)!;
        } finally { store.close(); }
      });
    } finally { temps.close(); }
  }));
  // Do not carry custody locks into observation or a recovery of preparation.
  // The observer subscribes before its first snapshot, including an early close.
  await ports.observe(admitted.id);
  return admitted;
}

function terminalFor(row: CheckRow) {
  const directory = `${row.log}.gate`;
  sameDescriptor(row.descriptor, directory);
  const terminal = terminalSchema.parse(readEnvelope(path.join(directory, "result.json")));
  if (terminal.runId !== row.id || terminal.descriptorDigest !== row.descriptor.descriptorDigest
    || terminal.closedUptimeMs < row.descriptor.startedUptimeMs || terminal.report && (terminal.report.runId !== row.id
      || terminal.report.descriptorDigest !== row.descriptor.descriptorDigest)) throw new Error("recorded check close proof is foreign");
  for (const report of terminal.reports) {
    if (report.runId !== row.id || report.descriptorDigest !== row.descriptor.descriptorDigest
      || report.atUptimeMs < row.descriptor.startedUptimeMs || report.atUptimeMs > terminal.closedUptimeMs) throw new Error("recorded supervisor close proof is foreign");
  }
  if (new Set(terminal.reports.map(report => report.kind)).size !== terminal.reports.length) throw new Error("recorded supervisor close proof is ambiguous");
  if (terminal.report) {
    const source = terminal.reports.find(report => report.kind === "namespace") ?? terminal.reports.find(report => report.kind === terminal.report!.kind);
    if (!source) throw new Error("recorded command has no matching producer close proof");
    let expected = { ...source, cleanup: terminal.reports.every(report => report.phase === "close" && report.cleanup === "confirmed") ? "confirmed" as const : "unknown" as const };
    if (expected.boundary === "namespace" && !terminal.reports.some(report => report.kind === "namespace"))
      expected = { ...expected, command: null, commandExit: null, commandSignal: null };
    if (digest(expected) !== digest(terminal.report)) throw new Error("recorded command close disagrees with its producer proofs");
  }
  return terminal;
}

export async function retainResult(row: CheckRow): Promise<{ result: CheckResult; assertUnchanged(): void }> {
  const deadline = performance.now() + 30_000;
  let terminal: ReturnType<typeof terminalFor> | null = null;
  let reason = "recorded check has no terminal producer receipt";
  try { terminal = terminalFor(row); } catch (error) { reason = (error instanceof Error ? error.message : reason).slice(0, 1024); }
  const destination = statePath("evidence", "recorded-checks", row.binding.pipeline, row.id);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const evidence: CheckResult["evidence"] = [];
  const stamps: Array<{ root: string; file: string; stamp: string }> = [];
  const rootStamp = (directory: string) => { try { return physical(directory); } catch { return "unavailable"; } };
  const roots = [...row.descriptor.manifest.roots.map(root => root.directory), destination]
    .map(directory => ({ directory, stamp: rootStamp(directory) }));
  const assertUnchanged = () => {
    for (const root of roots) if (rootStamp(root.directory) !== root.stamp) throw new Error("recorded retention root changed");
    for (const entry of stamps) if (evidenceStamp(entry.root, entry.file) !== entry.stamp) throw new Error("recorded evidence changed after retention");
    if (terminal && digest(terminalFor(row)) !== digest(terminal)) throw new Error("recorded terminal proof changed after retention");
  };
  let visited = 0, completed = 0, failed = 0, complete = false;
  const entries = [...row.descriptor.manifest.inputs, ...row.descriptor.manifest.outputs,
    row.descriptor.manifest.completion, { root: path.dirname(row.log), file: path.basename(row.log) },
    ...["descriptor.json", "owner.json", "result.json", "supervisor.json", "exit",
      ...(terminal?.reports ?? []).map(report => `${report.kind}.json`)].map(file => ({ root: `${row.log}.gate`, file }))];
  try {
    const assertSources = await verifyManifest(row.descriptor.manifest, deadline);
    const seen = new Set<string>();
    let missing = false;
    for (const entry of entries) {
      try {
      const source = ownedFile(entry.root, entry.file);
      if (seen.has(source)) continue;
      seen.add(source);
      const stamp = evidenceStamp(entry.root, entry.file);
      const sha256 = await fileDigest(source, deadline), file = digest(source);
      const target = path.join(destination, file), temporary = `${target}.${randomUUID()}.copy`;
      let created = false;
      let canonicalStamp: string | undefined;
      try {
        const before = evidenceStamp(destination, file);
        if (await fileDigest(target, deadline) === sha256 && evidenceStamp(destination, file) === before) canonicalStamp = before;
      } catch { /* A missing or different canonical copy is replaced atomically. */ }
      // Atomic publication; a reader never sees an incomplete retained file.
      if (!canonicalStamp) try {
        await retainFile(source, temporary, deadline);
        created = true;
        if (await fileDigest(source, deadline) !== sha256 || await fileDigest(temporary, deadline) !== sha256) throw new Error("recorded evidence changed during retention");
        const fd = fs.openSync(temporary, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, target);
        canonicalStamp = evidenceStamp(destination, file);
      } finally { if (created) fs.rmSync(temporary, { force: true }); }
      if (canonicalStamp === undefined) throw new Error("recorded canonical evidence proof is unavailable");
      evidence.push({ file, sha256, bytes: fs.statSync(target).size });
      stamps.push({ ...entry, stamp });
      stamps.push({ root: destination, file, stamp: canonicalStamp });
      } catch { missing = true; }
    }
    assertSources();
    assertUnchanged();
    writeEnvelope(path.join(destination, "evidence-manifest.json"), { runId: row.id, descriptorDigest: row.descriptor.descriptorDigest,
      evidenceDigest: digest(evidence), files: evidence.length });
    const completion = row.descriptor.manifest.completion;
    const counts = completionSchema.parse(readEnvelope(ownedFile(completion.root, completion.file)));
    visited = counts.visited; completed = counts.completed;
    failed = counts.outcomes.filter(outcome => outcome.exit !== 0).length;
    complete = !missing && digest(counts.selection) === digest(row.descriptor.manifest.selection)
      && visited === counts.selection.length && completed === visited && counts.outcomes.length === completed
      && counts.outcomes.every((outcome, index) => outcome.name === counts.selection[index]);
    reason = terminal ? complete ? "terminal producer receipt and complete selection retained" : "terminal receipt retained; selection incomplete" : reason;
  } catch (error) { reason = (error instanceof Error ? error.message : "evidence retention unknown").slice(0, 1024); complete = false; }
  if (!terminal?.report || terminal.report.phase !== "close" || terminal.report.cleanup !== "confirmed") {
    complete = false; reason = terminal ? "terminal wrapper receipt retained; command cleanup is unknown" : reason;
  }
  if (terminal?.report && terminal.report.commandExit === null && terminal.report.commandSignal === null) {
    complete = false; reason = "terminal wrapper receipt retained; actual command outcome is unknown";
  }
  const value = { state: terminal ? "terminal" as const : "unknown" as const, reason, terminal, complete, visited, completed, failed, evidence,
    evidenceCount: evidence.length,
    evidenceDigest: digest(evidence), revision: (row.result?.revision ?? 0) + 1,
    history: [...(row.result?.history ?? []), { at: Date.now(), reason }].slice(-8) };
  return { result: { ...value, digest: digest({ ...value, revision: undefined, history: undefined }) }, assertUnchanged };
}

export function consumerPermitted(row: CheckRow, conversation: string): boolean {
  return conversation === "operator" || conversation === row.binding.conversation || currentSeat(row.binding.project)?.conversationId === conversation;
}
export async function acknowledgeRecordedCheck(row: CheckRow, actor: string, input: { resultRevision: number; resultDigest: string; evidenceDigest: string; disposition: "adopt-retained" }) {
  if (!consumerPermitted(row, actor)) throw new Error("recorded check consumer is foreign");
  const temps = new AttemptTempStore();
  try {
    return await withFileTransactionAsync(temps.filename + ".sweep", "recorded-check acknowledgement", async () => {
      const store = await openRecordedChecks();
      try {
        const current = store.get(row.id);
        if (!current || current.revision !== row.revision || !current.result || current.result.revision !== input.resultRevision
          || current.result.digest !== input.resultDigest || current.result.evidenceDigest !== input.evidenceDigest) throw new Error("recorded check result acknowledgement is stale");
        if (current.acknowledgement) return current;
        const observed = await retainResult(current);
        if (observed.result.digest !== current.result.digest || !current.result.complete
          || current.result.terminal?.report?.cleanup !== "confirmed") throw new Error("recorded evidence custody is incomplete or changed");
        const updated: CheckRow = { ...current, revision: current.revision + 1, acknowledgement: { actor, ...input, at: Date.now() } };
        await store.write(updated, current.revision, () => {
          observed.assertUnchanged();
          if (!consumerPermitted(current, actor)) throw new Error("recorded check consumer changed");
          for (const root of current.descriptor.manifest.roots) if (physical(root.directory) !== root.identity) throw new Error("recorded check root changed before release");
        });
        wakeRecordedChecks();
        return updated;
      } finally { store.close(); }
    });
  } finally { temps.close(); }
}

export function sameExecutionHost(left: Binding, right: Binding) {
  return left.endpoint === right.endpoint && sameRecordedProcessIdentity(left.host, right.host);
}

/** Explicit teardown records cancellation before signalling the existing recorder.
 * The original deadline remains unchanged and a missing close stays unknown. */
export async function cancelRecordedHost(conversation: string) {
  const store = await openRecordedChecks();
  try {
    for (const row of store.forHost(conversation)) {
      if (!store.hostHeld(conversation) || row.result?.terminal?.report?.cleanup === "confirmed") continue;
      const updated = { ...row, revision: row.revision + 1, reason: "explicit host teardown requested recorded-check cancellation" };
      await store.write(updated, row.revision);
      const descriptor = descriptorSchema.parse(readEnvelope(path.join(`${row.log}.gate`, "descriptor.json")));
      if (digest(descriptor) !== digest(row.descriptor)) throw new Error("recorded check cancellation identity changed");
      if (processIdentityMayRun(descriptor.recorder)) process.kill(descriptor.recorder.pid, "SIGTERM");
    }
  } finally { store.close(); }
}
