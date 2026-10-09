import crypto from "node:crypto";

const preservedBytes = new WeakMap<readonly unknown[], Map<number, string>>();
const logged = new Set<string>();

export function rememberRecordBytes<T>(records: readonly T[], bytes: readonly string[], valid: (value: T) => boolean): readonly T[] {
  preservedBytes.set(records, new Map(records.flatMap((record, index) => valid(record) ? [] : [[index, bytes[index]!] as const])));
  return records;
}

export function preservedRecordJson(records: readonly unknown[], index: number): string | undefined {
  return preservedBytes.get(records)?.get(index);
}

/** Registry headers are ordinary JSON; rejected array elements retain their
    original bytes through first import and through rollback checkpoints. */
export function stringifyRegistryDocument(value: Record<string, unknown>): string {
  return `{\n${Object.entries(value).map(([key, item]) => {
    const json = Array.isArray(item) && preservedBytes.has(item)
      ? `[${item.map((record, index) => preservedRecordJson(item, index) ?? JSON.stringify(record)).join(",\n")}]`
      : JSON.stringify(item, null, 2);
    return `  ${JSON.stringify(key)}: ${json}`;
  }).join(",\n")}\n}\n`;
}

export interface RegistryRecordIssue {
  collection: string;
  id: string;
  reason: "malformed" | "unknown-but-preserved";
  detail: string;
}

/** Invalid legacy records without an id still need a durable, stable row key. */
export function registryRecordKey(value: unknown): string {
  if (value && typeof value === "object") {
    const id = (value as { id?: unknown; key?: unknown }).id ?? (value as { key?: unknown }).key;
    if (typeof id === "string" && id) return id;
  }
  return `unidentified-${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** Locate element bytes in an already parsed JSON document. This retains the
    original spelling/whitespace of records a writer cannot interpret. */
export function jsonArrayRecordBytes(source: string, property: string): string[] {
  const space = (start: number) => { while (/\s/.test(source[start] ?? "") && start < source.length) start++; return start; };
  const end = (start: number): number => {
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') { quoted = false; if (depth === 0) return i + 1; }
      } else if (char === '"') quoted = true;
      else if (char === "[" || char === "{") depth++;
      else if (char === "]" || char === "}") { if (--depth === 0) return i + 1; if (depth < 0) return i; }
      else if (char === "," && depth === 0) return i;
    }
    return source.length;
  };
  let cursor = space(source.indexOf("{") + 1);
  let arrayStart = -1;
  while (source[cursor] !== "}" && cursor < source.length) {
    const keyEnd = end(cursor);
    const key = JSON.parse(source.slice(cursor, keyEnd)) as string;
    const valueStart = space(space(keyEnd) + 1);
    if (key === property) arrayStart = valueStart; // JSON's last key wins.
    cursor = space(end(valueStart));
    if (source[cursor] === ",") cursor = space(cursor + 1);
  }
  if (source[arrayStart] !== "[") throw new Error(`missing JSON array: ${property}`);
  cursor = space(arrayStart + 1);
  const records: string[] = [];
  while (source[cursor] !== "]") {
    const valueEnd = end(cursor);
    records.push(source.slice(cursor, valueEnd).trimEnd());
    cursor = space(valueEnd);
    if (source[cursor] === ",") cursor = space(cursor + 1);
  }
  return records;
}

/** Logging names the record and never dumps its private payload. */
export function reportRegistryRecord(collection: string, value: unknown,
  reason: RegistryRecordIssue["reason"] = "malformed", detail = "validation failed; preserved without execution"): RegistryRecordIssue {
  const issue = { collection, id: registryRecordKey(value), reason, detail };
  const signature = JSON.stringify(issue);
  if (!logged.has(signature)) {
    if (logged.size >= 1_000) logged.clear();
    logged.add(signature);
    console.warn(`[${collection}] ${issue.id}: ${reason}; ${detail}`);
  }
  return issue;
}
