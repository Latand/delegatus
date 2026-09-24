"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { TelegramBotStatusPayload } from "@/lib/telegram/bot/contracts";

/**
 * Client state for the Bot section of the Telegram panel
 * (`docs/design/telegram-bot-account.md`, Decision 8). The same shape as
 * `useTelegramConnection`: one status payload, one busy flag, actions that
 * re-sync from the payload the server returns. It polls only while the panel
 * is open. The token passes through `connect` once and is never kept.
 */

const POLL_MS = 30_000;

export type TelegramBotState = {
  status: TelegramBotStatusPayload | null;
  busy: boolean;
  /** The last action's sanitized error code, or `"transport"`. */
  failure: { code: string } | null;
  refresh(fresh?: boolean): Promise<void>;
  connect(token: string): Promise<void>;
  setChat(chatId: string, alias: string, postAllowed: boolean): Promise<void>;
  remove(): Promise<void>;
};

type Outcome = { payload: TelegramBotStatusPayload } | { payload: null; code: string };

async function readOutcome(response: Response): Promise<Outcome> {
  const json = await response.json().catch(() => null) as { bot?: TelegramBotStatusPayload; code?: unknown } | null;
  if (response.ok && json?.bot) return { payload: json.bot };
  const code = typeof json?.code === "string" && /^[a-z_]{1,40}$/.test(json.code) ? json.code : "action_failed";
  return { payload: null, code };
}

export function useTelegramBot(enabled: boolean): TelegramBotState {
  const [status, setStatus] = useState<TelegramBotStatusPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ code: string } | null>(null);
  const sequenceRef = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++sequenceRef.current;
    try {
      const outcome = await readOutcome(await fetch("/api/telegram/bot"));
      if (sequence !== sequenceRef.current) return;
      if (outcome.payload) setStatus(outcome.payload);
      else setFailure({ code: outcome.code });
    } catch {
      if (sequence === sequenceRef.current) setFailure({ code: "transport" });
    }
  }, []);

  const act = useCallback(async (body: Record<string, unknown>) => {
    setBusy(true);
    setFailure(null);
    const sequence = ++sequenceRef.current;
    try {
      const outcome = await readOutcome(await fetch("/api/telegram/bot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      if (outcome.payload) {
        if (sequence === sequenceRef.current) setStatus(outcome.payload);
      } else {
        setFailure({ code: outcome.code });
      }
    } catch {
      setFailure({ code: "transport" });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, load]);

  return {
    status,
    busy,
    failure,
    refresh: (fresh = false) => (fresh ? act({ action: "refresh" }) : load()),
    connect: (token) => act({ action: "connect", token }),
    setChat: (chatId, alias, postAllowed) => act({ action: "chat", chatId, alias, postAllowed }),
    remove: () => act({ action: "remove" }),
  };
}
