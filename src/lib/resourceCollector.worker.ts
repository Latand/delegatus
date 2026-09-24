import "./resourceCollector.workerMode";

import { existsSync } from "node:fs";
import { parentPort } from "node:worker_threads";

import { createTranscriptHostObserver } from "./agent/transcriptHost";
import { procBackend } from "./proc";
import { agentProcesses, readStructuredHostStamp } from "./scanner/process";
import { buildResourceSnapshot, lastResourceBuildDiagnostic, lastResourceTargetRefs, RESOURCE_WORKER_OUTPUT_MAX_BYTES } from "./resources";
import { resourceWorkerRequestProblem, type ResourceWorkerRequest } from "./resourceWorkerRequest";
import { captureTmuxAttachReferences, panePidMap, tmuxServerPid } from "./tmux";
import type { FileEntry } from "./types";

function send(message: unknown): void {
  if (parentPort) {
    parentPort.postMessage(message);
    return;
  }
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function collect(message: unknown): Promise<void> {
  const problem = resourceWorkerRequestProblem(message);
  if (problem) {
    send({ type: "failure", error: `resource collector received an invalid request: ${problem}`.slice(0, 4_096) });
    return;
  }
  const request = message as ResourceWorkerRequest;
  try {
    const conversationByPath = new Map(request.files.flatMap((entry) => entry.conversationId ? [[entry.path, entry.conversationId] as const] : []));
    const readHosts = createTranscriptHostObserver({
      listFiles: async () => request.files as FileEntry[],
      panes: panePidMap,
      ppidMap: () => procBackend.ppidMap(),
      agents: agentProcesses,
      serverPid: tmuxServerPid,
      resumeRecords: async () => null,
      identity: procBackend.processIdentity,
      writesPath: procBackend.pidWritesPath,
      conversationIdForPath: (pathname) => conversationByPath.get(pathname) ?? null,
    });
    const payload = await buildResourceSnapshot(request.fresh, {
      readFiles: async () => request.files,
      readHosts: (fresh, entries, ppids) => readHosts(fresh, entries as FileEntry[], ppids),
      proc: procBackend,
      captureAttachReferences: captureTmuxAttachReferences,
      readStructuredHosts: async () => request.hosts,
      listAgentProcesses: agentProcesses,
      directoryExists: (directory) => existsSync(directory),
      processIdentity: procBackend.processIdentity,
      bootEpoch: () => request.identityEpoch,
      hostStamp: readStructuredHostStamp,
    });
    const diagnostic = lastResourceBuildDiagnostic();
    if (!diagnostic) throw new Error("resource worker completed without diagnostics");
    send({ type: "observation", payload, diagnostic, targets: lastResourceTargetRefs() });
  } catch (error) {
    send({ type: "failure", error: error instanceof Error ? error.message : String(error) });
  }
}

if (parentPort) {
  parentPort.on("message", (message: unknown) => { void collect(message); });
} else {
  let input = "";
  let inputBytes = 0;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes <= RESOURCE_WORKER_OUTPUT_MAX_BYTES) input += chunk;
  });
  process.stdin.on("end", () => {
    if (inputBytes > RESOURCE_WORKER_OUTPUT_MAX_BYTES) {
      send({ type: "failure", error: "resource collector input exceeded transport limit" });
      return;
    }
    try {
      void collect(JSON.parse(input));
    } catch (error) {
      send({ type: "failure", error: error instanceof Error ? error.message : String(error) });
    }
  });
}
