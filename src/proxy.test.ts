import { afterEach, expect, test } from "bun:test";
import http from "node:http";
import { networkInterfaces } from "node:os";
import { NextRequest } from "next/server";

import { proxy } from "./proxy";

const originalToken = process.env.LLV_TOKEN;
afterEach(() => {
  if (originalToken === undefined) delete process.env.LLV_TOKEN;
  else process.env.LLV_TOKEN = originalToken;
});

function remote(authorization: string): NextRequest {
  return new NextRequest("http://viewer.example/api/agent/snapshot", { headers: { host: "viewer.example", "x-forwarded-for": "203.0.113.10", authorization } });
}

function nonLoopbackIpv4Address(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("the auth exposure regression needs a non-loopback IPv4 interface");
}

async function requestThroughProxy(hostname: string): Promise<{ peerAddress: string; status: number }> {
  let peerAddress = "";
  const server = http.createServer(async (incoming, outgoing) => {
    peerAddress = incoming.socket.remoteAddress ?? "";
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) headers.append(name, entry);
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }
    const response = proxy(new NextRequest(`http://localhost${incoming.url ?? "/"}`, { headers }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("auth exposure regression server did not bind a TCP port");
  }

  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.get({
        hostname,
        port: address.port,
        path: "/api/agent/snapshot",
        headers: {
          host: "localhost",
          "x-forwarded-for": "127.0.0.1",
        },
      }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      request.once("error", reject);
    });
    return { peerAddress, status };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("a configured access token protects loopback and non-loopback peers despite loopback request headers", async () => {
  process.env.LLV_TOKEN = "viewer-token";

  const remoteRequest = await requestThroughProxy(nonLoopbackIpv4Address());
  expect(remoteRequest.peerAddress).not.toMatch(/^(?:127\.|::1$|::ffff:127\.)/);
  expect(remoteRequest.status).toBe(403);

  const localRequest = await requestThroughProxy("127.0.0.1");
  expect(localRequest.peerAddress).toMatch(/^(?:127\.|::1$|::ffff:127\.)/);
  expect(localRequest.status).toBe(403);
});

test("remote agent access accepts the exact Bearer LLV_TOKEN", () => {
  process.env.LLV_TOKEN = "viewer-token";
  expect(proxy(remote("Bearer viewer-token")).headers.get("x-middleware-next")).toBe("1");
  expect(proxy(remote("Bearer wrong-token")).status).toBe(403);
});

test("remote access accepts the existing llv_auth cookie", () => {
  process.env.LLV_TOKEN = "viewer-token";
  const request = new NextRequest("http://viewer.example/api/agent/snapshot", {
    headers: { host: "viewer.example", "x-forwarded-for": "203.0.113.10", cookie: "llv_auth=viewer-token" },
  });

  expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
});

test("only the report frame passes without the cookie; the route checks its signed scope", () => {
  process.env.LLV_TOKEN = "viewer-token";
  const bare = (pathname: string) =>
    new NextRequest(`http://viewer.example${pathname}`, { headers: { host: "viewer.example", "sec-fetch-site": "cross-site" } });
  expect(proxy(bare("/api/artifact/frame/scope/index.html")).headers.get("x-middleware-next")).toBe("1");
  for (const pathname of ["/api/artifact?path=%2Fx.md", "/api/artifact/framed", "/api/artifact/frame", "/api/files"]) {
    expect(proxy(bare(pathname)).status).toBe(403);
  }
});

test("with LLV_TOKEN set, the shared MCP endpoint keeps the token gate every other path has", () => {
  process.env.LLV_TOKEN = "operator-key";
  const bearer = (key: string) => `Bearer ${key}`;
  const mcp = (headers: Record<string, string>) =>
    proxy(new NextRequest("http://127.0.0.1:8898/api/mcp", { method: "POST", headers: { host: "127.0.0.1:8898", ...headers } }));
  const capability = "A".repeat(43);

  /* A capability is identity, not access: without the operator's key a
     request is refused before the route, whatever it presents — which is what
     keeps a tailnet caller with a spoofed loopback Host out. */
  expect(mcp({ "x-llv-spawn-capability": capability }).status).toBe(403);
  expect(mcp({}).status).toBe(403);
  /* The stable local entry supplies the key for loopback callers when it is
     trusted; with it the request reaches the route, which then asks for the
     capability. */
  expect(mcp({ authorization: bearer("operator-key"), "x-llv-spawn-capability": capability }).headers.get("x-middleware-next")).toBe("1");
});
