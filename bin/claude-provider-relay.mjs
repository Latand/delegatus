import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";
import { recordProviderMessageHealth } from "./claude-provider-health.mjs";

/** Private loopback relay. The real credential never enters Claude's process. */
export async function startClaudeProviderRelay(input) {
  if (input.token.length < 8 || Object.values(input.headers).some((value) => typeof value !== "string" || value.length < 8))
    throw new Error("Provider credential is too short for safe redaction");
  const target = new URL(input.baseUrl);
  if (!["https:", "http:"].includes(target.protocol)) throw new Error("Invalid provider relay URL");
  const alias = crypto.randomBytes(32).toString("hex");
  const secrets = [input.token, alias, ...Object.values(input.headers)];
  const variants = [...new Set(secrets.flatMap((secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    return [secret, escaped, secret.replaceAll("/", "\\/"), escaped.replaceAll("/", "\\/")];
  }))];
  const markerChoices = ["[redacted]", "[withheld]", "[hidden]"];
  let marker = markerChoices.find((candidate) => variants.every((secret) => !candidate.includes(secret)));
  while (!marker || variants.some((secret) => marker.includes(secret))) marker = `[${crypto.randomBytes(16).toString("hex")}]`;
  const scrub = (value) => variants.reduce((text, secret) => text.replaceAll(secret, marker), value);
  const scrubString = (value) => {
    const direct = scrub(value);
    const decoded = direct.replace(/\\u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\\//g, "/");
    const clean = scrub(decoded);
    return clean === decoded ? direct : clean;
  };
  const scrubJson = (value) => {
    if (typeof value === "string") return scrubString(value);
    if (Array.isArray(value)) return value.map(scrubJson);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, child]) => [scrubString(name), scrubJson(child)]));
    if (typeof value === "number") return scrub(String(value)) === String(value) ? value : marker;
    return value;
  };
  const server = http.createServer((request, response) => {
    request.socket.on("error", () => { /* one caller disconnected */ });
    response.on("error", () => { /* one response failed */ });
    const supplied = request.headers.authorization === `Bearer ${alias}` || request.headers["x-api-key"] === alias;
    if (!supplied || !request.url?.startsWith("/v1/")) {
      response.writeHead(403).end(); request.resume(); return;
    }
    const rawPath = request.url.split("?", 1)[0];
    if (rawPath.includes("\\") || /%(?:2e|2f|5c)/i.test(rawPath)) {
      response.writeHead(403).end(); request.resume(); return;
    }
    const upstreamRoot = `${target.pathname.replace(/\/$/, "")}/v1/`;
    const upstreamUrl = new URL(`${target.pathname.replace(/\/$/, "")}${request.url}`, target);
    if (upstreamUrl.origin !== target.origin || !upstreamUrl.pathname.startsWith(upstreamRoot)) {
      response.writeHead(403).end(); request.resume(); return;
    }
    const headers = { ...request.headers, ...input.headers,
      host: target.host, authorization: `Bearer ${input.token}`,
      "x-opencode-session": input.sessionId,
      "user-agent": request.headers["user-agent"] || "Delegatus/1.0 claude-provider",
      "accept-encoding": "identity" };
    delete headers["x-api-key"];
    delete headers["content-length"];
    const transport = target.protocol === "https:" ? https : http;
    const upstream = transport.request(upstreamUrl, { method: request.method, headers }, (upstreamResponse) => {
      const messages = rawPath === "/v1/messages" && request.method === "POST";
      const revision = input.credentialRevision;
      const record = (state) => {
        if (!messages || !input.healthHome || !revision) return;
        try { recordProviderMessageHealth(input.healthHome, revision, state); }
        catch { /* health evidence must not change the provider response */ }
      };
      if ((upstreamResponse.statusCode ?? 502) >= 300) {
        upstreamResponse.resume();
        const retryAfter = upstreamResponse.headers["retry-after"];
        const errorType = upstreamResponse.statusCode === 401 || upstreamResponse.statusCode === 403
          ? "authentication_error" : upstreamResponse.statusCode === 429 ? "rate_limit_error" : "provider_error";
        if (errorType === "authentication_error") record("error");
        response.writeHead((upstreamResponse.statusCode ?? 502) >= 400 ? upstreamResponse.statusCode : 502, {
          "content-type": "application/json",
          ...(typeof retryAfter === "string" && /^\d{1,8}$/.test(retryAfter) ? { "retry-after": retryAfter } : {}),
        }).end(JSON.stringify({ error: { type: errorType, message: "Provider request failed" } }));
        return;
      }
      if (upstreamResponse.headers["content-encoding"] && upstreamResponse.headers["content-encoding"] !== "identity") {
        upstreamResponse.resume(); response.writeHead(502).end(); return;
      }
      const contentType = String(upstreamResponse.headers["content-type"] ?? "").toLowerCase();
      if ((upstreamResponse.statusCode ?? 502) >= 200 && (upstreamResponse.statusCode ?? 502) < 300)
        response.once("finish", () => record("authenticated"));
      if (contentType.includes("application/json")) {
        const chunks = [];
        let bytes = 0;
        upstreamResponse.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024) { upstreamResponse.destroy(); response.writeHead(502).end(); return; }
          chunks.push(chunk);
        });
        upstreamResponse.on("end", () => {
          if (response.writableEnded) return;
          try {
            const body = scrubJson(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            response.writeHead(upstreamResponse.statusCode ?? 200, { "content-type": "application/json" }).end(JSON.stringify(body));
          } catch { response.writeHead(502).end(); }
        });
        upstreamResponse.on("error", () => { if (!response.writableEnded) response.writeHead(502).end(); });
        return;
      }
      if (!contentType.includes("text/event-stream")) { upstreamResponse.resume(); response.writeHead(502).end(); return; }
      response.writeHead(upstreamResponse.statusCode ?? 200, { "content-type": "text/event-stream" });
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let eventLines = [];
      const blocks = new Map();
      let bufferedBlockBytes = 0;
      const filter = new Transform({
        transform(chunk, _encoding, callback) {
          pending += decoder.write(chunk);
          if (pending.length > 8 * 1024 * 1024) return callback(new Error("Provider SSE event is oversized"));
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            const line = pending.slice(0, newline).replace(/\r$/, "");
            pending = pending.slice(newline + 1);
            if (line) eventLines.push(line);
            else if (eventLines.length) {
              try {
                const lines = eventLines;
                eventLines = [];
                const data = lines.filter((item) => item.startsWith("data:")).map((item) => item.slice(5).trimStart()).join("\n");
                const emit = (event, body) => {
                  for (const item of event) {
                    if (item.startsWith("data:")) continue;
                    this.push(scrub(item) + "\n");
                  }
                  this.push(`data: ${body === "[DONE]" ? body : JSON.stringify(scrubJson(body))}\n\n`);
                };
                if (!data) {
                  for (const item of lines) this.push(scrub(item) + "\n");
                  this.push("\n");
                } else if (data === "[DONE]") {
                  if (blocks.size) throw new Error("Provider SSE content block is incomplete");
                  emit(lines, data);
                } else {
                  const body = JSON.parse(data);
                  const index = body?.index;
                  if (body?.type === "content_block_start" && Number.isInteger(index)) {
                    if (blocks.has(index)) throw new Error("Provider SSE content block overlaps");
                    blocks.set(index, { start: { lines, body }, deltas: [] });
                  } else if (body?.type === "content_block_delta" && Number.isInteger(index)) {
                    const block = blocks.get(index);
                    if (!block) throw new Error("Provider SSE content delta has no start");
                    const value = body.delta?.type === "text_delta" ? body.delta.text
                      : body.delta?.type === "input_json_delta" ? body.delta.partial_json
                        : body.delta?.type === "thinking_delta" ? body.delta.thinking
                          : body.delta?.type === "signature_delta" ? body.delta.signature : null;
                    if (typeof value !== "string") throw new Error("Provider SSE content delta is invalid");
                    bufferedBlockBytes += Buffer.byteLength(value);
                    if (bufferedBlockBytes > 8 * 1024 * 1024) throw new Error("Provider SSE content block is oversized");
                    block.deltas.push({ lines, body, value });
                  } else if (body?.type === "content_block_stop" && Number.isInteger(index)) {
                    const block = blocks.get(index);
                    if (!block) throw new Error("Provider SSE content stop has no start");
                    blocks.delete(index);
                    bufferedBlockBytes -= block.deltas.reduce((size, delta) => size + Buffer.byteLength(delta.value), 0);
                    const initialText = block.start.body.content_block?.type === "text"
                      ? block.start.body.content_block.text : "";
                    if (typeof initialText !== "string") throw new Error("Provider SSE text block is invalid");
                    const kinds = [...new Set(block.deltas.map((delta) => delta.body.delta.type))];
                    if (kinds.length > 1 && !kinds.every((kind) => kind === "thinking_delta" || kind === "signature_delta"))
                      throw new Error("Provider SSE content delta types differ");
                    if (initialText && kinds.some((kind) => kind !== "text_delta")) throw new Error("Provider SSE text block has incompatible deltas");
                    // Nothing from a content block reaches Claude until all its logical
                    // deltas can be checked as one value, including split tool JSON.
                    emit(block.start.lines, initialText ? { ...block.start.body,
                      content_block: { ...block.start.body.content_block, text: "" } } : block.start.body);
                    for (const kind of kinds.length ? kinds : initialText ? ["text_delta"] : []) {
                      const group = block.deltas.filter((delta) => delta.body.delta.type === kind);
                      const delta = group[0] ?? { lines: ["event: content_block_delta"],
                        body: { type: "content_block_delta", index, delta: { type: "text_delta", text: "" } } };
                      const combined = (kind === "text_delta" ? initialText : "") + group.map((item) => item.value).join("");
                      const safe = kind === "input_json_delta" ? JSON.stringify(scrubJson(JSON.parse(combined))) : scrubString(combined);
                      emit(delta.lines, { ...delta.body, delta: { ...delta.body.delta,
                        [kind === "text_delta" ? "text" : kind === "input_json_delta" ? "partial_json"
                          : kind === "thinking_delta" ? "thinking" : "signature"]: safe } });
                    }
                    emit(lines, body);
                  } else emit(lines, body);
                }
              } catch { return callback(new Error("Provider SSE data is invalid")); }
            }
            newline = pending.indexOf("\n");
          }
          callback();
        },
        flush(callback) {
          const tail = pending + decoder.end();
          if (tail.trim() || eventLines.length || blocks.size) callback(new Error("Provider SSE event is incomplete"));
          else callback();
        },
      });
      filter.on("error", () => { upstreamResponse.destroy(); response.destroy(); });
      upstreamResponse.pipe(filter).pipe(response);
      upstreamResponse.on("error", () => response.destroy());
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502).end(); else response.destroy(); });
    request.on("error", () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider relay has no local port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, alias,
    close() { server.closeAllConnections(); server.close(); } };
}
