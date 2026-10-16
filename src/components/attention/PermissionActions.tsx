"use client";

import { Check, Loader2, X } from "@/components/icons";
import { useState } from "react";

import { layerPermissionAnswer, unlayerPermissionAnswer } from "@/components/attention/dismissalOverlay";
import { requestFilesRefresh } from "@/lib/filesEvents";
import { useLocale } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

type Decision = "allow" | "deny";

/* The row leaves on the press and comes back on a refusal as a new mount, so
   what went wrong and what is still on its way live beside the layer. */
const failures = new Map<string, string>();
const inFlight = new Set<string>();

/**
 * Allow once / Deny on a Needs-you row whose conversation holds a structured
 * tool permission request (#2215). It sends `conversation_action permission`
 * through the same route the MCP tool uses, keyed by the request, so a double
 * tap replays one operation instead of answering twice. The answer is drawn
 * at once: the row and the count leave through the dismissal overlay's
 * permission layer, and a refusal takes the layer back so the row returns
 * with its buttons and the reason.
 */
export function PermissionActions({ file, size = "compact" }: { file: FileEntry; size?: "compact" | "touch" }) {
  const { t } = useLocale();
  const permission = file.pendingPermission;
  const [busy, setBusy] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(() => (permission ? failures.get(permission.id) ?? null : null));
  if (!permission) return null;

  const answer = async (decision: Decision) => {
    if (busy || inFlight.has(permission.id)) return;
    inFlight.add(permission.id);
    failures.delete(permission.id);
    setBusy(decision);
    setError(null);
    layerPermissionAnswer(permission.id);
    const refuse = (reason: string) => {
      failures.set(permission.id, reason);
      setError(reason);
      unlayerPermissionAnswer(permission.id);
    };
    try {
      const response = await fetch("/api/conversation-host", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(file.conversationId ? { conversationId: file.conversationId } : {}),
          path: file.path,
          action: "permission",
          decision,
          requestId: permission.id,
          operationId: `permission:${permission.id}:${decision}`,
        }),
      });
      const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || body.ok !== true) refuse(body.error ?? `HTTP ${response.status}`);
      else requestFilesRefresh();
    } catch (caught) {
      refuse(caught instanceof Error ? caught.message : String(caught));
    } finally {
      inFlight.delete(permission.id);
      setBusy(null);
    }
  };

  const button = size === "touch"
    ? "inline-flex min-h-11 items-center gap-1.5 rounded-[8px] px-3 text-ui font-semibold disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    : "inline-flex items-center gap-1 rounded-[6px] px-2 py-0.5 text-[11px] font-bold disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40";
  const icon = size === "touch" ? "h-4 w-4" : "h-3.5 w-3.5";
  return (
    <div data-permission-actions={permission.id} className={`flex flex-wrap items-center gap-1.5 ${size === "touch" ? "px-4 pb-2" : "px-2.5 pb-2"}`}>
      <button
        type="button"
        data-permission-allow
        className={`${button} bg-success text-white`}
        disabled={busy !== null}
        onClick={() => void answer("allow")}
      >
        {busy === "allow" ? <Loader2 className={`${icon} animate-spin motion-reduce:animate-none`} aria-hidden /> : <Check className={icon} aria-hidden />}
        {t("attention.permissionAllowOnce")}
      </button>
      <button
        type="button"
        data-permission-deny
        className={`${button} bg-danger text-white`}
        disabled={busy !== null}
        onClick={() => void answer("deny")}
      >
        {busy === "deny" ? <Loader2 className={`${icon} animate-spin motion-reduce:animate-none`} aria-hidden /> : <X className={icon} aria-hidden />}
        {t("attention.permissionDeny")}
      </button>
      {error ? <span role="alert" className="min-w-0 truncate text-[11px] text-danger">{t("attention.permissionFailed", { error })}</span> : null}
    </div>
  );
}
