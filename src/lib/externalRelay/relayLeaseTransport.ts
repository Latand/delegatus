import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { endLeasedHelper, leasedHelperInput, spawnLeasedHelper } from "@/lib/helperLease";
import type { ExternalRelayCompletion, ExternalRelayProgress } from "./protocol";
import type { PairedRelay } from "./store";
import type { RelayAnswerDelivery } from "./answers";
import { ExternalRelayError, relayCall } from "./client";
import { completeRelayRequest } from "./relayCompletion";
import { ownerRelayAuthorized, ownerRelayStatusReplyAuthorized } from "./ownerAuthority";

export type TransportResult = { body: ExternalRelayCompletion; delivery: RelayAnswerDelivery };
type Frame = { type: "ready" } | { type: "heartbeat"; seq: number; phase: "attempt" | "acknowledged" | "failed" | "completion_pending" | "post_completion"; status: number; code?: string }
  | { type: "completion"; result?: TransportResult; error?: true } | { type: "refresh_features" } | { type: "drained" };
// A validated 128 KB answer may expand to 768 KB when JSON escapes control
// characters. Keep an explicit per-frame cap with room for the envelope.
const MAX_FRAME_BYTES = 1024 * 1024;
export function relayLeaseTransportLaunch(cwd = process.cwd()) {
  const source = path.join(cwd, "src/lib/externalRelay/relayLease.worker.ts");
  const bundled = path.join(cwd, ".next/server/relay-lease-worker.js");
  const containerBun = "/usr/local/bin/bun-container";
  return { executable: fs.existsSync(containerBun) ? containerBun : process.versions.bun ? process.execPath : process.env.LLV_BUN_EXECUTABLE || "bun",
    workerPath: fs.existsSync(source) ? source : bundled };
}

export class RelayLeaseTransport {
  private child: ChildProcess;
  private buffer = "";
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private completeResolve!: (result: TransportResult) => void;
  private completeReject!: (error: Error) => void;
  private drainedResolve!: () => void;
  private completePromise?: Promise<TransportResult>;
  private readonly drained = new Promise<void>(resolve => { this.drainedResolve = resolve; });
  private failed?: Error;
  private closed: Promise<void>;
  readonly ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });

  constructor(private readonly relay: PairedRelay, private readonly requestId: string, private readonly targetId: string, private readonly leaseId: string,
    private readonly intervalMs: number, private readonly onHeartbeat: (frame: Extract<Frame, { type: "heartbeat" }>) => void,
    initialProgress: ExternalRelayProgress | null = null, private readonly onRefreshFeatures?: () => void, launch = relayLeaseTransportLaunch()) {
    this.child = spawnLeasedHelper("relay-lease", { command: launch.executable, args: [launch.workerPath], cwd: process.cwd(), env: process.env }, undefined,
      { input: true, stdout: "pipe", stderr: "ignore" });
    this.closed = new Promise(resolve => this.child.once("close", () => resolve()));
    const fail = () => this.fail(new Error("relay lease helper ended"));
    this.child.once("error", fail); this.child.once("close", fail);
    leasedHelperInput(this.child).on("error", fail);
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.read(chunk));
    this.send({ type: "start", relay, requestId, targetId, leaseId, intervalMs, progress: initialProgress });
  }

  private send(value: unknown) {
    if (this.failed) throw this.failed;
    leasedHelperInput(this.child).write(JSON.stringify(value) + "\n", error => { if (error) this.fail(error); });
  }

  private fail(error: Error) {
    if (this.failed) return;
    this.failed = error;
    this.readyReject(error);
    this.completeReject?.(error);
    this.drainedResolve();
  }

  private read(chunk: string) {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) { this.fail(new Error("relay lease helper exceeded its frame bound")); endLeasedHelper(this.child); return; }
      try {
        const frame = JSON.parse(line) as Frame;
        if (frame.type === "ready") { this.readyResolve(); continue; }
        if (frame.type === "heartbeat") { this.onHeartbeat(frame); continue; }
        if (frame.type === "refresh_features") { this.onRefreshFeatures?.(); continue; }
        if (frame.type === "drained") { this.drainedResolve(); continue; }
        if (frame.type === "completion") {
          if (frame.result) this.completeResolve?.(frame.result);
          else this.completeReject?.(new Error("relay completion helper failed"));
          continue;
        }
        throw new Error("invalid relay lease helper frame");
      } catch { this.fail(new Error("invalid relay lease helper response")); endLeasedHelper(this.child); return; }
    }
    if (Buffer.byteLength(this.buffer) > MAX_FRAME_BYTES) { this.fail(new Error("relay lease helper exceeded its frame bound")); endLeasedHelper(this.child); }
  }

  progress(progress: ExternalRelayProgress | null) { this.send({ type: "progress", progress }); }

  complete(body: ExternalRelayCompletion, until: number, plainMax: number, ownerAuthorization: boolean | "status" = false): Promise<TransportResult> {
    if (this.completePromise) return this.completePromise;
    this.completePromise = new Promise((resolve, reject) => { this.completeResolve = resolve; this.completeReject = reject; });
    this.send({ type: "complete", body, until, plainMax, ownerAuthorization });
    return this.completePromise;
  }

  async close() {
    if (this.completePromise && !this.failed) await this.drained;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      try { this.send({ type: "stop" }); } catch { /* the helper is already exiting */ }
      this.child.stdin?.end();
    }
    await this.closed;
  }
}

