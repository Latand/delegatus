import { expect, test } from "bun:test";
import http from "node:http";
import { once } from "node:events";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { documentBasename, prepareInboundMedia, validateMediaInput, validatePdfStructure, writeInboundAgentInput } from "./mediaInput";
import { requestSchema, type ExternalRelayRequest } from "./protocol";
import { richRequest } from "./rich.fixture";
import { ExternalRelayError, relayDownloadMedia } from "./client";
import { admittedSeedMedia, RELAY_MEDIA_ANY_DOCUMENT, type InputMedia } from "./mediaInputValidation";
const MiB = 1024 * 1024;
const ref = (id = "media_a", size = 5) => ({ ref: id, kind: "document" as const, availability: "ready" as const, mime_type: "text/plain", byte_size: size, filename: "input.txt", expires_at: "2099-01-01T00:00:00Z" });
function request(items: InputMedia[] = [ref()]): ExternalRelayRequest {
  const r = richRequest();
  r.features = ["relay_rich_messages", "relay_media_in", "requester_context"];
  r.input.conversation = [{ id: "message", author: { key: "person", name: "Person", self: false }, sent_at: "2026-10-17T12:00:00Z", text: "Read this", reply_to: null, media: items }];
  r.input.respond_to = "message";
  return r;
}
function documentRequest(items: InputMedia[] = [ref()]) {
  const r = request(items); r.features!.push(RELAY_MEDIA_ANY_DOCUMENT); return r;
}
function refuses(fn: () => unknown, code: string, status: number) {
  try { fn(); throw new Error("accepted hostile input"); }
  catch (error) { expect(error).toBeInstanceOf(ExternalRelayError); expect(error).toMatchObject({ code, status }); }
}
test("media metadata and extracted documents survive negotiated parsing only", () => {
  const r = request();
  r.input.documents = [{ title: "Document", text: "Extracted", message_id: "message", media_ref: "media_a", extraction: "complete" }];
  expect(requestSchema.parse(r)).toEqual(r);
  const legacy = requestSchema.parse({ ...r, features: undefined });
  expect(legacy.input.conversation[0]).not.toHaveProperty("media");
  expect(legacy.input.documents[0]).toEqual({ title: "Document", text: "Extracted" });
});
test("all inbound metadata limits fail closed with exact errors", () => {
  validateMediaInput(request(Array.from({ length: 4 }, (_, i) => ref(`media_${i}`, 10 * MiB))));
  refuses(() => validateMediaInput(request(Array.from({ length: 5 }, (_, i) => ref(`media_${i}`)))), "too_large", 413);
  refuses(() => validateMediaInput(request([ref("media_a", 20 * MiB + 1)])), "too_large", 413);
  refuses(() => validateMediaInput(request([ref("media_a", 20 * MiB), ref("media_b", 20 * MiB), ref("media_c", 1)])), "too_large", 413);
  for (const changed of [{ ref: "../secret" }, { ref: "https://example.com/x" }, { filename: "../secret" }, { filename: "a\\secret" }, { filename: "a\u0000b" }, { byte_size: 0 }, { byte_size: undefined }, { mime_type: undefined }, { expires_at: undefined }, { expires_at: "bad" }]) {
    const r = request(); Object.assign(r.input.conversation[0]!.media![0]!, changed);
    refuses(() => validateMediaInput(r), "malformed", 400);
    expect(requestSchema.safeParse(r).success).toBe(false);
  }
  const badType = request(); badType.input.conversation[0]!.media![0]!.mime_type = "image/svg+xml";
  refuses(() => validateMediaInput(badType), "unsupported_media_type", 415);
  const foreign = request(); foreign.input.respond_to = "missing";
  refuses(() => validateMediaInput(foreign), "malformed", 400);
  const noContext = request(); noContext.features = ["relay_media_in"];
  refuses(() => validateMediaInput(noContext), "malformed", 400);
  const docs = request();
  for (const changed of [{ text: "x".repeat(16001) }, { media_ref: "foreign" }, { message_id: "foreign" }, { extraction: undefined }]) {
    docs.input.documents = [{ title: "x", text: "text", media_ref: "media_a", message_id: "message", extraction: "complete", ...changed }] as ExternalRelayRequest["input"]["documents"];
    refuses(() => validateMediaInput(docs), "malformed", 400);
  }
  docs.input.documents = Array.from({ length: 3 }, () => ({ title: "x", text: "x".repeat(16000), media_ref: "media_a", message_id: "message", extraction: "complete" }));
  refuses(() => validateMediaInput(docs), "too_large", 413);
});
async function fixture(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-input-test-"));
  const server = http.createServer((req, res) => { req.socket.on("error", () => {}); void Promise.resolve(handler(req, res)).catch(() => res.destroy()); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  return { directory, relay: { api_base: `http://127.0.0.1:${address.port}/api/relay/v1`, credential: "fixture-credential" },
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); } };
}
const options = () => ({ signal: new AbortController().signal, deadlineAt: Date.parse("2099-01-01T00:00:00Z"), authorize: () => {} });

