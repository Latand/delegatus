import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { FRAME_ROLES } from "@/lib/roleFrames";

import { roleAvatarDarkCss } from "./roleAvatarDarkCss";
import { costumeSvg } from "./roleCostumes";

describe("role avatars in the dark theme", () => {
  const css = roleAvatarDarkCss();

  test("every role has one picture and a rule in each dark scope, and the light theme matches nothing", () => {
    for (const role of FRAME_ROLES) {
      expect(css.match(new RegExp(`--ra-${role}:url\\(`, "g"))).toHaveLength(1);
      expect(css).toContain(`:root:not([data-theme="light"]) img[data-role-avatar="${role}"]{content:var(--ra-${role})}`);
      expect(css).toContain(`[data-theme="dark"] img[data-role-avatar="${role}"]{content:var(--ra-${role})}`);
    }
    /* Outside the custom properties, every rule sits inside the dark media block or on data-theme="dark". */
    const withoutVariables = css.replace(/:root\{[^}]*\}/, "");
    const selectors = [...withoutVariables.matchAll(/([^{}]+)\{content:/g)].map((match) => match[1]!.replace(/^@media[^{]*\{/, ""));
    expect(selectors).toHaveLength(FRAME_ROLES.length * 2);
    for (const selector of selectors) expect(selector.startsWith(':root:not([data-theme="light"]) ') || selector.startsWith('[data-theme="dark"] ')).toBe(true);
    expect(withoutVariables.startsWith("@media (prefers-color-scheme:dark){")).toBe(true);
  });

  test("each picture is the keyline-free drawing and renders the same as the dark SVG", async () => {
    for (const role of FRAME_ROLES) {
      const url = css.match(new RegExp(`--ra-${role}:url\\("data:image/svg\\+xml;utf8,([^"]*)"\\)`))?.[1];
      expect(url).toBeDefined();
      expect(url).not.toMatch(/[#<>"]/);
      expect(url).not.toContain("feMorphology");
      const decoded = url!.replaceAll("%23", "#").replaceAll("%3C", "<").replaceAll("%3E", ">").replaceAll("%25", "%");
      const render = (svg: string) => sharp(Buffer.from(svg), { density: 144 }).ensureAlpha().raw().toBuffer();
      expect((await render(decoded)).equals(await render(costumeSvg(role, "dark")))).toBe(true);
    }
  });
});
