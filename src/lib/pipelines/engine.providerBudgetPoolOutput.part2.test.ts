import { registerProviderOutputBudgetCases } from "./engine.providerBudgetOutput.fixture";

registerProviderOutputBudgetCases([true], ["claude"], ["control-after"]);
registerProviderOutputBudgetCases([true], ["codex"], ["operator", "orchestrator", "control-after", "operator-refused"]);
