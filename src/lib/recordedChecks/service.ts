import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipelineRecordReader, withPipelineStartupAdmission } from "@/lib/pipelines/store";
import { agentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { captureProcessIdentity, processIdentityStatus, processIdentityMayRun, sameRecordedProcessIdentity } from "@/lib/processIdentity";
import { procBackend } from "@/lib/proc";
import { verifiedCodexSocketOwner } from "@/lib/runtime/codexSocketTransport";
import { AttemptTempStore } from "@/lib/runtime/attemptTempRetention";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { statePath } from "@/lib/configDir";
import { currentSeat } from "@/lib/orchestrator/seatChannel";
import { descriptorSchema, descriptorDigest, readEnvelope, writeEnvelope, physical, createOwnedDirectory, verifyManifest, ownedFile, missingOwnedFile, fileDigest, retainFile, removeOwnedFile, evidenceStamp, isConfigurationPath, requiredConfigurationRoot, digest, custodyClock, terminalSchema, reportSchema, completionSchema, type Descriptor, type Manifest, type ProducerReport } from "./wire";
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
    || processIdentityStatus(descriptor.recorder) !== "alive" || !processIdentityMayRun(descriptor.recorder) || !descendant(descriptor.recorder.pid, binding.host.pid)
    || !descriptor.wrapper || processIdentityStatus(descriptor.wrapper) !== "alive" || !processIdentityMayRun(descriptor.wrapper)
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
      || processIdentityStatus(parsed.supervisor) !== "alive" || !processIdentityMayRun(parsed.supervisor)
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
export const revisionRefusedAdmission = (row: CheckRow) => row.admission === "refused" && row.reason === "recorded check revision changed";
/** A terminal recorder may outlive its native owner or the stage's turn. Its
 * original attempt must still be the latest attempt with the same definition. */
export function terminalAttemptBinding(row: CheckRow): Binding {
  const binding = row.binding, pipeline = pipelineRecordReader(binding.pipeline).read();
  const stage = pipeline?.stages.find(stage => stage.id === binding.stage);
  const attempt = pipeline?.runs.find(run => run.stageId === binding.stage)?.attempts.at(-1);
  if (!pipeline || !stage || !attempt || attempt.n !== binding.attempt || attempt.launchId !== binding.launch
    || attempt.conversationId !== binding.conversation || attempt.sessionId !== binding.session
    || digest([pipeline.controlGeneration, stage, attempt.definition, attempt.startedAt, attempt.effectiveRole, attempt.launchId]) !== binding.runtimeFence)
    throw new Error("recorded check original attempt changed");
  return binding;
}

export async function handoffRecordedCheck(conversation: string, requestKey: string, ticket: string, ports: HandoffPorts, preparingId?: string): Promise<CheckRow> {
  // A lost admission reply remains readable after that original attempt has
  // settled. Replaying this immutable receipt grants no new custody.
  if (!preparingId) {
    const store = await openRecordedChecks();
    let prior;
    try { prior = store.byRequest(digest([conversation, requestKey])); } finally { store.close(); }
    if (prior && prior.admission !== "preparing") {
      if (prior.binding.conversation !== conversation || prior.log !== path.resolve(ticket)) throw new Error("recorded check request belongs to another admission");
      await ports.observe(prior.id);
      const current = await openRecordedChecks();
      try { return current.get(prior.id)!; } finally { current.close(); }
    }
  }
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
          if (preparingId && (!reservation || reservation.admission !== "preparing" && !revisionRefusedAdmission(reservation)
            || reservation.binding.conversation !== conversation)) throw new Error("recorded check preparation changed");
          const request = reservation?.request ?? digest([conversation, requestKey]);
          const prior = store.byRequest(request);
          if (prior) {
            if (prior.log !== log || digest(prior.binding) !== digest(binding)) throw new Error("recorded check request belongs to another admission");
            if (prior.admission !== "preparing" && !revisionRefusedAdmission(prior)) return prior;
          }
          const descriptor = prior?.descriptor ?? descriptorSchema.parse(readEnvelope(path.join(directory, "descriptor.json")));
          // Older admissions could turn a harmless observer revision into a
          // refusal. A matching terminal producer no longer needs live recorder
          // custody, but still needs the original attempt, roots and sources.
          const recoveredTerminal = prior && revisionRefusedAdmission(prior) && fs.existsSync(path.join(directory, "result.json"))
            ? terminalFor(prior) : null;
          const verifyCustody = () => {
            if (!recoveredTerminal) return ports.verify(binding, descriptor, directory);
            if (digest(terminalFor(prior!)) !== digest(recoveredTerminal)
              || recoveredTerminal.dispatch !== "not-started" && (recoveredTerminal.report?.phase !== "close" || recoveredTerminal.report.cleanup !== "confirmed"))
              throw new Error("recorded check terminal custody is unverified");
            return recoveredTerminal.report;
          };
          let assertSources: (() => void) | undefined;
          const assertAuthority = () => {
            if (!recoveredTerminal && descriptor.deadlineUptimeMs <= custodyClock()) throw new Error("recorded check original deadline expired before admission");
            if (digest(ports.binding(conversation)) !== digest(binding)) throw new Error("recorded check stage or native owner changed");
            verifyRoots(descriptor.manifest, binding, temps);
            sameDescriptor(descriptor, directory);
            assertSources?.();
          };
          verifyRoots(descriptor.manifest, binding, temps);
          if (!descriptor.manifest.roots.some(root => root.purpose === "evidence" && log.startsWith(root.directory + path.sep))
            || isConfigurationPath(descriptor.manifest, log)) throw new Error("recorded check ticket is outside its evidence roots");
          if (!recoveredTerminal && descriptor.deadlineUptimeMs <= custodyClock()) throw new Error("recorded check original deadline expired");
          let row: CheckRow = prior ?? { id: descriptor.runId, request, binding, log, descriptor, revision: 1, admission: "preparing", reason: "verifying native custody",
            result: null, notification: null, acknowledgement: null, observerFault: null, observation: null, custody: [] };
          if (!prior) await store.write(row, null, assertAuthority);
          try {
            assertSources = await verifyManifest(descriptor.manifest);
            assertAuthority();
            const custody = verifyCustody();
            await withPipelineStartupAdmission(async available => {
              if (!available) throw new Error("recorded check final stage authority is unavailable");
              row = await store.update(row.id, current => ({ ...current, revision: current.revision + 1,
                admission: "accepted", reason: recoveredTerminal ? "matching terminal producer custody recovered" : "native custody accepted",
                custody: custody ? [custody] : current.custody }), () => { assertAuthority(); verifyCustody(); });
            }, "recorded check final custody", undefined, true);
          } catch (error) {
            row = await store.update(row.id, current => ({ ...current, revision: current.revision + 1,
              ...(current.admission === "accepted" ? {} : { admission: "refused" as const,
                reason: (error instanceof Error ? error.message : "custody unknown").slice(0, 1024) }) }), () => {});
          }
          return store.get(row.id)!;
        } finally { store.close(); }
      });
    } finally { temps.close(); }
  }), { waitMs: 30_000 });
  // Do not carry custody locks into observation or a recovery of preparation.
  // The observer subscribes before its first snapshot, including an early close.
  await ports.observe(admitted.id);
  return admitted;
}

