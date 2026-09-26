import type { NextRequest } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { callerConversationId, directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { liveRootSession } from "@/lib/root/adopt";

import type { DeputyAskOrigin } from "./deputies";

/**
 * Who may ask the orchestrator in parallel (docs/design/ghost-seat.md §5), and
 * as whom the ask is recorded.
 *
 * A deputy holds its seat's authority: its reports are the orchestrator's and
 * reach Telegram, its tick-setting writes are the seat's. So starting one is
 * the move the seat route refuses to a worker ("a worker able to seat itself
 * would inherit the manager surface in one move"), and the route admits only
 * the two callers the design names:
 *
 * - the operator's own browser (no conversation capability, no Viewer service
 *   marker), whose words the deputy receives as the operator's;
 * - the operator's root session, the voice gateway that relays for them, which
 *   presents its own capability. Its ask is an agent message (#1117: every MCP
 *   send is agent-authored) with the role `gateway`, delivered and drawn as
 *   such.
 *
 * Every other agent is refused, and so is an MCP call that names no
 * conversation: an ask nobody can attribute must not start a seat-attributed
 * self.
 */

export type DeputyAskerAdmission =
  | { ok: true; origin: DeputyAskOrigin }
  | { ok: false; status: 403; code: "asker_refused"; error: string };

type RootResolver = () => string | null;

const productionRoot: RootResolver = () => {
  const snapshot = agentRegistry().readOnlySnapshot();
  return liveRootSession({
    conversations: Object.values(snapshot.conversations),
    configuredRootId: process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null,
  })?.conversationId ?? null;
};

let resolveRoot: RootResolver = productionRoot;

/** Tests only; `null` restores the registry lookup. Seamed here because a
    route module may export only route fields. */
export function setDeputyRootResolverForTests(resolver: RootResolver | null): void {
  resolveRoot = resolver ?? productionRoot;
}

const REFUSED: DeputyAskerAdmission = {
  ok: false,
  status: 403,
  code: "asker_refused",
  error: "only the operator or the voice gateway may ask the orchestrator in parallel; an agent sends its message to the orchestrator instead",
};

export function deputyAskerOf(request: Pick<NextRequest, "headers">): DeputyAskerAdmission {
  const conversationId = callerConversationId(request);
  if (!conversationId) {
    /* No capability: the operator's browser, unless a Viewer service (the MCP
       server relaying a caller that named no conversation) says otherwise. */
    return directOperatorActivityAuthority(request).ok ? { ok: true, origin: { kind: "operator" } } : REFUSED;
  }
  let root: string | null = null;
  try {
    root = resolveRoot();
  } catch {
    root = null;
  }
  return root && root === conversationId
    ? { ok: true, origin: { kind: "agent", role: "gateway", conversationId } }
    : REFUSED;
}
