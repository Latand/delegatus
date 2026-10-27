import fs from "node:fs";
import { NextRequest } from "next/server";
import { blockingWaitDiagnostics } from "@/lib/blockingWaits";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { GET, POST } from "./route";

if (process.argv[3] === "hold") {
  withFileTransactionSync(process.argv[4]!, "test holds voice choice", () => {
    fs.writeFileSync(process.argv[2]!, "held");
    fs.readSync(0, Buffer.alloc(1), 0, 1, null);
  });
  process.exit(0);
}

const ready = process.argv[2]!;
let timerAtMs = 0;
process.on("SIGTERM", () => { fs.writeFileSync(`${ready}.signal`, "handled"); });
process.stdin.once("data", () => {
  const started = performance.now();
  setTimeout(() => {
    timerAtMs = performance.now() - started;
    fs.writeFileSync(`${ready}.timer`, "handled");
  }, 5);
});
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    if (req.method === "GET") return GET();
    const started = performance.now();
    try {
      const response = await POST(new NextRequest(req));
      const returnedAtMs = performance.now() - started;
      return Response.json({ status: response.status, body: await response.json(),
        timerAtMs, returnedAtMs, waits: blockingWaitDiagnostics().longest });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    }
  },
});
fs.writeFileSync(ready, JSON.stringify({ port: server.port }));
