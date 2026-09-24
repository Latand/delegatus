import { createConversationMigrationGET, createConversationMigrationPOST } from "./handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const POST = createConversationMigrationPOST();
export const GET = createConversationMigrationGET();
