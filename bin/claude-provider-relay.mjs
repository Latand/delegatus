import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { recordProviderMessageHealth } from "./claude-provider-health.mjs";

const EVENT_LIMIT = 8 * 1024 * 1024;
const QUEUE_LIMIT = 64;

// Units retain their original spelling and event owner. Only a possible secret
// suffix survives a write; safe prefixes can leave before the block ends.
function secretChannel(secrets, marker, signature = false) {
  const pending = [];
  const release = (units, replacement) => {
    if (!units.length) return;
    if (replacement !== undefined) {
      if (signature) throw new Error("Provider signature contains a credential");
      units[0].parts[0].item.value += replacement;
    } else {
      for (const unit of units) unit.parts[0].item.value += unit.raw;
    }
    for (const unit of units) for (const part of unit.parts) part.item.pending -= part.count;
  };
  const drain = (final) => {
    while (pending.length) {
      const text = pending.map(unit => unit.text).join("");
      const raw = pending.map(unit => unit.raw).join("");
      const matches = secrets.filter(secret => text.startsWith(secret) || raw.startsWith(secret));
      if (!final && secrets.some(secret => secret.startsWith(text) && secret.length > text.length
        || secret.startsWith(raw) && secret.length > raw.length)) break;
      if (matches.length) {
        const length = Math.max(...matches.map(secret => {
          if (text.startsWith(secret)) return secret.length;
          let bytes = 0, units = 0;
          while (bytes < secret.length) bytes += pending[units++].raw.length;
          return units;
        }));
        release(pending.splice(0, length), marker);
      } else if (!final && secrets.some(secret => secret.startsWith(text) || secret.startsWith(raw))) break;
      else release(pending.splice(0, 1));
    }
  };
  return { write(unit) { pending.push(unit); drain(false); }, end() { drain(true); } };
}

