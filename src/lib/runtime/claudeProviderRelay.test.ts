import { expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import http from "node:http";
import { startClaudeProviderRelay } from "./claudeProviderRelay";

const frame = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
const start = frame({ type: "message_start", message: { id: "msg_fixture", type: "message" } });
const stop = frame({ type: "message_stop" });
const blockStart = (type = "text", index = 0) => frame({ type: "content_block_start", index,
  content_block: { type, ...(type === "text" ? { text: "" } : type === "tool_use" ? { id: "tool_fixture", name: "fixture", input: {} } : { thinking: "", signature: "" }) } });
const blockStop = frame({ type: "content_block_stop", index: 0 });
const delta = (value: string, field = "text") => frame({ type: "content_block_delta", index: 0,
  delta: { type: field === "partial_json" ? "input_json_delta" : `${field}_delta`, [field]: value } });
const events = (output: string) => output.split("\n\n").flatMap(value => {
  const data = value.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
  return data ? [JSON.parse(data)] : [];
});
const content = (output: string, field = "text") => events(output).map(item => item.delta?.[field] ?? "").join("");

test("downstream acknowledgements advance upstream windows across write(false) and drain", async () => {
  const windows = 8, perWindow = 64, size = 64 * 1024;
  let sent = 0, acknowledged = 0, upstreamEnded = false;
  let sendWindow!: () => void;
  let rejectRun!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { rejectRun = reject; });
  let blocked!: () => void;
  const backpressured = new Promise<void>(resolve => { blocked = resolve; });
  let awaitingDrain = false, falseWrites = 0, drains = 0;
  let alias = "";
  const originalWrite = http.ServerResponse.prototype.write;
  type WriteArguments = Parameters<typeof originalWrite>
    | [chunk: unknown, callback?: Parameters<typeof originalWrite>[2]];
  // Observe the real relay response only; leave the producer's writes unchanged.
  const writes = spyOn(http.ServerResponse.prototype, "write").mockImplementation(function (this: http.ServerResponse, ...args: WriteArguments) {
    const downstream = this.req.headers.authorization === `Bearer ${alias}`;
    if (downstream && awaitingDrain) rejectRun(new Error("relay wrote again before downstream drain"));
    const accepted = Reflect.apply(originalWrite, this, args);
    if (downstream && !accepted) {
      awaitingDrain = true; falseWrites++;
      this.once("drain", () => { awaitingDrain = false; drains++; });
      blocked();
    }
    return accepted;
  });
  const upstream = http.createServer((request, response) => {
    request.resume(); response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(start + blockStart());
    sendWindow = () => {
      // Only receipt of the previous window lets the producer advance, including EOF.
      if (sent !== acknowledged * perWindow) { rejectRun(new Error("upstream advanced without acknowledgement")); return; }
      if (acknowledged === windows) { upstreamEnded = true; response.end(blockStop + stop); return; }
      const end = sent + perWindow;
      const pump = () => {
        while (!response.destroyed && sent < end) {
          sent++;
          if (!response.write(delta("z".repeat(size)))) { response.once("drain", pump); return; }
        }
      };
      pump();
    };
    sendWindow();
  });
  let relay: Awaited<ReturnType<typeof startClaudeProviderRelay>> | undefined;
  let client: http.IncomingMessage | undefined, request: http.ClientRequest | undefined;
  const watchdog = setTimeout(() => rejectRun(new Error(`downstream acknowledgement stalled at window ${acknowledged}/${windows} (sent ${sent} frames)`)), 20000);
  try {
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("No fixture port");
    relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${address.port}`, token: "abcdefgh", headers: {}, sessionId: "fixture" });
    alias = relay.alias;
    client = await Promise.race([failure, new Promise<http.IncomingMessage>((resolve, reject) => {
      request = http.request(relay!.baseUrl + "/v1/messages", { method: "POST", headers: { authorization: `Bearer ${alias}` } }, resolve);
      request.once("error", reject); request.end();
    })]);
    client.pause();
    await Promise.race([backpressured, failure]);
    expect(upstreamEnded).toBe(false);
    let pending = "", received = 0, terminal = false;
    client.setEncoding("utf8");
    client.on("data", (chunk: string) => {
      pending += chunk;
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        const [event] = events(pending.slice(0, boundary));
        pending = pending.slice(boundary + 2);
        if (event?.delta?.type === "text_delta") {
          if (!/^z+$/.test(event.delta.text)) { rejectRun(new Error("downstream content changed")); return; }
          received += event.delta.text.length;
          if (received === (acknowledged + 1) * perWindow * size) {
            if (upstreamEnded) { rejectRun(new Error("upstream ended before acknowledgement")); return; }
            acknowledged++;
            sendWindow();
          }
        }
        if (event?.type === "message_stop") terminal = true;
      }
    });
    const finished = new Promise<void>((resolve, reject) => { client!.once("end", resolve); client!.once("error", reject); });
    client.resume();
    await Promise.race([finished, failure]);
    expect(acknowledged).toBe(windows);
    expect(sent).toBe(windows * perWindow);
    expect(received).toBe(windows * perWindow * size);
    expect(terminal).toBe(true); expect(pending).toBe("");
    expect(falseWrites).toBeGreaterThan(0); expect(drains).toBe(falseWrites);
  } finally {
    clearTimeout(watchdog); client?.destroy(); request?.destroy(); relay?.close();
    upstream.closeAllConnections(); upstream.close(); writes.mockRestore();
  }
});

test("UTF-8 network boundaries and multi-line SSE preserve content and metadata", async () => {
  const bytes = Buffer.from(start + blockStart() + 'id: fixture\n: comment\nevent: content_block_delta\ndata: {"type":"content_block_delta",\ndata: "index":0,"delta":{"type":"text_delta","text":"Привіт 😀"}}\n\n' + blockStop + stop);
  const upstream = http.createServer((request, response) => {
    request.resume(); response.writeHead(200, { "content-type": "text/event-stream" });
    let index = 0;
    const next = () => { if (response.destroyed) return; if (index === bytes.length) { response.end(); return; } response.write(bytes.subarray(index, ++index)); setImmediate(next); };
    next();
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${address.port}`, token: "abcdefgh", headers: {}, sessionId: "fixture" });
  try {
    const output = await (await fetch(relay.baseUrl + "/v1/messages", { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } })).text();
    expect(content(output)).toBe("Привіт 😀");
    expect(output).toContain("id: fixture\n: comment\nevent: content_block_delta\n");
  } finally { relay.close(); upstream.closeAllConnections(); upstream.close(); }
});

