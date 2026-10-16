import type { RuntimeHostDiagnostics } from "./contracts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** A receipt is diagnostic evidence, never an admission authority. Reserve
 * space inside the journal's 16 KiB event budget and mark every omission. */
export function normalizeCodexProtocolReceipt(value: unknown): RuntimeHostDiagnostics["protocol"] {
  const source = record(value);
  if (typeof source.schemaVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(source.schemaVersion) || source.schemaVersion.length > 80
    || typeof source.schemaDigest !== "string" || !/^[a-f0-9]{64}$/.test(source.schemaDigest)
    || typeof source.experimentalApi !== "boolean") return undefined;
  const provider = record(source.provider);
  const receipt: NonNullable<RuntimeHostDiagnostics["protocol"]> = {
    schemaVersion: source.schemaVersion, schemaDigest: source.schemaDigest, experimentalApi: source.experimentalApi,
    provider: typeof provider.webSearch === "boolean" && typeof provider.imageGeneration === "boolean"
      ? { webSearch: provider.webSearch, imageGeneration: provider.imageGeneration } : null,
    models: [], anomalies: Number.isSafeInteger(source.anomalies) && (source.anomalies as number) >= 0 ? source.anomalies as number : 0,
  };
  const unpinned = record(source.unpinnedCli);
  if (typeof unpinned.cliVersion === "string" && /^\d+\.\d+\.\d+$/.test(unpinned.cliVersion) && unpinned.cliVersion.length <= 80
    && typeof unpinned.cliSchemaDigest === "string" && /^[a-f0-9]{64}$/.test(unpinned.cliSchemaDigest)) {
    receipt.unpinnedCli = { cliVersion: unpinned.cliVersion, cliSchemaDigest: unpinned.cliSchemaDigest };
  }
  const models = Array.isArray(source.models) ? source.models : [];
  let truncated = source.modelsTruncated === true || models.length > 64;
  for (const value of models.slice(0, 64)) {
    const model = record(value);
    if (typeof model.id !== "string" || !model.id) { truncated = true; continue; }
    const input = Array.isArray(model.inputModalities) ? model.inputModalities : [];
    const modalities = [...new Set(input.filter((item): item is string => ["text", "image", "audio"].includes(item)))];
    truncated ||= model.id.length > 200 || modalities.length !== input.length;
    receipt.models.push({ id: model.id.slice(0, 200), inputModalities: modalities });
    if (Buffer.byteLength(JSON.stringify(receipt)) > 4064) { receipt.models.pop(); truncated = true; break; }
  }
  if (truncated) receipt.modelsTruncated = true;
  return receipt;
}
