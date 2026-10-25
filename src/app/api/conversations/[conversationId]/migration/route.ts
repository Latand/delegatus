import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { createConversationMigrationGET, createConversationMigrationPOST } from "./handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const workspacePOST = createConversationMigrationPOST();
const workspaceGET = createConversationMigrationGET();

export const GET = workspaceRoute("/api/conversations/[conversationId]/migration", workspaceGET);

export const POST = workspaceRoute("/api/conversations/[conversationId]/migration", workspacePOST);