test("HTTP status, bounded diagnostics and retry information survive without secrets", async () => {
  const token = "abcdefgh";
  let status = 401, body = "", retry = "", contentType = "application/json";
  const foreign: string[] = [];
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) { foreign.push(request.url); return new Response("unexpected"); } });
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body, { status, headers: {
    "content-type": contentType, "retry-after": retry, location: `http://127.0.0.1:${target.port}`, "x-private": token,
  } }) });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  const send = () => fetch(relay.baseUrl + "/v1/messages", { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
  try {
    for (const code of [401, 403, 429, 500, 503, 302]) {
      status = code; body = JSON.stringify({ error: { message: `action required ${token}` } }); retry = code === 429 ? "12" : "Wed, 21 Oct 2026 07:28:00 GMT";
      const response = await send();
      expect(response.status).toBe(code === 302 ? 502 : code);
      expect(response.headers.get("retry-after")).toBe(retry);
      expect(response.headers.has("x-private")).toBe(false);
      expect(await response.json()).toEqual({ error: { type: code === 401 || code === 403 ? "authentication_error" : code === 429 ? "rate_limit_error" : "provider_error", message: "action required [redacted]" } });
    }
    expect(foreign).toEqual([]);
    status = 429; retry = token;
    body = JSON.stringify({ error: { message: "z".repeat(2040) + token } });
    let response = await send();
    expect(response.headers.has("retry-after")).toBe(false);
    let answer = await response.json() as { error: { message: string } };
    expect(answer.error.message.length).toBe(2048); expect(answer.error.message).not.toContain(token);
    for (const value of ["invalid " + token, JSON.stringify({ error: { message: token.repeat(9000) } })]) {
      body = value; response = await send(); answer = await response.json() as typeof answer;
      expect(answer.error.message).toBe(value.startsWith("invalid") ? "Provider request failed: invalid diagnostic" : "Provider request failed: oversized diagnostic");
    }
    contentType = "text/html"; body = token;
    expect((await (await send()).json()).error.message).toBe("Provider request failed: non-JSON diagnostic");
  } finally { relay.close(); upstream.stop(); target.stop(); }
});

