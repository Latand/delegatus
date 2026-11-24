import type { ChildProcess } from "node:child_process";
import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper } from "@/lib/helperLease";
import { withoutUnsupportedApiCredentials } from "@/lib/environmentIsolation";
import type { DependencyCacheFence, DependencyPreparationEffect, DependencyPreparationStep } from "./lockedDependencies";
import type { PrivateInstallEffect, PrivateInstallIntent, PrivateInstallReceipt } from "./provisionPrivateDependencies";
import type { LegacyInstallerObservation } from "./provisionLegacyInstaller";
import type { ProvisionExecPort } from "./git";
import { provisionToolchainEntry } from "./provisionToolchainEntry";
import { provisionFrame, provisionFrames, validCacheFence, validCacheIdentity, validPrivateIntent, validPrivateReceipt } from "./provisionToolchainProtocol";

type ToolchainStep = DependencyPreparationStep | "installingPrivateDependencies";
type ToolchainEffect = DependencyPreparationEffect | PrivateInstallEffect;
const steps = new Set<unknown>(["checkingDependencies", "validatingSealedGraph", "preparingToolchain", "installingPrivateDependencies"]);
const effects = new Set<unknown>(["open-cache", "prune-cache", "prepare-cache", "install-cache", "publish-cache", "link-cache",
  "private-scratch", "private-copy", "private-install", "private-marker", "private-publish", "private-cleanup", "create-modules-directory", "install-in-place"]);

export class ProvisionToolchainFailure extends Error {
  constructor(readonly reason: "toolchain-start-failed" | "toolchain-reply-lost" | "private-install-unverified") {
    super(reason);
  }
}

type ToolchainRequest = {
  root: string;
  token: string;
  repository: string;
  checkout: string;
  budgetMs: number;
  signal: AbortSignal;
  exec: ProvisionExecPort;
  privateReceipt?: PrivateInstallReceipt;
  privateIntent?: PrivateInstallIntent;
  recordPrivateReceipt(receipt: PrivateInstallReceipt): Promise<void>;
  recordPrivateIntent(intent: PrivateInstallIntent): Promise<void>;
  ready(workerPid: number): Promise<void>;
  step(step: ToolchainStep): Promise<void>;
  dispatch(effect: ToolchainEffect, sequence: number): Promise<void>;
  cacheBusy(identity: string): Promise<never>;
  cacheAcquired(fence: DependencyCacheFence): Promise<void>;
  legacyWriter(cause: Exclude<LegacyInstallerObservation, { kind: "clear" }>): Promise<never>;
  track(child: ChildProcess): void;
  observeReply?(type: string, detail?: string): Promise<void>;
};

