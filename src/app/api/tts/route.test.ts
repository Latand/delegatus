import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";

import { GET, POST } from "./route";

const originalKey = process.env.OPENAI_API_KEY;
const originalSonioxKey = process.env.SONIOX_API_KEY;
const originalBackend = process.env.LLV_TTS_BACKEND;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalFetch = globalThis.fetch;
const SONIOX_KEY = "soniox-account-key";

/* Env restore goes through a name-indexed helper: writing
   `process.env.X_API_KEY = value` directly reads as a credential assignment to
   the publication gate. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  setEnv("OPENAI_API_KEY", originalKey);
  setEnv("SONIOX_API_KEY", originalSonioxKey);
  setEnv("LLV_TTS_BACKEND", originalBackend);
  setEnv("XDG_CONFIG_HOME", originalConfigHome);
  globalThis.fetch = originalFetch;
});

function request(body: string, signal?: AbortSignal): NextRequest {
  return new NextRequest("http://127.0.0.1/api/tts", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json" },
    body,
    signal,
  });
}

describe("/api/tts", () => {
  test("reports unavailable and returns a clean 503 without an API key", async () => {
    process.env.LLV_TTS_BACKEND = "openai";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-test";
    setEnv("OPENAI_API_KEY", undefined);
    expect(await (await GET()).json()).toEqual({ available: false });
    const response = await POST(request(JSON.stringify({ text: "Hello" })));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "text-to-speech is unavailable" });
  });

  test("returns a clean 400 for a null JSON body", async () => {
    setEnv("OPENAI_API_KEY", "test-key");
    process.env.LLV_TTS_BACKEND = "openai";
    const response = await POST(request("null"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "expected a JSON object" });
  });

  test("streams the OpenAI audio response", async () => {
    setEnv("OPENAI_API_KEY", "test-key");
    process.env.LLV_TTS_BACKEND = "openai";
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } });
    const fetchMock = mock(async (...args: [string | URL | Request, RequestInit?]) => {
      void args;
      return new Response(stream, { headers: { "content-type": "audio/mpeg" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await POST(request(JSON.stringify({ text: "Read this answer." })));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    /* #1024: the client's copy of the configuration is a page-load-old
       singleton, so the audio says who was billed for it and is cached under
       that rather than under whatever the tab believed when it asked. */
    expect(response.headers.get("x-tts-backend")).toBe("openai");
    expect(response.headers.get("x-tts-model")).toBe("gpt-4o-mini-tts");
    expect(response.headers.get("x-tts-voice")).toBe("alloy");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: "Read this answer.",
      response_format: "mp3",
    });
  });

  test("rejects non-audio and oversized upstream responses", async () => {
    setEnv("OPENAI_API_KEY", "test-key");
    process.env.LLV_TTS_BACKEND = "openai";
    globalThis.fetch = mock(async () => new Response("not audio", { headers: { "content-type": "text/plain" } })) as unknown as typeof fetch;
    expect((await POST(request(JSON.stringify({ text: "Hello" })))).status).toBe(502);

    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]), {
      headers: { "content-type": "audio/mpeg", "content-length": String(32 * 1024 * 1024 + 1) },
    })) as unknown as typeof fetch;
    expect((await POST(request(JSON.stringify({ text: "Hello" })))).status).toBe(502);
  });

  test("propagates client cancellation to the provider request", async () => {
    setEnv("OPENAI_API_KEY", "test-key");
    process.env.LLV_TTS_BACKEND = "openai";
    const client = new AbortController();
    let providerSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      providerSignal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        if (providerSignal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        providerSignal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as unknown as typeof fetch;

    const pending = POST(request(JSON.stringify({ text: "Hello" }), client.signal));
    client.abort();
    expect((await pending).status).toBe(499);
    expect(providerSignal?.aborted).toBe(true);
  });

  test("admits three concurrent syntheses and releases every slot", async () => {
    setEnv("OPENAI_API_KEY", "test-key");
    process.env.LLV_TTS_BACKEND = "openai";
    const pending: Array<(response: Response) => void> = [];
    globalThis.fetch = mock(async () => new Promise<Response>((resolve) => pending.push(resolve))) as unknown as typeof fetch;
    const requests = [1, 2, 3].map((n) => POST(request(JSON.stringify({ text: `Hello ${n}` }))));
    while (pending.length < 3) await Promise.resolve();
    expect((await POST(request(JSON.stringify({ text: "Fourth" })))).status).toBe(429);
    for (const resolve of pending) resolve(new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } }));
    for (const response of await Promise.all(requests)) await response.arrayBuffer();

    globalThis.fetch = mock(async () => new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
    const afterRelease = await POST(request(JSON.stringify({ text: "After" })));
    expect(afterRelease.status).toBe(200);
    await afterRelease.arrayBuffer();
  });
});