for (const mode of ["headers", "delta", "shutdown"] as const) test(`downstream ${mode} cancels its owned upstream`, async () => {
  let closed!: () => void;
  const ended = new Promise<void>(resolve => { closed = resolve; });
  let release!: () => void;
  const upstream = http.createServer((request, response) => {
    request.resume(); response.once("close", closed);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(start + (mode === "headers" ? "" : blockStart() + delta("first content")));
    release = () => response.end(blockStop + stop);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${address.port}`, token: "abcdefgh", headers: {}, sessionId: "fixture" });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await fetch(relay.baseUrl + "/v1/messages", { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const reader = response.body!.getReader();
    await reader.read();
    if (mode === "shutdown") relay.close(); else await reader.cancel();
    await Promise.race([ended, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("upstream stayed open")), 1000); })]);
    release();
  } finally { clearTimeout(timeout); relay.close(); upstream.closeAllConnections(); upstream.close(); }
});

test("connection refusal and partial transport failure stay observable", async () => {
  const upstream = http.createServer((request, response) => {
    request.resume(); response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(start + blockStart() + delta("safe"));
    setImmediate(() => response.destroy());
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${address.port}`, token: "abcdefgh", headers: {}, sessionId: "fixture" });
  const send = async () => (await fetch(relay.baseUrl + "/v1/messages", { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } }));
  try {
    await expect(send().then(response => response.text())).rejects.toThrow();
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    const response = await send();
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toBe("Provider connection failed");
  } finally { relay.close(); upstream.closeAllConnections(); upstream.close(); }
});

async function streamFixture(run: (send: (body: string, path?: string) => Promise<string>) => Promise<void>, token = "abcdefgh", headers: Record<string, string> = {}) {
  let body = "";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body, { headers: { "content-type": "text/event-stream" } }) });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers, sessionId: "fixture" });
  try {
    await run(async (value, path = "/v1/messages") => {
      body = value;
      const response = await fetch(relay.baseUrl + path, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
      if (!response.ok) throw new Error("Relay refused the response");
      return response.text();
    });
  } finally { relay.close(); upstream.stop(); }
}

test("every text and tool escape split preserves safe spelling and redacts reflected credentials", async () => {
  const token = "abcd/efg";
  const escaped = [...token].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  await streamFixture(async send => {
    for (const secret of [token, token.replaceAll("/", "\\/"), escaped]) {
      for (let split = 1; split < secret.length; split++) {
        const output = await send(start + blockStart() + delta(`safe 😀 ${secret.slice(0, split)}`) + delta(`${secret.slice(split)} end`) + blockStop + stop);
        expect(content(output)).toBe("safe 😀 [redacted] end");
        expect(output).not.toContain(token);
      }
    }
    for (const spelling of [token, token.replaceAll("/", "\\/"), escaped, JSON.stringify(escaped).slice(1, -1)]) {
      const json = `{"${spelling}":"${spelling}","safe":"literal \\u0041 \\/ 😀","n":12.50e+2}`;
      for (let split = 1; split < json.length; split++) {
        const output = await send(start + blockStart("tool_use") + delta(json.slice(0, split), "partial_json") + delta(json.slice(split), "partial_json") + blockStop + stop);
        const reconstructed = content(output, "partial_json");
        expect(JSON.parse(reconstructed)).toEqual({ "[redacted]": "[redacted]", safe: "literal A / 😀", n: 1250 });
        expect(reconstructed).toContain('"safe":"literal \\u0041 \\/ 😀","n":12.50e+2');
        expect(output).not.toContain(token);
      }
    }
  }, token);
});

