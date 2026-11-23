import http from "node:http";
import fs from "node:fs";
import path from "node:path";

export function ownerIntentFixture(root: string, seatHandoff: boolean, capture?: string): string {
  const command = path.join(root, seatHandoff ? "route-seat-handoff" : "route-ordinary-answer");
  fs.writeFileSync(command, `#!${process.execPath}
const fs = require('fs'), args = process.argv.slice(2);
const prompt = await Bun.stdin.text();
${capture ? `fs.writeFileSync(${JSON.stringify(capture)}, prompt);` : ""}
const output = { seat_handoff: ${seatHandoff} };
const outputFile = args[args.indexOf('--output-last-message') + 1];
if (args.includes('--output-last-message')) fs.writeFileSync(outputFile, JSON.stringify(output));
else {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', structured_output: output }));
}
`, { mode: 0o700 });
  return command;
}
export async function startTestRelay(
  handler: (
    req: http.IncomingMessage,
    body: unknown,
  ) =>
    | {
        status?: number;
        body?: unknown;
        headers?: Record<string, string>;
        drop?: boolean;
        raw?: Buffer;
      }
    | Promise<{
        status?: number;
        body?: unknown;
        headers?: Record<string, string>;
        drop?: boolean;
        raw?: Buffer;
      }>,
) {
  const server = http.createServer(async (req, res) => {
    req.socket.on("error", () => {});
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const text = raw.toString("utf8");
      const answer = await handler(req, req.headers["content-type"]?.startsWith("application/json") ? text ? JSON.parse(text) : null : raw.length ? raw : null);
      if (answer.drop) {
        res.destroy();
        return;
      }
      res.writeHead(answer.status ?? 200, {
        "content-type": "application/json",
        ...answer.headers,
      });
      res.end(answer.raw ?? (answer.body === undefined ? "" : JSON.stringify(answer.body)));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Apply additive deadline and guest negotiation to historical wire captures. */
export function deadlineNegotiatedCapture(text: string): string {
  const capture = JSON.parse(text);
  capture.claim_body.features.splice(3, 0, "request_deadline");
  capture.claim_body.features.splice(4, 0, "relay_guest_answers");
  return JSON.stringify(capture, null, 2) + "\n";
}
