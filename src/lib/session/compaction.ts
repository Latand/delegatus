/** Completed native compaction boundaries, shared by bounded transcript readers.
 * A summary message or a started compaction is not a boundary. */
export function nativeCompaction(row: Record<string, unknown>): { postTokens: number | null } | null {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const kind = (value: unknown) => typeof value === "string" ? value.replace(/[_-]/g, "").toLowerCase() : "";
  if (row.type === "system" && row.subtype === "compact_boundary") {
    const post = record(row.compactMetadata).postTokens;
    return { postTokens: typeof post === "number" && Number.isFinite(post) && post >= 0 ? post : null };
  }
  // Older Claude transcripts used this explicit boundary type.
  if (row.type === "compact" || row.type === "compacted") return { postTokens: null };
  const payload = record(row.payload);
  const item = record(payload.item);
  const type = kind(payload.type);
  if ((row.type === "response_item" && kind(item.type ?? payload.type) === "contextcompaction")
    || (row.type === "event_msg" && (type === "contextcompacted" || type === "contextcompaction"
      || (type === "itemcompleted" && kind(item.type) === "contextcompaction")))) {
    return { postTokens: null };
  }
  return null;
}
