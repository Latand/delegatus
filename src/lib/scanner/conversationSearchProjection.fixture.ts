import { Database } from "bun:sqlite";
import { ConversationSearchProjection } from "./conversationSearchProjection";
import type { ConversationCatalogEntry } from "./conversationCatalog";
const [filename, mode] = process.argv.slice(2);
const capped = mode.startsWith("capped-");
const store = new ConversationSearchProjection(filename, capped ? { entries: 2, bytes: 10_000 } : undefined);
const entry: ConversationCatalogEntry = { path: "/catalog/restart.jsonl", root: "codex-sessions", name: "restart", project: "selected", title: "Catalog", firstPrompt: "", engine: "codex", kind: "session", fmt: "codex", size: 100, mtime: 1 };
let reads = 0;
try {
  const catalog = capped ? [1, 2, 3].map(n => ({ ...entry, path: `${entry.path}-${n}` })) : [entry];
  if (mode.endsWith("seed")) await store.search(catalog, "orchard", { readText: async () => { reads++; return { title: "Title", firstPrompt: "Orchard" }; } });
  const matches = await store.search(capped ? catalog.slice(-2) : catalog, "orchard", { readText: async () => { throw new Error("restart reopened a retained transcript"); } });
  const db = new Database(filename, { readonly: true });
  try {
    const retained = db.query<{ rows: number }, []>("SELECT rows FROM meta").get()!.rows;
    console.log(JSON.stringify({ reads, matches: matches.length, retained }));
  } finally { db.close(); }
} finally { store.close(); }
