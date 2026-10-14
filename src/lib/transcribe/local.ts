import fs from "node:fs";
import path from "node:path";

import { cacheEntryPath } from "@/lib/configDir";
import { endLeasedHelper, spawnLeasedHelper } from "@/lib/helperLease";

import { transcriptionLanguage, transcriptionResult } from "./languages";

import type { TranscribeResponse } from "./types";

/* Local faster-whisper path (default). Model and device are overridable per
   machine; CPU int8 keeps it dependency-free where there is no CUDA setup. */
const WHISPER_MODEL = process.env.LLV_WHISPER_MODEL || "small";
const WHISPER_DEVICE = process.env.LLV_WHISPER_DEVICE || "cpu";
const WHISPER_TIMEOUT_MS = 120_000;
const WHISPER_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;

/* Resolved per request so a venv created after the server started is picked up,
   and the legacy cache dir is honored when only the old venv exists. */
function whisperVenv(): string {
  return process.env.LLV_WHISPER_VENV || cacheEntryPath("whisper-venv");
}

/** Interpreter the local path would run — shown in setup hints. */
export function whisperPythonPath(): string {
  return path.join(whisperVenv(), "bin", "python");
}

/** Whether the faster-whisper venv is installed on this machine. */
export function localWhisperReady(): boolean {
  return fs.existsSync(whisperPythonPath());
}

export function localTranscribe(audioPath: string, language: string): Promise<TranscribeResponse> {
  const python = path.join(whisperVenv(), "bin", "python");
  const script = path.join(process.cwd(), "scripts", "whisper_transcribe.py");
  return new Promise((resolve, reject) => {
    /* Under a lease: the deadline below lives in this Viewer, so without one
       a transcription would outlive it and keep the service's cgroup
       populated (src/lib/helperLease.ts). */
    const child = spawnLeasedHelper("whisper-transcribe", {
      command: python,
      args: [script, audioPath, WHISPER_MODEL, WHISPER_DEVICE, transcriptionLanguage(language)],
      cwd: process.cwd(),
      env: process.env,
    }, undefined, { stdout: "pipe", stderr: "ignore", followRelease: false });
    let stdout = "";
    let failure: string | null = null;
    const stop = (reason: string) => {
      failure ??= reason;
      endLeasedHelper(child);
    };
    const timer = setTimeout(() => stop(`local STT ran past ${WHISPER_TIMEOUT_MS} ms`), WHISPER_TIMEOUT_MS);
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > WHISPER_OUTPUT_MAX_BYTES) stop("local STT exceeded its output limit");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure || ((code !== 0 || signal) && !stdout)) {
        /* The guardian exits 127 when the interpreter cannot be started. */
        const hint = code === 127 ? " (run scripts/setup-whisper.sh)" : "";
        reject(new Error((failure ?? `local STT exited with ${signal ?? code}`) + hint));
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { text?: unknown; error?: unknown; language?: unknown };
        if (typeof parsed.error === "string") {
          reject(new Error(parsed.error));
          return;
        }
        resolve(transcriptionResult(parsed.text, [parsed.language], language));
      } catch {
        reject(new Error("local STT returned invalid output"));
      }
    });
  });
}
