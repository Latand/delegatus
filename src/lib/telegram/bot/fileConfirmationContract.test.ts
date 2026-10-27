import { describe, expect, test } from "bun:test";
import { fileConfirmationReason, fileConfirmationSummary, fileConfirmationText, type FileConfirmationView } from "./fileConfirmationContract";
import type { DocumentWarning } from "./documents";

const hidden: DocumentWarning = { code: "document_forbidden_path", path: "/srv/orbit/.codex/auth.json", segment: ".codex", reason: "/srv/orbit/.codex/auth.json passes through dot-directory .codex." };
const outside: DocumentWarning = { code: "document_outside_roots", path: "/srv/orbit/.codex/auth.json", roots: ["/srv/orbit/handoff"], reason: "/srv/orbit/.codex/auth.json is outside the allowed document roots (/srv/orbit/handoff)." };
const privateKey: DocumentWarning = { code: "document_secret", secretClass: "private_key", line: 1, reason: "The file contains what looks like a secret (private_key, line 1)." };

function view(reasons: DocumentWarning[], files: FileConfirmationView["files"] = [{ path: "/srv/orbit/handoff/weekly-report.json", resolvedPath: "/srv/orbit/.codex/auth.json", filename: "weekly-report.json", sha256: "b".repeat(64), bytes: 2458 }]) {
  return { chatTitle: "Orbit Reports", files, reasons };
}

