import { JEV_ENDPOINT, JEV_INPUT_PRICE_USD, JevError, jevFailureCostUsd } from "@/lib/asks/jev";
import { groundedRequest, memoryGate, selectOffers, type Candidate, type SelectionInput } from "./selection";

export interface InjectionInput extends Omit<SelectionInput, "candidates"> {
  origin: string; project: string; conversation: string; requestId: string;
}
export interface InjectionPorts {
  enabled(): boolean;
  ownsTraffic(): boolean;
  candidates(deadline: number): Candidate[];
  reserve(ceiling: number): boolean;
  decide(body: ReturnType<typeof groundedRequest>, signal: AbortSignal): Promise<{ scores: Record<string, number>; cost: number }>;
  settle(cost: number): void;
  record(entries: Array<Candidate & { score: number }>): void;
  timeoutMs?: number;
  deadline?: number;
  signal?: AbortSignal;
}

/** No error can turn an optional memory offer into a failed operator turn. */
export async function injectMemory(input: InjectionInput, ports: InjectionPorts): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reserved: number | null = null;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  ports.signal?.addEventListener("abort", cancel, { once: true });
  const deadline = Math.min(ports.deadline ?? Infinity, performance.now() + Math.min(1500, ports.timeoutMs ?? 1500));
  try {
    if (ports.signal?.aborted || !memoryGate({ ...input, enabled: ports.enabled() }) || !ports.ownsTraffic()) return "";
    const candidates = ports.candidates(deadline);
    if (!candidates.length) return "";
    const body = groundedRequest({ ...input, candidates });
    if (performance.now() >= deadline) return "";
    const ceiling = Math.max(.01, (4096 + Buffer.byteLength(JSON.stringify(body))) * JEV_INPUT_PRICE_USD);
    if (!ports.reserve(ceiling)) return "";
    reserved = ceiling;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new JevError("timeout", "memory decision expired");
    const verdict = await Promise.race([
      ports.decide(body, abort.signal),
      new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new JevError("timeout", "memory decision cancelled")), { once: true })),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(Error("timeout")); }, remaining); }),
    ]);
    if (!Number.isFinite(verdict.cost) || verdict.cost < 0) throw new JevError("shape", "missing usage");
    ports.settle(verdict.cost);
    reserved = null;
    if (abort.signal.aborted || performance.now() >= deadline || !ports.enabled() || !ports.ownsTraffic()) return "";
    const result = selectOffers(candidates, verdict.scores);
    if (result.entries.length) ports.record(result.entries);
    return result.block;
  } catch (error) {
    if (reserved !== null) { try { ports.settle(jevFailureCostUsd(error, reserved)); } catch { /* optional accounting */ } }
    return "";
  }
  finally { clearTimeout(timer); ports.signal?.removeEventListener("abort", cancel); abort.abort(); }
}

export async function decideMemories(body: ReturnType<typeof groundedRequest>, key: string, signal: AbortSignal) {
  let response: Response;
  try {
    response = await fetch(JEV_ENDPOINT, { method: "POST", signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch { throw new JevError(signal.aborted ? "timeout" : "network", "memory decision unavailable"); }
  if (!response.ok) throw new JevError("http", "memory decision unavailable", response.status);
  let result;
  try { result = await response.json(); }
  catch { throw new JevError(signal.aborted ? "timeout" : "shape", "memory decision unreadable", response.status); }
  const cost = result?.usage?.cost;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) throw new JevError("shape", "missing usage", response.status);
  const scores: Record<string, number> = {};
  for (const id of Object.keys(body.questions)) {
    const score = result?.answers?.[id]?.noul;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) throw new JevError("shape", "invalid decision", response.status, cost);
    scores[id] = score;
  }
  return { scores, cost };
}
