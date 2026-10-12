import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

type Config = {
  repository: string;
  baseline: string;
  candidate: string;
  inputBase: string;
  inputHead: string;
  knownValuesFile: string;
  fingerprintFile: string;
  ocrLanguages: string;
  samples: number;
  outputFile: string;
};
type Run = { exitCode: number; report: Buffer; reportBytes: number; reportSha256: string; cpuSeconds: number; wallSeconds: number };

function fail(message: string): never { throw new Error(message); }

function git(repository: string, args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`git ${args[0]} failed`);
  return result.stdout.toString("utf8").trim();
}

function gitNulList(repository: string, args: string[]): string[] {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) fail(`git ${args[0]} failed`);
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

function loadConfig(path: string): Config {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  for (const key of ["repository", "baseline", "candidate", "inputBase", "inputHead", "knownValuesFile", "fingerprintFile", "ocrLanguages", "outputFile"] as const) {
    if (typeof raw[key] !== "string" || raw[key]!.length === 0) fail(`config requires ${key}`);
  }
  if (!Number.isInteger(raw.samples) || raw.samples! < 1 || raw.samples! > 25) fail("samples must be an integer from 1 to 25");
  const config = raw as Config;
  config.repository = resolve(config.repository);
  for (const key of ["knownValuesFile", "fingerprintFile"] as const) {
    config[key] = resolve(config[key]);
    if (!existsSync(config[key])) fail(`configured ${key} is unavailable`);
  }
  config.outputFile = resolve(config.outputFile);
  return config;
}

function cgroupUsage(): bigint {
  const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((entry) => entry.startsWith("0::"));
  if (!line) fail("unified cgroup path is unavailable; run through scripts/gate-slot.sh");
  const stat = readFileSync(join("/sys/fs/cgroup", line.slice(3), "cpu.stat"), "utf8");
  const value = stat.match(/^usage_usec\s+(\d+)$/m)?.[1];
  if (!value) fail("cgroup CPU usage counter is unavailable");
  return BigInt(value);
}

