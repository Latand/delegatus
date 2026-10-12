import { expect, test } from "bun:test";
import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsJobSetup } from "./helper-lease-windows.mjs";

// Run the production setup boundary with a delayed subprocess receipt. The
// native lifecycle suite separately proves the PowerShell kernel operations.
test("Windows containment accepts a setup receipt after the former five-second cut", () => {
  const handle = String(process.pid);
  const start = String(BigInt(10) ** BigInt(18));
  const begun = performance.now();
  const run = (command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => {
    expect(command).toBe("powershell.exe");
    expect(args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    const script = Buffer.from(args[3], "base64").toString("utf16le");
    expect(script).toContain("[HelperJob]::Install($guardian)");
    return spawnSync(process.execPath, ["-e", `setTimeout(() => process.stdout.write(${JSON.stringify(`${handle}:${start}`)}), 6000);`], options);
  };
  expect(windowsJobSetup(run)).toEqual({ handle, start });
  expect(performance.now() - begun).toBeGreaterThanOrEqual(6000);
}, 20_000);

for (const receipt of ["", "invalid", "0:invalid", "12:34"]) {
  test(`Windows containment refuses an invalid setup receipt (${receipt || "empty"})`, () => {
    const run = (_command: string, _args: string[], options: SpawnSyncOptionsWithStringEncoding) =>
      spawnSync(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(receipt)});`], options);
    expect(() => windowsJobSetup(run)).toThrow("could not establish Windows job ownership");
  });
}

test("Windows containment refuses a failing setup even with a valid receipt", () => {
  const receipt = `${process.pid}:${BigInt(10) ** BigInt(18)}`;
  const run = (_command: string, _args: string[], options: SpawnSyncOptionsWithStringEncoding) =>
    spawnSync(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(receipt)}); process.exit(1);`], options);
  expect(() => windowsJobSetup(run)).toThrow("could not establish Windows job ownership");
});

test.if(process.platform === "win32")("native Windows setup retains containment after six seconds of cold-start delay", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "helper-job-setup-"));
  const entry = path.join(root, "setup.mjs");
  try {
    fs.writeFileSync(entry, `import { spawnSync } from "node:child_process";
      import { windowsJobSetup } from ${JSON.stringify(new URL("./helper-lease-windows.mjs", import.meta.url).href)};
      const begun = performance.now();
      const job = windowsJobSetup((command, args, options) => {
        const script = Buffer.from(args[3], "base64").toString("utf16le");
        args[3] = Buffer.from("Start-Sleep -Seconds 6; " + script, "utf16le").toString("base64");
        return spawnSync(command, args, options);
      });
      console.log(JSON.stringify({ job, elapsedMs: performance.now() - begun }));`);
    const result = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout.trim());
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(6000);
    expect(receipt.job.handle).toMatch(/^[1-9][0-9]*$/);
    expect(receipt.job.start).toMatch(/^[0-9]{18,19}$/);
    console.log(`Native Windows job setup with injected 6000 ms delay: ${receipt.elapsedMs.toFixed(0)} ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 25_000);
