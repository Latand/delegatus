import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-cards-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { ORCHESTRATOR_ALERT_REF, monitorCardText, monitorClientRequestId, monitorRefIn, orchestratorAlertCardText, seatTickSettingsCardText } = await import("./cards");
import type { ClassifiedRequest } from "./types";

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function classified(overrides: Partial<ClassifiedRequest> = {}): ClassifiedRequest {
  return {
    request: {
      fingerprint: "0123456789abcdef",
      title: "Add a nightly backup for the attachment store",
      text: "Please add a nightly backup for the attachment store.",
      project: "viewer",
      at: "2026-07-27T09:30:00.000Z",
      references: [],
      asksForGithubIssue: false,
    },
    state: "untracked",
    match: null,
    reason: "no card, pipeline, flow, pull request or issue correlates",
    ...overrides,
  };
}

describe("monitor board cards", () => {
  test("carries the summary, the verdict and a machine-readable ref", () => {
    const text = monitorCardText(classified());
    expect(text.split("\n")[0]).toBe("Add a nightly backup for the attachment store");
    expect(text).toContain("never materialized");
    expect(text).toContain("2026-07-27 09:30 UTC");
    expect(monitorRefIn(text)).toBe("0123456789abcdef");
  });

  test("never quotes the operator's own words back onto the board", () => {
    const asked = classified({
      request: {
        ...classified().request,
        title: "Add a nightly backup for the attachment store",
        text: "Please add a nightly backup for the attachment store, my laptop died again and I lost the screenshots.",
      },
    });
    const text = monitorCardText(asked);
    /* A card is pasted, screenshotted and pushed. The transcript body must not
       travel with it — and the publication gate cannot catch a card, because
       cards are produced at runtime. */
    expect(text).not.toContain("my laptop died again");
    expect(text).not.toContain(asked.request.text);
    expect(text).not.toContain(">");
    expect(text).toContain("the monitor's own summary");
  });

  test("redacts anything the summary itself dragged along", () => {
    const text = monitorCardText(classified({
      request: { ...classified().request, title: "Fix the loader at /etc/agents/boot.json for someone@example.com" },
    }));
    expect(text).not.toContain("/etc/agents/boot.json");
    expect(text).not.toContain("someone@example.com");
  });

  test("an unconfirmed GitHub-issue candidate says no issue was created", () => {
    const text = monitorCardText(classified({
      state: "awaiting-confirmation",
      request: { ...classified().request, asksForGithubIssue: true },
      reason: "asks for a GitHub issue",
    }));
    expect(text).toContain("Unconfirmed");
    expect(text).toContain("No GitHub issue was created");
  });

  test("the ref survives an operator editing the card above it", () => {
    const text = `Reworded by hand\n\nsome notes\n\n${monitorCardText(classified()).split("\n").slice(-1)[0]}`;
    expect(monitorRefIn(text)).toBe("0123456789abcdef");
  });

  test("a card nobody stamped has no ref", () => {
    expect(monitorRefIn("Just a task someone typed\n\nmonitor-ref is mentioned in prose only")).toBeNull();
  });

  test("the orchestrator alert is a fixed identity so it surfaces once", () => {
    const text = orchestratorAlertCardText("no orchestrator has been adopted", "2026-07-27T12:00:00.000Z");
    expect(monitorRefIn(text)).toBe(ORCHESTRATOR_ALERT_REF);
    expect(monitorClientRequestId(ORCHESTRATOR_ALERT_REF)).toBe("monitor-741:orchestrator-unresolved");
    expect(text).toContain("durable record");
  });
});

describe("the standing tick notice card", () => {
  const input = {
    project: "atlas",
    detail: "wakes for this project are set to one every 30 minute(s)",
    reason: "a release afternoon",
    until: "2026-10-01T09:24:00.000Z",
    setBy: { kind: "manager", conversationId: "seat-1", project: "atlas" },
    updatedAt: "2026-10-01T07:00:00.000Z",
    schedule: { enabled: true, wakeIntervalMinutes: 30 },
    timeZone: "UTC",
  };
  const titleOf = (text: string) => text.split("\n")[0];

  test("its first line is the setting itself, in the operator's language, with the time it lapses", () => {
    expect(titleOf(seatTickSettingsCardText({ ...input, locale: "en" }))).toBe("Tick: every 30 min until 09:24");
    expect(titleOf(seatTickSettingsCardText({ ...input, locale: "uk" }))).toBe("Тікер: кожні 30 хв до 09:24");
  });

  test("a setting that lapses on another day names the date, and exact hours collapse", () => {
    const later = { ...input, until: "2026-10-03T09:24:00.000Z", schedule: { enabled: true, wakeIntervalMinutes: 120 } };
    expect(titleOf(seatTickSettingsCardText({ ...later, locale: "en" }))).toBe("Tick: every 2 h until 03.10 09:24");
    expect(titleOf(seatTickSettingsCardText({ ...later, locale: "uk" }))).toBe("Тікер: кожні 2 год до 03.10 09:24");
  });

  test("an off tick says off, and a setting with no expiry has no 'until'", () => {
    const off = { ...input, until: null, schedule: { enabled: false, wakeIntervalMinutes: 60 } };
    expect(titleOf(seatTickSettingsCardText({ ...off, locale: "en" }))).toBe("Tick: off");
    expect(titleOf(seatTickSettingsCardText({ ...off, locale: "uk" }))).toBe("Тікер: вимкнено");
  });

  test("the body is written in one language and keeps the ref line that makes it a notice", () => {
    const uk = seatTickSettingsCardText({ ...input, locale: "uk" });
    expect(uk).toContain("Вказівки на кожне пробудження: a release afternoon.");
    expect(uk.indexOf("Пробудження цього проєкту")).toBeLessThan(uk.indexOf("Вказівки на кожне пробудження:"));
    expect(uk).toContain("Змінив(ла): призначений оркестратор (seat-1).");
    expect(uk).not.toContain("Reason given");
    const en = seatTickSettingsCardText({ ...input, locale: "en" });
    expect(en).toContain("Instructions for every wake: a release afternoon.");
    expect(en.indexOf("Wakes for this project")).toBeLessThan(en.indexOf("Instructions for every wake:"));
    expect(en).toContain("Set by the designated seat (seat-1).");
    expect(en).not.toContain("Причина");
    for (const text of [uk, en]) expect(monitorRefIn(text)).toBe("seat-tick-settings");
  });

  test("the same inputs write the same card, so a settled setting rewrites nothing", () => {
    expect(seatTickSettingsCardText({ ...input, locale: "uk" })).toBe(seatTickSettingsCardText({ ...input, locale: "uk" }));
  });
});