async function runGate(checkout: string, inputRepository: string, args: string[], cache: string, ci: boolean, config: Config): Promise<Run> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    LLV_PRIVACY_KNOWN_VALUES_FILE: config.knownValuesFile,
    LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: config.fingerprintFile,
    LLV_PRIVACY_OCR_LANGUAGES: config.ocrLanguages,
    LLV_PRIVACY_FINGERPRINT_CACHE_DIR: cache,
  };
  if (ci) env.CI = "true"; else delete env.CI;
  const command = [process.execPath, join(checkout, "scripts/privacy-publication-gate.ts"), "--repository", inputRepository, ...args];
  const startCpu = cgroupUsage();
  const startWall = performance.now();
  const child = Bun.spawn(command, { cwd: checkout, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).arrayBuffer(),
    child.exited,
  ]);
  const report = Buffer.concat([Buffer.from(stdout), Buffer.from(stderr)]);
  const endWall = performance.now();
  const endCpu = cgroupUsage();
  return {
    exitCode,
    report,
    reportBytes: report.length,
    reportSha256: createHash("sha256").update(report).digest("hex"),
    cpuSeconds: Number(endCpu - startCpu) / 1_000_000,
    wallSeconds: (endWall - startWall) / 1000,
  };
}

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (!configPath) fail("usage: bun scripts/privacy-performance-repro.ts <external-private-config.json>");
  const config = loadConfig(configPath);
  const repository = config.repository;
  for (const ref of [config.baseline, config.candidate, config.inputBase, config.inputHead]) {
    git(repository, ["rev-parse", "--verify", `${ref}^{commit}`]);
  }
  const root = mkdtempSync(join(tmpdir(), "privacy-performance-repro-"));
  const worktrees: string[] = [];
  const baselineDir = join(root, "baseline");
  const candidateDir = join(root, "candidate");
  const inputDir = join(root, "input");
  const comparisons: Array<Record<string, unknown>> = [];
  try {
    for (const [path, ref] of [[baselineDir, config.baseline], [candidateDir, config.candidate], [inputDir, config.inputHead]] as const) {
      const result = Bun.spawnSync(["git", "-C", repository, "worktree", "add", "--detach", path, ref], { stdout: "ignore", stderr: "ignore" });
      if (result.exitCode !== 0) fail("could not prepare pinned benchmark worktree");
      worktrees.push(path);
      symlinkSync(join(repository, "node_modules"), join(path, "node_modules"));
    }
    const paths = gitNulList(repository, ["diff", "--name-only", "--diff-filter=ACMR", "-z", config.inputBase, config.inputHead]);
    if (paths.length === 0) fail("historical input range has no changed files");
    const samples: Array<{ repetition: number; entryPoint: string; state: string; baseline: Run; candidate: Run; identical: boolean }> = [];
    for (let repetition = 1; repetition <= config.samples; repetition += 1) {
      for (const entryPoint of ["pre-commit", "pre-push"] as const) {
        const args = entryPoint === "pre-commit"
          ? ["--require-known-values", "--paths", ...paths]
          : ["--base", config.inputBase, "--require-known-values", "--check-commits"];
        const baselineCache = join(root, `cache-${repetition}-${entryPoint}-baseline`);
        const candidateCache = join(root, `cache-${repetition}-${entryPoint}-candidate`);
        mkdirSync(baselineCache, { recursive: true, mode: 0o700 });
        mkdirSync(candidateCache, { recursive: true, mode: 0o700 });
        for (const state of ["cold", "warm"] as const) {
          const baseline = await runGate(baselineDir, inputDir, args, baselineCache, false, config);
          const candidate = await runGate(candidateDir, inputDir, args, candidateCache, false, config);
          samples.push({ repetition, entryPoint, state, baseline, candidate,
          identical: baseline.exitCode === candidate.exitCode && baseline.report.equals(candidate.report) });
        }
      }
    }
    for (const entryPoint of ["pre-commit", "pre-push"] as const) {
      const args = entryPoint === "pre-commit"
        ? ["--require-known-values", "--paths", ...paths]
        : ["--base", config.inputBase, "--require-known-values", "--check-commits"];
      const baseline = await runGate(baselineDir, inputDir, args, join(root, `cache-ci-${entryPoint}-baseline`), true, config);
      const candidate = await runGate(candidateDir, inputDir, args, join(root, `cache-ci-${entryPoint}-candidate`), true, config);
      comparisons.push({ entryPoint, ci: true, baseline, candidate,
        identical: baseline.exitCode === candidate.exitCode && baseline.report.equals(candidate.report) });
    }
    const result = {
      schemaVersion: 1,
      baseline: config.baseline,
      candidate: config.candidate,
      inputBase: config.inputBase,
      inputHead: config.inputHead,
      sampleCount: config.samples,
      changedPathCount: paths.length,
      runs: samples.map((row) => {
        return {
          repetition: row.repetition, entryPoint: row.entryPoint, state: row.state,
          baselineExitCode: row.baseline.exitCode, candidateExitCode: row.candidate.exitCode,
          baselineReportBytes: row.baseline.reportBytes, candidateReportBytes: row.candidate.reportBytes,
          baselineReportSha256: row.baseline.reportSha256, candidateReportSha256: row.candidate.reportSha256,
          baselineCpuSeconds: Number(row.baseline.cpuSeconds.toFixed(6)), candidateCpuSeconds: Number(row.candidate.cpuSeconds.toFixed(6)),
          baselineWallSeconds: Number(row.baseline.wallSeconds.toFixed(6)), candidateWallSeconds: Number(row.candidate.wallSeconds.toFixed(6)),
          identical: row.identical,
        };
      }),
      ciComparisons: comparisons.map((row) => {
        const item = row as { entryPoint: string; identical: boolean; baseline: Run; candidate: Run };
        return { entryPoint: item.entryPoint, identical: item.identical,
          baselineExitCode: item.baseline.exitCode, candidateExitCode: item.candidate.exitCode,
          baselineReportBytes: item.baseline.reportBytes, candidateReportBytes: item.candidate.reportBytes,
          baselineReportSha256: item.baseline.reportSha256, candidateReportSha256: item.candidate.reportSha256 };
      }),
    };
    if (result.runs.some((row) => !row.identical) || result.ciComparisons.some((row) => !row.identical)) fail("baseline and candidate CLI reports differ; no measurement file was written");
    mkdirSync(dirname(config.outputFile), { recursive: true });
    writeFileSync(config.outputFile, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    const medians = (entryPoint: string, state: string, side: "baselineCpuSeconds" | "candidateCpuSeconds") => {
      const values = result.runs.filter((row) => row.entryPoint === entryPoint && row.state === state).map((row) => row[side] as number).sort((a, b) => a - b);
      return values[Math.floor(values.length / 2)];
    };
    for (const entryPoint of ["pre-commit", "pre-push"]) for (const state of ["cold", "warm"]) {
      const before = medians(entryPoint, state, "baselineCpuSeconds");
      const after = medians(entryPoint, state, "candidateCpuSeconds");
      process.stdout.write(`${entryPoint} ${state}: ${before.toFixed(3)} -> ${after.toFixed(3)} CPU-s (${(before / after).toFixed(2)}x)\n`);
    }
    process.stdout.write(`CLI reports identical: ${result.runs.length} local comparisons; ${result.ciComparisons.length} CI comparisons. Sanitized samples written.\n`);
  } finally {
    for (const path of worktrees.reverse()) {
      Bun.spawnSync(["git", "-C", repository, "worktree", "remove", "--force", path], { stdout: "ignore", stderr: "ignore" });
    }
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
