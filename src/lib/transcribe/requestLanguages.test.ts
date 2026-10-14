import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import * as lease from "@/lib/helperLease";
import { callTranscribe } from "./chatgpt";
import { elevenLabsTranscribe } from "./elevenlabs";
import { localTranscribe } from "./local";

const originalFetch = globalThis.fetch;
const restores: Array<() => void> = [];
afterEach(() => { globalThis.fetch = originalFetch; for (const restore of restores.splice(0)) restore(); });
const choices = [["", "uk"], ["be", "uk"], ["fr", "uk"], ["uk-UA", "uk"], ["ru-RU", "ru"], ["en-US", "en"]] as const;

test.each(choices)("ChatGPT sends an allowed explicit language for %j", async (input, expected) => {
  let config = "";
  // Intercept the process boundary; curl and the provider are never contacted.
  const run = spyOn(childProcess, "execFile").mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1) as (error: null, stdout: string) => void;
    return { stdin: { end(value: string) { config = value; queueMicrotask(() => callback(null, '{"text":"speech"}\n200')); } } };
  }) as typeof childProcess.execFile);
  restores.push(() => run.mockRestore());
  await callTranscribe({ accessToken: "fixture", accountId: "fixture" }, "audio.webm", "audio/webm", input!);
  expect(config).toContain(`form = "language=${expected}"`);
});

test.each(choices)("ElevenLabs batch sends an allowed explicit language for %j", async (input, expected) => {
  let form: FormData | undefined;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    form = init.body as FormData;
    return Response.json({ text: "speech", language_code: "bel" });
  }) as typeof fetch;
  const result = await elevenLabsTranscribe("fixture", new File(["audio"], "audio.webm"), input!);
  expect(form?.get("language_code")).toBe(expected);
  expect(result).toEqual({ text: "speech", language: expected });
});

test.each(choices)("local Whisper gets an allowed explicit language for %j", async (input, expected) => {
  let argv: string[] = [];
  const run = spyOn(lease, "spawnLeasedHelper").mockImplementation(((_kind: unknown, spec: { args: string[] }) => {
    argv = spec.args;
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
    queueMicrotask(() => { child.stdout.end('{"text":"speech","language":"be"}'); child.emit("close", 0, null); });
    return child;
  }) as unknown as typeof lease.spawnLeasedHelper);
  restores.push(() => run.mockRestore());
  expect(await localTranscribe("audio.webm", input!)).toEqual({ text: "speech", language: expected });
  expect(argv.at(-1)).toBe(expected);
});

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test("the real Python wrapper pins its language and reports the model's language", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dictation-python-")); roots.push(root);
  fs.writeFileSync(path.join(root, "faster_whisper.py"), `
from types import SimpleNamespace
class WhisperModel:
    def __init__(self, *args, **kwargs): pass
    def transcribe(self, audio, **kwargs):
        assert kwargs["language"] == "ru"
        assert kwargs["multilingual"] is False
        return [SimpleNamespace(text="speech")], SimpleNamespace(language="ru")
`);
  const output = childProcess.execFileSync("python3", [path.resolve("scripts/whisper_transcribe.py"), "audio.webm", "small", "cpu", "ru"],
    { env: { ...process.env, PYTHONPATH: root }, encoding: "utf8", timeout: 5000 });
  expect(JSON.parse(output)).toEqual({ text: "speech", language: "ru" });
});

test.each([["ukr", "uk"], ["rus", "ru"], ["eng", "en"]] as const)("an allowed provider language %s survives normalization", async (reported, expected) => {
  globalThis.fetch = (async () => Response.json({ text: "speech", language_code: reported })) as unknown as typeof fetch;
  expect(await elevenLabsTranscribe("fixture", new File(["audio"], "audio.webm"), "uk")).toEqual({ text: "speech", language: expected });
});