test("a preceding backslash retains every possible credential escape prefix", async () => {
  const token = "abcdefgh";
  const safe = String.raw`safe \\u0041 \\q \\u00zz end`;
  await streamFixture(async send => {
    for (const prefix of ["\\", "\\\\", "\\u00"]) {
      const value = prefix + String.raw`\u0061bcdefgh`;
      for (const field of ["text", "thinking", "partial_json", "signature"]) {
        const kind = field === "text" ? "text" : field === "partial_json" ? "tool_use" : "thinking";
        const input = field === "partial_json" ? JSON.stringify({ value: value + " " + safe }) : value + " " + safe;
        for (let split = 0; split <= input.length; split++) {
          const wire = start + blockStart(kind) + delta(input.slice(0, split), field)
            + delta(input.slice(split), field) + blockStop + stop;
          if (field === "signature") {
            await expect(send(wire)).rejects.toThrow();
          } else {
            const output = content(await send(wire), field);
            if (field === "partial_json") {
              expect(JSON.parse(output)).toEqual({ value: prefix + "[redacted] " + safe });
            } else expect(output).toBe(prefix + "[redacted] " + safe);
            const logical = field === "partial_json" ? JSON.parse(output).value : output;
            expect(logical.replace(/\\u([\da-f]{4})/gi, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16))))
              .not.toContain(token);
          }
        }
      }
    }
    // A harmless signature must preserve all original escape spellings too.
    expect(content(await send(start + blockStart("thinking") + delta(safe, "signature") + blockStop + stop), "signature")).toBe(safe);
  }, token);
});

test("overlapping secret prefixes, markers, numeric tool values and JSON-escaped quotes", async () => {
  await streamFixture(async send => {
    expect(content(await send(start + blockStart() + delta("abcdefgh") + delta("ij tail") + blockStop + stop))).toBe("[redacted] tail");
  }, "abcdefgh", { "x-feature": "abcdefghij" });
  await streamFixture(async send => {
    const output = await send(start + blockStart() + delta("reda") + delta("cted") + blockStop + stop);
    expect(content(output)).toBe("[withheld]");
  }, "redacted");
  await streamFixture(async send => {
    const json = '{"value":12345678,"safe":1}';
    for (let split = 1; split < json.length; split++) {
      expect(JSON.parse(content(await send(start + blockStart("tool_use") + delta(json.slice(0, split), "partial_json") + delta(json.slice(split), "partial_json") + blockStop + stop), "partial_json")))
        .toEqual({ value: "[redacted]", safe: 1 });
    }
  }, "12345678");
  await streamFixture(async send => {
    const wire = start + blockStart("tool_use") + delta('{"n":123456789123456789,"safe":9007199254740993}', "partial_json") + blockStop + stop;
    expect(content(await send(wire), "partial_json")).toBe('{"n":"[redacted]","safe":9007199254740993}');
  }, "123456789123456789");
  const token = 'abcd"efgh';
  await streamFixture(async send => {
    const escaped = JSON.stringify(token).slice(1, -1);
    for (let split = 1; split < escaped.length; split++) {
      expect(content(await send(start + blockStart() + delta(escaped.slice(0, split)) + delta(escaped.slice(split)) + blockStop + stop))).toBe("[redacted]");
    }
  }, token);
});

test("thinking, signature and non-content events retain order and unsafe signatures fail", async () => {
  await streamFixture(async send => {
    const output = await send(start + blockStart("thinking") + delta("abc", "thinking")
      + frame({ type: "ping", detail: "keep" }) + delta("safe signature", "signature") + delta("defgh end", "thinking") + blockStop + stop);
    expect(content(output, "thinking")).toBe("[redacted] end");
    expect(content(output, "signature")).toBe("safe signature");
    const types = events(output).map(item => item.delta?.type ?? item.type);
    expect(types.indexOf("ping")).toBeLessThan(types.indexOf("signature_delta"));
    expect(types.indexOf("signature_delta")).toBeLessThan(types.lastIndexOf("thinking_delta"));
    await expect(send(start + blockStart("thinking") + delta("abcd", "signature") + delta("efgh", "signature") + blockStop + stop)).rejects.toThrow();
  });
});

