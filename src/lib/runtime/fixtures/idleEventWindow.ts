import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EngineHost } from "../engineHost";

export function idleWindowFixture(host: EngineHost) {
  const target = host as unknown as { identity: { path: string }; eventTranscriptPath?: string };
  const previous = target.eventTranscriptPath ?? target.identity.path;
  const setPath = (value: string) => {
    if (target.eventTranscriptPath !== undefined) target.eventTranscriptPath = value;
    else target.identity.path = value;
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "idle-window-"));
  const transcript = path.join(directory, "transcript.jsonl");
  setPath(transcript);
  fs.writeFileSync(transcript, "");
  fs.utimesSync(transcript, 0, 0);
  return { cleanup: () => {
    setPath(previous);
    fs.rmSync(directory, { recursive: true, force: true });
  } };
}
