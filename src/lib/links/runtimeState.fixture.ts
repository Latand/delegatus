// Bundle this entry twice to reproduce instrumentation/API module isolation.
export { syncPeer, lastSyncMoved } from "./client";
export { agentCursors, agentFeed } from "./agentFeed";
export { taskExchange } from "./taskExchange";
export { GET as peersGET } from "@/app/api/links/peers/route";
export { GET as agentsGET } from "@/app/api/links/agents/route";
