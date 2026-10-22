import { registerProviderOutputBudgetCases } from "./engine.providerBudgetOutput.fixture";

registerProviderOutputBudgetCases([true], ["claude"], ["operator", "orchestrator", "busy-operator", "same-tick", "reply-after"]);
registerProviderOutputBudgetCases([true], ["codex"], ["reply-after"]);
