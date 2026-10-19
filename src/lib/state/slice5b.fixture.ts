import path from "node:path";
import { pushSubscriptionStore, pushSentStore } from "@/lib/push";
import { presetStore } from "@/lib/flows/store";
import { templateStore } from "@/lib/workflows/store";
import { rolePresetStore } from "@/lib/roles/store";
import { nestingPolicyStore } from "@/lib/agent/nestingPolicy";
import { rootLineageStore } from "@/lib/root/store";
import { telegramReportStore } from "@/lib/telegram/reportStore";
import { telegramRegistrationStore } from "@/lib/telegram/hostRegistration";
import type { LegacyDocumentStore } from "./legacyDocumentStore";

const config = { engine: "codex", model: "gpt-6.1-sol", effort: "high" };
const at = "2026-10-01T00:00:00.000Z";
export const slice5bCases = [
  ["push-subscriptions.json", pushSubscriptionStore, [{ endpoint: "https://push.example.invalid/fixture", expirationTime: null }]],
  ["push-sent.json", pushSentStore, ["attention_fixture_a", "attention_fixture_b"]],
  ["review-loop-presets.json", presetStore, { presets: [{ name: "Fixture", implementer: config, reviewer: config }] }],
  ["workflow-templates.json", templateStore, { templates: [{ name: "Fixture", finish: "pr", stages: [{ kind: "implement", scope: "Fixture", agent: config }, { kind: "review-loop", reviewer: config, fixer: config, roundLimit: 3, reviewerMode: "headless" }] }] }],
  ["role-presets.json", rolePresetStore, { schemaVersion: 1, overrides: { builder: { config: { model: "gpt-fixture" }, promptScaffold: "Fixture scaffold" } }, retirements: { fixture: { at } } }],
  ["spawn-nesting.json", nestingPolicyStore, { schemaVersion: 1, maxAgentNestingDepth: 3 }],
  ["root-lineage.json", rootLineageStore, { schemaVersion: 1, rootId: "root_fixture", revision: 7, updatedAt: at, sessions: [{ conversationId: "conversation_fixture", path: null, startedAt: at }] }],
  ["telegram/reports.json", telegramReportStore, { version: 1, settings: { enabled: true, time: "08:30", groups: [] }, prompt: "Fixture analyst", cursor: { lastScheduledDay: "2026-10-01" }, active: { runId: "fixture-run", trigger: "manual", startedAt: at, windowStart: at, windowEnd: at, conversationId: "conversation_fixture", promptVersion: "fixture", pendingSettlement: { status: "ok", errorCode: null, hasReport: true } }, retry: { runId: "fixture-retry", trigger: "manual", armedAt: at }, history: [] }],
  ["telegram/registrations.json", telegramRegistrationStore, { version: 1, claude: { "fixture/config.json": "http://127.0.0.1:1/mcp" } }],
] as unknown as [string, LegacyDocumentStore<unknown>, unknown][];

if (import.meta.main) {
  const directory = process.argv[2]!;
  const observations = slice5bCases.map(([name, store]) => {
    const file = path.join(directory, name);
    return { name, state: store.importLegacy(file).state, value: store.read(file) };
  });
  console.log(JSON.stringify(observations));
}
