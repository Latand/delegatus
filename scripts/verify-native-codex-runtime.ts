import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** `--engine-only` runs the files that start the Codex executable named on the
    command line, the only part whose verdict depends on the Codex version.
    `--shared-only` runs the rest without a Codex fixture argument or executable.
    Together they are exactly the default selection: the pre-push hook runs the
    engine part once per supported version and the shared part once. */
export const SELECTIONS = ["--steering-only", "--engine-only", "--shared-only"] as const;
export type Selection = (typeof SELECTIONS)[number];

/* The files that start the executable through NATIVE_CODEX_QUEUE_TEST_BINARY,
   LLV_CODEX_HISTORY_CLI or LLV_CODEX_BINARY. They share one process, as they
   do inside the main batch below. */
export const engineFiles = [
  "src/lib/runtime/nativeCodexQueue.test.ts",
  "src/lib/runtime/codexHistoryReader.test.ts",
  "src/lib/runtime/nativeQueueCompaction.integration.test.ts",
  "src/lib/runtime/nativeQueueHost.integration.test.ts",
  "src/lib/runtime/codexSteerDelivery.integration.test.ts",
];
/* Engine files that install globals: one process each, like the other
   injection files. */
export const engineInjectionFiles = [
  "src/lib/runtime/codexAppServerHost.injectResponses.test.ts",
  "src/lib/runtime/codexAppServerHost.injectCli.test.ts",
];

export const files = [
  "src/lib/runtime/nativeCodexQueue.test.ts",
  "src/lib/runtime/codexHistoryReader.test.ts",
  "src/lib/runtime/nativeQueueRuntime.test.ts",
  "src/lib/runtime/nativeQueueContent.test.ts",
  "src/runtime-host/nativeQueueJournal.test.ts",
  // #1664: native entries through journal compaction, and evidence-only recovery.
  "src/runtime-host/nativeQueueCompaction.test.ts",
  "src/lib/runtime/nativeQueueCompaction.integration.test.ts",
  "src/lib/runtime/nativeQueueHost.integration.test.ts",
  "src/lib/runtime/codexSteerDelivery.integration.test.ts",
  "src/lib/runtime/codexTurnProfile.test.ts",
  "src/lib/runtime/codexAppServerHost.test.ts",
  "src/lib/runtime/claudeStreamBrokerHost.test.ts",
  "src/lib/runtime/structuredDeliveryQueue.test.ts",
  "src/lib/runtime/structuredDeliveryController.test.ts",
  "src/lib/runtime/engineHostEvents.test.ts",
  "src/lib/runtime/codex.test.ts",
  "src/lib/runtime/eventStore.test.ts",
  "src/lib/runtime/commands.test.ts",
  "src/lib/runtime/realtimeControl.selectedContext.test.ts",
  "src/lib/runtime/voiceViewBinding.test.ts",
  "src/lib/runtime/voicePersonaRole.test.ts",
  "src/lib/runtime/voiceDelivery.test.ts",
  "src/lib/runtime/voiceStreamChunks.test.ts",
  // #1629 experience stage: the queue the operator touches, and the voice
  // repairs the independent review of the component branch required.
  "src/lib/runtime/codexRealtimeTranscript.test.ts",
  "src/lib/mcp/nativeWorkMetadata.test.ts",
  "src/lib/mcp/voiceUtteranceWiring.test.ts",
  "src/components/nativeQueueView.test.ts",
  /* The delivery contracts the native queue shares with every other send. This
     file is green on the default branch and was red at this branch's head for
     two of them (an explicit-null turn fence read as an idle fence, and an
     undeclared steering capability read as a refusal), and nothing reported it:
     the branch never touched this file, so no reviewer ran it. A shared contract
     is verified by the suites of its dependents or by nobody. */
  "src/lib/runtime/structuredDelivery.integration.test.ts",
];

// These files install and remove a registry singleton. Give each its own
// process so later files cannot inherit a registry whose fixture was removed.
export const registryFiles = [
  "src/lib/runtime/voicePersonaMandate.test.ts",
  "src/lib/mcp/voiceUtteranceContext.test.ts",
];

export const injectionFiles = [
  "src/lib/runtime/codexAppServerHost.injectResponses.test.ts",
  "src/lib/runtime/codexAppServerHost.inject.test.ts",
  "src/lib/runtime/codexAppServerHost.injectCli.test.ts",
  "src/lib/runtime/structuredDeliveryQueue.inject.test.ts",
  "src/runtime-host/journal.inject.test.ts",
  "src/lib/runtime/http.inject.test.ts",
  "src/lib/runtime/commands.inject.test.ts",
  "src/components/ComposerBar.dom.test.tsx",
  "src/components/TmuxComposer.inject.dom.test.tsx",
  "src/components/TmuxComposer.injectReceipts.dom.test.tsx",
];

