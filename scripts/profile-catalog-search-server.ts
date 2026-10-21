import fs from "node:fs";
import path from "node:path";

const [repository, corpus, selectedArg, state] = process.argv.slice(2);
if (!repository || !corpus || !state) throw new Error("usage: profile-catalog-search-server.ts repository corpus selected state");
const root = path.resolve(corpus);
const selected = Number(selectedArg);
process.env.LLV_STATE_DIR = state;
process.env.LLV_RESOURCE_OBSERVATION_WORKER = "1";
const { replaceConversationCatalog } = await import(path.join(repository, "src/lib/scanner/conversationCatalog.ts"));
const { setFileCatalogMembershipProbeForTests } = await import(path.join(repository, "src/lib/scanner/scanCache.ts"));
const { GET } = await import(path.join(repository, "src/app/api/conversations/route.ts"));
let preparation: { state: "disabled" | "running" | "complete" | "failed"; startedAt: number | null; finishedAt: number | null; error?: string } = {
  state: process.env.PROFILE_PREPARE === "1" ? "running" : "disabled",
  startedAt: null,
  finishedAt: null,
};
const payload = JSON.stringify({ type: "user", message: { content: "Scoped keyword. " + "Synthetic prompt detail. ".repeat(2000) } }) + "\n";
const rows = Array.from({ length: 8247 }, (_, n) => {
  const pathname = path.join(root, `${n}.jsonl`);
  if (!fs.existsSync(pathname)) {
    fs.writeFileSync(pathname, payload);
    fs.utimesSync(pathname, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  }
  const stat = fs.statSync(pathname);
  return { path: pathname, root: "claude-projects", name: `${n}.jsonl`, project: n < selected ? "selected" : "other", title: "Conversation", firstPrompt: "", engine: "claude", kind: "session", fmt: "claude", mtime: stat.mtimeMs / 1000, size: stat.size };
});
setFileCatalogMembershipProbeForTests(async () => null);
replaceConversationCatalog(rows);
const stallMs = Number(process.env.PROFILE_STALL_MS ?? 0);
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: request => {
    if (new URL(request.url).pathname === "/__profile") return Response.json(preparation);
    if (stallMs > 0 && new URL(request.url).pathname === "/api/conversations") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
    return GET(request);
  },
});
console.log(JSON.stringify({ origin: server.url.origin, selected, rows: rows.length, prepared: false, preparationStartedAfterListen: process.env.PROFILE_PREPARE === "1" }));
if (process.env.PROFILE_PREPARE === "1") {
  preparation.startedAt = performance.now();
  const { conversationSearchProjection } = await import(path.join(repository, "src/lib/scanner/conversationSearchProjection.ts"));
  void conversationSearchProjection().prepare(rows).then(() => {
    preparation = { ...preparation, state: "complete", finishedAt: performance.now() };
  }, (error: unknown) => {
    preparation = { ...preparation, state: "failed", finishedAt: performance.now(), error: String(error) };
  });
}
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