function terminalFor(row: CheckRow) {
  const directory = `${row.log}.gate`;
  sameDescriptor(row.descriptor, directory);
  const terminal = terminalSchema.parse(readEnvelope(path.join(directory, "result.json")));
  if (terminal.dispatch === "not-started" && (terminal.report || terminal.reports.length
    || ["running", "supervisor.json", "portable.json", "service.json", "namespace.json"].some(file => !missingOwnedFile(directory, file))))
    throw new Error("recorded check not-started proof disagrees with dispatch evidence");
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

export async function retainResult(row: CheckRow): Promise<{ result: CheckResult; retentionComplete: boolean; assertUnchanged(): void }> {
  const deadline = performance.now() + 30_000;
  let terminal: ReturnType<typeof terminalFor> | null = null;
  let reason = "recorded check has no terminal producer receipt";
  try { terminal = terminalFor(row); } catch (error) { reason = (error instanceof Error ? error.message : reason).slice(0, 1024); }
  const destination = statePath("evidence", "recorded-checks", row.binding.pipeline, row.id);
  let destinationReady = false;
  try {
    createOwnedDirectory(path.dirname(statePath("state.sqlite")), ["evidence", "recorded-checks", row.binding.pipeline, row.id]);
    destinationReady = true;
  } catch (error) { reason = (error instanceof Error ? error.message : "canonical evidence directory is unavailable").slice(0, 1024); }
  const evidence: CheckResult["evidence"] = [];
  const stamps: Array<{ root: string; file: string; stamp: string }> = [];
  const absences: Array<{ root: string; file: string }> = [];
  const rootStamp = (directory: string) => { try { return physical(directory); } catch { return "unavailable"; } };
  const roots = [...row.descriptor.manifest.roots.map(root => root.directory), destination]
    .map(directory => ({ directory, stamp: rootStamp(directory) }));
  const assertRoots = () => {
    for (const root of roots) if (rootStamp(root.directory) !== root.stamp) throw new Error("recorded retention root changed");
  };
  const assertUnchanged = () => {
    assertRoots();
    for (const entry of stamps) if (evidenceStamp(entry.root, entry.file) !== entry.stamp) throw new Error("recorded evidence changed after retention");
    for (const entry of absences) if (!missingOwnedFile(entry.root, entry.file)) throw new Error("recorded evidence appeared after retention");
    if (terminal && digest(terminalFor(row)) !== digest(terminal)) throw new Error("recorded terminal proof changed after retention");
  };
  let visited = 0, completed = 0, failed = 0, complete = false;
  let retentionComplete = false;
  const entries = [...row.descriptor.manifest.inputs, ...row.descriptor.manifest.outputs,
    row.descriptor.manifest.completion, { root: path.dirname(row.log), file: path.basename(row.log) },
    ...["descriptor.json", "owner.json", "result.json", "supervisor.json", "exit", ...(terminal?.dispatch === "not-started" ? ["running"] : []),
      ...(terminal?.reports ?? []).map(report => `${report.kind}.json`)].map(file => ({ root: `${row.log}.gate`, file }))];
  try {
    if (!destinationReady) throw new Error(reason);
    const assertSources = await verifyManifest(row.descriptor.manifest, deadline);
    assertRoots();
    const seen = new Set<string>();
    let missing = false, refused = false;
    for (const entry of entries) {
      try {
      const source = ownedFile(entry.root, entry.file);
      if (seen.has(source)) continue;
      seen.add(source);
      const stamp = evidenceStamp(entry.root, entry.file);
      const sha256 = await fileDigest(source, deadline), file = digest(source);
      assertRoots();
      const target = path.join(destination, file), temporary = `${target}.${randomUUID()}.copy`;
      let created: string | undefined;
      let canonicalStamp: string | undefined;
      if (fs.lstatSync(target, { throwIfNoEntry: false })) ownedFile(destination, file);
      try {
        const before = evidenceStamp(destination, file);
        if (await fileDigest(target, deadline) === sha256 && evidenceStamp(destination, file) === before) canonicalStamp = before;
      } catch { /* A missing or different canonical copy is replaced atomically. */ }
      // Atomic publication; a reader never sees an incomplete retained file.
      if (!canonicalStamp) try {
        assertRoots();
        created = await retainFile(source, temporary, deadline);
        assertRoots();
        const sourceDigest = await fileDigest(source, deadline);
        assertRoots();
        const retainedDigest = await fileDigest(temporary, deadline);
        assertRoots();
        if (sourceDigest !== sha256 || retainedDigest !== sha256 || evidenceStamp(destination, path.basename(temporary)) !== created) throw new Error("recorded evidence changed during retention");
        const fd = fs.openSync(temporary, "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, target);
        canonicalStamp = evidenceStamp(destination, file);
      } finally { if (created) removeOwnedFile(temporary, created); }
      if (canonicalStamp === undefined) throw new Error("recorded canonical evidence proof is unavailable");
      evidence.push({ file, sha256, bytes: fs.statSync(target).size });
      stamps.push({ ...entry, stamp });
      stamps.push({ root: destination, file, stamp: canonicalStamp });
      } catch {
        missing = true;
        try { if (missingOwnedFile(entry.root, entry.file)) absences.push(entry); else refused = true; }
        catch { refused = true; }
      }
    }
    assertSources();
    assertUnchanged();
    writeEnvelope(path.join(destination, "evidence-manifest.json"), { runId: row.id, descriptorDigest: row.descriptor.descriptorDigest,
      evidenceDigest: digest(evidence), files: evidence.length,
      absent: absences.map(entry => digest(path.join(entry.root, entry.file))) });
    // A terminal cancellation may never produce its final selection report.
    // Retaining all present bytes and proved absences permits consumption of
    // that failure without turning it into a completed verification.
    retentionComplete = !refused && !!terminal && fs.readFileSync(ownedFile(`${row.log}.gate`, "exit"), "utf8") === `${terminal.wrapperExit}\n`;
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
  if (row.admission !== "accepted") {
    complete = false; reason = "producer evidence retained; native custody admission is unverified";
  }
  if (terminal?.dispatch === "not-started") { complete = false; reason = "terminal recorder closed before command dispatch; safe to re-run"; }
  const provedTerminal = row.admission === "accepted" || terminal?.dispatch === "not-started" ? terminal : null;
  const value = { state: provedTerminal ? "terminal" as const : "unknown" as const, reason, terminal: provedTerminal, complete, visited, completed, failed, evidence,
    evidenceCount: evidence.length,
    evidenceDigest: digest(evidence), revision: (row.result?.revision ?? 0) + 1,
    history: [...(row.result?.history ?? []), { at: Date.now(), reason }].slice(-8) };
  return { result: { ...value, digest: digest({ ...value, revision: undefined, history: undefined }) }, retentionComplete, assertUnchanged };
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
        const notStarted = current.result.terminal?.dispatch === "not-started";
        if (observed.result.digest !== current.result.digest || !observed.retentionComplete || current.admission !== "accepted"
          || !notStarted && current.result.terminal?.report?.cleanup !== "confirmed")
          throw new Error("recorded evidence custody is incomplete or changed");
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
      const identity = processIdentityStatus(descriptor.recorder);
      if (identity === "unverified") throw new Error("recorded check cancellation awaits verified recorder identity");
      if (identity === "alive") process.kill(descriptor.recorder.pid, "SIGTERM");
    }
  } finally { store.close(); }
}