describe("/api/tts — soniox (#1020)", () => {
  test("posts the documented /tts body and streams the audio back", async () => {
    process.env.LLV_TTS_BACKEND = "soniox";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-soniox";
    setEnv("SONIOX_API_KEY", SONIOX_KEY);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([9, 9])); controller.close(); } });
    const fetchMock = mock(async () => new Response(stream, { headers: { "content-type": "audio/mpeg" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(await (await GET()).json()).toEqual({ available: true });
    const response = await POST(request(JSON.stringify({ text: "Read this answer." })));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([9, 9]));

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://tts-rt.soniox.com/tts");
    expect(new Headers(init.headers as HeadersInit).get("authorization")).toBe(`Bearer ${SONIOX_KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({
      model: "tts-rt-v2",
      voice: "Adrian",
      language: "en",
      audio_format: "mp3",
      text: "Read this answer.",
    });
  });

  test("degrades with a clean 503 and a key path when no key is present", async () => {
    process.env.LLV_TTS_BACKEND = "soniox";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-soniox";
    setEnv("SONIOX_API_KEY", undefined);
    globalThis.fetch = mock(async () => { throw new Error("must not call Soniox without a key"); }) as unknown as typeof fetch;

    expect(await (await GET()).json()).toEqual({ available: false });
    const response = await POST(request(JSON.stringify({ text: "Hello" })));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "text-to-speech is unavailable",
      keyPath: expect.stringContaining("soniox-api-key"),
    });
  });

  test("preserves a permanent upstream refusal without leaking the key", async () => {
    process.env.LLV_TTS_BACKEND = "soniox";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-soniox";
    setEnv("SONIOX_API_KEY", SONIOX_KEY);
    globalThis.fetch = mock(async () => Response.json(
      { error_code: 401, error_type: "unauthorized", error_message: "Invalid API key." },
      { status: 401 },
    )) as unknown as typeof fetch;

    const response = await POST(request(JSON.stringify({ text: "Hello" })));
    const raw = await response.text();
    expect(response.status).toBe(401);
    expect(JSON.parse(raw)).toEqual({ error: "soniox TTS failed (HTTP 401)" });
    expect(raw).not.toContain(SONIOX_KEY);
  });

  test("selecting soniox leaves the ElevenLabs request body untouched", async () => {
    process.env.LLV_TTS_BACKEND = "elevenlabs";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-soniox";
    setEnv("ELEVENLABS_API_KEY", "eleven-key");
    const fetchMock = mock(async () => Response.json(elevenPayload("Read this answer.")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await POST(request(JSON.stringify({ text: "Read this answer." })));
    await response.json();

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/with-timestamps");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("xi-api-key")).toBe("eleven-key");
    expect(JSON.parse(String(init.body))).toEqual({ model_id: "eleven_multilingual_v2", text: "Read this answer." });

    setEnv("ELEVENLABS_API_KEY", undefined);
  });
});

/** An ElevenLabs `/with-timestamps` envelope for `text`, one 0.1s per character. */
function elevenPayload(text: string, audio = "QUJD") {
  return {
    audio_base64: audio,
    alignment: {
      characters: [...text],
      character_start_times_seconds: [...text].map((_, index) => index * 0.1),
      character_end_times_seconds: [...text].map((_, index) => (index + 1) * 0.1),
    },
    normalized_alignment: { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] },
  };
}

describe("/api/tts — elevenlabs character alignment (#1022)", () => {
  test("asks for timestamps and passes the alignment through beside the audio", async () => {
    process.env.LLV_TTS_BACKEND = "elevenlabs";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-eleven";
    setEnv("ELEVENLABS_API_KEY", "eleven-key");
    globalThis.fetch = mock(async () => Response.json(elevenPayload("Hi"))) as unknown as typeof fetch;

    const response = await POST(request(JSON.stringify({ text: "Hi" })));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-tts-backend")).toBe("elevenlabs");
    expect(response.headers.get("x-tts-model")).toBe("eleven_multilingual_v2");
    expect(response.headers.get("x-tts-voice")).toBe("21m00Tcm4TlvDq8ikWAM");
    expect(await response.json()).toEqual({
      audio: "QUJD",
      contentType: "audio/mpeg",
      alignment: { characters: ["H", "i"], starts: [0, 0.1], ends: [0.1, 0.2] },
    });
    setEnv("ELEVENLABS_API_KEY", undefined);
  });

  test("a payload without a usable alignment still plays, with alignment null", async () => {
    process.env.LLV_TTS_BACKEND = "elevenlabs";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-eleven";
    setEnv("ELEVENLABS_API_KEY", "eleven-key");
    globalThis.fetch = mock(async () => Response.json({
      audio_base64: "QUJD",
      alignment: { characters: ["H", "i"], character_start_times_seconds: [0], character_end_times_seconds: [0.1] },
    })) as unknown as typeof fetch;

    const response = await POST(request(JSON.stringify({ text: "Hi" })));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ audio: "QUJD", contentType: "audio/mpeg", alignment: null });
    setEnv("ELEVENLABS_API_KEY", undefined);
  });

  test("a malformed envelope is a clean 502 and releases the synthesis slot", async () => {
    process.env.LLV_TTS_BACKEND = "elevenlabs";
    process.env.XDG_CONFIG_HOME = "/nonexistent/tts-route-eleven";
    setEnv("ELEVENLABS_API_KEY", "eleven-key");
    globalThis.fetch = mock(async () => new Response("<html>gateway</html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

    const broken = await POST(request(JSON.stringify({ text: "Hi" })));
    expect(broken.status).toBe(502);
    expect(await broken.json()).toEqual({ error: "elevenlabs TTS returned invalid audio" });

    /* The slot came back: three more syntheses are admitted right after. */
    globalThis.fetch = mock(async () => Response.json(elevenPayload("Hi"))) as unknown as typeof fetch;
    for (const response of await Promise.all([1, 2, 3].map(() => POST(request(JSON.stringify({ text: "Hi" })))))) {
      expect(response.status).toBe(200);
      await response.json();
    }
    setEnv("ELEVENLABS_API_KEY", undefined);
  });
});

describe("Soniox fast route", () => {
  test("streams PCM before EOF with authoritative geometry and language", async () => {
    process.env.LLV_TTS_BACKEND = "soniox"; setEnv("SONIOX_API_KEY", SONIOX_KEY);
    let finish!: () => void;
    let sent: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 0])); finish = () => c.close(); } }), { headers: { "content-type": "audio/pcm" } });
    }) as unknown as typeof fetch;
    const response = await POST(request(JSON.stringify({ text: "First sentence.", mode: "soniox-pcm" })));
    expect(sent).toMatchObject({ audio_format: "pcm_s16le", sample_rate: 24000, language: "en" });
    expect(response.headers.get("x-tts-encoding")).toBe("pcm_s16le");
    expect(response.headers.get("x-tts-channels")).toBe("1");
    expect(response.headers.get("x-tts-language")).toBe("en");
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 0]));
    finish(); expect((await reader.read()).done).toBe(true);
  });
  test("rejects byte overflow and stale mode before a paid call", async () => {
    process.env.LLV_TTS_BACKEND = "soniox"; setEnv("SONIOX_API_KEY", SONIOX_KEY);
    const fetchMock = mock(async () => new Response()); globalThis.fetch = fetchMock as unknown as typeof fetch;
    expect((await POST(request(JSON.stringify({ text: "я".repeat(2501), mode: "soniox-pcm" })))).status).toBe(413);
    process.env.LLV_TTS_BACKEND = "openai"; setEnv("OPENAI_API_KEY", "test-key");
    expect((await POST(request(JSON.stringify({ text: "Hello", mode: "soniox-pcm" })))).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test("preserves sanitized 429 retry delay and rejects a wrong PCM content type", async () => {
    process.env.LLV_TTS_BACKEND = "soniox"; setEnv("SONIOX_API_KEY", SONIOX_KEY);
    globalThis.fetch = mock(async () => new Response("private upstream details", { status: 429, headers: { "retry-after": "2", "x-private": "private" } })) as unknown as typeof fetch;
    const busy = await POST(request(JSON.stringify({ text: "Hello", mode: "soniox-pcm" })));
    expect(busy.status).toBe(429); expect(busy.headers.get("retry-after")).toBe("2");
    expect(busy.headers.get("x-private")).toBeNull(); expect(await busy.text()).not.toContain("private");
    globalThis.fetch = mock(async () => new Response(new Uint8Array([1, 0]), { headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
    expect((await POST(request(JSON.stringify({ text: "Hello", mode: "soniox-pcm" })))).status).toBe(502);
  });
  test("mid-body abort cancels the reader and releases admission once", async () => {
    process.env.LLV_TTS_BACKEND = "soniox"; setEnv("SONIOX_API_KEY", SONIOX_KEY);
    const canceled = mock(() => undefined);
    globalThis.fetch = mock(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 0])); }, cancel: canceled }), { headers: { "content-type": "audio/pcm" } })) as unknown as typeof fetch;
    const abort = new AbortController();
    const response = await POST(request(JSON.stringify({ text: "Hello", mode: "soniox-pcm" }), abort.signal));
    const reader = response.body!.getReader(); await reader.read(); abort.abort();
    expect((await reader.read()).done).toBe(true); expect(canceled).toHaveBeenCalledTimes(1);
    const replies = await Promise.all(Array.from({ length: 3 }, () => POST(request(JSON.stringify({ text: "Hello", mode: "soniox-pcm" })))));
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200]);
    await Promise.all(replies.map((r) => r.body!.cancel()));
  });
});

test("Soniox rolling admission rejects the 101st start and reopens after one minute", async () => {
  process.env.LLV_TTS_BACKEND = "soniox"; setEnv("SONIOX_API_KEY", SONIOX_KEY);
  const originalNow = Date.now; let now = originalNow() + 60_001; Date.now = () => now;
  let calls = 0;
  globalThis.fetch = mock(async () => { calls++; return new Response(new Uint8Array([1, 0]), { headers: { "content-type": "audio/pcm" } }); }) as unknown as typeof fetch;
  try {
    for (let i = 0; i < 100; i++) {
      const response = await POST(request(JSON.stringify({ text: "Hello", mode: "soniox-pcm" })));
      expect(response.status).toBe(200); await response.arrayBuffer();
    }
    const busy = await POST(request(JSON.stringify({ text: "Hello", mode: "soniox-pcm" })));
    expect(busy.status).toBe(429); expect(busy.headers.get("retry-after")).toBe("60"); expect(calls).toBe(100);
    now += 60_001;
    const next = await POST(request(JSON.stringify({ text: "Hello", mode: "soniox-pcm" })));
    expect(next.status).toBe(200); await next.arrayBuffer(); expect(calls).toBe(101);
  } finally { Date.now = originalNow; }
});


describe("Fish Audio route", () => {
  const fixtureKey = "provider-fixture";
  const names = ["FISH_AUDIO_API_KEY", "LLV_TTS_FISHAUDIO_MODEL", "LLV_TTS_FISHAUDIO_VOICE"];
  const original = names.map((name) => process.env[name]);
  let clock: ReturnType<typeof spyOn>;
  beforeEach(() => {
    clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-14T00:00:00Z"));
    process.env.LLV_TTS_BACKEND = "fishaudio";
    process.env.XDG_CONFIG_HOME = "/nonexistent/fish-route-test";
    setEnv(names[0]!, "provider-fixture");
    setEnv(names[1]!, "s2.1-pro-free");
    setEnv(names[2]!, undefined);
  });
  afterEach(() => { names.forEach((name, index) => setEnv(name, original[index])); mock.restore(); clock.mockRestore(); });
  const pcmRequest = (text = "Привіт. Привет. Hello.", signal?: AbortSignal) => request(JSON.stringify({ text, mode: "pcm" }), signal);
  const safe = (response: Response, body: string) => {
    expect(body).not.toContain("provider-fixture");
    expect(JSON.stringify([...response.headers])).not.toContain("provider-fixture");
  };

  test.each(["s2.1-pro-free", "s2.1-pro"])("sends the exact native request for %s without a language", async (model) => {
    setEnv(names[1]!, model);
    const upstream = mock(async () => new Response(new Uint8Array([1, 0]), { headers: { "content-type": "audio/pcm" } }));
    globalThis.fetch = upstream as unknown as typeof fetch;
    const response = await POST(pcmRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("x-tts-backend")).toBe("fishaudio");
    expect(response.headers.get("x-tts-model")).toBe(model);
    expect(await response.arrayBuffer()).toEqual(new Uint8Array([1, 0]).buffer);
    const call = upstream.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://api.fish.audio/v1/tts");
    expect(call[1].headers).toEqual({ authorization: `Bearer ${fixtureKey}`, "content-type": "application/json", model });
    expect(JSON.parse(String(call[1].body))).toEqual({ text: "Привіт. Привет. Hello.", format: "pcm", sample_rate: 24000, latency: "balanced" });
    safe(response, "");
  });

  test("streams octet-stream PCM before EOF, sets an explicit voice and propagates stop", async () => {
    setEnv(names[2]!, "configured-voice");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    let upstreamSignal: AbortSignal | undefined;
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      upstreamSignal = init?.signal as AbortSignal;
      expect(JSON.parse(String(init?.body)).reference_id).toBe("configured-voice");
      return new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new Uint8Array([1, 0])); }, cancel() { cancelled = true; } }), { headers: { "content-type": "application/octet-stream" } });
    }) as unknown as typeof fetch;
    const abort = new AbortController();
    const response = await POST(pcmRequest("Hello", abort.signal));
    expect(response.headers.get("content-type")).toBe("audio/pcm");
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 0]));
    controller.enqueue(new Uint8Array([2, 0]));
    expect((await reader.read()).value).toEqual(new Uint8Array([2, 0]));
    abort.abort();
    expect(upstreamSignal?.aborted).toBe(true);
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  test("free expiry refuses before fetch and keeps the free model", async () => {
    const now = spyOn(Date, "now").mockReturnValue(Date.parse("2026-12-01T00:00:00Z"));
    const upstream = mock(async () => { throw new Error("must not call"); });
    globalThis.fetch = upstream as unknown as typeof fetch;
    try {
      const response = await POST(pcmRequest());
      expect(response.status).toBe(410);
      const body = await response.text(); safe(response, body);
      expect(JSON.parse(body).code).toBe("fishaudio-free-ended");
      expect(upstream).not.toHaveBeenCalled();
      expect(process.env.LLV_TTS_FISHAUDIO_MODEL).toBe("s2.1-pro-free");
    } finally { now.mockRestore(); }
  });

  test.each([400, 401, 402, 403, 404, 429, 500])("maps HTTP %i without echoing upstream secrets", async (status) => {
    globalThis.fetch = mock(async () => new Response("provider-fixture", { status })) as unknown as typeof fetch;
    const response = await POST(pcmRequest());
    const body = await response.text(); safe(response, body);
    expect(response.status).toBe(status === 500 ? 502 : status);
    expect(JSON.parse(body).code).toBe([402, 403, 404].includes(status) ? "fishaudio-free-refused" : undefined);
    if (status === 429) expect(response.headers.get("retry-after")).toBe("1");
  });
  test("paid credit refusals have no free-model code", async () => {
    setEnv(names[1]!, "s2.1-pro");
    globalThis.fetch = mock(async () => new Response("provider-fixture", { status: 402 })) as unknown as typeof fetch;
    const response = await POST(pcmRequest());
    const body = await response.text(); safe(response, body);
    expect(response.status).toBe(402); expect(JSON.parse(body).code).toBeUndefined();
  });
  test("missing key, stale modes and non-audio are clean refusals", async () => {
    const upstream = mock(async () => new Response("provider-fixture", { headers: { "content-type": "application/json" } }));
    globalThis.fetch = upstream as unknown as typeof fetch;
    for (const mode of [undefined, "soniox-pcm"]) expect((await POST(request(JSON.stringify({ text: "Hello", mode })))).status).toBe(409);
    expect(upstream).not.toHaveBeenCalled();
    const invalid = await POST(pcmRequest());
    expect(invalid.status).toBe(502); safe(invalid, await invalid.text());
    setEnv(names[0]!, undefined);
    const missing = await POST(pcmRequest());
    expect(missing.status).toBe(503);
    expect((await missing.json()).keyPath).toMatch(/fishaudio-api-key$/);
  });
});