test("in-band provider errors release sanitized diagnostics after unresolved content", async () => {
  await streamFixture(async send => {
    const output = await send(start + blockStart() + delta("abc")
      + frame({ type: "error", error: { type: "overloaded_error", message: "retry abcdefgh" } }));
    expect(events(output).at(-1)).toEqual({ type: "error", error: { type: "overloaded_error", message: "retry [redacted]" } });
    expect(output).not.toContain("abcdefgh");
    expect(output).not.toContain("message_stop");
  });
});

test("credentials containing literal escape spelling remain protected", async () => {
  const token = "\\u0061bcdefgh";
  await streamFixture(async send => {
    for (let split = 1; split < token.length; split++) {
      expect(content(await send(start + blockStart() + delta(token.slice(0, split)) + delta(token.slice(split)) + blockStop + stop))).toBe("[redacted]");
    }
  }, token);
});

test("blocks larger than the old total cap stream, while malformed and individually oversized inputs fail", async () => {
  await streamFixture(async send => {
    const part = "z".repeat(64 * 1024);
    const output = await send(start + blockStart() + Array.from({ length: 129 }, () => delta(part)).join("") + blockStop + stop);
    expect(content(output).length).toBe(part.length * 129);
    const malformed = [
      start, start + blockStart(), start + blockStart() + delta("safe") + blockStop,
      start + blockStart("tool_use") + delta('{"value":', "partial_json") + blockStop + stop,
      start + blockStart("tool_use") + delta('{"value":1,}', "partial_json") + blockStop + stop,
      start + blockStart("tool_use") + delta('{"value":"\\q"}', "partial_json") + blockStop + stop,
      start + blockStart("tool_use") + delta('{"value":\u00a01}', "partial_json") + blockStop + stop,
      start + Array.from({ length: 65 }, (_, index) => blockStart("text", index)).join(""),
      start + blockStart() + delta("abc") + Array.from({ length: 65 }, () => frame({ type: "ping" })).join(""),
      start + blockStart() + delta("abc") + Array.from({ length: 5 }, () => frame({ type: "ping", padding: "z".repeat(2 * 1024 * 1024) })).join(""),
      start + blockStart("tool_use") + delta('{"n":1', "partial_json") + Array.from({ length: 9 }, () => delta("0".repeat(1024 * 1024), "partial_json")).join(""),
      start + blockStart() + delta("z".repeat(8 * 1024 * 1024)),
      ": " + "z".repeat(8 * 1024 * 1024) + "\n\n",
      Array.from({ length: 130 }, () => ": " + part + "\n").join("") + "\n",
      "data: {}\n",
    ];
    for (const [index, wire] of malformed.entries()) {
      let refused = false;
      try { await send(wire); } catch { refused = true; }
      expect({ index, refused }).toEqual({ index, refused: true });
    }
    expect(await send('data: {"message":"generic"}\n\n', "/v1/events")).toContain("generic");
    expect(content(await send(start + blockStart() + delta("recovered") + blockStop + stop))).toBe("recovered");
  });
});

