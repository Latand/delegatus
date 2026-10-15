import type { FeedSnapshot, Item, nativeUserRefFor, rawUserTextFor, assistantEchoText, hasSameSessionOwner } from "../parse";
const tools = (snapshot: FeedSnapshot) => snapshot.items.flatMap(({ item }) => item.kind === "cmd-group" ? item.calls : item.kind === "tool" ? [item] : []);

export function realHistoryIds(lines: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      for (const id of [record?.id, record?.payload?.id, record?.payload?.call_id, record?.payload?.item?.id]) if (typeof id === "string" && id) ids.add(id);
    } catch { /* Malformed records carry no engine identity. */ }
  }
  return ids;
}

/** A bijection for counter-generated IDs, including group references. Real
 * call/delivery/record IDs and all other string fields remain byte-exact. */
export function comparableHistory(snapshot: FeedSnapshot, provenance: {
  nativeUserRefFor: typeof nativeUserRefFor; rawUserTextFor: typeof rawUserTextFor;
  assistantEchoText: typeof assistantEchoText; hasSameSessionOwner: typeof hasSameSessionOwner;
}, realIds: ReadonlySet<string> = new Set()): unknown {
  const { nativeUserRefFor, rawUserTextFor, assistantEchoText, hasSameSessionOwner } = provenance;
  const ids = new Map<string, string>();
  const generated = (value: unknown) => {
    if (typeof value === "string" && /^plain-\d+-\d{4}-/.test(value) && !realIds.has(value) && !ids.has(value)) ids.set(value, `generated-${ids.size}`);
  };
  for (const { item } of snapshot.items) {
    if ("sourceId" in item) generated(item.sourceId);
    if (item.kind === "tool") generated(item.id);
    if (item.kind === "cmd-group") item.calls.forEach(call => generated(call.id));
  }
  const metadata = (item: Item) => ({ native: nativeUserRefFor(item), raw: rawUserTextFor(item), echo: assistantEchoText(item) });
  const calls = tools(snapshot);
  return JSON.parse(JSON.stringify({
    snapshot,
    metadata: snapshot.items.map(({ item }) => ({ ...metadata(item), calls: item.kind === "cmd-group" ? item.calls.map(metadata) : undefined })),
    owners: calls.map(a => calls.map(b => hasSameSessionOwner(a, b))),
  }, (key, value) => value === undefined ? { undefined: true }
    : (key === "id" || key === "sourceId") && typeof value === "string" ? ids.get(value) ?? value
      : key === "ids" && Array.isArray(value) ? value.map(id => ids.get(id) ?? id) : value));
}
