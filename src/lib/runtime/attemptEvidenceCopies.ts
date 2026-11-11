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
import { discoverAttemptCopies } from "./attemptCopyDiscovery";

const HOUR = 3600000;
function copyParent() {
  const parent = statePath("evidence", "attempt-temp"), stat = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(parent) !== parent
    || process.getuid && stat.uid !== process.getuid()) throw new Error("indirect attempt evidence parent");
  return parent;
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
      const manifest = readEnvelope(path.join(destination, "manifest.json")) as { pipelineId?: unknown; launchId?: unknown; original?: unknown; identity?: unknown };
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
export async function sweepEvidenceCopies(store: AttemptTempStore, options: AttemptTempSweepOptions) {
  return withFileTransactionAsync(store.filename + ".sweep", "attempt evidence copy admission", () => sweepOwnedCopies(store, options));
}

async function sweepOwnedCopies(store: AttemptTempStore, options: AttemptTempSweepOptions) {
  const now = options.now ?? Date.now, deadline = now() + 10000;
  const report = { adopted: 0, checked: 0, removed: 0, removedBytes: 0, errors: 0, unattributed: { count: 0, bytes: 0 } };
  if (options.mode !== "dry-run") {
    try { report.adopted = await adoptCopies(store, now, deadline); }
    catch (error) {
      report.errors++;
      const detail = attemptTempFailureDetail(error), parent = statePath("evidence", "attempt-temp");
      if (store.copyFailure(parent, detail)) console.error("[attempt evidence] discovery retained", detail);
    }
  }
  const inventory = new RepositoryLinkInventory({ now, budgetMs: 10000 });
  const observe = async (row: EvidenceCopy): Promise<AttemptTempAuthority> => {
    if (row.kind === "agent") return { state: row.expiresAt !== null && now() >= row.expiresAt ? "expired" : "closed",
      expiresAt: row.expiresAt, revision: "agent", isCurrent: () => row.expiresAt !== null && now() >= row.expiresAt };
    const owner = { directory: row.destination, pipelineId: row.pipelineId, launchId: row.launchId, createdAt: row.createdAt, retainUntilClose: true };
    return options.authority ? options.authority(owner, inventory)
      : { state: await options.state(owner, inventory), revision: "", isCurrent: () => true };
  };
  for (const row of store.dueCopies(now(), 8)) {
    if (now() >= deadline) break;
    report.checked++;
    store.registerCopy({ ...row, checkedAt: now() + 60000 });
    let releaseClaim: (() => void) | null = null;
    try {
      const parent = copyParent();
      if (!parent) throw new Error("attempt evidence parent missing");
      copyPath(row.destination, parent);
      const authority = await observe(row);
      const expiresAt = row.kind === "agent" ? row.expiresAt : authority.expiresAt ?? null;
      store.registerCopy({ ...row, expiresAt, checkedAt: expiresAt && expiresAt > now() ? expiresAt : now() + (authority.state === "expired" ? 60000 : HOUR) });
      if (authority.state !== "expired" || !authority.isCurrent()) continue;
      if (row.pipelineId && options.mode !== "dry-run") {
        releaseClaim = await claimAttemptRetirement(row.pipelineId, row.destination);
      }
      const journal = attemptTempJournalPath(row.destination), pending = fs.existsSync(journal);
      let target = row.destination;
      if (pending) {
        const intent = readEnvelope(journal) as { directory?: unknown; trash?: unknown };
        if (intent.directory !== row.destination || typeof intent.trash !== "string" || path.dirname(intent.trash) !== parent)
          throw new Error("attempt evidence journal binding changed");
        target = intent.trash;
      }
      const stat = fs.lstatSync(target, { throwIfNoEntry: false });
      if (!stat && !pending) { if (options.mode !== "dry-run") store.forgetCopy(row.destination); continue; }
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid())) throw new Error("attempt evidence identity changed");
      const identity = stat ? `${stat.dev}:${stat.ino}` : null;
      let dispatchAuthority = authority;
      let protection: { current: () => boolean } | undefined;
      const validate = (directory: string) => {
        if (!copyParent() || !dispatchAuthority.isCurrent() || dispatchAuthority.state !== "expired" || now() >= deadline) return false;
        const current = fs.lstatSync(directory, { throwIfNoEntry: false });
        return !!current?.isDirectory() && !current.isSymbolicLink() && `${current.dev}:${current.ino}` === identity
          && protection?.current() === true && inventory.unchangedAll();
      };
      const held = async (directory: string) => {
        protection = await snapshotAttemptProtection(directory, deadline - now());
        if (!await inspectAttemptTree(directory, row.destination)) return true;
        const scan = options.scan([row.destination, directory]);
        const clear = options.references ? await options.references(row.destination, directory, scan)
          : await attemptReferencesClear(row.destination, directory, scan, undefined, inventory);
        dispatchAuthority = await observe(row);
        return !clear || !validate(directory);
      };
      if (options.mode === "dry-run") continue;
      // The initial quarantine validation also needs a protection snapshot.
      if (!pending && await held(row.destination)) continue;
      const removed = pending ? await finishTreeTrash(journal, held, undefined, validate, true)
        : await removeTreeViaTrash(row.destination, { journal, held, validate, disposable: true });
      if (removed || !fs.existsSync(row.destination) && !fs.existsSync(journal)) {
        store.forgetCopy(row.destination);
        if (removed) { report.removed++; report.removedBytes += row.bytes; }
      } else store.registerCopy({ ...row, expiresAt, checkedAt: now() + 60000 });
      store.copyFailure(row.destination, null);
    } catch (error) {
      report.errors++;
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
  report.unattributed = store.unattributedCopies();
  return report;
}
