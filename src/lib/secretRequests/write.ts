import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { isStagingMode } from "@/lib/staging";
import { FileTransactionBusyError, withFileTransactionAsync } from "@/lib/state/fileTransaction";
import { confirmPlace, destinationRevision, fsCode, gitStatus, inspectDestination, readExistingEnv, sameEntry, sameInode, secretStagingDirectory } from "./destination";
import { composeEnvFile } from "./envFile";
import { SecretParentDirectory } from "./parentDirectory";
import { auditTransition, entryRefusals, findSecretRequestRecord, transition, updateSecretRequest, writingSecretRequests } from "./store";
import { SecretRequestError, secretError, type FileIdentity, type SecretActor, type SecretRefusal, type SecretRequestRecord } from "./types";
import { secretLength } from "./value";

type Writing = Extract<SecretRequestRecord, { state: "writing" }>;
const BUSY = "secret destination is busy";

export type WriteCheckpoint = "validated" | "writing" | "created" | "journaled" | "written" | "file-synced"
  | "before-rename" | "renamed" | "directory-synced" | "entered";
interface WriteOptions {
  now?: () => number;
  checkpoint?: (step: WriteCheckpoint) => void | Promise<void>;
  authorize?: () => void;
  actor?: "owner" | "operator";
}

function lock<T>(filename: string, run: () => Promise<T>, waitMs = 5_000) {
  // Lock metadata lives in private state, whose parents are controlled by
  // Delegatus. An agent-selected directory is never used for lock creation.
  const key = createHash("sha256").update(destinationLockName(filename)).digest("hex");
  return withFileTransactionAsync(statePath("secret-request-locks", key), BUSY, run,
    { waitMs, label: "secret-request.write" });
}

function destinationLockName(filename: string) {
  // Filesystems can address the same entry by another case or normalization.
  return filename.normalize("NFC").toLowerCase();
}

function temporaryName(record: Writing): string {
  return `.delegatus-secret-${record.write.id}.tmp`;
}

async function openStagingDirectory(filename: string, expected?: FileIdentity): Promise<{ directory: SecretParentDirectory; identity: FileIdentity }>;
async function openStagingDirectory(filename: string, expected: FileIdentity | undefined, create: false): Promise<{ directory: SecretParentDirectory; identity: FileIdentity } | null>;
async function openStagingDirectory(filename: string, expected?: FileIdentity, create = true) {
  if (create) await fs.mkdir(filename, { recursive: true, mode: 0o700 });
  let stats;
  try { stats = await fs.lstat(filename, { bigint: true }); }
  catch (error) {
    if (!create && fsCode(error) === "ENOENT") return null;
    throw error;
  }
  const identity = { device: String(stats.dev), inode: String(stats.ino) };
  if (!stats.isDirectory() || Number(stats.uid) !== process.geteuid?.()
    || (stats.mode & BigInt(0o777)) !== BigInt(0o700)
    || (expected && (identity.device !== expected.device || identity.inode !== expected.inode))) {
    throw new SecretRequestError("secret_destination_changed");
  }
  const directory = await SecretParentDirectory.open(filename, identity);
  await directory.handle.chmod(0o700);
  const opened = await directory.handle.stat({ bigint: true });
  if ((opened.mode & BigInt(0o777)) !== BigInt(0o700) || !sameInode(opened, identity)) {
    await directory.handle.close();
    throw new SecretRequestError("secret_destination_changed");
  }
  return { directory, identity };
}

function isPrivateFile(stats: Awaited<ReturnType<SecretParentDirectory["stat"]>>): stats is NonNullable<typeof stats> {
  return Boolean(stats?.isFile() && Number(stats.uid) === process.geteuid?.()
    && stats.nlink === BigInt(1) && (stats.mode & BigInt(0o7777)) === BigInt(0o600));
}

async function finish(record: Writing, file: FileIdentity, actor: SecretActor, now: number) {
  const saved = await updateSecretRequest(record.id, current => {
    if (current.state !== "writing" || current.write.id !== record.write.id) throw new SecretRequestError("secret_request_unavailable");
    const { write, ...base } = current;
    return {
      ...base, state: "entered", enteredAt: now, length: write.length, file,
      transitions: transition(current, "entered", actor, now),
    };
  }, now);
  auditTransition(saved);
  return saved;
}