// Decode only for comparison. Nonmatching escapes keep their exact wire bytes.
// A second tolerant layer recognizes literal Unicode escapes inside tool strings.
function escapeChannel(next, strict = false) {
  let pending = [];
  const deliver = () => { for (const unit of pending) next.write(unit); pending = []; };
  return {
    write(unit) {
      if (!pending.length && unit.text !== "\\") { next.write(unit); return; }
      pending.push(unit);
      const text = pending.map(part => part.text).join("");
      if (text.length === 1) return;
      if (text[1] === "u" && text.length < 6 && /^[\\]u[\da-f]*$/i.test(text)) return;
      let decoded;
      if (/^\\u[\da-f]{4}$/i.test(text)) decoded = String.fromCharCode(parseInt(text.slice(2), 16));
      else if (text === "\\/") decoded = "/";
      else if (strict && /^\\["\\bfnrt]$/.test(text)) decoded = JSON.parse(`"${text}"`);
      if (decoded !== undefined) {
        next.write({ text: decoded, raw: pending.map(part => part.raw).join(""), parts: pending.flatMap(part => part.parts) });
        pending = [];
      } else {
        if (strict) throw new Error("Provider tool JSON escape is invalid");
        deliver();
      }
    },
    end() {
      if (strict && pending.length) throw new Error("Provider tool JSON escape is incomplete");
      deliver(); next.end();
    },
  };
}

function textChannel(secrets, marker, signature = false) {
  const comparison = escapeChannel(secretChannel(secrets, marker, signature));
  return {
    write(value, item) {
      for (let i = 0; i < value.length; i++) {
        item.pending++;
        comparison.write({ text: value[i], raw: value[i], parts: [{ item, count: 1 }] });
      }
    },
    end() { comparison.end(); },
  };
}

// Incremental JSON grammar for partial_json. Strings stream through the same
// redactor; only one bounded number/literal and the container stack are retained.
function toolChannel(secrets, marker, scrubJson) {
  const stack = [{ kind: "root", state: "value" }];
  let string = null, escaped = false, unicode = 0, key = false, atom = "", atomParts = [];
  const top = () => stack[stack.length - 1];
  const emit = (unit, text = unit.raw) => {
    unit.parts[0].item.value += text;
    for (const part of unit.parts) part.item.pending -= part.count;
  };
  const valueDone = () => {
    const context = top();
    if (!["value", "first"].includes(context.state)) throw new Error("Provider tool JSON value is unexpected");
    context.state = context.kind === "root" ? "done" : "comma";
  };
  const atomDone = () => {
    if (!atom.length) return;
    const raw = atom;
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(raw)) throw new Error("Provider tool JSON value is invalid");
    const value = JSON.parse(raw);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Provider tool JSON number is invalid");
    const safe = secrets.some(secret => raw.includes(secret)) ? marker : scrubJson(value);
    emit({ raw, parts: atomParts }, safe === value ? raw : JSON.stringify(safe));
    atom = ""; atomParts = []; valueDone();
  };
  const appendAtom = (unit) => {
    atom += unit.raw;
    const part = unit.parts[0], last = atomParts[atomParts.length - 1];
    if (last?.item === part.item) last.count += part.count; else atomParts.push({ ...part });
    if (atom.length > EVENT_LIMIT) throw new Error("Provider tool JSON token is oversized");
  };
  const consume = (unit) => {
    const char = unit.text;
    if (string) {
      if (!escaped && !unicode && char === '"') {
        string.end(); string = null; emit(unit);
        if (key) top().state = "colon"; else valueDone();
      } else {
        if (unicode) {
          if (!/[\da-f]/i.test(char)) throw new Error("Provider tool JSON Unicode escape is invalid");
          unicode--;
        } else if (escaped) {
          if (!/["\\/bfnrtu]/.test(char)) throw new Error("Provider tool JSON escape is invalid");
          unicode = char === "u" ? 4 : 0; escaped = false;
        } else if (char === "\\") escaped = true;
        else if (char.charCodeAt(0) < 32) throw new Error("Provider tool JSON string is invalid");
        string.write(unit);
      }
      return;
    }
    if (atom.length) {
      if (/[ \t\r\n,}\]]/.test(char)) atomDone();
      else {
        appendAtom(unit);
        return;
      }
    }
    if (/[ \t\r\n]/.test(char)) { emit(unit); return; }
    const context = top();
    if (char === '"') {
      key = context.kind === "object" && ["key", "first"].includes(context.state);
      if (!key && !["value", "first"].includes(context.state)) throw new Error("Provider tool JSON string is unexpected");
      string = escapeChannel(escapeChannel(secretChannel(secrets, marker)), true);
      emit(unit);
    } else if (char === "{" || char === "[") {
      if (!["value", "first"].includes(context.state) || context.kind === "object" && context.state === "first") throw new Error("Provider tool JSON container is unexpected");
      valueDone(); stack.push({ kind: char === "{" ? "object" : "array", state: "first" });
      if (stack.length > QUEUE_LIMIT) throw new Error("Provider tool JSON nesting is oversized");
      emit(unit);
    } else if (char === "}" || char === "]") {
      if (context.kind !== (char === "}" ? "object" : "array") || !["first", "comma"].includes(context.state)) throw new Error("Provider tool JSON container is invalid");
      stack.pop(); emit(unit);
    } else if (char === ":" && context.kind === "object" && context.state === "colon") {
      context.state = "value"; emit(unit);
    } else if (char === "," && context.state === "comma" && context.kind !== "root") {
      context.state = context.kind === "object" ? "key" : "value"; emit(unit);
    } else if (/[\-\dtfn]/.test(char) && ["value", "first"].includes(context.state) && !(context.kind === "object" && context.state === "first")) appendAtom(unit);
    else throw new Error("Provider tool JSON syntax is invalid");
  };
  return {
    write(value, item) {
      for (let i = 0; i < value.length; i++) { item.pending++; consume({ text: value[i], raw: value[i], parts: [{ item, count: 1 }] }); }
    },
    end() {
      atomDone();
      if (string || stack.length !== 1 || top().state !== "done") throw new Error("Provider tool JSON is incomplete");
    },
  };
}

async function* eventFrames(source) {
  const decoder = new StringDecoder("utf8");
  let pending = "", lines = [], bytes = 0;
  for await (const chunk of source) {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const raw = pending.slice(0, newline + 1); pending = pending.slice(newline + 1);
      bytes += Buffer.byteLength(raw);
      if (bytes > EVENT_LIMIT) throw new Error("Provider SSE event is oversized");
      const line = raw.slice(0, -1).replace(/\r$/, "");
      if (line) lines.push(line);
      else { if (lines.length) yield lines; lines = []; bytes = 0; }
    }
    if (bytes + Buffer.byteLength(pending) > EVENT_LIMIT) throw new Error("Provider SSE event is oversized");
  }
  if ((pending + decoder.end()).trim() || lines.length) throw new Error("Provider SSE event is incomplete");
}

