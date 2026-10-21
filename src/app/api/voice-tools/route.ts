import { readVoiceTools, changeVoiceTools } from "@/lib/voiceTools/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = readVoiceTools;
export const POST = changeVoiceTools;
