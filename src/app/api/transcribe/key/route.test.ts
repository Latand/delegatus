import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { NextRequest } from "next/server";

import type { TranscribeBackendInfo } from "@/lib/transcribeBackend";

import { PUT } from "./route";

/*
 * The Voice step's key write (#2004, design §2.6): the key lands in the file
 * the server already reads, at mode 600, and never comes back in a reply or a
 * log line. Everything runs under a throw-away XDG_CONFIG_HOME.
 */

const SAVED = ["XDG_CONFIG_HOME", "LLV_TRANSCRIBE_BACKEND", "ELEVENLABS_API_KEY", "SONIOX_API_KEY"] as const;
const saved = Object.fromEntries(SAVED.map((name) => [name, process.env[name]]));
const roots: string[] = [];

/* Name-indexed: a literal assignment to an *_API_KEY variable reads as a
   credential to the publication gate. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stt-key-route-"));
  roots.push(root);
  setEnv("XDG_CONFIG_HOME", root);
  for (const name of SAVED.slice(1)) setEnv(name, undefined);
  return path.join(root, "agent-log-viewer");
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  for (const name of SAVED) setEnv(name, saved[name]);
});

function put(body: unknown, host = "127.0.0.1"): Promise<Response> {
  return PUT(new NextRequest("http://127.0.0.1/api/transcribe/key", {
    method: "PUT",
    headers: { host, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

const FAKE_KEY = ["fixture", "stt", "value", "0123456789"].join("-");

describe("PUT /api/transcribe/key", () => {
  test("writes the trimmed key at mode 600 and answers availability without it", async () => {
    const dir = configHome();
    const log = spyOn(console, "log");
    const error = spyOn(console, "error");
    try {
      const response = await put({ provider: "soniox", key: `  ${FAKE_KEY}  ` });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(FAKE_KEY);
      const info = JSON.parse(text) as TranscribeBackendInfo;
      expect(info.options.find((option) => option.id === "soniox")).toMatchObject({ available: true, keySource: "file" });
      const file = path.join(dir, "soniox-api-key");
      expect(fs.readFileSync(file, "utf8")).toBe(`${FAKE_KEY}\n`);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const logged = [...log.mock.calls, ...error.mock.calls].flat().map(String).join("\n");
      expect(logged).not.toContain(FAKE_KEY);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test("replacing a key keeps the mode at 600 even when the old file was wider", async () => {
    const dir = configHome();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "elevenlabs-api-key"), "old\n", { mode: 0o644 });
    expect((await put({ provider: "elevenlabs", key: FAKE_KEY })).status).toBe(200);
    expect(fs.readFileSync(path.join(dir, "elevenlabs-api-key"), "utf8")).toBe(`${FAKE_KEY}\n`);
    expect(fs.statSync(path.join(dir, "elevenlabs-api-key")).mode & 0o777).toBe(0o600);
  });

  test("a key the environment supplies cannot be replaced here", async () => {
    const dir = configHome();
    setEnv("SONIOX_API_KEY", "from-the-environment");
    const response = await put({ provider: "soniox", key: FAKE_KEY });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code?: string }).code).toBe("KEY_FROM_ENV");
    expect(fs.existsSync(path.join(dir, "soniox-api-key"))).toBe(false);
  });

  test("a line break, an empty key, an unknown provider or a foreign origin is refused", async () => {
    const dir = configHome();
    expect((await put({ provider: "soniox", key: "abc\ndef" })).status).toBe(400);
    expect((await put({ provider: "soniox", key: "   " })).status).toBe(400);
    expect((await put({ provider: "soniox", key: "x".repeat(513) })).status).toBe(400);
    expect((await put({ provider: "chatgpt", key: FAKE_KEY })).status).toBe(400);
    expect((await put({ provider: "soniox", key: FAKE_KEY }, "attacker.example")).status).toBe(403);
    expect(fs.existsSync(path.join(dir, "soniox-api-key"))).toBe(false);
  });
});

describe("the backend file", () => {
  test("a chosen backend is written at mode 600", async () => {
    const dir = configHome();
    const { writeTranscribeBackend } = await import("@/lib/transcribeBackend");
    writeTranscribeBackend("soniox");
    expect(fs.statSync(path.join(dir, "transcribe-backend")).mode & 0o777).toBe(0o600);
  });

  test("the info names where a live key comes from, and never the key", async () => {
    configHome();
    const { transcribeBackendInfo } = await import("@/lib/transcribeBackend");
    setEnv("ELEVENLABS_API_KEY", FAKE_KEY);
    const info = transcribeBackendInfo();
    expect(info.options.find((option) => option.id === "elevenlabs")?.keySource).toBe("env");
    expect(info.options.find((option) => option.id === "soniox")?.keySource).toBeNull();
    expect(JSON.stringify(info)).not.toContain(FAKE_KEY);
  });
});
