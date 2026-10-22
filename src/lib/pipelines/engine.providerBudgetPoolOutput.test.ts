import { registerProviderOutputBudgetCases } from "./engine.providerBudgetOutput.fixture";

registerProviderOutputBudgetCases([true], ["claude"], ["harness-control", "operator-refused"]);
registerProviderOutputBudgetCases([true], ["codex"], ["harness-control", "busy-operator", "same-tick"]);
