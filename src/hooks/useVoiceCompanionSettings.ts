"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  /* The last reading the server gave, and the presses still on their way. The
     drawn settings are the one with the other laid over it, so a refusal drops
     only its own press and never a snapshot taken over an earlier press. */
  const [stored, setStored] = useState<CompanionSettings | null>(null);
  const [presses, setPresses] = useState<ReadonlyArray<{ id: number; value: Partial<CompanionSettings> }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const applied = useRef(0);
  const epoch = useRef(0);
  const pending = useRef(0);
  const settings = useMemo(() => (stored ? presses.reduce((held, press) => ({ ...held, ...press.value }), stored) : null), [stored, presses]);
  const request = useCallback(async (endpoint: "settings" | "key", body?: unknown, quiet = false, press?: Partial<CompanionSettings>): Promise<boolean> => {
    const current = ++sequence.current;
    const born = epoch.current;
    if (!quiet) { pending.current++; setBusy(true); }
    if (press) setPresses((held) => [...held, { id: current, value: press }]);
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
      /* An answer older than one already taken never overwrites it. */
      if (born === epoch.current && current > applied.current) { applied.current = current; setStored(result as CompanionSettings); }
      return true;
    } catch {
      if (current === sequence.current) setError("COMPANION_UNAVAILABLE");
      return false;
    } finally {
      if (press) setPresses((held) => held.filter((entry) => entry.id !== current));
      if (!quiet) { pending.current--; setBusy(pending.current > 0); }
    }
  }, []);
  /* A setting shows at once and locks nothing (audit B24); a refusal puts the
     last value the server confirmed back, with the presses still out drawn
     over it. Releasing an uncertain session waits: the server decides what is
     left of it. */
  const update = useCallback(async (value: Parameters<VoiceCompanionSettingsHook["update"]>[0]): Promise<boolean> => {
    if ("releaseUncertainSession" in value) return request("settings", value);
    return request("settings", value, true, value);
  }, [request]);
  const refresh = useCallback(async () => { await request("settings"); }, [request]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void refresh(); });
    return () => { disposed = true; sequence.current++; epoch.current++; };
  }, [open, refresh]);
  return { settings, busy, error, refresh, update, saveKey: key => request("key", { key }) };
}
