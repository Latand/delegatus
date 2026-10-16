"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompanionSettings } from "@/lib/voiceCompanion/storage";

export interface VoiceCompanionSettingsHook {
  settings: CompanionSettings | null;
  busy: boolean;
  error: string | null;
  refresh(): Promise<void>;
  update(value: Partial<Pick<CompanionSettings, "enabled" | "monthlyCapUsd" | "backend" | "callMemory">> | { releaseUncertainSession: true }): Promise<boolean>;
  /** The caller clears its input after success. The hook never stores a key. */
  saveKey(key: string): Promise<boolean>;
}

/** Used by the existing settings surface; mounting this starts no voice call. */
export function useVoiceCompanionSettings(open: boolean): VoiceCompanionSettingsHook {
  const [settings, setSettings] = useState<CompanionSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const pending = useRef(0);
  const request = useCallback(async (endpoint: "settings" | "key", body?: unknown, quiet = false): Promise<boolean> => {
    const current = ++sequence.current;
    if (!quiet) { pending.current++; setBusy(true); }
    setError(null);
    try {
      const response = await fetch(`/api/voice-companion/${endpoint}`, {
        cache: "no-store",
        ...(body === undefined ? {} : { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok) {
        const code = typeof result?.code === "string" && /^[A-Z_]{1,40}$/.test(result.code) ? result.code : "COMPANION_UNAVAILABLE";
        if (current === sequence.current) setError(code);
        return false;
      }
      if (current === sequence.current) setSettings(result as CompanionSettings);
      return true;
    } catch {
      if (current === sequence.current) setError("COMPANION_UNAVAILABLE");
      return false;
    } finally {
      if (!quiet) { pending.current--; setBusy(pending.current > 0); }
    }
  }, []);
  /* A setting shows at once and locks nothing (audit B24); a refusal puts the
     stored value back, unless a newer write already answered over it. Releasing
     an uncertain session waits: the server decides what is left of it. */
  const update = useCallback(async (value: Parameters<VoiceCompanionSettingsHook["update"]>[0]): Promise<boolean> => {
    if ("releaseUncertainSession" in value) return request("settings", value);
    let before: CompanionSettings | null = null;
    setSettings((held) => { before = held; return held ? { ...held, ...value } : held; });
    const mine = sequence.current + 1;
    const ok = await request("settings", value, true);
    if (!ok && sequence.current === mine) setSettings(before);
    return ok;
  }, [request]);
  const refresh = useCallback(async () => { await request("settings"); }, [request]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void refresh(); });
    return () => { disposed = true; sequence.current++; };
  }, [open, refresh]);
  return { settings, busy, error, refresh, update, saveKey: key => request("key", { key }) };
}
