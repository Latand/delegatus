import type { NextRequest } from "next/server";

import { keysJson, keysOwnerRequest } from "@/lib/keys/access";
import type { KeysAnswer } from "@/lib/keys/shared";
import { keyEntries } from "@/lib/keys/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { isStagingMode } from "@/lib/staging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The «Keys» list (docs/design/keys-settings.md §5): each key's state, and
 * for the operator's own page its masked form. It never carries a value; the
 * value leaves only through `POST /api/keys/<id>/reveal`, one per press.
 */
export function GET(req: NextRequest) {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const owner = keysOwnerRequest(req);
  return keysJson<KeysAnswer>({ keys: keyEntries(owner), staging: isStagingMode(), owner });
}
