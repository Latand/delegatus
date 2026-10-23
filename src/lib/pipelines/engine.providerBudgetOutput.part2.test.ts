import { registerProviderOutputBudgetCases } from "./engine.providerBudgetOutput.fixture";

registerProviderOutputBudgetCases([false], ["claude"], ["operator", "busy-operator", "same-tick"]);
registerProviderOutputBudgetCases([false], ["codex"], ["operator", "operator-refused"]);
