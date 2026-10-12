import { expect, test } from "bun:test";

import {
  createUrlAllowed,
  deriveCloneUsername,
  offersCloneCreate,
  randomCloneName,
  transliterate,
  validCloneName,
  validCloneUsername,
} from "./cloneNames";

test("the block is dark until the descriptor lists clone_create", () => {
  expect(offersCloneCreate({})).toBe(false);
  expect(offersCloneCreate({ features: ["requester_context"] })).toBe(false);
  expect(offersCloneCreate({ features: ["requester_context", "clone_create"] })).toBe(true);
});

test("a Ukrainian name derives the prototype's username by the national table", () => {
  expect(deriveCloneUsername("Нічна Сова")).toBe("nichna_sova_bot");
  expect(deriveCloneUsername("Тихий Лис")).toBe("tykhyi_lys_bot");
  expect(transliterate("Їжак і Юля")).toBe("yizhak i yulia");
  expect(transliterate("Зоряна")).toBe("zoriana");
  expect(transliterate("м’ята")).toBe("miata");
});

test("an English or mixed name derives a valid username", () => {
  expect(deriveCloneUsername("Night Owl")).toBe("night_owl_bot");
  expect(deriveCloneUsername("Helper Bot")).toBe("helper_bot");
  expect(deriveCloneUsername("  42 Café — Ліга!  ")).toBe("cafe_liha_bot");
  expect(deriveCloneUsername("🦉")).toBe("clone_bot");
  expect(deriveCloneUsername("")).toBe("clone_bot");
});

test("a long name is cut to Telegram's 32 characters and still ends in bot", () => {
  const username = deriveCloneUsername("Дуже довга назва помічника для великого чату ліги");
  expect(username.length).toBeLessThanOrEqual(32);
  expect(username.endsWith("_bot")).toBe(true);
  expect(validCloneUsername(username)).toBe(true);
});

test("every random name derives a valid username, and 🎲 never repeats the current name", () => {
  for (const locale of ["uk", "en"] as const) {
    for (let index = 0; index < 50; index++) {
      const name = randomCloneName(locale);
      expect(validCloneName(name)).toBe(true);
      expect(validCloneUsername(deriveCloneUsername(name))).toBe(true);
    }
    const sequence = [0, 0, 0.5, 0.5];
    let step = 0;
    const first = randomCloneName(locale, "", () => sequence[step++ % 2]!);
    step = 0;
    expect(randomCloneName(locale, first, () => sequence[step++]!)).not.toBe(first);
  }
  expect(randomCloneName("uk", "", () => 0)).toBe("Нічна Сова");
});

test("username and name checks follow the link's rules", () => {
  expect(validCloneUsername("nichna_sova_bot")).toBe(true);
  expect(validCloneUsername("NightOwlBot")).toBe(true);
  expect(validCloneUsername("abot")).toBe(false);
  expect(validCloneUsername("1owl_bot")).toBe(false);
  expect(validCloneUsername("night_owl")).toBe(false);
  expect(validCloneUsername("owl-bot")).toBe(false);
  expect(validCloneUsername(`${"a".repeat(30)}bot`)).toBe(false);
  expect(validCloneName("  ")).toBe(false);
  expect(validCloneName("a".repeat(65))).toBe(false);
  expect(validCloneName("Сова\nдруга")).toBe(false);
});

test("only a t.me newbot link is opened", () => {
  expect(createUrlAllowed("https://t.me/newbot/manager_bot/nichna_sova_bot?name=%D0%A1")).toBe(true);
  expect(createUrlAllowed("http://t.me/newbot/manager_bot/x_bot")).toBe(false);
  expect(createUrlAllowed("https://t.me/manager_bot")).toBe(false);
  expect(createUrlAllowed("https://example.com/newbot/manager_bot/x_bot")).toBe(false);
  expect(createUrlAllowed("tg://newbot?manager=manager_bot")).toBe(false);
  expect(createUrlAllowed("not a url")).toBe(false);
});