test.each([
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "budget.xlsx"],
  ["application/octet-stream", "original.bin"],
  ["Application/Octet-Stream", "mixed-case.bin"],
  ["application/octet-stream; format=opaque", "parameters.bin"],
  ["text/html", "page.html"],
  ["image/svg+xml", "drawing.svg"],
])("%s documents download as opaque bytes only with the any-document feature", async (mime, filename) => {
  // Includes binary, markup and executable signatures: none is parsed or run.
  const bytes = Buffer.from([80, 75, 0, 255, ...Buffer.from("<svg/>MZ")]);
  const media = { ...ref("media_a", bytes.length), mime_type: mime, filename };
  let calls = 0;
  const r = documentRequest([media]);
  r.input.documents = [{ title: filename, text: "", message_id: "message", media_ref: media.ref, extraction: "unavailable" }];
  const f = await fixture((req, res) => {
    calls++; expect(req.headers["delegatus-relay-lease"]).toBe(r.lease_id);
    res.writeHead(200, { "content-type": mime, "content-length": bytes.length }); res.end(bytes);
  });
  try {
    expect(requestSchema.parse(r)).toEqual(r);
    const result = await prepareInboundMedia(f.relay, r, f.directory, options());
    expect(result.files).toHaveLength(1); const file = result.files[0]!;
    expect(path.basename(file.path)).toBe(filename);
    expect(await fs.readFile(file.path)).toEqual(bytes);
    expect((await fs.stat(file.path)).mode & 0o777).toBe(0o600);
    const projected = JSON.parse(result.prompt.split("<inbound_media>\n")[1]!.split("\n</inbound_media>")[0]!);
    expect(projected[0]).toMatchObject({ filename, mime_type: mime, byte_size: bytes.length, local_path: file.path });
    expect(await writeInboundAgentInput(result.files, result.prompt, f.directory, options().signal, () => {})).toBeUndefined();
    expect(admittedSeedMedia(r, { seed_media_refs: [media.ref] })).toBe(false);
    await result.dispose(); expect(await fs.readdir(f.directory)).toEqual([]);
    await expect(prepareInboundMedia(f.relay, request([media]), f.directory, options()))
      .rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
    expect(requestSchema.safeParse(request([media])).success).toBe(false);
    expect(calls).toBe(1);
  } finally { await f.close(); }
});

test("any-document filenames reject traversal and controls before any download", async () => {
  let calls = 0;
  const f = await fixture((_req, res) => { calls++; res.end(); });
  try {
    for (const filename of ["../escape.xlsx", "a/b", "a\\b", ".", "..", "", "a\u0000b", "a\nb", "a\u0085b", "x".repeat(129)]) {
      const r = documentRequest([{ ...ref(), filename, mime_type: "application/octet-stream" }]);
      await expect(prepareInboundMedia(f.relay, r, f.directory, options())).rejects.toMatchObject({ code: "malformed", status: 400 });
      expect(requestSchema.safeParse(r).success).toBe(false);
    }
    expect(calls).toBe(0); expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});

test("original filenames survive with deterministic collisions that reserve later original names", async () => {
  const names = ["Звіт.xlsx", "Звіт.xlsx", "Звіт (2).xlsx", "звіт.xlsx"];
  const f = await fixture((req, res) => { res.writeHead(200, { "content-type": "application/octet-stream", "content-length": 5 }); res.end(`data${req.url!.slice(-1)}`); });
  try {
    const r = documentRequest(names.map((filename, index) => ({ ...ref(`media_${index}`), filename, mime_type: "application/octet-stream" })));
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await prepareInboundMedia(f.relay, r, f.directory, options());
      expect(result.files.map(file => path.basename(file.path))).toEqual(["Звіт.xlsx", "Звіт (3).xlsx", "Звіт (2).xlsx", "звіт (4).xlsx"]);
      for (const file of result.files) expect(await fs.readFile(file.path, "utf8")).toBe(`data${file.ref.slice(-1)}`);
      expect(result.files.every(file => path.dirname(file.path) === path.dirname(result.files[0]!.path))).toBe(true);
      await result.dispose(); expect(await fs.readdir(f.directory)).toEqual([]);
    }
  } finally { await f.close(); }
});

