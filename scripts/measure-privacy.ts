/** Offline replay only. Inputs stay in the caller's marked state copy.
 * Emit timing and output digests; never emit prompts, reports or memory rows. */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { withoutStoredLessons, storedLessonTexts } from "../src/lib/memory/roleStore";
import { renderReport, type RenderReportInput } from "../src/lib/bridge/reportRender";

const directory = process.env.LLV_STATE_DIR;
if (!directory || !fs.existsSync(path.join(directory, ".privacy-replay-copy"))) throw new Error("A marked offline state copy is required");
const mode = process.argv[2];
if (mode !== "baseline" && mode !== "worker") throw new Error("usage: measure-privacy.ts baseline|worker");
const inputs = JSON.parse(fs.readFileSync(path.join(directory, "inputs.json"), "utf8")) as { prompt: string; report: Omit<RenderReportInput, "at"> & { at: string } };
const privacy = mode === "worker" ? await import("../src/lib/memory/privacy") : null;
const worker = mode === "worker" ? await import("../src/lib/links/taskPageWorker") : null;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Initialize the serving process's state revision outside per-call measurements.
const lessons = storedLessonTexts();
const report = { ...inputs.report, at: new Date(inputs.report.at), deny: { accounts: [], people: [], local: [], projects: [] } } as RenderReportInput;
if (process.platform !== "linux") throw new Error("The main-thread CPU probe requires Linux procfs");
const ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
const mainCpu = () => {
  const raw = fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/stat`, "utf8");
  const columns = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  return (Number(columns[11]) + Number(columns[12])) * 1000 / ticks;
};
try {
  for (let iteration = 0; iteration < 3; iteration++) {
    for (const kind of ["prompt", "report"] as const) {
      let maxMainGapMs = 0, maxMainCpuWindowMs = 0, last = performance.now(), cpuAt = mainCpu();
      const sample = () => {
        const now = performance.now(), cpu = mainCpu();
        maxMainGapMs = Math.max(maxMainGapMs, now - last - 5);
        maxMainCpuWindowMs = Math.max(maxMainCpuWindowMs, cpu - cpuAt);
        last = now; cpuAt = cpu;
      };
      const timer = setInterval(sample, 5);
      await new Promise<void>(done => setImmediate(done));
      const start = performance.now(), cpuBefore = mainCpu();
      const value = kind === "prompt"
        ? privacy ? await privacy.withoutStoredLessonsAsync(inputs.prompt) : withoutStoredLessons(inputs.prompt)
        : privacy ? await privacy.renderReportAsync(report) : renderReport({ ...report, deny: { ...report.deny!, lessons } });
      const ms = performance.now() - start, mainThreadCpuMs = mainCpu() - cpuBefore;
      await new Promise(done => setTimeout(done, 10)); clearInterval(timer); sample();
      console.log(JSON.stringify({ mode, iteration, kind, ms, maxMainGapMs, mainThreadCpuMs, maxMainCpuWindowMs,
        promptChars: inputs.prompt.length, reportBytes: Buffer.byteLength(JSON.stringify(inputs.report)), lessons: lessons.length,
        inputDigest: digest(kind === "prompt" ? inputs.prompt : inputs.report), outputDigest: digest(value) }));
    }
  }
} finally { await worker?.shutdownTaskPageWorker(); }
