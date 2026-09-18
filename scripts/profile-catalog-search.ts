/** Scoped catalog hydration profile with an invented, fixed corpus. */
import fs from "node:fs";
import path from "node:path";
const repo = path.resolve(process.argv[2] ?? ".");
const root = path.resolve(process.argv[3] ?? ".artifacts/performance/catalog");
fs.mkdirSync(root, { recursive: true });
const { replaceConversationCatalog } = await import(path.join(repo, "src/lib/scanner/conversationCatalog.ts"));
const { GET } = await import(path.join(repo, "src/app/api/conversations/route.ts"));
const payload = JSON.stringify({ type: "user", message: { content: "Scoped keyword. " + "Synthetic prompt detail. ".repeat(2000) } }) + "\n";
const rows = Array.from({ length: 8247 }, (_, n) => {
  const pathname = path.join(root, `${n}.jsonl`);
  if (!fs.existsSync(pathname)) fs.writeFileSync(pathname, payload);
  const stat = fs.statSync(pathname);
  return { path: pathname, root: "claude-projects", name: `${n}.jsonl`, project: n < 951 ? "selected" : "other", title: "Conversation", firstPrompt: "", engine: "claude", kind: "session", fmt: "claude", mtime: stat.mtimeMs / 1000, size: stat.size };
});
replaceConversationCatalog(rows);
const results = [];
for (let n = 0; n < 2; n++) {
 const start = performance.now();
 const response = await GET(new Request("http://localhost/api/conversations?project=selected&q=keyword&limit=10"));
 const body = await response.json();
 results.push({ sample: n + 1, ms: performance.now() - start, status: response.status, total: body.total, items: body.items?.length });
 if (body.total !== 951 || body.items?.length !== 10) throw new Error("search result changed");
}
console.log(JSON.stringify({ corpus: rows.length, selected: 951, results }, null, 2));