async function interrupt(record: Writing, code: SecretRefusal, actor: SecretActor, now: number) {
  const saved = await updateSecretRequest(record.id, current => {
    if (current.state !== "writing") throw new SecretRequestError("secret_request_unavailable");
    const { write: removed, ...snapshot } = current;
    if (removed.id !== record.write.id) throw new SecretRequestError("secret_request_unavailable");
    return { ...snapshot, state: "pending", transitions: transition(current, "pending", actor, now),
      refusals: entryRefusals(current, code, now) };
  });
  auditTransition(saved);
  return saved;
}

async function recoverLocked(record: Writing, now: number, refusal?: SecretRefusal): Promise<SecretRequestRecord> {
  const filename = record.destination.path;
  const dir = await SecretParentDirectory.open(path.dirname(filename), record.write.parent).catch(() => null);
  const name = path.basename(filename);
  const found = dir ? await dir.stat(name) : null;
  const temporary = record.write.temporary;
  // The rename is the commit point. Finish it from the pinned destination
  // inode alone; staging may already have been removed after the rename.
  if (found && temporary && sameInode(found, temporary)) {
    try {
      if (!isPrivateFile(found)) throw new SecretRequestError("secret_destination_changed");
      await dir!.handle.sync();
      await dir!.confirm();
      return await finish(record, temporary, "recovery", now);
    } finally { await dir?.handle.close(); }
  }
  const staged = await openStagingDirectory(record.write.stagingPath, record.write.stagingParent, false);
  try {
    const leftover = staged ? await staged.directory.temporaryStat(temporaryName(record)) : null;
    if (leftover) {
      // A crash before the inode checkpoint can leave only an empty file.
      // Never delete a mismatched or linked entry while replaying the journal.
      if (temporary ? (!isPrivateFile(leftover) || !sameInode(leftover, temporary))
        : (!leftover.isFile() || Number(leftover.uid) !== process.geteuid?.() || leftover.nlink !== BigInt(1)
          || leftover.size !== BigInt(0))) {
        throw new SecretRequestError("secret_destination_changed");
      }
      await staged!.directory.unlink(temporaryName(record));
      await staged!.directory.handle.sync();
    }
    if (!dir && !leftover) {
      // The pinned parent moved after a rename. Without that directory
      // descriptor or the staged inode, the installed file's new name cannot
      // be proven. Record the refusal and release the durable writing state;
      // leave the moved file untouched for its owner to inspect.
      return await interrupt(record, refusal ?? "secret_destination_changed", refusal ? "operator" : "recovery", now);
    }
    return await interrupt(record, refusal ?? "secret_entry_interrupted", refusal ? "operator" : "recovery", now);
  } finally { await dir?.handle.close(); await staged?.directory.handle.close(); }
}

export async function readSecretRequest(id: string, now = Date.now(), waitMs?: number): Promise<SecretRequestRecord | null> {
  try {
    const initial = findSecretRequestRecord(id);
    if (!initial || isStagingMode() || (initial.state !== "writing" && !dueToExpire(initial, now))) return initial;
    return await lock(initial.destination.path, async () => {
      const latest = findSecretRequestRecord(id);
      const current = latest?.state === "writing" && latest.destination.path === initial.destination.path
        ? await recoverLocked(latest, now) : latest;
      return current && dueToExpire(current, now) ? expirePending(id, now) : current;
    }, waitMs);
  } catch (error) {
    if (waitMs !== undefined && error instanceof FileTransactionBusyError) return findSecretRequestRecord(id);
    throw secretError(error, fsCode(error) === "ELOOP" ? "secret_destination_link" : "secret_request_unavailable");
  }
}

/** Called by startup when a Viewer owns the collection. Each row has its own
 * recovery lock, so one unresolved destination cannot stop the others. */
export async function recoverSecretRequests(now = Date.now()): Promise<{ id: string; code: SecretRefusal }[]> {
  const failures: { id: string; code: SecretRefusal }[] = [];
  for (const record of await writingSecretRequests()) {
    try { await readSecretRequest(record.id, now); }
    catch (error) {
      const { code } = secretError(error, "secret_request_unavailable");
      failures.push({ id: record.id, code });
      console.warn(`[secret-request] ${record.id} recovery ${code}`);
    }
  }
  return failures;
}

async function refusePending(id: string, code: SecretRefusal, now: number) {
  await updateSecretRequest(id, record => record.state === "pending"
    ? { ...record, refusals: entryRefusals(record, code, now) } : record);
}

function dueToExpire(record: SecretRequestRecord, now: number): boolean {
  return record.state === "pending" && record.expiresAt <= now;
}

