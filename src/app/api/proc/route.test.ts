import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { NextRequest } from "next/server";
import * as scanner from "@/lib/scanner";
import * as roots from "@/lib/scanner/roots";
import * as transcripts from "@/lib/scanner/transcripts";
import { captureProcessIdentity } from "@/lib/processIdentity";
import { hostExitText, readHostExit, observeHostExit, recordHostStop, withHostStopOrigin } from "@/lib/runtime/hostExit";
import { POST } from "./route";

for (const force of [false, true]) for (const revalidation of ["accepted", "stale", "refused", "signal-error"] as const) for (const prior of [false, true]) {
  test(`process endpoint records only effective signals (force=${force}, revalidation=${revalidation}, prior=${prior})`, async () => {
    const child = spawn(process.execPath, ["-e", 'process.stdout.write("ready"); setInterval(()=>{},1000)'], { stdio: ["ignore", "pipe", "ignore"] });
    const closed = once(child, "close");
    await once(child.stdout!, "data");
    const identity = captureProcessIdentity(child.pid!);
    observeHostExit(child, identity);
    const pathname = "fixtures/session.jsonl";
    const list = spyOn(scanner, "listFiles").mockResolvedValue([{ path: pathname, pid: child.pid! }] as Awaited<ReturnType<typeof scanner.listFiles>>);
    const allowed = spyOn(roots, "pathAllowed").mockReturnValue(true);
    const engine = spyOn(transcripts, "transcriptEngine").mockReturnValue("codex");
    const owner = spyOn(transcripts, "claudeSubagentOwnerPath").mockReturnValue(null);
    const verify = spyOn(transcripts, "verifyTranscriptPid").mockReturnValue(revalidation !== "refused");
    if (revalidation === "stale") verify.mockReturnValueOnce(true).mockReturnValue(false);
    if (prior) withHostStopOrigin({ path: "earlier-stop", operationId: "earlier-operation" }, () => recordHostStop(identity, "SIGTERM", "earlier-stop"));
    const previous = readHostExit(identity)?.stop;
    const original = process.kill.bind(process);
    const signals: string[] = [];
    const sink = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== child.pid || signal === 0) return original(pid, signal);
      expect(readHostExit(identity)?.stop).toMatchObject({ path: "/api/proc", signal: force ? "SIGKILL" : "SIGTERM" });
      expect(readHostExit(identity)?.stop?.operationId).toBeTruthy();
      if (revalidation === "signal-error") throw new Error("fixture signalling refused");
      signals.push(String(signal));
      return original(pid, signal);
    });
    try {
      const response = await POST(new NextRequest("http://127.0.0.1/api/proc", { method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" }, body: JSON.stringify({ path: pathname, force }) }));
      const accepted = revalidation === "accepted";
      expect(response.status).toBe(accepted ? 200 : revalidation === "signal-error" ? 500 : 409);
      expect(signals).toEqual(accepted ? [force ? "SIGKILL" : "SIGTERM"] : []);
      if (!accepted) {
        expect(readHostExit(identity)?.stop).toEqual(previous);
        original(child.pid!, "SIGKILL");
        await closed;
        expect(hostExitText(readHostExit(identity))).toContain(prior ? "stopped by earlier-stop (earlier-operation)" : "no Delegatus stop recorded");
      }
    } finally {
      sink.mockRestore(); verify.mockRestore(); owner.mockRestore(); engine.mockRestore(); allowed.mockRestore(); list.mockRestore();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
    }
  });
}
