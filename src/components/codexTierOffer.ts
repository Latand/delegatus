"use client";

import { useEffect, useState } from "react";

import type { TFunction } from "@/lib/i18n";

/** The tier the speed rows' Ultra stands for, by the catalog's own id. */
export const ULTRA_TIER = "ultrafast";

/**
 * What one Codex account's own model catalog says about one tier for one model.
 * `loading` until `/api/accounts/codex/models` answers; then the tier is
 * offered, absent (with the tier names the account does list), or unknown
 * because the catalog, the account or the model's row could not be read.
 * Nothing but an answered read ever claims the tier is missing.
 */
export type TierOffer =
  | { state: "loading" }
  | { state: "offered"; account: string }
  | { state: "absent"; account: string; offers: string[] }
  | { state: "unknown"; account: string }
  | { state: "no-model" };

type CatalogAccount = { id: string; label?: string; models?: { slug: string; tiers: { id: string; name: string }[] | null }[] };

/** The offer one catalog answer makes; `null` is a read that failed. */
export function tierOfferFrom(account: CatalogAccount | null, requested: string, model: string, tier: string): TierOffer {
  if (!model) return { state: "no-model" };
  const name = account?.label || account?.id || requested;
  const tiers = account?.models?.find((row) => row.slug === model)?.tiers;
  if (!account || !tiers) return { state: "unknown", account: name };
  if (tiers.some((offer) => offer.id === tier)) return { state: "offered", account: name };
  return { state: "absent", account: name, offers: tiers.map((offer) => offer.name) };
}

/**
 * Reads whether `account` ("" for the engine's active account) lists `tier` for
 * `model`, only while `enabled` — a menu that is open, never a poll. A changed
 * account or model reads again; a read that has not answered stays `loading`.
 */
export function useCodexTierOffer({ account, model, tier = ULTRA_TIER, enabled }: {
  account: string;
  model: string;
  tier?: string;
  enabled: boolean;
}): TierOffer {
  /* The answer belongs to the read that made it: a closed menu forgets it, so every
     opening shows a fresh read and an answer for another account is never shown. */
  const [answer, setAnswer] = useState<{ key: string; account: CatalogAccount | null } | null>(null);
  const key = enabled ? account : null;
  useEffect(() => {
    if (key === null) return;
    let cancelled = false;
    void fetch(`/api/accounts/codex/models${account ? `?account=${encodeURIComponent(account)}` : ""}`)
      .then(async (response) => {
        const body = response.ok ? await response.json() as { accounts?: unknown } : null;
        const rows = Array.isArray(body?.accounts) ? body.accounts as CatalogAccount[] : [];
        return rows.find((row) => row && typeof row.id === "string" && (!account || row.id === account)) ?? null;
      })
      .catch(() => null)
      .then((read) => {
        if (!cancelled) setAnswer({ key, account: read });
      });
    return () => {
      cancelled = true;
      setAnswer(null);
    };
  }, [account, key]);
  if (!model) return { state: "no-model" };
  return answer && answer.key === key ? tierOfferFrom(answer.account, account, model, tier) : { state: "loading" };
}

/** The Ultra row, where a surface offers it: whether it can be chosen, and the
    visible reason when it cannot. A disabled row with no reason is a catalog read
    still in flight. */
export interface UltraRow { enabled: boolean; reason: string | null }

/** The Ultra row an offer makes. `running` is a conversation already on the tier,
    which its account evidently offers; a launch draft's own choice proves nothing. */
export function ultraRowOf(t: TFunction, offer: TierOffer, model: string, running = false): UltraRow {
  return running ? { enabled: true, reason: null } : { enabled: offer.state === "offered", reason: ultraUnavailableReason(t, offer, model) };
}

/** The visible reason Ultra cannot be chosen, or null while it can (or while the read is in flight). */
export function ultraUnavailableReason(t: TFunction, offer: TierOffer, modelName: string): string | null {
  /* A model name is one word: a line never breaks at its hyphens. */
  const model = modelName.replace(/-/g, "\u2011");
  switch (offer.state) {
    case "absent":
      return offer.offers.length
        ? t("composer.speedUltraAbsent", { account: offer.account, model, offers: offer.offers.join(", ") })
        : t("composer.speedUltraAbsentNone", { account: offer.account, model });
    case "unknown":
      return t("composer.speedUltraUnknown", { account: offer.account });
    case "no-model":
      return t("composer.speedUltraNeedsModel");
    default:
      return null;
  }
}
