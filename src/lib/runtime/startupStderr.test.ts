import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STDERR_READ_BYTES, startupStderrText } from "./startupStderr";

function diagnostic(text: string, limit = 2048): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-stderr-"));
  const file = path.join(root, "stderr");
  let fd: number | undefined;
  try {
    fs.writeFileSync(file, text);
    fd = fs.openSync(file, "r");
    return startupStderrText(fd, fs.fstatSync(fd).size, limit);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("short startup stderr keeps its redacted cause without a clipping notice", () => {
  expect(diagnostic("EADDRINUSE: callback bind refused\nBearer " + "private".repeat(8)))
    .toBe("EADDRINUSE: callback bind refused\nBearer [redacted]");
});

test.each([2049, STDERR_READ_BYTES - 1, STDERR_READ_BYTES, STDERR_READ_BYTES + 1, STDERR_READ_BYTES * 2])(
  "startup stderr keeps a clipping notice at %s bytes",
  size => {
    const cause = "EADDRINUSE: callback bind refused\n";
    // A snapshot may observe the independent drain at any of these sizes.
    const result = diagnostic(cause + "x".repeat(size - cause.length));
    expect(result).toStartWith(cause);
    expect(result).toEndWith("[stderr clipped]");
    expect(result.length).toBeLessThanOrEqual(2048);
  },
);

test("read clipping survives a long retained complete line", () => {
  const result = diagnostic("EADDRINUSE: callback bind refused\n" + "x".repeat(4000) + "\n" + "y".repeat(STDERR_READ_BYTES));
  expect(result).toStartWith("EADDRINUSE: callback bind refused\n");
  expect(result).toEndWith("[stderr clipped]");
  expect(result.length).toBeLessThanOrEqual(2048);
});

test.each([false, true])("read clipping stays visible after redacting a key block: complete=%s", complete => {
  const result = diagnostic("EADDRINUSE: callback bind refused\n-----BEGIN PRIVATE KEY-----\n"
    + "KEYPAYLOAD\n".repeat(20) + (complete ? "-----END PRIVATE KEY-----\n" : "") + "x".repeat(STDERR_READ_BYTES));
  expect(result).toStartWith("EADDRINUSE: callback bind refused\n[redacted]");
  expect(result).not.toContain("KEYPAYLOAD");
  expect(result).not.toContain("PRIVATE KEY");
  expect(result).toEndWith("[stderr clipped]");
  expect(result.length).toBeLessThanOrEqual(2048);
});

test.each([0, 1, 15, 16, 32, 64])("clipping respects a custom diagnostic limit of %s", limit => {
  const result = diagnostic("EADDRINUSE: callback bind refused\n" + "x".repeat(100), limit);
  expect(result.length).toBeLessThanOrEqual(limit);
  if (limit >= "[stderr clipped]".length) expect(result).toEndWith("[stderr clipped]");
});