async function expirePending(id: string, now: number): Promise<SecretRequestRecord> {
  let transitioned = false;
  const saved = await updateSecretRequest(id, current => {
    if (!dueToExpire(current, now)) return current;
    transitioned = true;
    return { ...current, state: "expired", transitions: transition(current, "expired", "expiry", now) };
  }, now);
  if (transitioned) auditTransition(saved);
  return saved;
}

export async function declineSecretRequest(id: string, actor: "owner" | "operator", authorize: () => void): Promise<SecretRequestRecord> {
  if (isStagingMode()) throw new SecretRequestError("staging");
  if (!findSecretRequestRecord(id)) throw new SecretRequestError("secret_not_pending");
  const saved = await updateSecretRequest(id, current => {
    authorize();
    const now = Date.now();
    if (current.state !== "pending") throw new SecretRequestError("secret_not_pending");
    if (dueToExpire(current, now)) return { ...current, state: "expired", transitions: transition(current, "expired", "expiry", now) };
    return { ...current, state: "cancelled", transitions: transition(current, "cancelled", actor, now) };
  }, Date.now());
  auditTransition(saved);
  if (saved.state === "expired") throw new SecretRequestError("secret_expired");
  return saved;
}

/** Takes ownership of the supplied bytes and wipes them on every completion. */
export async function writeSecretRequest(id: string, revision: string, value: Uint8Array, options: WriteOptions = {}): Promise<SecretRequestRecord> {
  const now = options.now ?? Date.now;
  const checkpoint = options.checkpoint;
  const actor = options.actor ?? "operator";
  try {
    if (isStagingMode()) throw new SecretRequestError("staging");
    const first = findSecretRequestRecord(id);
    if (!first) throw new SecretRequestError("secret_not_pending");
    return await lock(first.destination.path, async () => {
      options.authorize?.();
      // Recover the earlier write before a second request can replace its
      // inode and erase proof that the first rename landed.
      for (const record of await writingSecretRequests()) {
        if (record.state === "writing" && destinationLockName(record.destination.path) === destinationLockName(first.destination.path)) {
          await recoverLocked(record, now());
        }
      }
      const record = findSecretRequestRecord(id);
      if (record?.state !== "pending") throw new SecretRequestError("secret_not_pending");
      if (record.destination.path !== first.destination.path) throw new SecretRequestError("secret_destination_changed");
      if (dueToExpire(record, now())) {
        await expirePending(id, now());
        throw new SecretRequestError("secret_expired");
      }

      let writing: Writing | undefined;
      let dir: SecretParentDirectory | undefined;
      let handle: Awaited<ReturnType<SecretParentDirectory["create"]>> | undefined;
      let staged: Awaited<ReturnType<typeof openStagingDirectory>> | undefined;
      let temporary: FileIdentity | undefined;
      let content: Buffer | undefined;
      let renameAttempted = false;
      let refreshed = false;
      try {
        const length = secretLength(value, record.format, record.minLength);
        const inspected = await inspectDestination(record.project, record.target, record.destination.authorizedRoot).catch(error => {
          if (error instanceof SecretRequestError && ["secret_destination_exists", "secret_env_key_duplicated"].includes(error.code)) {
            throw new SecretRequestError("secret_destination_changed");
          }
          throw error;
        });
        const { destination, existing, parent } = inspected;
        const currentRevision = destinationRevision(destination);
        if (currentRevision !== record.destinationRevision || Boolean(existing) !== Boolean(record.destination.previous)) {
          // Refresh the pending card under its old destination lock. The next
          // entry takes the lock for the newly confirmed path.
          await updateSecretRequest(id, current => {
            if (current.state !== "pending") throw new SecretRequestError("secret_not_pending");
            return { ...current, destination, destinationRevision: currentRevision,
              refusals: entryRefusals(current, "secret_destination_changed", now()) };
          });
          refreshed = true;
          throw new SecretRequestError("secret_destination_changed");
        }
        if (currentRevision !== revision) throw new SecretRequestError("secret_destination_changed");
        await checkpoint?.("validated");

        const parentPath = path.dirname(destination.path);
        dir = await SecretParentDirectory.open(parentPath, parent);
        const stagingPath = await secretStagingDirectory(destination, parentPath);
        staged = await openStagingDirectory(stagingPath);
        if ((await staged.directory.handle.stat({ bigint: true })).dev !== (await dir.handle.stat({ bigint: true })).dev) {
          throw new SecretRequestError("secret_destination_unavailable");
        }
        if (record.target.kind === "env") {
          const old = existing ? await readExistingEnv(destination.path, existing) : Buffer.alloc(0);
          try { content = composeEnvFile(old, record.target.key, value); }
          finally { old.fill(0); }
        } else if (record.target.trailingNewline !== false) {
          content = Buffer.alloc(value.length + 1);
          content.set(value);
          content[value.length] = 10;
        }

        writing = await updateSecretRequest(id, current => {
          options.authorize?.();
          if (current.state !== "pending") throw new SecretRequestError("secret_not_pending");
          const at = now();
          if (current.expiresAt <= at) throw new SecretRequestError("secret_expired");
          return {
            ...current, destination, state: "writing", write: { id: randomBytes(16).toString("hex"), parent, length,
              stagingPath, stagingParent: staged!.identity },
            transitions: transition(current, "writing", actor, at),
          };
        });
        auditTransition(writing);
        await checkpoint?.("writing");

        const tmp = temporaryName(writing);
        handle = await staged.directory.create(tmp, identity => { temporary = identity; });
        await checkpoint?.("created");
        await handle.chmod(0o600);
        const inode = temporary!;
        if (!sameInode(await handle.stat({ bigint: true }), inode)) throw new SecretRequestError("secret_destination_changed");
        // Durably bind ownership before the temporary can contain any bytes.
        const writeId = writing.write.id;
        writing = await updateSecretRequest(id, current => {
          if (current.state !== "writing" || current.write.id !== writeId) throw new SecretRequestError("secret_request_unavailable");
          return { ...current, write: { ...current.write, temporary: inode } };
        });
        await checkpoint?.("journaled");
        await staged.directory.confirm();
        await confirmPlace(handle, path.join(stagingPath, tmp));
        await handle.writeFile(content ?? value);
        await checkpoint?.("written");
        await handle.sync();
        await checkpoint?.("file-synced");

        const name = path.basename(destination.path);
        await checkpoint?.("before-rename");
        if (await gitStatus(parentPath, name) !== destination.git) throw new SecretRequestError("secret_destination_changed");
        await dir.confirm();
        const owned = await staged.directory.temporaryStat(tmp);
        if (!isPrivateFile(owned) || !sameInode(owned, inode) || !sameEntry(await dir.stat(name), existing)) {
          throw new SecretRequestError("secret_destination_changed");
        }
        options.authorize?.();
        renameAttempted = true;
        await staged.directory.renameTo(tmp, dir, name);
        await checkpoint?.("renamed");
        await dir.handle.sync();
        await staged.directory.handle.sync();
        await checkpoint?.("directory-synced");
        await dir.confirm();
        const installed = await dir.stat(name);
        if (!isPrivateFile(installed) || !sameInode(installed, inode)) throw new SecretRequestError("secret_destination_changed");
        const result = await finish(writing, inode, actor, now());
        await checkpoint?.("entered");
        return result;
      } catch (error) {
        const refusal = secretError(error, fsCode(error) === "ELOOP" ? "secret_destination_link" : "secret_destination_unavailable");
        if (writing && dir && renameAttempted) {
          // A rejected rename can still have installed the file. Settle
          // from its durable inode checkpoint before allowing any retry.
          const current = findSecretRequestRecord(id);
          if (current?.state === "writing") await recoverLocked(current, now(), refusal.code);
        } else if (writing && dir) {
          const tmp = temporaryName(writing);
          if (temporary) {
            const stat = await staged?.directory.temporaryStat(tmp);
            if (stat && !sameInode(stat, temporary)) throw new SecretRequestError("secret_destination_changed");
            if (stat) {
              await staged!.directory.unlink(tmp);
              await staged!.directory.handle.sync();
            }
          } else if (await staged?.directory.temporaryStat(tmp)) {
            // A failed create can be ambiguous. Let recovery check the name
            // and its ownership before any later request reuses the path.
            throw refusal;
          }
          await interrupt(writing, refusal.code, actor, now());
        } else if (!writing && !refreshed) {
          if (refusal.code === "secret_expired") await expirePending(id, now());
          else await refusePending(id, refusal.code, now());
        }
        throw refusal;
      } finally {
        content?.fill(0);
        await handle?.close().catch(() => {});
        await staged?.directory.handle.close().catch(() => {});
        await dir?.handle.close().catch(() => {});
      }
    });
  } catch (error) {
    throw secretError(error, "secret_request_unavailable");
  } finally {
    value.fill(0);
  }
}
