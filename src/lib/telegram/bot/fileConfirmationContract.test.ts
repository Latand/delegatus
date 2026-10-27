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

  const shots = (...names: string[]) => names.map((name, index) => ({ path: `/srv/shots/${name}`, resolvedPath: `/srv/shots/${name}`, filename: name, sha256: String(index).repeat(64), bytes: index + 1 }));
  const away = (name: string): DocumentWarning => ({ code: "document_outside_roots", path: `/srv/shots/${name}`, roots: ["/srv/handoff"], reason: "outside" });
  const dotted = (name: string): DocumentWarning => ({ code: "document_forbidden_path", path: `/srv/shots/${name}`, segment: ".cache", reason: "hidden" });

  test("one reason every image shares is said once, for all of them", () => {
    const files = shots("one.png", "two.png");
    const en = fileConfirmationSummary(view([away("one.png"), away("two.png")], files), "en");
    expect(en).toMatchObject({ heading: "Both images are outside the folders files may be sent from (handoff)", intro: "An agent wants to send two images to Orbit Reports.", more: null, reasons: [], real: null });
    const uk = fileConfirmationSummary(view([away("one.png"), away("two.png")], files), "uk");
    expect(uk).toMatchObject({ heading: "Обидва зображення поза теками, з яких дозволено надсилати (handoff)", intro: "Агент хоче надіслати два зображення у Orbit Reports.", more: null, reasons: [] });
    const three = shots("a.png", "b.png", "c.png");
    expect(fileConfirmationSummary(view(three.map(file => dotted(file.filename)), three), "en").heading).toBe("All three images are inside the hidden folder .cache");
    expect(fileConfirmationSummary(view(three.map(file => dotted(file.filename)), three), "uk").heading).toBe("Усі три зображення лежать у прихованій теці .cache");
  });

  test("among several images the heading names the ones its reason holds for", () => {
    const files = shots("one.png", "two.png", "three.png");
    const single = fileConfirmationSummary(view([away("two.png")], files), "en");
    expect(single).toMatchObject({ heading: "two.png is outside the folders files may be sent from (handoff)", more: null, reasons: [] });
    expect(single.names).toContain("two.png");
    expect(fileConfirmationSummary(view([away("two.png")], files), "uk").heading).toBe("two.png поза теками, з яких дозволено надсилати (handoff)");
    const pair = fileConfirmationSummary(view([dotted("one.png"), away("one.png"), dotted("three.png")], files), "en");
    expect(pair).toMatchObject({ heading: "one.png and three.png are inside the hidden folder .cache", more: "One more reason Delegatus paused it:", reasons: ["one.png is outside the folders files may be sent from (handoff)."], warnings: "three warnings" });
    expect(fileConfirmationSummary(view([dotted("one.png"), away("one.png"), dotted("three.png")], files), "uk")).toMatchObject({ heading: "one.png і three.png лежать у прихованій теці .cache", more: "Ще одна причина, чому Delegatus зупинив надсилання:" });
  });

  test("the same code with another folder stays its own reason", () => {
    const files = shots("one.png", "two.png");
    const other: DocumentWarning = { ...dotted("two.png"), segment: ".git" };
    const summary = fileConfirmationSummary(view([dotted("one.png"), other], files), "en");
    expect(summary.heading).toBe("one.png is inside the hidden folder .cache");
    expect(summary.reasons).toEqual(["two.png is inside the hidden folder .git."]);
  });

  test("a lead reason without a path among several images names no file", () => {
    const files = shots("one.png", "two.png");
    const bare: DocumentWarning = { code: "document_outside_roots", roots: ["/srv/handoff"], reason: "outside" };
    expect(fileConfirmationSummary(view([bare, away("two.png")], files), "en")).toMatchObject({ heading: "One of these files is outside the folders files may be sent from (handoff)", reasons: ["two.png is outside the folders files may be sent from (handoff)."] });
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
