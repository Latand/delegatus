import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { attemptTempJournalPath } from "@/lib/tempSweep";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { processIdentityProvenDead, type ProcessIdentity } from "@/lib/processIdentity";

type Claim = { directories: string[]; revision: string; owner: ProcessIdentity };

/** Called only by the serialized sweep after its removal has settled without
 * dispatch or error. Preserve a refused replay's surviving tree, then cancel
 * its intent before releasing the lane claim. Changed bindings stay fenced. */
export function restoreRefusedAttemptTrash(directory: string, expectedIdentity?: string) {
  const journal = attemptTempJournalPath(directory);
  if (!fs.existsSync(journal)) return;
  const row = JSON.parse(fs.readFileSync(journal, "utf8")) as {
    directory: string; trash: string; uid: number; identity: string; disposable?: boolean;
  };
  if (row.directory !== directory || typeof row.trash !== "string" || row.disposable !== true
    || path.dirname(row.trash) !== path.dirname(directory)
    || !path.basename(row.trash).startsWith(`.delegatus-trash-${path.basename(directory)}-`)
    || expectedIdentity !== undefined && row.identity !== expectedIdentity)
    throw new Error("refused attempt quarantine binding changed");
  const current = fs.lstatSync(directory, { throwIfNoEntry: false });
  const trash = fs.lstatSync(row.trash, { throwIfNoEntry: false });
  const owned = (stat: fs.Stats | undefined) => stat?.isDirectory() && !stat.isSymbolicLink()
    && `${stat.dev}:${stat.ino}` === row.identity && stat.uid === row.uid
    && (!process.getuid || stat.uid === process.getuid())
    && stat.dev === fs.statSync(path.dirname(directory)).dev;
  // A crash between restore and journal removal leaves the original identity
  // in place. Complete that cancellation without touching a replacement.
  if (owned(current) && !trash) { fs.unlinkSync(journal); return; }
  if (current || !owned(trash)) throw new Error("refused attempt quarantine identity changed");
  fs.renameSync(row.trash, directory);
  fs.unlinkSync(journal);
}

function claimPath(pipelineId: string) {
  return statePath("attempt-retirements", createHash("sha256").update(pipelineId).digest("hex") + ".json");
}

export function hasAttemptRetirementClaim(pipelineId: string) {
  return fs.existsSync(claimPath(pipelineId));
}

/** Called by every pipeline writer under its existing state lease. Claim
 * admission uses that same lease, but no lease survives content removal. */
export function assertPipelineNotRetiring(pipelineId: string, revision: () => string) {
  const file = claimPath(pipelineId);
  if (!fs.existsSync(file)) return;
  const claim = JSON.parse(fs.readFileSync(file, "utf8")) as Claim;
  // A crash after forgetting the ledger row has no candidate left to visit.
  // With no journal and a proven-dead owner, no removal can still dispatch.
  if (claim.owner && processIdentityProvenDead(claim.owner)
    && !claim.directories.some(directory => fs.existsSync(attemptTempJournalPath(directory)))) {
    fs.unlinkSync(file); return;
  }
  if (claim.revision !== revision()) throw new Error("pipeline attempt retirement pending; retry after recovery");
}

/** The attempt-sweep admission is the sole owner of these claims, including
 * replay after a helper dies. Pending journals keep mutation admission fenced
 * while independent namespaces of this lane can still retire. */
export function admitAttemptRetirement(pipelineId: string, directory: string, revision: string, owner: ProcessIdentity): () => void {
  const file = claimPath(pipelineId);
  let directories: string[] = [];
  if (fs.existsSync(file)) {
    const prior = JSON.parse(fs.readFileSync(file, "utf8")) as Claim;
    directories = prior.directories.filter(item => fs.existsSync(attemptTempJournalPath(item)));
  }
  directories = [...new Set([...directories, directory])];
  writeJsonDurably(file, { directories, revision, owner });
  return () => {
    directories = directories.filter(item => fs.existsSync(attemptTempJournalPath(item)));
    if (directories.length) writeJsonDurably(file, { directories, revision, owner });
    else fs.unlinkSync(file);
  };
}
