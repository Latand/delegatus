import type { NextRequest } from "next/server";

import { keysJson, keysOwnerGate } from "@/lib/keys/access";
import { operatorDecisions } from "@/lib/prototypeReview/read";
import { isStagingMode } from "@/lib/staging";
import { accessKeyWithheld, teamActor } from "@/lib/team";
import { operatorSecretRequests } from "./operatorRead";
import { findSecretRequestRecord } from "./store";
import { SecretRequestError, secretError, type SecretRefusal } from "./types";
import { isSecretRequestId, SECRET_BODY_LIMIT, SECRET_BODY_TYPE, SECRET_REVISION_HEADER } from "./view";
import { declineSecretRequest, writeSecretRequest } from "./write";

async function readSecretBody(request: NextRequest, buffer: Uint8Array): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new SecretRequestError("secret_value_format");
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return buffer.subarray(0, length);
      try {
        if (value.byteLength > buffer.byteLength - length) throw new SecretRequestError("secret_value_too_long");
        buffer.set(value, length);
        length += value.byteLength;
      } finally {
        value.fill(0);
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw secretError(error, "secret_value_format");
  } finally {
    reader.releaseLock();
  }
}

function refusalStatus(code: SecretRefusal): number {
  switch (code) {
    case "operator_only": case "owner_required": return 403;
    case "secret_value_too_long": return 413;
    case "secret_value_format": case "secret_env_value_unquotable": return 400;
    case "secret_request_unavailable": return 503;
    default: return 409;
  }
}

export async function secretOperatorPOST(request: NextRequest, params: Promise<{ id: string }>, action: "value" | "decline") {
  const refusal = keysOwnerGate(request);
  if (refusal) return refusal;

  const { id } = await params;
  if (!isSecretRequestId(id)) return keysJson({ code: "secret_not_pending" }, 404);
  if (isStagingMode()) return keysJson({ code: "staging" }, 409);
  const authorize = () => {
    if (isStagingMode()) throw new SecretRequestError("staging");
    if (keysOwnerGate(request)) {
      throw new SecretRequestError(accessKeyWithheld(request) ? "owner_required" : "operator_only");
    }
  };

  let buffer: Uint8Array | undefined;
  try {
    const actor = teamActor(request).kind === "member" ? "owner" : "operator";
    let record;
    if (action === "decline") {
      record = await declineSecretRequest(id, actor, authorize);
    } else {
      const revision = request.headers.get(SECRET_REVISION_HEADER) ?? "";
      if (request.headers.get("content-type") !== SECRET_BODY_TYPE || request.headers.has("content-encoding")) {
        throw new SecretRequestError("secret_value_format");
      }
      if (!/^[a-f0-9]{64}$/.test(revision)) throw new SecretRequestError("secret_destination_changed");
      buffer = new Uint8Array(SECRET_BODY_LIMIT);
      const value = await readSecretBody(request, buffer);
      authorize();
      record = await writeSecretRequest(id, revision, value, { authorize, actor });
    }
    const secretRequests = await operatorSecretRequests(record.project);
    authorize();
    return keysJson({ ...operatorDecisions(record.project), secretRequests });
  } catch (error) {
    const { code } = secretError(error, "secret_request_unavailable");
    console.info(`[secret-request] ${id} refused ${code}`);
    if (code === "secret_destination_changed" && !keysOwnerGate(request)) {
      try {
        const record = findSecretRequestRecord(id);
        const secretRequests = record ? await operatorSecretRequests(record.project) : [];
        if (!keysOwnerGate(request)) return keysJson({ code, secretRequests }, refusalStatus(code));
      } catch { /* the next poll can recover the current destination */ }
    }
    return keysJson({ code }, refusalStatus(code));
  } finally {
    buffer?.fill(0);
  }
}
