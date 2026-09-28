import http from "node:http";
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
      }
    | Promise<{
        status?: number;
        body?: unknown;
        headers?: Record<string, string>;
        drop?: boolean;
      }>,
) {
  const server = http.createServer(async (req, res) => {
    req.socket.on("error", () => {});
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const text = Buffer.concat(chunks).toString("utf8");
      const answer = await handler(req, text ? JSON.parse(text) : null);
      if (answer.drop) {
        res.destroy();
        return;
      }
      res.writeHead(answer.status ?? 200, {
        "content-type": "application/json",
        ...answer.headers,
      });
      res.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
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
