import { createHash } from "node:crypto";
import { deliveredRuleToConversation } from "./deliveryLedger";
import { activeRoleRuleRows } from "./roleViewSource";
import { RoleMemoryRefusal } from "./roleStore";
import { memoryIndex } from "./service";
import { roleMemoryEnabled } from "./settings";

/** Check the one citation inside the form's write admission. */
export function legatusDecisionRule(project: string, conversationId: string, ruleId: unknown): string | undefined {
  if (ruleId === undefined) return undefined;
  if (!roleMemoryEnabled() || typeof ruleId !== "string" || !/^r_[a-f0-9]{16}$/.test(ruleId)) {
    throw new RoleMemoryRefusal("RULE_NOT_READABLE", "cite one active rule readable by Legatus");
  }
  const rule = activeRoleRuleRows({ project, reader: "legatus", id: ruleId, limit: 1 })[0];
  if (!rule) throw new RoleMemoryRefusal("RULE_NOT_READABLE", "cite one active rule readable by Legatus");
  const hash = createHash("sha256").update(rule.rule).digest("hex");
  if (!deliveredRuleToConversation(conversationId, ruleId, hash) && !memoryIndex().openedLegatusRule(ruleId, conversationId, hash)) {
    throw new RoleMemoryRefusal("RULE_NOT_DELIVERED", "cite a rule this Legatus conversation received or opened");
  }
  return ruleId;
}