export async function runProvisionToolchain(request: ToolchainRequest): Promise<void> {
  let child: ChildProcess | undefined;
  let ready = false;
  let parentFailure: unknown;
  const parent = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) { parentFailure = error; throw error; }
  };
  const stop = () => {
    if (!child) return;
    child.stdin?.destroy();
    endLeasedHelper(child);
  };
  try {
    const { entry, command, cwd } = provisionToolchainEntry();
    request.signal.throwIfAborted();
    const env = withoutUnsupportedApiCredentials({ ...process.env });
    for (const key of Object.keys(env)) {
      if (/^(?:LLV|DELEGATUS)_(?:STATE|INBOX|HELPER_LEASE)/.test(key)) delete env[key];
    }
    child = spawnLeasedHelper("provision-toolchain", { command, args: ["--no-env-file", entry, "prepare"], cwd, env },
      request.root, { input: true, stdout: "pipe", followRelease: true });
    child.on("error", stop);
    request.track(child);
    request.signal.addEventListener("abort", stop, { once: true });
    if (request.signal.aborted) stop();
    const input = leasedHelperInput(child);
    input.on("error", stop);
    const send = (body: object) => {
      request.signal.throwIfAborted();
      return new Promise<void>((resolve, reject) => {
        input.write(provisionFrame(body), error => error ? reject(error) : resolve());
      });
    };
    let sequence = 0;
    for await (const frame of provisionFrames(child.stdout!)) {
      request.signal.throwIfAborted();
      const { repository, checkout, token, budgetMs } = request;
      if (!ready) {
        if (frame.type !== "ready" || frame.version !== 1 || typeof frame.pid !== "number"
          || !Number.isSafeInteger(frame.pid) || frame.pid <= 0) throw new Error("invalid provisioning ready frame");
        const pid = frame.pid;
        await parent(() => request.ready(pid));
        await request.observeReply?.("ready");
        ready = true;
        await send({ type: "start", token, repository, checkout, budgetMs, privateReceipt: request.privateReceipt, privateIntent: request.privateIntent });
        continue;
      }
      if (frame.token !== token || frame.seq !== ++sequence) throw new Error("out-of-order provisioning request");
      const go = { type: "go", token, seq: sequence };
      if (frame.type === "step" && steps.has(frame.step)) {
        await parent(() => request.step(frame.step as ToolchainStep));
      } else if (frame.type === "dispatch" && effects.has(frame.effect)) {
        const effect = frame.effect as ToolchainEffect;
        try { await parent(() => request.dispatch(effect, sequence)); }
        catch (error) {
          // Refuse this exact request while its pipe is still open. The
          // guardian also closes the lease if the requester has already left.
          if (await send({ type: "stop", token, seq: sequence }).then(() => true, () => false)) {
            await request.observeReply?.("stop", effect);
          }
          throw error;
        }
      } else if (frame.type === "cacheBusy" && validCacheIdentity(frame.identity)) {
        const identity = frame.identity;
        await parent(() => request.cacheBusy(identity));
      } else if (frame.type === "cacheAcquired" && validCacheFence(frame.fence)) {
        const fence = frame.fence;
        await parent(() => request.cacheAcquired(fence));
      } else if (frame.type === "legacyWriter" && validLegacyObservation(frame.observation)) {
        const cause = frame.observation;
        await parent(() => request.legacyWriter(cause));
      } else if (frame.type === "privateReceipt" && validPrivateReceipt(frame.receipt)) {
        const receipt = frame.receipt;
        await parent(() => request.recordPrivateReceipt(receipt));
      } else if (frame.type === "privateIntent" && validPrivateIntent(frame.intent)) {
        const intent = frame.intent;
        await parent(() => request.recordPrivateIntent(intent));
      } else if (frame.type === "readCommonDir" && typeof frame.owner === "boolean") {
        const result = await request.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          frame.owner ? repository : checkout, request.signal);
        await send({ ...go, code: result.code, value: result.stdout.trim() });
        continue;
      } else if (frame.type === "checkIgnoredModules") {
        const result = await request.exec("git", ["check-ignore", "--quiet", "node_modules"], checkout, request.signal);
        await request.observeReply?.("checkIgnoredModules");
        await send({ ...go, code: result.code });
        continue;
      } else if (frame.type === "result") {
        if (frame.outcome === "verified") return;
        if (frame.outcome === "private-install-unverified") throw new ProvisionToolchainFailure(frame.outcome);
        throw new Error("invalid provisioning result");
      } else if (frame.type !== "payloadScanComplete") throw new Error("invalid provisioning worker request");
      await request.observeReply?.(String(frame.type),
        typeof frame.effect === "string" ? frame.effect : typeof frame.step === "string" ? frame.step : undefined);
      await send(go);
    }
    throw new Error("provisioning worker exited before its result");
  } catch (error) {
    if (request.signal.aborted || error === parentFailure || error instanceof ProvisionToolchainFailure) throw error;
    throw new ProvisionToolchainFailure(ready ? "toolchain-reply-lost" : "toolchain-start-failed");
  } finally {
    request.signal.removeEventListener("abort", stop);
    stop();
  }
}

function validLegacyObservation(value: unknown): value is Exclude<LegacyInstallerObservation, { kind: "clear" }> {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.kind === "possible-writer") return typeof row.pid === "number" && Number.isSafeInteger(row.pid) && row.pid > 0
    && typeof row.start === "string" && /^\d{1,30}$/.test(row.start);
  return row.kind === "incomplete" && ["enumeration", "process-identity", "working-directory", "expired", "unsupported"].includes(String(row.reason));
}
