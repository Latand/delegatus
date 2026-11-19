import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { workflowEntries } from "./ci-platform-scope";

const command = join(import.meta.dir, "ci-test.ts");

test("CI refuses missing files before dispatch and requires real passing tests in every file", async () => {
  const root = mkdtempSync(join(tmpdir(), "ci-test-fixture-"));
  try {
    writeFileSync(join(root, "pass.test.ts"), 'import { test, expect } from "bun:test"; test("runs", () => expect(1).toBe(1));');
    writeFileSync(join(root, "empty.test.ts"), 'console.log("1 pass\\nRan 1 test across 1 file.");');
    writeFileSync(join(root, "skip.test.ts"), 'import { test } from "bun:test"; test.skip("skipped", () => {});');
    writeFileSync(join(root, "fail.test.ts"), 'import { test, expect } from "bun:test"; test("fails", () => expect(1).toBe(2));');
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, command, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, output: out + err };
    };
    const green = await run(["pass.test.ts"]);
    expect(green.code, green.output).toBe(0);
    expect(green.output).toContain("ci-test: verified pass.test.ts");
    const missing = await run(["pass.test.ts", "missing.test.ts"]);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain("named test file is missing or invalid: missing.test.ts");
    expect(missing.output).not.toContain("ci-test: verified");
    for (const args of [[], ["empty.test.ts"], ["skip.test.ts"], ["fail.test.ts"],
      ["pass.test.ts", "empty.test.ts"], ["pass.test.ts", "--", "-t", "absent"]]) {
      const red = await run(args);
      expect(red.code, JSON.stringify({ args, output: red.output })).not.toBe(0);
    }
    const filtered = await run(["pass.test.ts", "--", "-t", "runs"]);
    expect(filtered.code, filtered.output).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test("the replay workflow step passes and refuses a deleted or empty named file", async () => {
  const repository = join(import.meta.dir, "..");
  const workflow = Bun.YAML.parse(readFileSync(join(repository, ".github/workflows/memory-selection.yml"), "utf8")) as {
    jobs: { replay: { steps: Array<{ run?: string }> } };
  };
  const script = workflow.jobs.replay.steps.find(step => step.run?.includes("scripts/ci-test.ts"))!.run!;
  const files = workflowEntries(script).filter(file => file.endsWith(".test.ts"));
  const root = mkdtempSync(join(tmpdir(), "ci-workflow-"));
  try {
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/ci-test.ts"), readFileSync(command));
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), 'import { test } from "bun:test"; test("runs", () => {});');
    }
    const run = async () => {
      const child = Bun.spawn(["bash", "-c", script], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      return { code, output: out + err };
    };
    expect(files.length).toBeGreaterThan(0);
    const green = await run();
    expect(green.code, green.output).toBe(0);
    rmSync(join(root, files[0]!));
    const missing = await run();
    expect(missing.code).toBe(1);
    expect(missing.output).toContain(`named test file is missing or invalid: ${files[0]}`);
    writeFileSync(join(root, files[0]!), "");
    expect((await run()).code).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
