import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CAP_SECONDS } from "../src/lib/dictationTimer";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runSetup(outcome: "success" | "decode-error" | "inference-error") {
  const root = mkdtempSync(path.join(tmpdir(), "whisper-setup-test-"));
  roots.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  if (python.status !== 0) throw new Error(`Python 3 required for setup smoke tests: ${python.stderr}`);
  const interpreter = path.join(bin, "stub-python");
  writeFileSync(interpreter, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "-m" ] && [ "\${2:-}" = "pip" ]; then
  printf '%s\\n' "$@" > "$INSTALL_LOG"
  exit 0
fi
exec "$REAL_PYTHON" "$@"
`, { mode: 0o755 });
  writeFileSync(path.join(bin, "python3"), `#!/usr/bin/env bash
set -euo pipefail
[ "$1" = "-m" ] && [ "$2" = "venv" ]
mkdir -p "$3/bin"
cp "$STUB_INTERPRETER" "$3/bin/python"
`, { mode: 0o755 });
  writeFileSync(path.join(root, "faster_whisper.py"), `import os
import wave
from pathlib import Path

class WhisperModel:
    def __init__(self, model, device, compute_type):
        assert (model, device, compute_type) == ("tiny", "cpu", "int8")

    def transcribe(self, audio, language, vad_filter):
        assert language == "en" and vad_filter is False
        with wave.open(audio) as wav:
            assert (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getnframes()) == (1, 2, 16000, 16000)
        Path(os.environ["AUDIO_LOG"]).write_text(audio)
        if os.environ["SMOKE_OUTCOME"] == "decode-error":
            raise TypeError("open() got an unexpected keyword argument 'metadata_errors'")
        def segments():
            if os.environ["SMOKE_OUTCOME"] == "inference-error":
                raise RuntimeError("stub inference failed")
            Path(os.environ["CONSUMED_LOG"]).write_text("consumed")
            yield object()
        return segments(), None
`);
  const installLog = path.join(root, "install.log");
  const audioLog = path.join(root, "audio.log");
  const consumedLog = path.join(root, "consumed.log");
  const result = spawnSync("bash", [path.resolve(import.meta.dir, "setup-whisper.sh")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      DELEGATUS_WHISPER_VENV: path.join(root, "venv"),
      DELEGATUS_WHISPER_MODEL: "tiny",
      DELEGATUS_WHISPER_DEVICE: "cpu",
      XDG_CACHE_HOME: path.join(root, "cache"),
      TMPDIR: root,
      PYTHONPATH: root,
      REAL_PYTHON: python.stdout.trim(),
      STUB_INTERPRETER: interpreter,
      SMOKE_OUTCOME: outcome,
      INSTALL_LOG: installLog,
      AUDIO_LOG: audioLog,
      CONSUMED_LOG: consumedLog,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { ...result, root, installLog, audioLog, consumedLog };
}

test.skipIf(process.platform === "win32")("setup installs the committed pins and transcribes a temporary one-second WAV before ready", () => {
  const result = runSetup("success");
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(readFileSync(result.installLog, "utf8").trim().split("\n")).toEqual([
    "-m", "pip", "install", "--quiet", "-r", path.resolve(import.meta.dir, "whisper-requirements.txt"),
  ]);
  expect(readFileSync(result.consumedLog, "utf8")).toBe("consumed");
  const audio = readFileSync(result.audioLog, "utf8");
  expect(audio.startsWith(result.root + path.sep)).toBe(true);
  expect(existsSync(path.dirname(audio))).toBe(false);
  expect(result.stdout).toContain("transcription smoke passed: tiny cpu");
  expect(result.stdout).toContain("whisper venv ready");
});

for (const [outcome, error] of [
  ["decode-error", "open() got an unexpected keyword argument 'metadata_errors'"],
  ["inference-error", "stub inference failed"],
] as const) {
  test.skipIf(process.platform === "win32")(`setup propagates ${outcome} and never reports ready`, () => {
    const result = runSetup(outcome);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Traceback");
    expect(result.stderr).toContain(error);
    expect(result.stdout).not.toContain("transcription smoke passed");
    expect(result.stdout).not.toContain("whisper venv ready");
    expect(existsSync(path.dirname(readFileSync(result.audioLog, "utf8")))).toBe(false);
  });
}

test("transcription documentation states the recording cap", () => {
  const doc = readFileSync(path.resolve(import.meta.dir, "../docs/transcription.md"), "utf8");
  expect(doc).toContain(`after ${CAP_SECONDS / 60} minutes (${CAP_SECONDS} seconds`);
  expect(doc).not.toContain("2-minute");
});
