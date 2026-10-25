import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { NextRequest } from "next/server";
import * as scanner from "@/lib/scanner";
import * as roots from "@/lib/scanner/roots";
import * as transcripts from "@/lib/scanner/transcripts";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { readHostExit } from "@/lib/runtime/hostExit";
import { POST } from "./route";

for (const force of [false, true]) for (const verified of [false, true]) {
  test(`process endpoint records before signal (force=${force}, verified=${verified})`, async () => {
    const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready"); setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(child, "close");
    await once(child.stdout!, "data");
    const identity = captureProcessIdentity(child.pid!);
    const pathname = "fixtures/session.jsonl";
    const list = spyOn(scanner, "listFiles").mockResolvedValue([{ path: pathname, pid: child.pid! }] as Awaited<ReturnType<typeof scanner.listFiles>>);
    const allowed = spyOn(roots, "pathAllowed").mockReturnValue(true);
    const engine = spyOn(transcripts, "transcriptEngine").mockReturnValue("codex");
    const owner = spyOn(transcripts, "claudeSubagentOwnerPath").mockReturnValue(null);
    const verify = spyOn(transcripts, "verifyTranscriptPid").mockReturnValue(verified);
    const original = process.kill.bind(process);
    const signals: string[] = [];
    const sink = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== child.pid || signal === 0) return original(pid, signal);
      expect(readHostExit(identity)?.stop).toMatchObject({ path: "/api/proc", signal: force ? "SIGKILL" : "SIGTERM" });
      expect(readHostExit(identity)?.stop?.operationId).toBeTruthy();
      signals.push(String(signal));
      return true;
    });
    try {
      const response = await POST(new NextRequest("http://127.0.0.1/api/proc", { method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ path: pathname, force }) }));
      expect(response.status).toBe(verified ? 200 : 409);
      expect(signals).toEqual(verified ? [force ? "SIGKILL" : "SIGTERM"] : []);
      if (!verified) expect(readHostExit(identity)?.stop).toBeNull();
    } finally {
      sink.mockRestore(); verify.mockRestore(); owner.mockRestore(); engine.mockRestore(); allowed.mockRestore(); list.mockRestore();
      child.kill("SIGKILL");
      await closed;
    }
  });
}
