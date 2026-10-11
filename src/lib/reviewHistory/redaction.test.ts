import path from "node:path";
import { expect, test } from "bun:test";
import { redactArchive, sensitiveKey } from "./redaction";

test.each([
  ["apiKey", true], ["APIToken", true], ["DBPassword", true],
  ["HTTPAuthorization", true], ["TLSPrivateKey", true], ["api_key", true],
  ["api-key", true], ["auth.password", true], ["PRIVATE KEY", true],
  ["DBPasswordHash", true], ["clientSecret", true], ["accessTokenValue", true], ["PRIVATE KEY VALUE", true],
  ["pAsSwOrD", true], ["aPiKeY", true],
  ["tokenCount", false], ["APITokenCount", false], ["token_count", false],
  ["token-count", false], ["token.count", false], ["passwordChanged", false],
  ["DBPasswordChanged", false], ["secretary", false], ["receiptId", false],
] as const)("credential classification: %s", (key, expected) => {
  expect(sensitiveKey(key)).toBe(expected);
});

test("ordinary quotation and backslashes remain prose; binary text refuses export", () => {
  for (const prose of ['ordinary "quotes"', String.raw`Use "\d+" literally`, "unfinished 'prose", String.raw`escaped \"ordinary\" prose`]) {
    expect(redactArchive(prose)).toBe(prose);
  }
  expect(() => redactArchive("binary\0text")).toThrow("ARCHIVE_UNAVAILABLE");
});

test("long benign prose and identifiers scale within a bounded child deadline", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const { redactArchive } = await import(${JSON.stringify(path.join(import.meta.dir, "redaction.ts"))});
      const measure = input => {
        const start = process.cpuUsage();
        const unchanged = redactArchive(input) === input;
        const cpu = process.cpuUsage(start);
        return { cpuMs: (cpu.user + cpu.system) / 1000, unchanged };
      };
      const results = ["ordinary line ", "ordinary-line-"].map(prefix => {
        const small = prefix.repeat(8_192), large = prefix.repeat(65_536);
        redactArchive(small);
        const calibration = Array.from({ length: 3 }, () => measure(small).cpuMs);
        const measured = measure(large);
        return { smallCpuMs: Math.max(...calibration), largeCpuMs: measured.cpuMs, unchanged: measured.unchanged };
      });
      console.log(JSON.stringify(results));
    `],
    env: { ...process.env }, stdout: "pipe", stderr: "pipe",
  });
  let expired = false;
  // Growth is asserted with CPU time. Allow ample wall time for a busy host.
  const deadline = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 60_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(expired).toBeFalse();
    if (code !== 0) throw new Error(stderr);
    const results = JSON.parse(stdout) as Array<{ smallCpuMs: number; largeCpuMs: number; unchanged: boolean }>;
    if (process.env.LLV_REDACTION_TIMINGS === "1") console.error(JSON.stringify(results));
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.unchanged).toBeTrue();
      // Eight times the input gets three times the linear growth allowance.
      // CPU time excludes scheduler waits; the floor absorbs short-scan noise.
      expect(result.largeCpuMs).toBeLessThan(Math.max(100, result.smallCpuMs * 24));
    }
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
  }
}, 90_000);
