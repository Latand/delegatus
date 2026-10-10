import { expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import { externalRelayFile } from "@/lib/externalRelay/store";
import { bindSpawnDiagnostics, spawnDiagnosticError, withSpawnDiagnostics } from "./spawnDiagnostics";

test("ordinary spawn diagnostics keep their caller attribution and object fields", () => {
  const fields = { launchId: "launch_fixture", conversationId: "conversation_fixture", error: new Error("fixture error") };
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    withSpawnDiagnostics("ordinary_fixture", () => spawnDiagnosticError("Launch failed", fields));
    expect(logger).toHaveBeenCalledWith("Launch failed", fields);
  } finally { logger.mockRestore(); }
});

test("deferred owner diagnostics retain their scope and withhold unserializable input", () => {
  const emitted: unknown[][] = [];
  const logger = spyOn(console, "error").mockImplementation((...args) => { emitted.push(args); });
  try {
    const report = withSpawnDiagnostics("relay-owner-fixture", () => bindSpawnDiagnostics(() => {
      spawnDiagnosticError("Launch failed", { conversationId: "conversation_fixture", get error() { throw Error("private input"); } });
    }));
    report();
    expect(emitted).toEqual([["Owner relay diagnostic unavailable; sensitive details withheld"]]);
  } finally { logger.mockRestore(); }
});

test("a failed credential resolver cannot expose an owner diagnostic", () => {
  const emitted: unknown[][] = [];
  const logger = spyOn(console, "error").mockImplementation((...args) => { emitted.push(args); });
  const read = fs.readFileSync.bind(fs);
  const reader = spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (String(file) === externalRelayFile("relays")) throw Error("credential store unavailable");
    return (read as (...args: unknown[]) => unknown)(file, ...args);
  }) as typeof fs.readFileSync);
  try {
    withSpawnDiagnostics("relay-owner-fixture", () => spawnDiagnosticError(new Error("sensitive payload")));
    expect(emitted).toEqual([["Owner relay diagnostic unavailable; sensitive details withheld"]]);
  } finally { reader.mockRestore(); logger.mockRestore(); }
});
