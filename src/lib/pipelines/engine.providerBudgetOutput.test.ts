import { registerProviderOutputBudgetCases } from "./engine.providerBudgetOutput.fixture";

registerProviderOutputBudgetCases([false], ["claude"], ["control-after", "operator-refused"]);
registerProviderOutputBudgetCases([false], ["codex"], ["harness-control", "busy-operator", "same-tick"]);