test("filesystem-restricted and long Unicode filenames retain their original prompt metadata", async () => {
  const names = ["CON.txt", "part:one?.bin", "😀".repeat(123) + ".xlsx", "report. "];
  const f = await fixture((_req, res) => { res.writeHead(200, { "content-type": "application/octet-stream", "content-length": 5 }); res.end("hello"); });
  try {
    const result = await prepareInboundMedia(f.relay, documentRequest(names.map((filename, index) => ({ ...ref(`media_${index}`), filename, mime_type: "application/octet-stream" }))), f.directory, options());
    expect(result.files.map(file => path.basename(file.path))).toEqual(process.platform === "win32"
      ? ["_CON.txt", "part_one_.bin", "😀".repeat(62) + ".xlsx", "report_"]
      : ["CON.txt", "part:one?.bin", "😀".repeat(62) + ".xlsx", "report. "]);
    for (const file of result.files) expect(Buffer.byteLength(path.basename(file.path))).toBeLessThanOrEqual(255);
    const projected = JSON.parse(result.prompt.split("<inbound_media>\n")[1]!.split("\n</inbound_media>")[0]!);
    expect(projected.map((media: InputMedia) => media.filename)).toEqual(names);
    await result.dispose();
  } finally { await f.close(); }
});

test("Windows device names and unsafe characters are sanitized on every host platform", () => {
  for (const name of ["CON.txt", "NUL .txt", "COM¹.xlsx", "LPT².bin", "CONIN$", "CONOUT$"]) {
    expect(documentBasename(name, "win32")).toBe(`_${name}`);
    expect(documentBasename(name, "linux")).toBe(name);
  }
  expect(documentBasename("report:part?.xlsx", "win32")).toBe("report_part_.xlsx");
  expect(documentBasename("report. ", "win32")).toBe("report_");
});

