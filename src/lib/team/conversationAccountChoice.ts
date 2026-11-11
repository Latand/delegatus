import { NextResponse, type NextRequest } from "next/server";

import { AccountProjectBindingsUnreadableError, assertMemberAccountChoice, MemberAccountRefusedError } from "@/lib/accounts/projectBindings";
import { agentRegistry } from "@/lib/agent/registry";
import { callerConversationId } from "@/lib/agent/operatorAuthority";

import type { TeamActor } from "./contract";
import { teamActor } from "./actor";
import { existingTeamStore } from "./store";
import { conversationWorkspacePrincipal, memberWorkspacePrincipal } from "./workspacePrincipal";
import { workspaceConversationProject } from "./workspaceRoute";

/*
 * A member's explicit account choice on a conversation that already runs
 * (docs/design/team-memory-and-workspaces.md §5.2, W1). The browser's
 * "reconfigure" action and the migration route's "select-account" both end in
 * a control that checks only that the account exists. For a call bound to a
 * member this guard comes first: the account must be in the project's pool,
 * and where the project has no pool nothing can be named. It reads the pool
 * alone, before any account is looked up, so an account that exists and one
 * that does not get the same answer. The owner and calls bound to nobody are
 * not its business and pass unchanged.
 */

function refusal(error: unknown): NextResponse {
  if (error instanceof MemberAccountRefusedError) {
    return NextResponse.json({ error: error.message, code: "project_account_refused", reason: error.reason }, { status: 409 });
  }
  if (error instanceof AccountProjectBindingsUnreadableError) return NextResponse.json({ error: error.message }, { status: 409 });
  return NextResponse.json({ error: "member authority is unavailable", code: "team_store_unavailable" }, { status: 503 });
}

/** The 409 to answer, or null when the choice may go on. `trusted` is an
 *  in-process caller's actor; an HTTP caller is read from its request. */
export async function conversationAccountChoiceRefusal(
  req: NextRequest,
  trusted: TeamActor | undefined,
  identity: string,
  accountId: string,
): Promise<NextResponse | null> {
  try {
    const actor = trusted ?? teamActor(req);
    const registry = agentRegistry();
    let bound = false;
    if (actor.kind === "member") {
      const store = existingTeamStore();
      bound = Boolean(store && memberWorkspacePrincipal(store, actor.memberId, null));
    } else if (actor.kind === "agent") {
      bound = conversationWorkspacePrincipal(id => registry.conversation(id as `conversation_${string}`), actor.conversationId) !== null;
    }
    if (!bound) return null;
    const conversation = identity.startsWith("conversation_")
      ? registry.conversation(identity as `conversation_${string}`)
      : registry.conversationForPath(identity);
    if (!conversation || conversation.engine === "copilot") return null;
    const generation = conversation.generations.at(-1);
    /* Naming the account it already runs on is how a pending choice is withdrawn. */
    if (generation?.accountId === accountId) return null;
    const project = await workspaceConversationProject(conversation.id);
    assertMemberAccountChoice(project, conversation.engine, accountId);
    return null;
  } catch (error) {
    return refusal(error);
  }
}
