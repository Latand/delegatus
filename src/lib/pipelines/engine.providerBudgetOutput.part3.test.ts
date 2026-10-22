import { registerProviderOutputBudgetCases } from "./engine.providerBudgetOutput.fixture";

registerProviderOutputBudgetCases([false], ["claude"], ["orchestrator", "harness-control", "reply-after"]);
registerProviderOutputBudgetCases([false], ["codex"], ["orchestrator", "reply-after", "control-after"]);
