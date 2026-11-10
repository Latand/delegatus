import { workspaceRoute } from "@/lib/team/workspaceRoute";
import { conversationHostPOST } from "./handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* The name that says what the endpoint does: resume or respawn a conversation's
   host and deliver to it. `/api/tmux` is the same handlers under the old path,
   kept so nothing in flight breaks (#1301). */
const workspacePOST = conversationHostPOST;

export const POST = workspaceRoute("/api/conversation-host", workspacePOST);
