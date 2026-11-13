import http from "node:http";
import fs from "node:fs";

// A separate process keeps the service worker alive when the client disconnects
// or its event loop stops. All requests bind to an ephemeral loopback listener.
const [mode, ledgerPath] = process.argv.slice(2);
type Receipt = { arguments: string; applied: boolean; terminal: boolean };
const ledger: Record<string, Receipt> = fs.existsSync(ledgerPath!) ? JSON.parse(fs.readFileSync(ledgerPath!, "utf8")) : {};
let calls = 0;
let effects = Object.values(ledger).filter(row => row.applied).length;
const bodies: unknown[] = [];
const order: string[] = [];
const save = () => fs.writeFileSync(ledgerPath!, JSON.stringify(ledger));
const commit = (key: string) => {
  if (!ledger[key]!.terminal) {
    ledger[key]!.applied = true; ledger[key]!.terminal = true; effects++; save(); order.push("committed");
  }
};
const server = http.createServer(async (req, res) => {
  req.socket.on("error", () => {});
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (req.url === "/state") {
    res.end(JSON.stringify({ calls, effects, bodies, order })); return;
  }
  if (req.url === "/release") {
    if (["lost", "slow", "fenced"].includes(mode!)) for (const key of Object.keys(ledger)) commit(key);
    res.end("released"); return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString());
  bodies.push(body); calls++;
  const key = `${req.url}/${body.call_id}`;
  const args = JSON.stringify({ tool: body.tool, arguments: body.arguments });
  const prior = ledger[key];
  if (prior && prior.arguments !== args) {
    res.writeHead(409); res.end(JSON.stringify({ error: { code: "call_conflict" } })); return;
  }
  const result = (status: string, replayed = !!prior, code?: string) => ({
    call_id: body.call_id, tool: body.tool, effect: "action", status,
    output: status === "ok" ? "Rule saved." : status === "error" ? "Rule was not saved." : "",
    truncated: false, delivered: false, replayed, calls_remaining: 0, ...(code ? { code } : {}),
  });
  if (calls === 1 && !prior) {
    if (mode === "before_acceptance") {
      // No receipt exists: the socket times out before admission.
      req.socket.setTimeout(1, () => req.socket.destroy()); return;
    }
    ledger[key] = { arguments: args, applied: false, terminal: false }; save(); order.push("accepted");
    if (mode === "fenced") { ledger[key]!.terminal = true; save(); order.push("fenced"); }
    if (mode === "slow") {
      res.end(JSON.stringify({ ...result("pending", false), retry_after_s: 1 })); return;
    }
    if (mode === "lost") {
      // The test releases the independent worker after observing this loss.
      order.push("disconnected"); res.destroy(); return;
    }
    res.end(JSON.stringify(result("outcome_unknown", false))); return;
  }
  if (mode === "unreadable") { res.writeHead(503); res.end(); return; }
  if (mode === "unauthorized" || mode === "unsupported_version") {
    res.writeHead(mode === "unauthorized" ? 401 : 426); res.end(JSON.stringify({ error: { code: mode } })); return;
  }
  if (mode === "wrong_identity" || mode === "wrong_effect") {
    res.end(JSON.stringify({ ...result("ok"), ...(mode === "wrong_identity" ? { call_id: "z".repeat(43) } : { effect: "read" }) })); return;
  }
  if (mode === "fenced") {
    ledger[key]!.terminal = true; save(); order.push("fenced"); res.end(JSON.stringify(result("error"))); return;
  }
  if (mode === "legacy_denied") { res.end(JSON.stringify(result("denied", true, "too_many_calls"))); return; }
  if (mode === "legacy_unknown") { res.end(JSON.stringify(result("outcome_unknown", true))); return; }
  if (mode === "before_acceptance" && calls === 2) {
    // An authoritative pre-admission refusal has no accepted operation to cache.
    res.end(JSON.stringify(result("error", false))); return;
  }
  order.push("replayed");
  if (prior && !prior.terminal) { res.end(JSON.stringify({ ...result("pending"), retry_after_s: 1 })); return; }
  if (!prior) ledger[key] = { arguments: args, applied: false, terminal: false };
  commit(key);
  res.end(JSON.stringify(result(ledger[key]!.applied ? "ok" : "error")));
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") console.log(address.port);
});
