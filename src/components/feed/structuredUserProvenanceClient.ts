import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";

export async function structuredUserProvenance(refs: string[]): Promise<Record<string, DeliveredMessageProvenance | null>> {
  const response = await fetch("/api/structured-user/provenance", {
    method: "POST", headers: { "Content-Type": "application/json" },
    credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ refs }),
  });
  if (!response.ok) throw new Error("structured-user provenance is unavailable");
  const result = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid provenance response");
  return result;
}
