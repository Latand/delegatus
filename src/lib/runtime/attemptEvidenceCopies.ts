import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { readEnvelope } from "@/lib/recordedChecks/wire";
import { attemptTempJournalPath, finishTreeTrash, removeTreeViaTrash } from "@/lib/tempSweep";
import { allocatedAttemptBytes, attemptReferencesClear, inspectAttemptTree, snapshotAttemptProtection, RepositoryLinkInventory } from "./attemptTempFilesystem";
import { AttemptTempStore, type AttemptTempSweepOptions, type AttemptTempAuthority, type EvidenceCopy } from "./attemptTempRetention";
import { attemptTempFailureDetail } from "./attemptTempDiagnostics";
import { withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { claimAttemptRetirement } from "@/lib/pipelines/store";
import { restoreRefusedAttemptTrash } from "@/lib/pipelines/retirementClaim";
import { discoverAttemptCopies } from "./attemptCopyDiscovery";
import { readAttemptEvidenceBinding } from "./attemptEvidenceBinding";

const HOUR = 3600000;
/** Pin the nearest existing ancestor as well as each absent segment. A missing
 * namespace is evidence only while its readable, direct parent proof survives. */
function copyParentProof() {
  const parent = statePath("evidence", "attempt-temp"), missing: string[] = [];
  let anchor = parent, stat: fs.Stats | undefined;
  while (!(stat = fs.lstatSync(anchor, { throwIfNoEntry: false }))) {
    missing.push(anchor);
    const next = path.dirname(anchor);
    if (next === anchor) throw new Error("attempt evidence has no readable ancestor");
    anchor = next;
  }
  const identity = `${stat.dev}:${stat.ino}`;
  const current = () => {
    const checked = fs.lstatSync(anchor, { throwIfNoEntry: false });
    if (!checked?.isDirectory() || checked.isSymbolicLink() || `${checked.dev}:${checked.ino}` !== identity
      || fs.realpathSync(anchor) !== anchor || process.getuid && checked.uid !== process.getuid()) return false;
    fs.accessSync(anchor, fs.constants.R_OK | fs.constants.X_OK);
    return missing.every(directory => !fs.lstatSync(directory, { throwIfNoEntry: false }));
  };
  if (!current()) throw new Error("indirect attempt evidence parent");
  return { parent, exists: missing.length === 0, current };
}
function copyParent() {
  const proof = copyParentProof();
  return proof.exists ? proof.parent : null;
}
function copyPath(destination: string, parent: string) {
  if (path.dirname(destination) !== parent || !/^[a-f0-9]{64}$/.test(path.basename(destination))) throw new Error("unowned attempt evidence destination");
}

/** One bounded legacy page. Unattributable copies are explicit retained data;
 * directory age and a familiar name grant no removal authority. */
async function adoptCopies(store: AttemptTempStore, now: () => number, deadline: number) {
  const parent = copyParent(), cursor = store.copyCursor();
  if (!parent || cursor.done) return 0;
  const page = discoverAttemptCopies(parent, cursor.cursor, now, deadline);
  let adopted = 0;
  for (const name of page.names) {
    if (now() >= deadline) return adopted;
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const destination = path.join(parent, name);
    if (store.copy(destination)) continue;
    const stat = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (!stat?.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) continue;
    try {
      const manifest = readAttemptEvidenceBinding(path.join(destination, "manifest.json"));
      if (typeof manifest.original !== "string" || typeof manifest.identity !== "string" || !/^\d+:\d+$/.test(manifest.identity)
        || createHash("sha256").update(manifest.original).update("\0").update(manifest.identity).digest("hex") !== name)
        throw new Error("attempt evidence manifest has no matching creation identity");
      const owner = typeof manifest.original === "string" ? store.owner(manifest.original) : null;
      const pipelineId = typeof manifest.pipelineId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(manifest.pipelineId)
        ? manifest.pipelineId : owner?.identity === manifest.identity ? owner?.pipelineId ?? null : null;
      const launchId = typeof manifest.launchId === "string" ? manifest.launchId : owner?.launchId ?? "legacy";
      store.registerCopy({ destination, pipelineId, launchId, kind: pipelineId ? "lane" : "unattributed",
        createdAt: now(), expiresAt: null, checkedAt: now(), bytes: 0 });
      adopted++;
    } catch {
      store.registerCopy({ destination, pipelineId: null, launchId: "legacy", kind: "unattributed",
        createdAt: now(), expiresAt: null, checkedAt: now(), bytes: 0 });
      adopted++;
    }
    // Measuring is bounded by the same owned native-command deadline as roots.
    const row = store.copy(destination)!;
    try { store.registerCopy({ ...row, bytes: await allocatedAttemptBytes(destination) }); }
    catch (error) {
      const detail = attemptTempFailureDetail(error);
      if (store.copyFailure(destination, detail)) console.error("[attempt evidence] adoption retained", detail);
    }
  }
  // Commit only after the entire bounded page is registered. A crash replays
  // at most this page and the primary key makes that replay idempotent.
  store.checkpointCopies(page.cursor, page.done);
  return adopted;
}

/** Runs after root admission is released. Each removal has its own journal;
 * due-row checkpoints, attribution and errors survive a helper restart. */
export async function sweepEvidenceCopies(store: AttemptTempStore, options: AttemptTempSweepOptions, policy: { agentCopiesManagedSeparately?: boolean } = {}) {
  return withFileTransactionAsync(store.filename + ".sweep", "attempt evidence copy admission", () => sweepOwnedCopies(store, options, policy));
}

async function sweepOwnedCopies(store: AttemptTempStore, options: AttemptTempSweepOptions, policy: { agentCopiesManagedSeparately?: boolean }) {
  const now = options.now ?? Date.now, deadline = now() + 10000;
  const report = { adopted: 0, checked: 0, inspected: 0, removed: 0, removedBytes: 0, errors: 0, unattributed: { count: 0, bytes: 0 } };
  if (options.mode !== "dry-run") {
    try {
      report.adopted = await adoptCopies(store, now, deadline);
      store.copyFailure(statePath("evidence", "attempt-temp"), null);
    }
    catch (error) {
      report.errors++;
      const detail = attemptTempFailureDetail(error), parent = statePath("evidence", "attempt-temp");
      if (store.copyFailure(parent, detail)) console.error("[attempt evidence] discovery retained", detail);
    }
  }
  if (options.mode !== "dry-run") {
    store.refreshReporting(now, deadline);
  }
  const inventory = new RepositoryLinkInventory({ now, budgetMs: 10000 });
  const observe = async (row: EvidenceCopy): Promise<AttemptTempAuthority> => {
    if (row.kind === "agent" && policy.agentCopiesManagedSeparately) return { state: "unknown", expiresAt: null,
      revision: "host-ended-retention", isCurrent: () => false };
    if (row.kind === "agent") return { state: row.expiresAt !== null && now() >= row.expiresAt ? "expired" : "closed",
      expiresAt: row.expiresAt, revision: "agent", isCurrent: () => row.expiresAt !== null && now() >= row.expiresAt };
    const owner = { directory: row.destination, pipelineId: row.pipelineId, launchId: row.launchId, createdAt: row.createdAt, retainUntilClose: true };
    return options.authority ? options.authority(owner, inventory)
      : { state: await options.state(owner, inventory), revision: "", isCurrent: () => true };
  };
  const visited = new Set<string>();
  for (const row of now() >= deadline ? [] : store.dueCopies(now(), 8)) {
    if (now() >= deadline) break;
    visited.add(row.destination);
    report.checked++;
    store.registerCopy({ ...row, checkedAt: now() + 60000 });
    let releaseClaim: (() => void) | null = null;
    try {
      const parentProof = copyParentProof(), parent = parentProof.parent;
      copyPath(row.destination, parent);
      const journal = attemptTempJournalPath(row.destination), pending = fs.existsSync(journal);
      if (pending && row.pipelineId && options.mode !== "dry-run")
        releaseClaim = await claimAttemptRetirement(row.pipelineId, row.destination);
      const authority = await observe(row);
      const expiresAt = authority.expiresAt ?? null;
      store.registerCopy({ ...row, expiresAt, checkedAt: expiresAt && expiresAt > now() ? expiresAt : now() + (authority.state === "expired" ? 60000 : HOUR) });
      if (!parentProof.current()) throw new Error("attempt evidence parent changed after authority");
      let target = row.destination;
      if (pending) {
        const intent = readEnvelope(journal) as { directory?: unknown; trash?: unknown };
        if (intent.directory !== row.destination || typeof intent.trash !== "string" || path.dirname(intent.trash) !== parent)
          throw new Error("attempt evidence journal binding changed");
        target = intent.trash;
      }
      if (parentProof.exists && fs.lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) {
        // Eligibility is independent of the lane's expiry. Recent copies must
        // also drop out of the forecast when a person pins them.
        const protection = await snapshotAttemptProtection(target, deadline - now());
        const clear = await inspectAttemptTree(target, row.destination);
        store.copyEligible(row.destination, clear && protection.current() && parentProof.current());
      }
      if (authority.state !== "expired" || !authority.isCurrent()) {
        if (pending && options.mode !== "dry-run") restoreRefusedAttemptTrash(row.destination);
        continue;
      }
      if (!releaseClaim && row.pipelineId && options.mode !== "dry-run") {
        releaseClaim = await claimAttemptRetirement(row.pipelineId, row.destination);
      }
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!stat && !pending) {
        if (!parentProof.current() || !authority.isCurrent() || now() >= deadline)
          throw new Error("attempt evidence absence proof changed");
        if (options.mode !== "dry-run") store.forgetCopy(row.destination);
        continue;
      }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid())) throw new Error("attempt evidence identity changed");
      const identity = stat ? `${stat.dev}:${stat.ino}` : null;
      let dispatchAuthority = authority;
      let protection: { current: () => boolean } | undefined;
      const validate = (directory: string) => {
        if (!parentProof.current() || !dispatchAuthority.isCurrent() || dispatchAuthority.state !== "expired" || now() >= deadline) return false;
        const current = fs.lstatSync(directory, { throwIfNoEntry: false });
        return !!current?.isDirectory() && !current.isSymbolicLink() && `${current.dev}:${current.ino}` === identity
          && protection?.current() === true && inventory.unchangedAll();
      };
      const held = async (directory: string) => {
        protection = await snapshotAttemptProtection(directory, deadline - now());
        if (!await inspectAttemptTree(directory, row.destination)) {
          store.copyEligible(row.destination, false);
          return true;
        }
        const scan = options.scan([row.destination, directory]);
        const clear = options.references ? await options.references(row.destination, directory, scan)
          : await attemptReferencesClear(row.destination, directory, scan, undefined, inventory);
        dispatchAuthority = await observe(row);
        const valid = validate(directory);
        // A changed protection snapshot may be a marker created during any
        // awaited observation. Exclude conservatively and re-prove next visit.
        store.copyEligible(row.destination, clear && valid);
        return !clear || !valid;
      };
      if (options.mode === "dry-run") continue;
      // The initial quarantine validation also needs a protection snapshot.
      if (!pending && await held(row.destination)) continue;
      const removed = pending ? await finishTreeTrash(journal, held, undefined, validate, true)
        : await removeTreeViaTrash(row.destination, { journal, held, validate, disposable: true });
      if (!removed) restoreRefusedAttemptTrash(row.destination, identity ?? undefined);
      if (removed || !fs.existsSync(row.destination) && !fs.existsSync(journal)) {
        store.forgetCopy(row.destination);
        if (removed) { report.removed++; report.removedBytes += row.bytes; }
      } else store.registerCopy({ ...row, expiresAt, checkedAt: now() + 60000 });
      store.copyFailure(row.destination, null);
    } catch (error) {
      report.errors++;
      store.copyEligible(row.destination, false);
      const detail = attemptTempFailureDetail(error);
      if (store.copyFailure(row.destination, detail)) console.error("[attempt evidence] copy retained", detail);
    } finally {
      try { releaseClaim?.(); }
      catch (error) {
        report.errors++;
        const detail = attemptTempFailureDetail(error);
        if (store.copyFailure(row.destination, detail)) console.error("[attempt evidence] retirement claim retained", detail);
      }
    }
  }
  // A producer schedules checkedAt at expiry. Visit a separate indexed page
  // for human pins without changing that schedule or granting removal authority.
  // The durable cursor keeps advancing even if a particular copy is unreadable.
  for (const row of now() >= deadline ? [] : store.copiesToInspect(8)) {
    if (now() >= deadline) break;
    store.checkpointCopyInspection(row.destination);
    if (visited.has(row.destination)) continue;
    report.inspected++;
    store.copyEligible(row.destination, false);
    try {
      const parent = copyParentProof();
      copyPath(row.destination, parent.parent);
      if (!parent.exists || fs.existsSync(attemptTempJournalPath(row.destination))) continue;
      const stat = fs.lstatSync(row.destination, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid())
        throw new Error("attempt evidence identity changed");
      const protection = await snapshotAttemptProtection(row.destination, deadline - now());
      const clear = await inspectAttemptTree(row.destination, row.destination);
      store.copyEligible(row.destination, clear && protection.current() && parent.current() && now() < deadline);
      store.copyFailure(row.destination, null);
    } catch (error) {
      report.errors++;
      const detail = attemptTempFailureDetail(error);
      if (store.copyFailure(row.destination, detail)) console.error("[attempt evidence] inspection retained", detail);
    }
  }
  report.unattributed = store.unattributedCopies();
  return report;
}
