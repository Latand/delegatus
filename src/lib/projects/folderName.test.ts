import { describe, expect, test } from "bun:test";

import { FOLDER_NAME_MAX, folderName } from "./folderName";

describe("folderName", () => {
  /* Red on main: the module is new. */
  test.each([
    ["PR GRAM", "pr-gram"],
    ["Мій проєкт", "mii-proiekt"],
    ["Щоденник", "shchodennyk"],
    ["Ярослав", "yaroslav"],
    ["Café déjà vu!", "cafe-deja-vu"],
    ["  ../../etc  ", "etc"],
    ["项目", "project"],
    ["🚀🚀", "project"],
    ["...", "project"],
    ["CON", "con-project"],
    ["com7", "com7-project"],
    ["LPT1", "lpt1-project"],
    ["worktrees", "worktrees-project"],
    [".worktrees", "worktrees-project"],
    ["a/b\\c", "a-b-c"],
  ])("%s becomes %s", (name, expected) => {
    expect(folderName(name)).toBe(expected);
  });

  test.each([
    ["Євген", "yevhen"],
    ["Їжак", "yizhak"],
    ["Йосип", "yosyp"],
    ["Юля", "yulia"],
    ["Яма", "yama"],
    ["мої ємності", "moi-yemnosti"],
    ["змія", "zmiia"],
    ["район", "raion"],
    ["2 яблука", "2-yabluka"],
  ])("Ukrainian letters take their word-start or medial form: %s", (name, expected) => {
    expect(folderName(name)).toBe(expected);
  });

  test.each([
    ["п'ять", "piat"],
    ["п’ять", "piat"],
    ["пʼять", "piat"],
    ["кінь", "kin"],
  ])("apostrophes and the soft sign vanish and leave the next letter medial: %s", (name, expected) => {
    expect(folderName(name)).toBe(expected);
  });

  test("Russian-only letters have a form, so a Russian name keeps its letters", () => {
    expect(folderName("Ёлка съела мышь Эх")).toBe("yolka-sela-mysh-ekh");
  });

  test("decomposed and composed spellings give one folder", () => {
    expect(folderName("Мій".normalize("NFD"))).toBe(folderName("Мій".normalize("NFC")));
    expect(folderName("déjà".normalize("NFD"))).toBe("deja");
  });

  test("the result only ever holds a-z, 0-9 and an inner hyphen", () => {
    for (const name of ["..", "~/.ssh", "C:\\Windows", "a\u0000b", "\u202Egnp.exe", "  -x-  ", "UPPER_case.Name", "ß"]) {
      expect(folderName(name)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  test("a long name is cut at a hyphen past position 24", () => {
    const words = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike";
    const slug = folderName(words);
    expect(slug.length).toBeLessThanOrEqual(FOLDER_NAME_MAX);
    expect(slug).toBe("alpha-bravo-charlie-delta-echo-foxtrot-golf");
  });

  test("a hyphen right after the 48th character keeps the whole word", () => {
    expect(folderName(`${"a".repeat(30)} ${"b".repeat(17)} tail`)).toBe(`${"a".repeat(30)}-${"b".repeat(17)}`);
  });

  test("a long name with no hyphen past position 24 is cut at the limit", () => {
    expect(folderName("x".repeat(80))).toBe("x".repeat(48));
    expect(folderName(`short ${"y".repeat(80)}`)).toBe(`short-${"y".repeat(42)}`);
  });

  test("a cut leaves no trailing hyphen", () => {
    expect(folderName(`${"z".repeat(47)}- tail`)).toBe("z".repeat(47));
  });
});
