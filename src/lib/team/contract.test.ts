import { describe, expect, test } from "bun:test";

import {
  cleanMemberName,
  formatUserCode,
  MEMBER_COLOR_HEX,
  MEMBER_COLOR_INK,
  MEMBER_COLORS,
  memberInitials,
  normalizeUserCode,
  nullTeam,
  safeNextPath,
} from "./contract";

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

describe("member avatar colours", () => {
  test("every colour draws its initials in the ink that reads better, at 3.9:1 or more", () => {
    for (const color of MEMBER_COLORS) {
      const ink = MEMBER_COLOR_INK[color];
      const other = ink === "#ffffff" ? "#1f2328" : "#ffffff";
      const chosen = contrast(MEMBER_COLOR_HEX[color], ink);
      expect(chosen, color).toBeGreaterThanOrEqual(3.9);
      expect(chosen, color).toBeGreaterThanOrEqual(contrast(MEMBER_COLOR_HEX[color], other));
    }
  });
});

describe("names", () => {
  test("initials take the first letters of two words, or the first two letters of one", () => {
    expect(memberInitials("Mira Koval")).toBe("MK");
    expect(memberInitials("oleh")).toBe("OL");
    expect(memberInitials("Олег Петренко")).toBe("ОП");
    expect(memberInitials("  ")).toBe("?");
    expect(memberInitials("7")).toBe("7");
  });

  test("a stored name is collapsed, bounded to 60 characters and has no control bytes", () => {
    expect(cleanMemberName("  Mira \n  Koval ")).toBe("Mira Koval");
    expect(cleanMemberName("")).toBeNull();
    expect(cleanMemberName(42)).toBeNull();
    expect([...cleanMemberName("я".repeat(80))!].length).toBe(60);
  });
});

describe("approval codes", () => {
  test("a typed code is read without case or separators and only in the code alphabet", () => {
    expect(normalizeUserCode("kj7-4mp")).toBe("KJ74MP");
    expect(normalizeUserCode("KJ7 4MP")).toBe("KJ74MP");
    expect(normalizeUserCode("KJ0-4MP")).toBeNull();
    expect(normalizeUserCode("KJ7-4M")).toBeNull();
    expect(formatUserCode("KJ74MP")).toBe("KJ7-4MP");
  });
});

describe("the return path after sign-in", () => {
  test("only a same-origin path survives", () => {
    expect(safeNextPath("/team?tab=activity#x")).toBe("/team?tab=activity#x");
    expect(safeNextPath("https://evil.example/")).toBe("/");
    expect(safeNextPath("//evil.example/")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/sign-in?next=/")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });
});

describe("the seam", () => {
  test("an install without the module answers solo and names nobody", () => {
    expect(nullTeam.teamMode()).toBe("solo");
    expect(nullTeam.teamActor({ headers: new Headers(), cookies: { get: () => undefined } })).toEqual({ kind: "operator" });
    expect(nullTeam.refuseAnonymous({ kind: "anonymous" })).toBeNull();
    expect(nullTeam.messageSenders(["a"])).toEqual({});
  });
});
