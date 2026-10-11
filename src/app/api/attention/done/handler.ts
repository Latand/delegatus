import type { NextRequest } from "next/server";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { AttentionRequestError, readBoundedJson } from "@/lib/attention/validation";
import { projectDoneItems, type DoneWorld } from "@/lib/done/project";
import { acknowledgeDoneItems, doneRevision, unacknowledgedDoneItems } from "@/lib/done/store";
import { DONE_ACK_MAX_KEYS, type DoneAcknowledgeAnswer, type DoneItemsAnswer } from "@/lib/done/types";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { FileTransactionBusyError } from "@/lib/state/fileTransaction";

/*
 * «Готово» (docs/design/done-section.md §3). GET projects the sources (at most
 * once every 30 s per process) and answers the items still waiting, newest
 * event first. POST is the operator's «Прийняти» and its «Повернути»: from the
 * Viewer's own page, never from an agent, so nothing is acknowledged that the
 * operator has not seen. No MCP tool reaches it.
 */

export interface DoneRoutePorts {
  world(): DoneWorld;
  now(): number;
  log?(message: string, error: unknown): void;
}

const headers = { "Cache-Control": "no-store" };

function failure(error: unknown): Response {
  if (error instanceof AttentionRequestError) return Response.json({ ok: false, code: error.code, error: error.message }, { status: error.status, headers });
  if (error instanceof FileTransactionBusyError) return Response.json({ ok: false, code: "DONE_STATE_BUSY", error: error.message }, { status: 503, headers: { ...headers, "Retry-After": "1" } });
  throw error;
}

export function doneReadHandler(ports: DoneRoutePorts) {
  return async (): Promise<Response> => {
    try {
      try {
        await projectDoneItems(ports.world());
      } catch (error) {
        /* A source that cannot be read this time still leaves the items the
           store already holds to answer with. */
        if (error instanceof FileTransactionBusyError) throw error;
        (ports.log ?? ((message, cause) => console.error(message, cause)))("[done] projection failed", error);
      }
      const answer: DoneItemsAnswer = { ok: true, items: unacknowledgedDoneItems(), revision: doneRevision() };
      return Response.json(answer, { headers });
    } catch (error) {
      return failure(error);
    }
  };
}

export function doneAcknowledgeHandler(ports: Pick<DoneRoutePorts, "now">) {
  return async (request: NextRequest): Promise<Response> => {
    const rejection = rejectCrossOrigin(request);
    if (rejection) {
      rejection.headers.set("Cache-Control", "no-store");
      return rejection;
    }
    /* An agent's request carries the capability its spawn was given; only
       the operator's own page acknowledges. */
    if (request.headers.has(VIEWER_SPAWN_CAPABILITY_HEADER)) {
      return Response.json({ ok: false, code: "DONE_OPERATOR_ONLY", error: "only the operator acknowledges finished work" }, { status: 403, headers });
    }
    try {
      const body = await readBoundedJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new AttentionRequestError("INVALID_REQUEST", "request body must be an object");
      const fields = body as Record<string, unknown>;
      const keys = fields.keys;
      if (!Array.isArray(keys) || keys.length === 0) throw new AttentionRequestError("INVALID_KEYS", "name at least one item key");
      if (keys.length > DONE_ACK_MAX_KEYS) throw new AttentionRequestError("TOO_MANY_KEYS", `at most ${DONE_ACK_MAX_KEYS} keys at once`);
      if (keys.some((key) => typeof key !== "string" || !key || key.length > 512)) throw new AttentionRequestError("INVALID_KEYS", "every key is a non-empty string");
      if (fields.undo !== undefined && typeof fields.undo !== "boolean") throw new AttentionRequestError("INVALID_REQUEST", "undo is a boolean");
      const changed = acknowledgeDoneItems(keys as string[], { undo: fields.undo === true, surface: fields.surface === "phone" ? "phone" : "desktop", now: ports.now() });
      const answer: DoneAcknowledgeAnswer = { ok: true, changed };
      return Response.json(answer, { headers });
    } catch (error) {
      return failure(error);
    }
  };
}
