import { expect, test } from "bun:test";

import { translate } from "@/lib/i18n";

import { loopbackLink, relativeTime } from "./ui";

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

test("a loopback link is the only kind the invite dialog warns about", () => {
  expect(loopbackLink("http://127.0.0.1:8898/join/abc")).toBe(true);
  expect(loopbackLink("http://localhost:8899/join/abc")).toBe(true);
  expect(loopbackLink("http://[::1]:8898/join/abc")).toBe(true);
  expect(loopbackLink("https://dev.example.net/join/abc?k=x")).toBe(false);
  expect(loopbackLink("http://100.64.0.7:8898/join/abc")).toBe(false);
  expect(loopbackLink("not a url")).toBe(false);
});

test("device and session phrases name the place with its preposition, never a quoted noun", () => {
  const on = translate("uk", "team.surfaceOn.phone");
  expect(translate("uk", "team.approve.confirm", { surfaceOn: on, browser: "Safari" })).toBe("Увійти під вашим ім’ям на телефоні (Safari)?");
  expect(translate("en", "team.approve.confirm", { surfaceOn: translate("en", "team.surfaceOn.phone"), browser: "Safari" })).toBe("Sign in as you on a phone (Safari)?");
  expect(translate("uk", "team.action.signedIn", { surfaceOn: translate("uk", "team.surfaceOn.desktop"), via: translate("uk", "team.via.claim") })).toBe("увійшов(ла) на комп’ютері під час створення команди");
  expect(translate("uk", "team.action.device.approved", { surfaceOn: on })).not.toContain("«");
});
