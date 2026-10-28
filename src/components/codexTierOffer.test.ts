import { expect, test } from "bun:test";

import { serviceTierRefusal } from "@/lib/accounts/codexServiceTiers";
import { translate, type TFunction } from "@/lib/i18n";

import { serviceTierRefusalOffer, speedRefusalText, tierOfferFrom, ultraUnavailableReason } from "./codexTierOffer";

const en: TFunction = (key, params) => translate("en", key, params);
const uk: TFunction = (key, params) => translate("uk", key, params);
const label = (slug: string) => (slug === "gpt-6.1-sol" ? "GPT-6.1-Sol" : slug);
const refused = (error: string) => ({ code: "service_tier_unavailable", error });

test("every one-account Ultrafast refusal the server writes reads back as the Ultra row's reason", () => {
  const writer = (account: Parameters<typeof serviceTierRefusal>[0][number], selection: "pinned" | "selected" = "pinned") =>
    serviceTierRefusal([account], "gpt-6.1-sol", "ultrafast", account.id, selection);
  const cases: Array<[string, string, string]> = [
    [writer({ id: "default", label: "Account B", tiers: ["priority"], alternativeModels: [] }), "Account B doesn't offer Ultrafast for GPT‑6.1‑Sol (offers: Fast)", "Account B не пропонує Ultrafast для GPT‑6.1‑Sol (є: Швидка)"],
    [writer({ id: "acct-c", tiers: ["flex", "priority"], alternativeModels: ["gpt-6-astra"] }, "selected"), "acct-c doesn't offer Ultrafast for GPT‑6.1‑Sol (offers: flex, Fast)", "acct-c не пропонує Ultrafast для GPT‑6.1‑Sol (є: flex, Швидка)"],
    [writer({ id: "default", label: "Account: \"B\"", tiers: [], alternativeModels: [] }), "Account: \"B\" doesn't offer Ultrafast for GPT‑6.1‑Sol", "Account: \"B\" не пропонує Ultrafast для GPT‑6.1‑Sol"],
    [writer({ id: "default", label: "Account B", tiers: null, alternativeModels: [] }), "Can't read Account B's model catalog to check Ultrafast", "Не вдалося прочитати каталог моделей Account B, щоб перевірити Ultrafast"],
  ];
  for (const [error, english, ukrainian] of cases) {
    expect(speedRefusalText(en, refused(error), label)).toBe(english);
    expect(speedRefusalText(uk, refused(error), label)).toBe(ukrainian);
  }
});

test("a refusal the client cannot read stays the server's own text", () => {
  const several = serviceTierRefusal([
    { id: "a", tiers: ["priority"], alternativeModels: [] },
    { id: "b", tiers: [], alternativeModels: [] },
  ], "gpt-6.1-sol", "ultrafast");
  const none = serviceTierRefusal([], "gpt-6.1-sol", "ultrafast", "default");
  const priority = serviceTierRefusal([{ id: "a", tiers: [], alternativeModels: [] }], "gpt-6.1-sol", "priority", "a");
  for (const error of [several, none, priority, "a runtime change is already in flight"]) {
    expect(serviceTierRefusalOffer(error)).toBeNull();
    expect(speedRefusalText(uk, refused(error), label)).toBe(error);
  }
  /* Another code is never read as a tier refusal, and a body without text says nothing of its own. */
  const ultra = serviceTierRefusal([{ id: "a", tiers: [], alternativeModels: [] }], "gpt-6.1-sol", "ultrafast", "a");
  expect(speedRefusalText(uk, { code: "tier_change_failed", error: ultra }, label)).toBe(ultra);
  expect(speedRefusalText(uk, { code: "service_tier_unavailable" }, label)).toBeNull();
});

test("the catalog's offers are named by the words the speed rows use", () => {
  const offer = tierOfferFrom({ id: "account-d", label: "Account D", models: [{ slug: "gpt-6.1-sol", tiers: [{ id: "priority", name: "Fast" }, { id: "flex", name: "Flex" }] }] }, "account-d", "gpt-6.1-sol", "ultrafast");
  expect(ultraUnavailableReason(uk, offer, "GPT-6.1-Sol")).toBe("Account D не пропонує Ultrafast для GPT‑6.1‑Sol (є: Швидка, Flex)");
  expect(ultraUnavailableReason(en, offer, "GPT-6.1-Sol")).toBe("Account D doesn't offer Ultrafast for GPT‑6.1‑Sol (offers: Fast, Flex)");
});
