import type { NextRequest } from "next/server";

import { auditKeyAction, keysJson, keysOwnerGate } from "@/lib/keys/access";
import { exportKeys } from "@/lib/keys/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** «Copy all keys» (design §7, M1): every set key as a NAME=value line, the variable-set ones included. */
export function POST(req: NextRequest) {
  const refusal = keysOwnerGate(req);
  if (refusal) return refusal;
  const exported = exportKeys(new Date());
  auditKeyAction("export", [`${exported.count}`]);
  return keysJson(exported);
}
