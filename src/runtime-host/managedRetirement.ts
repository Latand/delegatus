import fs from "node:fs";

import { processIdentityStatus, type ProcessIdentity } from "@/lib/processIdentity";
import type { ViewerReleaseIdentity } from "@/lib/runtime/contracts";
import { resumeRetirementOwner } from "./managedNativePreservation";

export interface ManagedContainerIdentity {
  id: string;
  image: string;
  revision: string;
  managed: string;
  running: boolean;
}

export interface ManagedRetirementPorts {
  inspect(container: string): Promise<ManagedContainerIdentity>;
  stop(id: string): Promise<void>;
  preserveNativeProcesses(owner: ProcessIdentity, id: string): Promise<void>;
  recordBoundary(container: ManagedContainerIdentity): Promise<void>;
  fenceStands(): boolean;
  ownerStatus?(owner: ProcessIdentity): "alive" | "dead" | "unverified";
  ownsContainer?(owner: ProcessIdentity, id: string): boolean;
}

/** Container membership and process identity are independent proofs: PID reuse
    or an unreadable cgroup cannot authorize stopping another deployment. */
function ownsContainer(owner: ProcessIdentity, id: string): boolean {
  try {
    return fs.readFileSync(`/proc/${owner.pid}/cgroup`, "utf8").split("\n")
      .some(line => line.split("/").some(part => part === id || part === `docker-${id}.scope`));
  } catch { return false; }
}

/** Retires only an exactly identified managed web container. Native engines
    keep running; their durable ledgers and original queue keys are preserved
    for the successor's existing restart-cut and adoption checks. */
export async function retireFencedManagedViewer(
  candidate: ViewerReleaseIdentity,
  owner: ProcessIdentity,
  ports: ManagedRetirementPorts,
): Promise<void> {
  const status = ports.ownerStatus ?? processIdentityStatus;
  const belongs = ports.ownsContainer ?? ownsContainer;
  const first = await ports.inspect(candidate.container);
  const matches = (current: ManagedContainerIdentity) => /^[a-f0-9]{64}$/.test(current.id)
    && current.id === first.id && current.image === candidate.image
    && current.revision === candidate.revision && current.managed === "1";
  if (!ports.fenceStands() || !matches(first)) throw new Error("managed retirement identity or fence is unavailable");
  if (status(owner) === "dead") return;
  if (status(owner) !== "alive" || !first.running || !belongs(owner, first.id)) {
    throw new Error("managed retirement cannot prove the activation owner's container");
  }
  try {
    await ports.preserveNativeProcesses(owner, first.id);
    await ports.recordBoundary(first);
    const current = await ports.inspect(first.id);
    if (!ports.fenceStands() || !matches(current)) {
      throw new Error("managed retirement identity changed after its restart boundary");
    }
    // Cooperative exit can win while the durable boundary is being written.
    if (status(owner) === "dead") return;
    if (!current.running || status(owner) !== "alive" || !belongs(owner, current.id)) {
      throw new Error("managed retirement identity changed after its restart boundary");
    }
    await ports.stop(current.id);
    const stopped = await ports.inspect(current.id);
    if (!ports.fenceStands() || !matches(stopped) || stopped.running || status(owner) !== "dead") {
      throw new Error("managed retirement has no positive activation-owner death proof");
    }
  } finally { resumeRetirementOwner(owner); }
}