/** In-process transport for focused runner tests. Production leaves leaseWorker unset. */
export class InlineRelayLeaseTransport {
  private seq = 0;
  private progressValue: ExternalRelayProgress | null;
  private timer?: ReturnType<typeof setTimeout>;
  private progressTimer?: ReturnType<typeof setTimeout>;
  private beatPromise: Promise<void> = Promise.resolve();
  private nextDue: number;
  private stopped = false;
  private completing = false;
  private accepted = false;
  private closed = false;
  private busy = false;
  private regularPending = false;
  private progressPending = false;
  private pendingLeaseLoss?: { status: number; code: string };
  readonly ready: Promise<void>;

  constructor(private readonly relay: PairedRelay, private readonly requestId: string, private readonly targetId: string,
    private readonly leaseId: string, private readonly intervalMs: number,
    private readonly onHeartbeat: (frame: Extract<Frame, { type: "heartbeat" }>) => void,
    progress: ExternalRelayProgress | null, private readonly onRefreshFeatures?: () => void) {
    this.progressValue = progress;
    this.nextDue = Date.now() + intervalMs;
    this.ready = this.beat(false);
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || this.closed) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.beat(true); }, Math.max(0, this.nextDue - Date.now()));
    this.timer.unref();
  }

  private async beat(regular: boolean): Promise<void> {
    if (this.busy) { if (regular) this.regularPending = true; return; }
    if (this.stopped || this.closed) return;
    clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.busy = true;
    const seq = ++this.seq;
    const sent = this.progressValue;
    const progress = sent;
    const frame = (phase: Extract<Frame, {type:"heartbeat"}>["phase"], status: number, code?: string) =>
      this.onHeartbeat({ type: "heartbeat", seq, phase, status, ...(code ? {code} : {}) });
    this.beatPromise = (async () => {
      try {
        frame("attempt", 0);
        const response = await relayCall(this.relay.api_base, `/requests/${encodeURIComponent(this.requestId)}/heartbeat`, "POST",
          { lease_id: this.leaseId, seq, progress }, this.relay.credential,
          { timeoutMs: 5000, maxBytes: this.relay.limits.max_response_bytes });
        frame("acknowledged", response.status);
        if (this.progressValue === sent) this.progressValue = null;
      } catch (error) {
        const status = error instanceof ExternalRelayError ? error.status : 0;
        const code = error instanceof ExternalRelayError ? error.code : "transport_error";
        const leaseLost = status === 404 || status === 409 && code === "lease_lost";
        const phase = this.accepted && leaseLost ? "post_completion" : this.completing && leaseLost ? "completion_pending" : "failed";
        frame(phase, status, code);
        if (phase === "completion_pending") this.pendingLeaseLoss = {status,code};
        if (phase === "failed" && leaseLost) this.stopped = true;
      }
    })();
    await this.beatPromise;
    this.busy = false;
    if (this.pendingLeaseLoss && !this.completing) {
      const lost = this.pendingLeaseLoss; this.pendingLeaseLoss = undefined;
      frame(this.accepted ? "post_completion" : "failed", lost.status, lost.code);
    }
    if (this.progressPending && !this.stopped && !this.closed) {
      this.progressPending = false;
      void this.beat(false);
    } else if (!this.stopped && !this.closed) {
      const now = Date.now();
      if (regular) while (this.nextDue <= now) this.nextDue += this.intervalMs;
      if (this.regularPending) { this.regularPending = false; void this.beat(true); }
      else this.arm();
    }
  }

  progress(progress: ExternalRelayProgress | null) {
    this.progressValue = progress;
    if (this.stopped || this.closed) return;
    if (this.busy) this.progressPending = true;
    else if (!this.progressTimer) {
      this.progressTimer = setTimeout(() => { this.progressTimer = undefined; void this.beat(false); }, 50);
      this.progressTimer.unref();
    }
  }

  async complete(body: ExternalRelayCompletion, until: number, plainMax: number, ownerAuthorization: boolean | "status" = false): Promise<TransportResult> {
    this.completing = true;
    const result = await completeRelayRequest(this.relay, this.requestId, body, () => until,
      ownerAuthorization ? () => ownerAuthorization === "status"
        ? ownerRelayStatusReplyAuthorized(this.relay.id, this.targetId, this.requestId, body, plainMax)
        : ownerRelayAuthorized(this.relay.id, this.targetId, this.requestId) : undefined,
      async () => { this.onRefreshFeatures?.(); }, plainMax);
    this.completing = false;
    this.accepted = result.delivery === "accepted";
    if (this.pendingLeaseLoss) {
      const lost = this.pendingLeaseLoss; this.pendingLeaseLoss = undefined;
      this.onHeartbeat({ type:"heartbeat", seq:this.seq, phase:this.accepted ? "post_completion" : "failed", ...lost });
    }
    if (this.accepted) { this.stopped = true; clearTimeout(this.timer); }
    return result;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.progressTimer);
    await this.beatPromise;
  }
}