test("ordinary content reaches the consumer before block stop", async () => {
  const text = "ordinary first delta", safePrefix = text.slice(0, -1);
  for (const aliasByte of [0xaa, 0xff]) for (let split = 0; split <= text.length; split++) for (const bytewise of [false, true]) {
    let written = 0, first = 0, stopped = 0;
    let release!: () => void;
    const completion = new Promise<void>(resolve => { release = resolve; });
    const upstream = http.createServer((request, response) => {
      request.resume(); response.writeHead(200, { "content-type": "text/event-stream" });
      written = performance.now();
      const wire = start + blockStart() + delta(text.slice(0, split)) + delta(text.slice(split));
      void (async () => {
        for (const part of bytewise ? [...wire] : [wire]) {
          if (response.destroyed) return;
          response.write(part);
          if (bytewise) await new Promise<void>(resolve => setImmediate(resolve));
        }
        await completion;
        if (response.destroyed) return;
        stopped = performance.now(); response.end(blockStop + stop);
      })();
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    // Force both the alias that holds the final 'a' and one that releases it.
    const random = spyOn(crypto, "randomBytes").mockImplementation(((size: number) => Buffer.alloc(size, aliasByte)) as typeof crypto.randomBytes);
    let relay: Awaited<ReturnType<typeof startClaudeProviderRelay>>;
    try {
      relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${address.port}`, token: "opaque-provider-8427", headers: {}, sessionId: "fixture" });
    } finally { random.mockRestore(); }
    const abort = new AbortController();
    // Only a deadlock bound: elapsed time never releases upstream completion.
    const timer = setTimeout(() => abort.abort(new Error("No early safe content or stream completion")), 5000);
    try {
      const response = await fetch(relay.baseUrl + "/v1/messages", { method: "POST", headers: { authorization: `Bearer ${relay.alias}` }, signal: abort.signal });
      const reader = response.body!.getReader(), decoder = new TextDecoder();
      let pending = "", reconstructed = "";
      const types: string[] = [];
      try {
        while (true) {
          // Yield the reader independently of network and delta fragmentation.
          await new Promise<void>(resolve => setImmediate(resolve));
          const { done, value } = await reader.read();
          if (done) { pending += decoder.decode(); break; }
          pending += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) >= 0) {
            const complete = pending.slice(0, boundary + 2); pending = pending.slice(boundary + 2);
            for (const event of events(complete)) {
              types.push(event.type);
              reconstructed += event.delta?.text ?? "";
              if (!first && reconstructed.startsWith(safePrefix)) {
                first = performance.now();
                expect(stopped).toBe(0);
                release();
              }
            }
          }
        }
      } finally { reader.releaseLock(); }
      expect(pending).toBe("");
      expect(reconstructed).toBe(text);
      expect(types[0]).toBe("message_start");
      expect(types.slice(-2)).toEqual(["content_block_stop", "message_stop"]);
      expect(first).toBeGreaterThan(written); expect(stopped).toBeGreaterThanOrEqual(first);
      console.info(JSON.stringify({ aliasByte, split, bytewise, written, first, stopped }));
    } finally {
      clearTimeout(timer); release();
      relay.close(); upstream.closeAllConnections(); upstream.close();
    }
  }
});

test("provider relay authenticates only its child and scrubs split credential echoes", async () => {
  const token = "opaque-provider-token-8427";
  const headerValue = "opaque-header-value-8427";
  const observed: Array<{ auth: string | null; header: string | null; session: string | null; agent: string | null }> = [];
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    observed.push({ auth: request.headers.get("authorization"), header: request.headers.get("x-feature"),
      session: request.headers.get("x-opencode-session"), agent: request.headers.get("user-agent") });
    const body = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: {"type":"message_start","message":"denied ${token.slice(0, 10)}`));
        await Bun.sleep(10);
        controller.enqueue(new TextEncoder().encode(`${token.slice(10)} ${headerValue} ordinary text"}\n\ndata: {"type":"message_stop"}\n\n`));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "x-provider-debug": `denied ${token} ${headerValue}` } });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}/zen/go`, token,
    headers: { "x-feature": headerValue }, sessionId: "conversation-fixture" });
  try {
    const denied = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST" });
    expect(denied.status).toBe(403);
    expect(observed).toHaveLength(0);
    for (const unsafePath of ["/v1/../../admin", "/v1/%2e%2e/%2e%2e/admin"]) {
      const url = new URL(relay.baseUrl);
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = http.request({ hostname: url.hostname, port: url.port, path: unsafePath, method: "POST",
          headers: { authorization: `Bearer ${relay.alias}` } }, (response) => { response.resume(); resolve(response.statusCode); });
        request.on("error", reject); request.end();
      });
      expect(status).toBe(403);
    }
    expect(observed).toHaveLength(0);
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: {
      authorization: `Bearer ${relay.alias}`, "user-agent": "claude-cli/fixture",
    } });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(token);
    expect(text).not.toContain(headerValue);
    expect(response.headers.has("x-provider-debug")).toBe(false);
    expect(text).toContain("ordinary text");
    expect(observed).toEqual([{ auth: `Bearer ${token}`, header: headerValue,
      session: "conversation-fixture", agent: "claude-cli/fixture" }]);
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay redacts credentials split across text and tool-input deltas", async () => {
  const token = "opaque-provider-token-8427";
  const header = "opaque-header-value-8427";
  const event = (type: string, body: unknown) => `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
  const sse = [
    event("message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", content: [], model: "fixture", usage: { input_tokens: 1, output_tokens: 1 } } }),
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `before ${token.slice(0, 10)}` } }),
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${token.slice(10)} after` } }),
    event("content_block_stop", { type: "content_block_stop", index: 0 }),
    event("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool_fixture", name: "fixture", input: {} } }),
    event("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: `{"value":"${header.slice(0, 9)}` } }),
    event("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: `${header.slice(9)}"}` } }),
    event("content_block_stop", { type: "content_block_stop", index: 1 }),
    event("message_stop", { type: "message_stop" }),
  ].join("");
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(sse, { headers: { "content-type": "text/event-stream" } }) });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token,
    headers: { "x-feature": header }, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const output = await response.text();
    expect(output).not.toContain(token);
    expect(output).not.toContain(header);
    const events = output.trim().split("\n\n").map((frame) => JSON.parse(frame.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
    expect(events.filter(item => item.type !== "content_block_delta").map(item => item.type)).toEqual([
      "message_start", "content_block_start", "content_block_stop", "content_block_start", "content_block_stop", "message_stop",
    ]);
    expect(events.filter(item => item.delta?.type === "text_delta").map(item => item.delta.text).join("")).toBe("before [redacted] after");
    expect(JSON.parse(events.filter(item => item.delta?.type === "input_json_delta").map(item => item.delta.partial_json).join(""))).toEqual({ value: "[redacted]" });
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay checks initial block text together with later deltas", async () => {
  const token = "opaque-provider-token-8427";
  const frame = (type: string, body: unknown) => `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response([
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: token.slice(0, 10) } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: token.slice(10) } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  ].join(""), { headers: { "content-type": "text/event-stream" } }) });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const frames = (await response.text()).trim().split("\n\n");
    const events = frames.map((value) => JSON.parse(value.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
    expect(events[0].content_block.text).toBe("");
    expect(events[1].delta.text).toBe("[redacted]");
  } finally { relay.close(); upstream.stop(); }
});

