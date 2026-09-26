import { expect, test } from "bun:test";

import { translate } from "@/lib/i18n";

import { relativeTime } from "./ui";

const NOW = Date.parse("2026-09-26T12:00:00Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

test("under a minute reads as just now, never Intl's bare now", () => {
  expect(relativeTime(at(-10_000), "en", NOW)).toBe("just now");
  expect(relativeTime(at(-10_000), "uk", NOW)).toBe("щойно");
  expect(translate("uk", "team.presence.seen", { age: relativeTime(at(-10_000), "uk", NOW) })).toBe("був(ла) щойно");
});

test("the invite note spells the expiry out, so the uk sentence ends with one full stop", () => {
  const time = relativeTime(at(7 * 86_400_000), "uk", NOW, "long");
  expect(time).toBe("через 7 днів");
  const note = translate("uk", "team.invite.note", { time });
  expect(note).not.toContain("..");
  expect(note).toContain("спливає через 7 днів.");
  expect(translate("en", "team.invite.note", { time: relativeTime(at(7 * 86_400_000), "en", NOW, "long") })).toContain("expires in 7 days.");
});
