import { captureProcessIdentity, processIdentityMayRun } from "../src/lib/processIdentity";

/** Broker shutdown can await workers that were in the service's cgroup.
 * Judge the current members only after that shutdown has settled. A vanished
 * cgroup entry is dead; an unverifiable live identity still refuses cleanup. */
export async function serviceSurvivors(members: () => number[], close: () => Promise<void>) {
  await close();
  return members().map(pid => captureProcessIdentity(pid)).filter(identity => processIdentityMayRun(identity));
}