for (const aliasByte of [0x11, 0xee]) test(`provider relay preserves thinking and signature deltas in one block (alias ${aliasByte.toString(16)})`, async () => {
  const token = "opaque-provider-token-8427";
  const frame = (type: string, body: unknown) => `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response([
    frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: token.slice(0, 10) } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: token.slice(10) } }),
    frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "safe-signature" } }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
  ].join(""), { headers: { "content-type": "text/event-stream" } }) });
  const random = spyOn(crypto, "randomBytes").mockImplementation(((size: number) => Buffer.alloc(size, aliasByte)) as typeof crypto.randomBytes);
  let relay: Awaited<ReturnType<typeof startClaudeProviderRelay>>;
  try { relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" }); }
  catch (error) { upstream.stop(); throw error; }
  finally { random.mockRestore(); }
  try {
    const response = await fetch(`${relay.baseUrl}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const frames = (await response.text()).trim().split("\n\n");
    const events = frames.map((value) => JSON.parse(value.split("\n").find((line) => line.startsWith("data: "))!.slice(6)));
    expect(events.filter(item => item.type !== "content_block_delta").map(item => item.type)).toEqual(["content_block_start", "content_block_stop"]);
    const deltas = events.filter(item => item.type === "content_block_delta").map(item => item.delta);
    expect(deltas.map(item => item.type).filter((type, index) => index === 0 || type !== deltas[index - 1].type)).toEqual(["thinking_delta", "signature_delta"]);
    expect(deltas.map(item => item.thinking ?? "").join("")).toBe("[redacted]");
    expect(deltas.map(item => item.signature ?? "").join("")).toBe("safe-signature");
    expect(events.every(item => item.index === 0)).toBe(true);
    expect(events[0].type).toBe("content_block_start");
    expect(events.at(-1).type).toBe("content_block_stop");
  } finally { relay.close(); upstream.stop(); }
});