async function* redactEvents(source, secrets, marker, scrubJson, scrubString, messages, validated) {
  const blocks = new Map(), queue = [];
  let queueBytes = 0, started = false, stopped = false, failed = false;
  const add = (lines, body, field) => {
    const metadata = lines.filter(line => !line.startsWith("data:"));
    const bytes = Buffer.byteLength(JSON.stringify(body) ?? "") + metadata.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
    const item = { lines: metadata, body, field, value: "", pending: 0, emitted: false, bytes };
    if (field) item.body.delta[field] = "";
    queue.push(item); queueBytes += bytes;
    if (queue.length > QUEUE_LIMIT || queueBytes > EVENT_LIMIT) throw new Error("Provider SSE pending output is oversized");
    return item;
  };
  const drain = function* () {
    while (queue.length) {
      const item = queue[0];
      if (item.pending && !item.value) break;
      if ((!item.field && !item.emitted) || item.value) {
        const safe = scrubJson(item.body);
        const body = item.field ? { ...safe, delta: { ...safe.delta, [item.field]: item.value } } : safe;
        yield item.lines.map(line => scrubString(line) + "\n").join("")
          + (body === undefined ? "" : `data: ${body === "[DONE]" ? body : JSON.stringify(body)}\n`) + "\n";
        item.emitted = true; item.value = "";
      }
      if (item.pending) break;
      queue.shift(); queueBytes -= item.bytes;
    }
  };
  const fields = { text_delta: "text", thinking_delta: "thinking", signature_delta: "signature", input_json_delta: "partial_json" };
  const channel = (block, kind) => {
    if (!block.channels.has(kind)) block.channels.set(kind, kind === "input_json_delta" ? toolChannel(secrets, marker, scrubJson) : textChannel(secrets, marker, kind === "signature_delta"));
    return block.channels.get(kind);
  };
  for await (const lines of eventFrames(source)) {
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    const body = data ? data === "[DONE]" ? data : JSON.parse(data) : undefined;
    const type = body?.type, index = body?.index;
    if (stopped && type && type !== "ping") throw new Error("Provider SSE continues after message stop");
    if (messages && !started && (type?.startsWith("content_block_") || type === "message_delta" || type === "message_stop"))
      throw new Error("Provider SSE message has no start");
    if (type === "message_start") { if (started) throw new Error("Provider SSE message overlaps"); started = true; }
    if (type === "error") {
      // An upstream error terminates unfinished content. Discard unresolved
      // suffixes so they cannot hide the provider's sanitized diagnostic.
      failed = true; blocks.clear(); queue.length = 0; queueBytes = 0;
    }
    if (type === "content_block_start") {
      if (!Number.isInteger(index) || blocks.has(index) || blocks.size >= QUEUE_LIMIT) throw new Error("Provider SSE content block is invalid");
      const block = { type: body.content_block?.type, channels: new Map() };
      blocks.set(index, block);
      const initialFields = block.type === "text" ? ["text"] : block.type === "thinking" ? ["thinking", "signature"] : [];
      const initial = initialFields.map(field => [field, body.content_block[field] ?? ""]);
      for (const [field, value] of initial) {
        if (typeof value !== "string") throw new Error("Provider SSE initial content is invalid");
        body.content_block[field] = "";
      }
      add(lines, body);
      for (const [field, value] of initial) if (value) {
        const kind = `${field}_delta`;
        const item = add(["event: content_block_delta"], { type: "content_block_delta", index, delta: { type: kind, [field]: "" } }, field);
        channel(block, kind).write(value, item);
      }
    } else if (type === "content_block_delta") {
      const block = blocks.get(index), kind = body.delta?.type, field = fields[kind], value = body.delta?.[field];
      const allowed = block?.type === "text" ? ["text_delta"] : block?.type === "thinking" ? ["thinking_delta", "signature_delta"] : block?.type === "tool_use" ? ["input_json_delta"] : [];
      if (!block || !allowed.includes(kind) || typeof value !== "string") throw new Error("Provider SSE content delta is invalid");
      const item = add(lines, body, field);
      channel(block, kind).write(value, item);
    } else if (type === "content_block_stop") {
      const block = blocks.get(index);
      if (!block) throw new Error("Provider SSE content stop has no start");
      for (const stream of block.channels.values()) stream.end();
      blocks.delete(index); add(lines, body);
    } else {
      if (type === "message_stop" || body === "[DONE]") {
        if (blocks.size) throw new Error("Provider SSE content block is incomplete");
        if (type === "message_stop") stopped = true;
      }
      add(lines, body);
    }
    yield* drain();
  }
  if (blocks.size || queue.length || messages && !failed && (!started || !stopped)) throw new Error("Provider SSE message is incomplete");
  validated(!failed);
}

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
  const active = new Set();
  const server = http.createServer((request, response) => {
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
    let upstreamResponse;
    let filter;
    let successful = false;
    const messages = rawPath === "/v1/messages" && request.method === "POST";
    const record = (state) => {
      if (!messages || !input.healthHome || !input.credentialRevision) return;
      try { recordProviderMessageHealth(input.healthHome, input.credentialRevision, state); }
      catch { /* Health evidence must not change the provider response. */ }
    };
    const cleanup = () => {
      active.delete(cancel);
      request.unpipe(upstream);
      upstream.destroy(); upstreamResponse?.destroy(); filter?.destroy();
    };
    const cancel = () => { cleanup(); response.destroy(); };
    const fail = (message) => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { type: "provider_error", message } }));
      cleanup();
    };
    const readBody = async (source, limit) => {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > limit) throw new Error("oversized");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    const upstream = transport.request(upstreamUrl, { method: request.method, headers }, (source) => {
      upstreamResponse = source;
      void (async () => {
        const status = source.statusCode ?? 502;
        if (status >= 300) {
          const errorType = status === 401 || status === 403 ? "authentication_error"
            : status === 429 ? "rate_limit_error" : "provider_error";
          if (errorType === "authentication_error") record("error");
          let message = "Provider request failed: invalid diagnostic";
          try {
            const raw = await readBody(source, 64 * 1024);
            if (!String(source.headers["content-type"]).toLowerCase().includes("application/json")) {
              message = "Provider request failed: non-JSON diagnostic";
            } else {
              const body = JSON.parse(raw);
              if (typeof body?.error?.message === "string") message = scrubString(body.error.message).slice(0, 2048);
            }
          } catch (error) {
            message = error?.message === "oversized" ? "Provider request failed: oversized diagnostic"
              : "Provider request failed: invalid diagnostic";
          }
          if (response.destroyed) return;
          const retry = source.headers["retry-after"];
          const safeRetry = typeof retry === "string" && retry.length <= 64 && scrubString(retry) === retry
            && (/^\d{1,8}$/.test(retry) || /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry) && Number.isFinite(Date.parse(retry)));
          response.writeHead(status >= 400 ? status : 502, { "content-type": "application/json",
            ...(safeRetry ? { "retry-after": retry } : {}) })
            .end(JSON.stringify({ error: { type: errorType, message } }));
          return;
        }
        if (source.headers["content-encoding"] && source.headers["content-encoding"] !== "identity") {
          fail("Provider response encoding is unsupported"); return;
        }
        const contentType = String(source.headers["content-type"] ?? "").toLowerCase();
        if (contentType.includes("application/json")) {
          const body = scrubJson(JSON.parse(await readBody(source, EVENT_LIMIT)));
          successful = status >= 200 && status < 300 && !body?.error;
          response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
          return;
        }
        if (!contentType.includes("text/event-stream")) { fail("Provider response type is unsupported"); return; }
        response.writeHead(status, { "content-type": "text/event-stream" });
        response.flushHeaders();
        filter = Readable.from(redactEvents(source, variants, marker, scrubJson, scrubString, messages,
          (valid) => { successful = valid; }), { objectMode: false, highWaterMark: 16 * 1024 });
        await pipeline(filter, response);
      })().catch(() => fail("Provider response is invalid or interrupted"));
    });
    active.add(cancel);
    response.once("finish", () => { if (successful) record("authenticated"); cleanup(); });
    response.once("close", cleanup);
    request.once("aborted", cancel);
    request.once("error", cancel);
    upstream.once("error", () => fail("Provider connection failed"));
    request.pipe(upstream);
  });
  server.on("connection", socket => socket.on("error", () => { /* One caller disconnected. */ }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Provider relay has no local port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, alias,
    close() { for (const cancel of active) cancel(); server.closeAllConnections(); server.close(); } };
}