/* #1652's attachment retention, which ships beside injection (#1689): the
   retained queue admissions, the queue route's files, every inbox writer under
   one key, the admitted retry over a real journal, and the composer's
   reconciliation and pending-image suites. Each installs its own globals, so
   each runs in its own process like the injection files. */
export const attachmentFiles = [
  "src/components/retainedQueueAdmissions.dom.test.ts",
  "src/lib/runtime/nativeQueueHttp.files.test.ts",
  "src/lib/runtime/inboxWriters.integration.test.ts",
  "src/lib/runtime/composerPayloadRetry.integration.test.ts",
  "src/lib/inboxFiles.test.ts",
  "src/components/TmuxComposer.test.ts",
  "src/components/TmuxComposer.reconciliation.dom.test.tsx",
  "src/components/TmuxComposer.reconciliationExpiry.dom.test.tsx",
  "src/components/TmuxComposer.pendingImages.dom.test.tsx",
];

/**
 * The browser half, run in its own process.
 *
 * Every one of these installs its own happy-dom window over the same globals,
 * and Bun runs a `bun test <files…>` invocation in ONE process — so a DOM file
 * sharing a process with the runtime files above starts inheriting whichever
 * document loaded first. They are a separate spawn for that reason, not because
 * they are optional.
 */
export const domFiles = [
  "src/components/NativeQueuePanel.dom.test.tsx",
  "src/components/TmuxComposer.nativeQueue.dom.test.tsx",
  "src/components/VoiceConversation.dom.test.tsx",
  "src/lib/realtime/voiceCardChain.dom.test.ts",
  "src/lib/realtime/voiceCanonicalTranscript.dom.test.ts",
  "src/lib/realtime/codexRealtimeClient.selectedContext.dom.test.ts",
  "src/lib/realtime/codexRealtimeClient.transport.dom.test.ts",
];
/** The batches a selection runs, each one `bun test` process. */
export function nativeBatches(selection?: Selection): string[][] {
  const singles = [...domFiles, ...registryFiles, ...injectionFiles, ...attachmentFiles];
  if (selection === "--steering-only") return [["src/lib/runtime/codexSteerDelivery.integration.test.ts"]];
  if (selection === "--engine-only") return [engineFiles, ...engineInjectionFiles.map(file => [file])];
  if (selection === "--shared-only") {
    const engine = new Set([...engineFiles, ...engineInjectionFiles]);
    return [files.filter(file => !engine.has(file)), ...singles.filter(file => !engine.has(file)).map(file => [file])];
  }
  return [files, ...singles.map(file => [file])];
}

if (import.meta.main) {
  const sharedOnly = process.argv[2] === "--shared-only" && process.argv[3] === undefined;
  const binary = sharedOnly ? undefined : process.argv[2];
  const selection = sharedOnly ? "--shared-only" : process.argv[3];
  if (selection !== undefined && !(SELECTIONS as readonly string[]).includes(selection)) throw new Error(`Only ${SELECTIONS.join(", ")} are supported as a selection`);
  if (!sharedOnly && (!binary || !isAbsolute(binary) || !existsSync(binary))) throw new Error("Pass an absolute Codex fixture executable");
  const roots = mkdtempSync(join(tmpdir(), "n-"));
  const bin = join(roots, "bin"); mkdirSync(bin); symlinkSync(process.execPath, join(bin, "bun"));
  const env: NodeJS.ProcessEnv = {
    PATH: [bin, dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    LANG: "C.UTF-8", NODE_ENV: "test",
    ...(selection === "--shared-only" ? {} : {
      NATIVE_CODEX_QUEUE_TEST_BINARY: binary,
      LLV_CODEX_HISTORY_CLI: binary,
      LLV_CODEX_BINARY: binary,
    }),
    LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1",
  };
  // Nested test runners need the existing manager connection for containment.
  for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GEMINI_CLI_HOME", "LLV_STATE_DIR", "TMPDIR"]) {
    env[key] = join(roots, key === "TMPDIR" ? "t" : key.toLowerCase()); mkdirSync(env[key]!);
  }
  const batches = nativeBatches(selection as Selection | undefined);
  for (const file of batches.flat()) if (!existsSync(file)) throw new Error(`Missing named native runtime check: ${file}`);
  for (const file of batches.flat()) {
    const result = spawnSync(process.execPath, ["test", file], { env, stdio: "inherit", timeout: 300_000, killSignal: "SIGKILL" });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
