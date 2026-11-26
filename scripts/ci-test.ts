import { statSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Explicit files before `--`, Bun test options after it. No directory sweeps. */
export async function runCiTests(args: string[]): Promise<number> {
  const separator = args.indexOf("--");
  const files = separator < 0 ? args : args.slice(0, separator);
  const options = separator < 0 ? [] : args.slice(separator + 1);
  if (!files.length) throw new Error("ci-test: name at least one test file");
  for (const file of files) {
    if (!/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) || !statSync(file, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`ci-test: named test file is missing or invalid: ${file}`);
    }
  }
  const directory = mkdtempSync(join(tmpdir(), "ci-test-"));
  try {
    for (const file of files) {
      const report = join(directory, "result.xml");
      rmSync(report, { force: true });
      const result = Bun.spawn([process.execPath, "test", isAbsolute(file) ? file : `./${file}`, ...options,
        "--reporter=junit", "--reporter-outfile", report], {
        stdin: "ignore", stdout: "inherit", stderr: "inherit",
      });
      const code = await result.exited;
      if (code !== 0) return code;
      // The reporter belongs to this invocation. Console text can come from a
      // test or preload; a successful exit alone also admits empty selections.
      let xml: string;
      try { xml = readFileSync(report, "utf8"); }
      catch { throw new Error(`ci-test: no test report for ${file}`); }
      const header = /<testsuites\b([^>]*)>/.exec(xml)?.[1] ?? "";
      const count = (name: string) => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(header)?.[1] ?? NaN);
      if (!(count("tests") > count("skipped")) || count("failures") !== 0 || /<(?:failure|error)\b/.test(xml)) {
        throw new Error(`ci-test: no passing tests ran in ${file}`);
      }
      console.log(`ci-test: verified ${file}`);
    }
    return 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try { process.exitCode = await runCiTests(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "ci-test: test verification failed");
    process.exitCode = 1;
  }
}
