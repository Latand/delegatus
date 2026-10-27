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

let signalAt = 0;
process.on("SIGTERM", () => { signalAt = Date.now(); });
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(req) {
    if (req.method === "GET") return GET();
    const started = performance.now();
    let timerAtMs = 0;
    const timer = setTimeout(() => { timerAtMs = performance.now() - started; }, 5);
    try {
      const response = await POST(new NextRequest(req));
      const returnedAtMs = performance.now() - started;
      // Let an already pending signal/timer run even on the blocking control.
      await new Promise(resolve => setTimeout(resolve, 0));
      return Response.json({ status: response.status, body: await response.json(),
        timerAtMs, signalAt, returnedAtMs, waits: blockingWaitDiagnostics().longest });
    } catch (error) {
      return Response.json({ error: (error as Error).message }, { status: 500 });
    } finally { clearTimeout(timer); }
  },
});
fs.writeFileSync(process.argv[2]!, JSON.stringify({ port: server.port }));
