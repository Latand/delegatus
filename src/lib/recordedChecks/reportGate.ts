import { cpuOwnerStatus } from "@/lib/runtime/signalSandboxContext";
import { readRecorded, type CheckRow } from "./store";
import { terminalFor } from "./service";

export type RecordedCheckExclusion = {
  id: string;
  resultRevision: number;
  reason: string;
  custody: "cleanup-confirmed" | "not-started";
};

/** Reporting never acknowledges evidence or releases retention. A zero count
 * alone says nothing about execution: require the producer's close proof and
 * current absence of every recorded producer, including the outer recorder. */
function closedCustody(row: CheckRow): RecordedCheckExclusion["custody"] | null {
  let terminal = row.result?.terminal;
  if (!terminal) {
    try { terminal = terminalFor(row); } catch { /* Retained custody may still prove producer cleanup. */ }
  }
  if (terminal && (terminal.runId !== row.id || terminal.descriptorDigest !== row.descriptor.descriptorDigest)) return null;
  // The dispatch proof is supplied by the recorder protocol added in #3558.
  // Older receipts cannot infer never-started from an absent command identity.
  const notStarted = terminal && "dispatch" in terminal && terminal.dispatch === "not-started";
  const report = terminal?.report;
  const closing = report ? [report] : row.custody;
  if (!notStarted && (!closing.length || closing.some(proof => proof.phase !== "close" || proof.cleanup !== "confirmed"))) return null;
  const proofs = [...row.custody, ...(terminal?.reports ?? []), ...(report ? [report] : [])];
  if (proofs.some(proof => proof.runId !== row.id || proof.descriptorDigest !== row.descriptor.descriptorDigest
    || proof.atUptimeMs < row.descriptor.startedUptimeMs)) return null;
  if (notStarted && proofs.length) return null;
  const owners = [row.descriptor.recorder, row.descriptor.wrapper,
    ...proofs.flatMap(proof => [proof.supervisor, proof.command])];
  if (owners.some(owner => owner && cpuOwnerStatus(owner) !== "dead")) return null;
  return notStarted ? "not-started" : "cleanup-confirmed";
}

/** At most four outstanding receipts belong to one launch. Re-read at each
 * report/settlement boundary; saved exclusions never grant future authority. */
export const recordedReportReceipts = (launch: string) => readRecorded(store => store.forLaunch(launch).map(row => {
  const result = row.result;
  const custody = closedCustody(row);
  const exclusion: RecordedCheckExclusion | null = result && !result.complete && result.visited === 0 && result.completed === 0 && custody
    ? { id: row.id, resultRevision: result.revision, custody,
      reason: `${row.reason}; ${result.reason}; ${custody === "not-started" ? "command never started" : "own producer cleanup confirmed"}` }
    : null;
  return { id: row.id, pending: !result?.terminal || !custody, complete: result?.complete === true, exclusion };
}), []);