test("any-document feature preserves metadata limits, photo restrictions and unavailable extraction", () => {
  const binary = (id: string, size: number) => ({ ...ref(id, size), mime_type: "application/octet-stream" });
  validateMediaInput(documentRequest([binary("a", 20 * MiB), binary("b", 20 * MiB)]));
  for (const items of [[binary("a", 20 * MiB + 1)], [binary("a", 20 * MiB), binary("b", 20 * MiB), binary("c", 1)], Array.from({ length: 5 }, (_, i) => binary(`m_${i}`, 1))]) {
    refuses(() => validateMediaInput(documentRequest(items)), "too_large", 413);
  }
  for (const mime_type of ["application/octet-stream", "image/svg+xml", "application/pdf", "text/plain"]) {
    const r = documentRequest([{ ...ref(), kind: "photo", mime_type }]);
    refuses(() => validateMediaInput(r), "unsupported_media_type", 415);
    expect(requestSchema.safeParse(r).success).toBe(false);
  }
  const r = documentRequest([binary("a", 5)]);
  r.input.documents = [{ title: "Extracted", text: "untrusted", message_id: "message", media_ref: "a", extraction: "complete" }];
  refuses(() => validateMediaInput(r), "malformed", 400);
  expect(requestSchema.safeParse(r).success).toBe(false);
});
function validPdf() {
  const parts = ["%PDF-1.4\n"];
  const offsets = [0];
  for (const object of [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n",
  ]) { offsets.push(Buffer.byteLength(parts.join(""))); parts.push(object); }
  const xref = Buffer.byteLength(parts.join(""));
  parts.push(`xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.from(parts.join(""));
}
test.each([false, true])("original download is authenticated, lease scoped and stored privately (any-document=%s)", async enabled => {
  const r = request(); let calls = 0;
  if (enabled) r.features!.push(RELAY_MEDIA_ANY_DOCUMENT);
  const f = await fixture((req, res) => {
    calls++; expect(req.url).toBe(`/api/relay/v1/requests/${r.request_id}/media/media_a`);
    expect(req.headers.authorization).toBe("Bearer fixture-credential");
    expect(req.headers["delegatus-relay-lease"]).toBe(r.lease_id);
    expect(req.headers["delegatus-relay-version"]).toBe("1");
    res.writeHead(200, { "content-type": "text/plain", "content-length": 5, "cache-control": "no-store", "content-disposition": "attachment; filename=../../outside.txt" }); res.end("hello");
  });
  try {
    const result = await prepareInboundMedia(f.relay, r, f.directory, options());
    expect(calls).toBe(1); expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(path.basename(file.path)).toBe(enabled ? "input.txt" : "0.txt");
    expect(await fs.readFile(file.path, "utf8")).toBe("hello");
    expect(path.relative(f.directory, file.path).startsWith("..")).toBe(false);
    expect((await fs.stat(file.path)).mode & 0o777).toBe(0o600);
    expect(result.prompt).toContain("media_a"); expect(result.prompt).toContain(file.path);
    expect(JSON.stringify(r)).not.toContain(f.directory);
    await result.dispose(); expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});
test.each([false, true])("PDF structure is validated and malformed originals removed (any-document=%s)", async enabled => {
  const valid = validPdf();
  for (const [bytes, accepted] of [
    [valid, true],
    [Buffer.from("%PDF-1.7\n<script>hostile</script>\n%%EOF\n"), false],
    [valid.subarray(0, valid.length - 40), false],
  ] as const) {
    const r = request([ref("media_a", bytes.length)]);
    if (enabled) r.features!.push(RELAY_MEDIA_ANY_DOCUMENT);
    r.input.conversation[0]!.media![0]!.mime_type = enabled ? "Application/PDF" : "application/pdf";
    r.input.conversation[0]!.media![0]!.filename = "input.pdf";
    const f = await fixture((_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf", "content-length": bytes.length }); res.end(bytes);
    });
    try {
      if (accepted) {
        const result = await prepareInboundMedia(f.relay, r, f.directory, options());
        expect(result.files).toHaveLength(1); await result.dispose();
      } else {
        await expect(prepareInboundMedia(f.relay, r, f.directory, options())).rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
        expect(await fs.readdir(f.directory)).toEqual([]);
      }
    } finally { await f.close(); }
  }
});
test.each([false, true])("JPEG and PNG content validation remains enforced (any-document=%s)", async enabled => {
  const sharp = (await import("sharp")).default;
  for (const mime of ["image/png", "image/jpeg"] as const) {
    const image = sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } });
    const valid = await (mime === "image/png" ? image.png() : image.jpeg()).toBuffer();
    for (const [bytes, accepted] of [[valid, true], [valid.subarray(0, 16), false], [Buffer.from("<svg/>"), false]] as const) {
      const r = request([{ ...ref("media_a", bytes.length), mime_type: enabled ? mime.toUpperCase() : mime }]);
      if (enabled) r.features!.push(RELAY_MEDIA_ANY_DOCUMENT);
      const f = await fixture((_req, res) => { res.writeHead(200, { "content-type": mime, "content-length": bytes.length }); res.end(bytes); });
      try {
        if (accepted) { const result = await prepareInboundMedia(f.relay, r, f.directory, options()); expect(result.files).toHaveLength(1); await result.dispose(); }
        else await expect(prepareInboundMedia(f.relay, r, f.directory, options())).rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
        expect(await fs.readdir(f.directory)).toEqual([]);
      } finally { await f.close(); }
    }
  }
});
test("PDF parsing runs in an owned bounded process and abort terminates it after its start handshake", async () => {
  const f = await fs.mkdtemp(path.join(os.tmpdir(), "relay-pdf-worker-"));
  const filename = path.join(f, "valid.pdf"); await fs.writeFile(filename, validPdf());
  try {
    const workerThreadId = await validatePdfStructure(filename, new AbortController().signal, () => {});
    expect(workerThreadId).not.toBe(process.pid);
    const controller = new AbortController(); let started: number | undefined;
    const pending = validatePdfStructure(filename, controller.signal, () => {}, {
      timeoutMs: 2_000,
      workerStarted: workerId => { started = workerId; controller.abort(new DOMException("fixture cancellation", "AbortError")); },
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBeTypeOf("number"); expect(started).not.toBe(process.pid);
  } finally { await fs.rm(f, { recursive: true, force: true }); }
});
test("PDF memory exhaustion kills only the bounded parser process and removes all originals", async () => {
  if (process.platform !== "linux") return;
  const r = request([ref("media_first", 5), ref("media_bomb", validPdf().length)]);
  r.input.conversation[0]!.media![1]!.mime_type = "application/pdf";
  r.input.conversation[0]!.media![1]!.filename = "input.pdf";
  const f = await fixture((req, res) => {
    const bytes = req.url?.endsWith("media_first") ? Buffer.from("first") : validPdf();
    res.writeHead(200, { "content-type": req.url?.endsWith("media_first") ? "text/plain" : "application/pdf", "content-length": bytes.length });
    res.end(bytes);
  });
  const parentPid = process.pid;
  try {
    await expect(prepareInboundMedia(f.relay, r, f.directory, {
      ...options(), pdfValidation: { workerEntry: path.join(import.meta.dir, "pdfMemoryBomb.fixture.ts"), memoryLimitMb: 96 },
    })).rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
    expect(process.pid).toBe(parentPid);
    expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});
test.each([false, true])("stream accepts exact file and total limits without accumulating original buffers (any-document=%s)", async enabled => {
  const r = request([ref("media_a", 20 * MiB), ref("media_b", 20 * MiB)]);
  const mime = enabled ? "application/octet-stream" : "text/plain";
  if (enabled) { r.features!.push(RELAY_MEDIA_ANY_DOCUMENT); for (const media of r.input.conversation[0]!.media!) media.mime_type = mime; }
  const f = await fixture(async (_req, res) => {
    res.writeHead(200, { "content-type": mime, "content-length": 20 * MiB });
    const chunk = Buffer.alloc(65536, 120);
    for (let i = 0; i < 320; i++) if (!res.write(chunk)) await once(res, "drain");
    res.end();
  });
  try { const result = await prepareInboundMedia(f.relay, r, f.directory, options()); expect(result.files).toHaveLength(2); await result.dispose(); }
  finally { await f.close(); }
});
test("stream byte budgets reset after restarting the real downloader process", async () => {
  let downloads = 0;
  const f = await fixture(async (_req, res) => {
    downloads++;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": 20 * MiB });
    const chunk = Buffer.alloc(65536, 120);
    for (let i = 0; i < 320; i++) if (!res.write(chunk)) await once(res, "drain");
    res.end();
  });
  const script = `import { prepareInboundMedia } from "./src/lib/externalRelay/mediaInput.ts";
    const input = JSON.parse(await Bun.stdin.text());
    const result = await prepareInboundMedia(input.relay, input.request, input.directory, {
      signal: new AbortController().signal, deadlineAt: Date.parse("2099-01-01T00:00:00Z"), authorize: () => {},
    });
    console.log(result.files.length); await result.dispose();`;
  try {
    for (let pass = 0; pass < 2; pass++) {
      const sandbox = path.join(f.directory, `process-${pass}`);
      for (const name of ["home", "config", "state", "tmp"]) await fs.mkdir(path.join(sandbox, name), { recursive: true });
      const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env,
        HOME: path.join(sandbox, "home"), XDG_CONFIG_HOME: path.join(sandbox, "config"), LLV_STATE_DIR: path.join(sandbox, "state"), TMPDIR: path.join(sandbox, "tmp"), LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
      }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      child.stdin.write(JSON.stringify({ relay: f.relay, request: documentRequest([ref("media_a", 20 * MiB), ref("media_b", 20 * MiB)].map(media => ({ ...media, mime_type: "application/octet-stream" }))), directory: f.directory }));
      child.stdin.end();
      const [output, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ status, errors }).toEqual({ status: 0, errors: "" });
      expect(output.trim()).toBe("2");
      expect((await fs.readdir(f.directory)).some(name => name.startsWith("media-"))).toBe(false);
    }
    expect(downloads).toBe(4);
  } finally { await f.close(); }
});
test.each([false, true])("hostile responses preserve errors and delete every partial file (any-document=%s)", async enabled => {
  for (const mode of ["redirect", "missing_length", "oversize", "short", "mime", "html", "revoked", "interrupted", "expired"] as const) {
    const r = request(); const auth = options(); let revoked = false;
    if (enabled) r.features!.push(RELAY_MEDIA_ANY_DOCUMENT);
    auth.authorize = () => { if (revoked) throw new ExternalRelayError("lease_lost", 409); };
    if (mode === "expired") r.input.conversation[0]!.media![0]!.expires_at = "2000-01-01T00:00:00Z";
    const f = await fixture((_req, res) => {
      if (mode === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/" }); res.end(); return; }
      if (mode === "revoked") revoked = true;
      const content = mode === "html" ? "<svg>" : "hello";
      res.writeHead(200, { "content-type": mode === "mime" ? "image/svg+xml" : "text/plain", ...(mode === "missing_length" ? {} : { "content-length": mode === "oversize" ? 20 * MiB + 1 : 5 }) });
      if (mode === "interrupted") { res.write("he"); res.destroy(); } else res.end(mode === "short" ? "he" : content);
    });
    try {
      const code = mode === "revoked" ? "lease_lost" : mode === "expired" ? "media_unavailable" : mode === "mime" || mode === "html" ? "unsupported_media_type" : mode === "oversize" ? "too_large" : "malformed";
      const status = mode === "redirect" ? 302 : mode === "revoked" ? 409 : mode === "expired" ? 422 : mode === "mime" || mode === "html" ? 415 : mode === "oversize" ? 413 : 400;
      await expect(prepareInboundMedia(f.relay, r, f.directory, auth)).rejects.toMatchObject({ code, status });
      expect(await fs.readdir(f.directory)).toEqual([]);
    } finally { await f.close(); }
  }
});
test("HTML tags beyond the common tag set are refused across stream chunk boundaries", async () => {
  for (const body of ["<h1>Injected</h1>", "<textarea>Injected</textarea>"]) {
    const r = request([ref("media_first", 2), ref("media_a", Buffer.byteLength(body))]);
    const f = await fixture((req, res) => {
      if (req.url?.endsWith("media_first")) {
        res.writeHead(200, { "content-type": "text/plain", "content-length": 2 }); res.end("ok"); return;
      }
      res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
      res.write(body.slice(0, 2)); res.end(body.slice(2));
    });
    try {
      await expect(prepareInboundMedia(f.relay, r, f.directory, options())).rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
      expect(await fs.readdir(f.directory)).toEqual([]);
    } finally { await f.close(); }
  }
});
test("unfinished long HTML tag names remain rejected across a confirmed file-write boundary", async () => {
  const prefix = `<x-${"a".repeat(100)}`;
  const r = request([ref("media_first", 2), ref("media_a", Buffer.byteLength(prefix) + 5)]);
  let allowClose!: () => void;
  const closeAllowed = new Promise<void>(resolve => { allowClose = resolve; });
  let prefixSent!: () => void;
  const prefixReady = new Promise<void>(resolve => { prefixSent = resolve; });
  const f = await fixture(async (req, res) => {
    if (req.url?.endsWith("media_first")) { res.writeHead(200, { "content-type": "text/plain", "content-length": 2 }); res.end("ok"); return; }
    res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(prefix) + 5 });
    res.write(prefix); prefixSent(); await closeAllowed; res.end(">body");
  });
  try {
    const pending = prepareInboundMedia(f.relay, r, f.directory, options());
    await prefixReady;
    const mediaDir = path.join(f.directory, (await fs.readdir(f.directory))[0]!);
    const partialPath = path.join(mediaDir, "1.txt");
    const watcher = watch(mediaDir);
    try {
      await new Promise<void>((resolve, reject) => {
        const onChange = async () => {
          try { if ((await fs.stat(partialPath)).size >= Buffer.byteLength(prefix)) { watcher.close(); resolve(); } }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reject(error); }
        };
        watcher.on("change", onChange); watcher.on("error", reject); void onChange();
      });
    } finally { watcher.close(); }
    allowClose();
    await expect(pending).rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
    expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { allowClose(); await f.close(); }
});
test("ordinary inbound text formats remain accepted", async () => {
  for (const [mime, body] of [["text/plain", "hello"], ["text/markdown", "# heading"], ["text/csv", "a,b\n1,2"], ["application/json", "{\"ok\":true}"]] as const) {
    const r = request([ref("media_a", Buffer.byteLength(body))]);
    r.input.conversation[0]!.media![0]!.mime_type = mime;
    const f = await fixture((_req, res) => {
      res.writeHead(200, { "content-type": mime, "content-length": Buffer.byteLength(body) }); res.end(body);
    });
    try { const result = await prepareInboundMedia(f.relay, r, f.directory, options()); expect(result.files).toHaveLength(1); await result.dispose(); }
    finally { await f.close(); }
  }
});
test.each(["revoked", "aborted"] as const)("%s during an active stream removes the partial file and earlier originals", async mode => {
  const r = request([ref("media_first", 5), ref("media_second", 20 * MiB)]);
  const controller = new AbortController();
  let signalChunk!: () => void, releaseServer!: () => void;
  const chunkSeen = new Promise<void>(resolve => { signalChunk = resolve; });
  const allowMore = new Promise<void>(resolve => { releaseServer = resolve; });
  const auth = { ...options(), signal: controller.signal, authorize: () => {} };
  let bytesSent = 0, activeChecksAfterRevocation = 0;
  const f = await fixture(async (req, res) => {
    const refId = req.url?.split("/").pop();
    if (refId === "media_first") { res.writeHead(200, { "content-type": "text/plain", "content-length": 5 }); res.end("first"); return; }
    res.writeHead(200, { "content-type": "text/plain", "content-length": 20 * MiB });
    const chunk = Buffer.alloc(65536, 120);
    res.write(chunk); bytesSent += chunk.length;
    signalChunk();
    await allowMore;
    for (let i = 1; i < 320 && !res.destroyed; i++) {
      const writable = res.write(chunk); bytesSent += chunk.length;
      if (!writable) await new Promise<void>(resolve => {
        const done = () => { res.off("drain", done); res.off("close", done); resolve(); };
        res.once("drain", done); res.once("close", done);
      });
    }
    if (!res.destroyed) res.end();
  });
  try {
    const pending = prepareInboundMedia(f.relay, r, f.directory, auth);
    await chunkSeen;
    const mediaDir = path.join(f.directory, (await fs.readdir(f.directory))[0]!);
    const partialPath = path.join(mediaDir, "1.txt");
    const watcher = watch(mediaDir);
    try {
      await new Promise<void>((resolve, reject) => {
        const onChange = async () => {
          try { if ((await fs.stat(partialPath)).size >= 65536) { watcher.close(); resolve(); } }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") reject(error); }
        };
        watcher.on("change", onChange);
        watcher.on("error", reject);
        void onChange();
      });
    } finally { watcher.close(); }
    if (mode === "revoked") auth.authorize = () => { activeChecksAfterRevocation++; throw new ExternalRelayError("lease_lost", 409); };
    else controller.abort(new Error("cancelled"));
    releaseServer();
    await expect(pending).rejects.toBeDefined();
    if (mode === "revoked") expect(activeChecksAfterRevocation).toBeGreaterThan(0);
    expect(bytesSent).toBeLessThan(20 * MiB);
    expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { controller.abort(); releaseServer(); await f.close(); }
});
test("service download refusals preserve each authenticated error status and code", async () => {
  for (const [status, code] of [[400, "malformed"], [401, "unauthorized"], [404, "not_found"], [409, "lease_lost"], [413, "too_large"], [415, "unsupported_media_type"], [422, "media_unavailable"], [429, "rate_limited"]] as const) {
    const f = await fixture((_req, res) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { code, retry_after_s: 1 } })); });
    try { await expect(prepareInboundMedia(f.relay, request(), f.directory, options())).rejects.toMatchObject({ code, status }); expect(await fs.readdir(f.directory)).toEqual([]); }
    finally { await f.close(); }
  }
});
test("unavailable refs stay visible without a download; cancellation sends nothing", async () => {
  const r = request(); Object.assign(r.input.conversation[0]!.media![0]!, { availability: "protected", byte_size: undefined, mime_type: undefined, expires_at: undefined });
  let calls = 0;
  const f = await fixture((_req, res) => { calls++; res.end(); });
  try {
    const result = await prepareInboundMedia(f.relay, r, f.directory, options()); expect(result.files).toEqual([]); expect(result.prompt).toContain("protected"); expect(calls).toBe(0); await result.dispose();
    const abort = new AbortController(); abort.abort();
    await expect(prepareInboundMedia(f.relay, request(), f.directory, { ...options(), signal: abort.signal })).rejects.toBeDefined();
    expect(calls).toBe(0); expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});

test("Claude image input spools a native stream-json frame and preserves image bytes across chunk boundaries", async () => {
  const f = await fixture((_req, res) => { res.end(); });
  try {
    const image = path.join(f.directory, "image.png");
    const bytes = Buffer.alloc(98305, 42); await fs.writeFile(image, bytes);
    const input = await writeInboundAgentInput([{ ref: "photo", path: image, kind: "photo", mime_type: "image/png" }], "Read the attached photo", f.directory, new AbortController().signal, () => {});
    const frame = JSON.parse(await fs.readFile(input!, "utf8"));
    expect(frame).toMatchObject({ type: "user", message: { role: "user", content: [{ type: "text", text: "Read the attached photo" }, { type: "image", source: { type: "base64", media_type: "image/png" } }] } });
    expect(Buffer.from(frame.message.content[1].source.data, "base64")).toEqual(bytes);
    expect((await fs.stat(input!)).mode & 0o777).toBe(0o600);
  } finally { await f.close(); }
});

test("trigger refs precede the direct parent and document extraction accepts exact scalar limits", () => {
  const r = request([ref("trigger_ref", 20 * MiB)]);
  r.input.conversation[0]!.reply_to = "parent";
  r.input.conversation.unshift({ id: "parent", author: { key: "parent_person", name: "Person", self: false }, sent_at: "2026-10-17T11:59:00Z", text: "Earlier file", reply_to: null, media: [ref("parent_ref", 20 * MiB)] });
  r.input.documents = [{ title: "Trigger", message_id: "message", media_ref: "trigger_ref", extraction: "truncated", text: "😀".repeat(16000) }, { title: "Parent", message_id: "parent", media_ref: "parent_ref", extraction: "complete", text: "x".repeat(16000) }];
  expect(validateMediaInput(requestSchema.parse(r)).map(media => media.ref)).toEqual(["trigger_ref", "parent_ref"]);
});

test("download rejects hostile route, credential and lease inputs before emitting a request", async () => {
  let calls = 0;
  const f = await fixture((_req, res) => { calls++; res.end(); });
  try {
    const r = request();
    for (const changes of [{ request: "../other" }, { ref: "../other" }, { ref: "photo?token=example" }, { lease: "" }, { lease: "lease\r\nHeader: value" }, { credential: "" }]) {
      await expect(relayDownloadMedia(f.relay.api_base, changes.request ?? r.request_id, changes.lease ?? r.lease_id, changes.ref ?? "media_a", changes.credential ?? f.relay.credential,
        async () => {}, { signal: new AbortController().signal, beforeSend: () => {} })).rejects.toMatchObject({ code: "malformed", status: 400 });
    }
    expect(calls).toBe(0);
    let live = true;
    const pending = relayDownloadMedia(f.relay.api_base, r.request_id, r.lease_id, "media_a", f.relay.credential, async () => {}, {
      signal: new AbortController().signal, beforeSend: () => { if (!live) throw new ExternalRelayError("lease_lost", 409); },
    });
    live = false;
    await expect(pending).rejects.toMatchObject({ code: "lease_lost", status: 409 });
    expect(calls).toBe(0);
  } finally { await f.close(); }
});

test("a later failed original removes previously downloaded files and a retry starts with its own byte budget", async () => {
  let failSecond = true;
  const f = await fixture((req, res) => {
    const bad = failSecond && req.url?.endsWith("media_b");
    res.writeHead(200, { "content-type": bad ? "image/svg+xml" : "text/plain", "content-length": 5 }); res.end("hello");
  });
  try {
    const r = request([ref("media_a"), ref("media_b")]);
    await expect(prepareInboundMedia(f.relay, r, f.directory, options())).rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
    expect(await fs.readdir(f.directory)).toEqual([]);
    failSecond = false;
    const retry = await prepareInboundMedia(f.relay, r, f.directory, options());
    expect(retry.files.map(file => file.ref)).toEqual(["media_a", "media_b"]);
    await retry.dispose(); expect(await fs.readdir(f.directory)).toEqual([]);
  } finally { await f.close(); }
});
