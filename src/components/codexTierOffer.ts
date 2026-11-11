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
  | { state: "absent"; account: string; offers: { id: string; name: string }[] }
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
  return { state: "absent", account: name, offers: tiers.map(({ id, name }) => ({ id, name })) };
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

/** A tier as the speed rows name it, so a reason never names an offer by a word no row shows. */
export function speedTierName(t: TFunction, tier: { id: string; name: string }): string {
  if (tier.id === "priority") return t("composer.speedFastShort");
  if (tier.id === "default" || tier.id === "standard") return t("composer.speedStandard");
  return tier.name;
}

/** The visible reason Ultra cannot be chosen, or null while it can (or while the read is in flight). */
export function ultraUnavailableReason(t: TFunction, offer: TierOffer, modelName: string): string | null {
  /* A model name is one word: a line never breaks at its hyphens. */
  const model = modelName.replace(/-/g, "\u2011");
  switch (offer.state) {
    case "absent":
      return offer.offers.length
        ? t("composer.speedUltraAbsent", { account: offer.account, model, offers: offer.offers.map((tier) => speedTierName(t, tier)).join(", ") })
        : t("composer.speedUltraAbsentNone", { account: offer.account, model });
    case "unknown":
      return t("composer.speedUltraUnknown", { account: offer.account });
    case "no-model":
      return t("composer.speedUltraNeedsModel");
    default:
      return null;
  }
}

/**
 * A refused speed action in the operator's words. The server's refusal of an
 * unavailable Ultrafast is the one sentence `serviceTierRefusal` writes, naming
 * the one account the conversation runs on, the model and the tiers its catalog
 * lists; read back, it says what the Ultra row's own reason says. Anything else,
 * or a refusal over several accounts, is the server's own text.
 */
export function speedRefusalText(t: TFunction, body: { code?: unknown; error?: unknown }, modelName: (slug: string) => string): string | null {
  if (typeof body.error !== "string") return null;
  if (body.code !== "service_tier_unavailable") return body.error;
  const offer = serviceTierRefusalOffer(body.error);
  return offer ? ultraUnavailableReason(t, offer.offer, modelName(offer.model)) ?? body.error : body.error;
}

const QUOTED = String.raw`"(?:[^"\\]|\\.)*"`;
const REFUSAL = new RegExp(String.raw`^no evaluated account offers serviceTier ${ULTRA_TIER} for model (\S+); evaluated (?:pinned|selected) account ${QUOTED}: account (${QUOTED})(?: \(([^()]*)\))?: (\S+) offered: (.*?)(?:; ${ULTRA_TIER} offered for other models on this account: .*)?$`);

/** The account, model and offers of a one-account Ultrafast refusal; null for any other text. */
export function serviceTierRefusalOffer(text: string): { model: string; offer: TierOffer } | null {
  const match = REFUSAL.exec(text);
  if (!match || match[1] !== match[4]) return null;
  let name: string;
  try { name = JSON.parse(match[2]!) as string; } catch { return null; }
  const offered = match[5]!;
  if (offered === "unknown (catalog unavailable)") return { model: match[1]!, offer: { state: "unknown", account: name } };
  const ids = offered === "none" ? [] : offered.split(", ");
  if (ids.some((id) => !/^[a-z][a-z0-9_-]{0,31}$/.test(id))) return null;
  return { model: match[1]!, offer: { state: "absent", account: name, offers: ids.map((id) => ({ id, name: id })) } };
}
