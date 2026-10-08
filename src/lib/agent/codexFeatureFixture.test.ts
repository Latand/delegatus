import { expect, test } from "bun:test";
import { codexSubagentArgs, readCodexFeatures, setCodexFeatureReaderForTest } from "./codexSpawnPolicy";

test("preloaded feature inventory makes fake launchers independent of the installed CLI", () => {
  const binary = "missing-codex-fixture-binary";
  const features = readCodexFeatures(binary);
  expect(features.map((feature) => feature.name)).toContain("multi_agent_v2");
  const args = codexSubagentArgs(binary);
  for (const name of ["multi_agent", "multi_agent_v2", "memories", "future_worker"]) {
    expect(args[args.indexOf(name) - 1]).toBe("--disable");
  }
  expect(args).not.toContain("shell_tool");
  expect(codexSubagentArgs(binary, true)).toEqual(["-c", "agents.enabled=true"]);
});

test("native feature probes explicitly opt in and restore the process fixture", () => {
  const binary = "missing-codex-fixture-binary";
  const fixture = readCodexFeatures(binary);
  const restore = setCodexFeatureReaderForTest(undefined);
  try {
    expect(() => readCodexFeatures(binary)).toThrow("refuses this launch");
  } finally { restore(); }
  expect(readCodexFeatures(binary)).toEqual(fixture);
});