describe("fileConfirmationSummary", () => {
  test("a secret leads and the other reasons follow in stored order", () => {
    expect(fileConfirmationSummary(view([hidden, outside, privateKey]), "en")).toMatchObject({
      heading: "This file looks like it holds a private key",
      intro: "An agent wants to send weekly-report.json to Orbit Reports, and it is a link to .codex/auth.json.",
      more: "Two more reasons Delegatus paused it:",
      reasons: ["The file is inside the hidden folder .codex.", "It is outside the folders files may be sent from (handoff)."],
      real: ".codex/auth.json",
      approvedSubject: ".codex/auth.json, which weekly-report.json links to,",
      warnings: "three warnings",
    });
    expect(fileConfirmationSummary(view([hidden, outside, privateKey]), "uk")).toMatchObject({
      heading: "Схоже, у цьому файлі приватний ключ",
      intro: "Агент хоче надіслати weekly-report.json у Orbit Reports, а це посилання на .codex/auth.json.",
      more: "Ще дві причини, чому Delegatus зупинив надсилання:",
      reasons: ["Файл лежить у прихованій теці .codex.", "Він поза теками, з яких дозволено надсилати (handoff)."],
      warnings: "три застереження",
    });
  });

  test("without a secret the hidden folder leads; a lone outside-roots reason leaves no list", () => {
    const folder = fileConfirmationSummary(view([outside, hidden]), "en");
    expect(folder.heading).toBe("This file is inside the hidden folder .codex");
    expect(folder.reasons).toEqual(["The file is outside the folders files may be sent from (handoff)."]);
    expect(folder.more).toBe("One more reason Delegatus paused it:");
    const lone = fileConfirmationSummary(view([outside]), "uk");
    expect(lone.heading).toBe("Файл поза теками, з яких дозволено надсилати (handoff)");
    expect(lone.reasons).toEqual([]);
    expect(lone.more).toBeNull();
    expect(lone.warnings).toBe("одне застереження");
  });

  test("a requested path that is the resolved file names no link", () => {
    const plain = fileConfirmationSummary(view([outside], [{ path: "/srv/notes.md", resolvedPath: "/srv/notes.md", filename: "notes.md", sha256: "c".repeat(64), bytes: 10 }]), "en");
    expect(plain.real).toBeNull();
    expect(plain.intro).toBe("An agent wants to send notes.md to Orbit Reports.");
    expect(plain.approvedSubject).toBe("notes.md");
  });

  test("two images name each file in their own reasons", () => {
    const files = [
      { path: "/srv/shots/one.png", resolvedPath: "/srv/shots/one.png", filename: "one.png", sha256: "d".repeat(64), bytes: 1 },
      { path: "/srv/shots/two.png", resolvedPath: "/srv/shots/two.png", filename: "two.png", sha256: "e".repeat(64), bytes: 2 },
    ];
    const reasons: DocumentWarning[] = [
      { code: "document_outside_roots", path: "/srv/shots/one.png", roots: ["/srv/handoff"], reason: "outside" },
      { code: "document_outside_roots", path: "/srv/shots/two.png", roots: ["/srv/handoff"], reason: "outside" },
    ];
    const en = fileConfirmationSummary(view(reasons, files), "en");
    expect(en.heading).toBe("One of these files is outside the folders files may be sent from (handoff)");
    expect(en.intro).toBe("An agent wants to send two images to Orbit Reports.");
    expect(en.reasons).toEqual(["two.png is outside the folders files may be sent from (handoff)."]);
    expect(en.real).toBeNull();
    expect(fileConfirmationSummary(view(reasons, files), "uk").intro).toBe("Агент хоче надіслати два зображення у Orbit Reports.");
  });

  test("a reason without its segment or roots falls back to the detector's own sentence", () => {
    const bare: DocumentWarning[] = [{ code: "document_forbidden_path", reason: "/srv/x passes through dot-directory .x." }, { code: "document_outside_roots", path: "/srv/x", reason: "/srv/x is outside the allowed document roots." }];
    const summary = fileConfirmationSummary(view(bare), "uk");
    expect(summary.heading).toBe(fileConfirmationReason(bare[0]!, "uk").replace(/\.$/, ""));
    expect(summary.reasons).toEqual([fileConfirmationReason(bare[1]!, "uk")]);
  });

  test("an unknown or missing secret class reads as a secret", () => {
    expect(fileConfirmationSummary(view([{ code: "document_secret", secretClass: "toString", reason: "x" }]), "en").heading).toBe("This file looks like it holds a secret");
    expect(fileConfirmationSummary(view([{ code: "document_secret", reason: "x" }]), "uk").heading).toBe("Схоже, у цьому файлі секрет");
  });

  test("Ukrainian counts take their plural forms", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index): DocumentWarning => ({ code: "document_outside_roots", path: `/srv/${index}`, roots: ["/srv/handoff"], reason: "outside" }));
    const forms = [1, 2, 5, 21].map(count => fileConfirmationSummary(view(many(count)), "uk"));
    expect(forms.map(summary => summary.warnings)).toEqual(["одне застереження", "два застереження", "5 застережень", "21 застереження"]);
    expect(forms.map(summary => summary.more)).toEqual([null, "Ще одна причина, чому Delegatus зупинив надсилання:", "Ще 4 причини, чому Delegatus зупинив надсилання:", "Ще 20 причин, чому Delegatus зупинив надсилання:"]);
    const images = (count: number) => Array.from({ length: count }, (_, index) => ({ path: `/srv/${index}.png`, resolvedPath: `/srv/${index}.png`, filename: `${index}.png`, sha256: "f".repeat(64), bytes: 1 }));
    expect([2, 5, 21].map(count => fileConfirmationSummary(view([outside], images(count)), "uk").intro)).toEqual([
      "Агент хоче надіслати два зображення у Orbit Reports.",
      "Агент хоче надіслати 5 зображень у Orbit Reports.",
      "Агент хоче надіслати 21 зображення у Orbit Reports.",
    ]);
  });

  test("decided sentences drop the time an old row never recorded", () => {
    const words = fileConfirmationText.en;
    expect(words.sentBody(null, "notes.md", "one warning")).toBe("You approved notes.md despite one warning.");
    expect(fileConfirmationText.uk.rejectedBody("15:03", "notes.md")).toBe("О 15:03 ви вирішили не надсилати notes.md.");
  });
});
