import fs from "node:fs";
import { expect, test } from "bun:test";

import { DELEGATUS_DOCKER_NAMES, LEGACY_DOCKER_NAMES, type DockerNameSpelling } from "../src/runtime-host/dockerNames";
import type { RuntimeHostReleaseRecord, RuntimeHostRollbackIntent } from "../src/runtime-host/hostRelease";
import {
  completeRuntimeHostRollback,
  requestRuntimeHostRollback,
  resumeRuntimeHostRollback,
  runtimeHostRollbackTargetFromHandoff,
} from "../src/runtime-host/hostRollback";
import { runtimeHostSuccessorName } from "../src/runtime-host/hostSuccessor";
import { parseRollbackArguments, renderRuntimeHostRollbackPlan } from "./rollback-runtime-host";

const source = fs.readFileSync(new URL("./rollback-runtime-host.ts", import.meta.url), "utf8");

test("issue 1270: runtime-host rollback plans by default and needs explicit execution", () => {
  expect(parseRollbackArguments([])).toEqual({ execute: false });
  expect(parseRollbackArguments(["--execute"])).toEqual({ execute: true });
  expect(() => parseRollbackArguments(["--force"])).toThrow("unsupported option --force");
});

test("issue 1270: rollback starts from durable state without the failing listener", () => {
  expect(source).toContain("readRuntimeHostRollbackTarget");
  expect(source).toContain("runtimeHostRollbackTargetFromHandoff");
  expect(source).toContain("requestRuntimeHostRollback");
  expect(source).not.toContain("runtime-host.sock");
  expect(source).not.toContain("scripts/rebuild.sh");
  expect(source).not.toContain("fetch(");
  expect(source).not.toContain("curl");
});

function generation(names: DockerNameSpelling, revision: string): RuntimeHostReleaseRecord {
  const image = `${names.imageRepository}:hostboot-${revision}`;
  return {
    image,
    revision,
    container: runtimeHostSuccessorName(revision, image, names),
    endpoint: "http://127.0.0.1:8898",
    stagedAt: "2026-09-23T00:00:00.000Z",
  };
}

/* Rename slice 3 (docs/design/rename-delegatus.md §6.6): the release that
   switches to the delegatus names is handed over by, and rolls back to, one
   named the old way, and a later rollback can run the other way round. The
   retained generation runs this release's code either way. */
for (const [failedNames, retainedNames] of [
  [DELEGATUS_DOCKER_NAMES, LEGACY_DOCKER_NAMES],
  [LEGACY_DOCKER_NAMES, DELEGATUS_DOCKER_NAMES],
] as const) {
  test(`rename slice 3: a rollback from ${failedNames.runtimeHostPrefix}* to ${retainedNames.runtimeHostPrefix}* finds, stops and removes the failed generation`, async () => {
    const failed = generation(failedNames, "d".repeat(40));
    const retained = generation(retainedNames, "a".repeat(40));
    expect(failed.container.startsWith(failedNames.runtimeHostPrefix)).toBe(true);
    expect(retained.image.startsWith(`${retainedNames.imageRepository}:`)).toBe(true);
    const target = runtimeHostRollbackTargetFromHandoff({
      revision: failed.revision,
      image: failed.image,
      successorContainer: failed.container,
      predecessorId: retained.container,
      previousRelease: retained,
      successorRelease: failed,
      recordedAt: failed.stagedAt,
    });
    if (!target) throw new Error("the handoff did not yield a rollback target");

    const plan = renderRuntimeHostRollbackPlan(target);
    expect(plan).toContain(`failed generation    ${failed.revision} (${failed.container})`);
    expect(plan).toContain(`retained generation  ${retained.revision} (${retained.container})`);

    const docker: string[] = [];
    const written: { intent: RuntimeHostRollbackIntent | null; release: RuntimeHostReleaseRecord | null } = { intent: null, release: null };
    await requestRuntimeHostRollback(target, {
      writeIntent: (value) => { written.intent = value; },
      writeRelease: (value) => { written.release = value; },
      enablePreviousRestart: async (container) => { docker.push(`update --restart unless-stopped ${container}`); },
      startPrevious: async (container) => { docker.push(`start ${container}`); },
    });
    expect(written.release).toEqual(retained);
    expect(docker).toEqual([`update --restart unless-stopped ${retained.container}`, `start ${retained.container}`]);

    const self = { image: retained.image, revision: retained.revision, container: retained.container };
    expect(await resumeRuntimeHostRollback(self, {
      readIntent: () => written.intent,
      disableActiveRestart: async (container) => { docker.push(`update --restart no ${container}`); },
      stopActive: async (container) => { docker.push(`stop ${container}`); },
    })).toBe(true);
    expect(await completeRuntimeHostRollback(self, {
      readIntent: () => written.intent,
      readHandoffIntent: () => null,
      removeFailed: async (container) => { docker.push(`rm -f ${container}`); },
      clearHandoffIntent: () => {},
      clearIntent: () => { written.intent = null; },
    })).toBe(true);
    expect(docker.slice(2)).toEqual([
      `update --restart no ${failed.container}`,
      `stop ${failed.container}`,
      `rm -f ${failed.container}`,
    ]);
    expect(written.intent).toBeNull();
  });
}