test("provider error prose and headers are withheld before Claude can persist them", async () => {
  const token = "opaque-provider-8427";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(`{"error":{"message":"denied ${token.replaceAll("/", "\\/")}"}}`, {
      status: 401, headers: { "content-type": "application/json", "x-provider-debug": token },
    });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const body = await response.text();
    expect(response.status).toBe(401);
    expect(body).not.toContain(token);
    expect(JSON.parse(body).error.message).toBe("denied [redacted]");
    expect(response.headers.has("x-provider-debug")).toBe(false);
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay refuses credential values too short for safe response redaction", async () => {
  await expect(startClaudeProviderRelay({ baseUrl: "http://127.0.0.1:9876", token: "long-token-8427",
    headers: { "x-feature": "1" }, sessionId: "fixture" })).rejects.toThrow("too short");
});

test("provider relay does not rescrub its own marker when a credential spells redacted", async () => {
  const token = "redacted";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ message: token, usage: 10 });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token,
    headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const answer = await response.json() as { message: string; usage: number };
    expect(answer.usage).toBe(10);
    expect(answer.message).not.toContain(token);
    expect(answer.message).toContain("withheld");
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay removes a slash-escaped credential from JSON", async () => {
  const token = "abcde123/";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response('{"message":"abcde123\\/","usage":10}', { headers: { "content-type": "application/json" } });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const body = await response.json() as { message: string; usage: number };
    expect(body.usage).toBe(10);
    expect(body.message).not.toContain(token);
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay removes per-character Unicode escaped credentials from JSON", async () => {
  const token = "opaque-provider-8427";
  const encoded = [...token].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(`{"message":"${encoded}","usage":10}`, { headers: { "content-type": "application/json" } });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const body = await response.json() as { message: string; usage: number };
    expect(body.usage).toBe(10);
    expect(body.message).not.toContain(token);
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay removes raw and literal Unicode-escaped copies in one field", async () => {
  const token = "opaque-provider-8427";
  const encoded = [...token].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ message: `${token} and ${encoded}`, usage: 10 });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const body = await response.json() as { message: string; usage: number };
    expect(body.usage).toBe(10);
    expect(body.message).not.toContain(token);
    expect(body.message).not.toContain(encoded);
  } finally { relay.close(); upstream.stop(); }
});

test("malformed provider SSE closes its connection without stopping the relay", async () => {
  let malformed = true;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(malformed ? "data: invalid-json\n\n" : "data: {\"message\":\"ok\"}\n\n",
      { headers: { "content-type": "text/event-stream" } });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token: "opaque-provider-8427",
    headers: {}, sessionId: "fixture" });
  try {
    await fetch(`${relay.baseUrl}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } })
      .then((response) => response.text()).catch(() => "");
    malformed = false;
    const response = await fetch(`${relay.baseUrl}/v1/events`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    expect(await response.text()).toContain("ok");
  } finally { relay.close(); upstream.stop(); }
});

test("provider relay withholds a numeric credential echoed as a JSON number", async () => {
  const token = "12345678";
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return Response.json({ usage: 12345678, safe: 10 });
  } });
  const relay = await startClaudeProviderRelay({ baseUrl: `http://127.0.0.1:${upstream.port}`, token, headers: {}, sessionId: "fixture" });
  try {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, { method: "POST", headers: { authorization: `Bearer ${relay.alias}` } });
    const body = await response.json() as { usage: unknown; safe: number };
    expect(body.usage).not.toBe(12345678);
    expect(body.safe).toBe(10);
  } finally { relay.close(); upstream.stop(); }
});
