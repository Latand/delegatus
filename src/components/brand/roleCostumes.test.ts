import { describe, expect, test } from "bun:test";
import sharp from "sharp";

import { FRAME_ROLES } from "@/lib/roleFrames";
import { ROLE_IDS } from "@/lib/roles/types";

import { costumeSvg } from "./roleCostumes";

/*
 * The costumes of docs/design/role-avatars.md (round 2, §9) and the agent with
 * no role in sunglasses and a tuxedo: one drawing per role, each the shipped
 * mark with its own layer, every one inside the canvas the keyline needs.
 */

describe("role costumes", () => {
  test("every registry role and the agent with no role has its own drawing", () => {
    expect([...FRAME_ROLES]).toEqual([...ROLE_IDS, "neutral"]);
    const drawings = FRAME_ROLES.map((role) => costumeSvg(role));
    expect(new Set(drawings).size).toBe(FRAME_ROLES.length);
    for (const svg of drawings) {
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">')).toBe(true);
      expect(svg.endsWith("</svg>")).toBe(true);
      /* The shipped mark's red body and the pale keyline round the silhouette. */
      expect(svg).toContain('fill="#E0392B" d="M32 7C18 7');
      expect(svg).toContain('<g filter="url(#k)">');
    }
  });

  test("the agent with no role wears black sunglasses and a tuxedo in place of the clear glasses and the belly", () => {
    const agent = costumeSvg("neutral");
    /* Dark lenses and no pupils. */
    expect(agent).toContain('<g fill="#262B35" stroke="#231B1C" stroke-width="3.6"');
    expect(agent).not.toContain('<circle cx="22" cy="31"');
    /* The cream belly gives way to the jacket, the white shirt front and the bow tie. */
    expect(agent).not.toContain('cx="32" cy="54" rx="15" ry="11"');
    expect(agent).toContain('fill="#FFFFFF" d="M23.5 45.4H40.5L32 61Z"');
    expect(agent).toContain('M25.2 44.2 31 47.2 25.2 50.4Z');
    /* Every costumed role keeps the clear glasses (the reviewer's loupe replaces its right lens). */
    for (const role of ROLE_IDS) expect(costumeSvg(role)).toContain('<g fill="#FBEBDD" stroke="#231B1C" stroke-width="3.6"');
  });

  test("all ink sits inside x 3–61, y 2–62 of the 64 grid, so the keyline never meets the edge", async () => {
    const scale = 8;
    for (const role of FRAME_ROLES) {
      const bare = costumeSvg(role).replace('<g filter="url(#k)">', "<g>");
      const { data, info } = await sharp(Buffer.from(bare), { density: 72 * scale }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
      for (let y = 0; y < info.height; y += 1) for (let x = 0; x < info.width; x += 1) {
        if (data[(y * info.width + x) * info.channels + 3]! < 32) continue;
        left = Math.min(left, x); right = Math.max(right, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
      }
      const box = { role, left: left / scale, top: top / scale, right: right / scale, bottom: bottom / scale };
      expect(info.width).toBe(64 * scale);
      expect(box.left).toBeGreaterThanOrEqual(3);
      expect(box.top).toBeGreaterThanOrEqual(2);
      expect(box.right).toBeLessThanOrEqual(61);
      expect(box.bottom).toBeLessThanOrEqual(62);
    }
  });
});
