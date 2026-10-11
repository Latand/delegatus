import type { FrameRole } from "@/lib/roleFrames";

/*
 * Delegatus in each role's costume (docs/design/role-avatars.md, variant 1 as
 * redrawn in round 2, §9). Every drawing is the shipped mark
 * (public/brand/delegatus-mark.svg, 64-unit grid) with one costume layer over
 * it, so the character, its glasses and its red body stay the same across
 * roles and only the silhouette's top or side changes. `neutral`, the agent
 * with no role, wears black sunglasses and a tuxedo (operator, 2026-10-11).
 *
 * The rules every costume follows (role-avatars-critique-2.md):
 *  - all ink inside x 3–61, y 2–62, so the keyline never meets the edge;
 *  - two line weights: accessory outlines 2.6, the glasses 3.6; nothing inside
 *    an accessory thinner than 2;
 *  - no highlights or glints: every hat is flat colour like the body;
 *  - a hat covers the hair, with no grey fin behind it;
 *  - one pale keyline round the silhouette, so one file serves both schemes.
 */

const INK = "#231B1C";
const OUT = `stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"`;
/** A coloured strap or rim: the colour band over an ink band 2.6 wider, so it
    shows the same 1.3 ink edge on each side as an outlined shape. */
const band = (d: string, colour: string, width: number) =>
  `<path d="${d}" fill="none" stroke="${INK}" stroke-width="${width + 2.6}" stroke-linecap="round"/><path d="${d}" fill="none" stroke="${colour}" stroke-width="${width}" stroke-linecap="round"/>`;

/* ── The shipped mark underneath ─────────────────────────────────────────── */
const BODY_PATH = "M32 7C18 7 10 20 10 36C10 51 19 60 32 60C45 60 54 51 54 36C54 20 46 7 32 7Z";
const BODY_CLIP = `<clipPath id="b"><path d="${BODY_PATH}"/></clipPath>`;
const BODY = `<path fill="#E0392B" d="${BODY_PATH}"/>`;
const BELLY = `<ellipse clip-path="url(#b)" cx="32" cy="54" rx="15" ry="11" fill="#F7DCC6"/>`;
const HAIR = `<path fill="#7B6D68" d="M12 23C10 14 15 7 23 6C27 3 33 2 37 4C44 2 51 2 58 1C56 5 54 8 52 10C56 13 58 17 57 22C53 19 49 18 46 19C43 22 38 22 35 20C30 18 24 19 20 22C17 24 14 24 12 23Z"/><path fill="#ABA09B" d="M18 16Q34.4 12.1 50 6Q33.3 8.7 18 16Z"/>`;
/* The mark's swept tip reaches y 1; a costume that keeps the hair draws it
   1.4 units lower so the keyline stays inside the canvas. */
const HAIR_TRIMMED = HAIR.replace("C44 2 51 2 58 1C56 5 54 8", "C44 2.6 51 2.8 57.4 2.6C55.8 5.6 54 8");
/* The orchestrator's band holds the hair: everything above its arc is trimmed. */
const HEADSET_ARC = "M8.5 30C6 13.5 18 5 32 5S58 13.5 55.5 30";
const HAIR_UNDER_BAND = `<clipPath id="h"><path d="${HEADSET_ARC}Z"/></clipPath><g clip-path="url(#h)">${HAIR}</g>`;
const LENS_L = `<rect x="13" y="25" width="16" height="11" rx="3"/>`;
const LENS_R = `<rect x="35" y="25" width="16" height="11" rx="3"/>`;
const BRIDGE = `<path d="M29 29.5H35" stroke="${INK}" stroke-width="3.2"/>`;
function glasses(kind: "clear" | "no-right-lens" | "sunglasses"): string {
  if (kind === "sunglasses") return `<g fill="#262B35" stroke="${INK}" stroke-width="3.6" stroke-linejoin="round">${LENS_L}${LENS_R}</g>${BRIDGE}`;
  const right = kind === "clear";
  return `<g fill="#FBEBDD" stroke="${INK}" stroke-width="3.6" stroke-linejoin="round">${LENS_L}${right ? LENS_R : ""}</g>${BRIDGE}<circle cx="22" cy="31" r="2.3" fill="${INK}"/>${right ? `<circle cx="42" cy="31" r="2.3" fill="${INK}"/>` : ""}`;
}
/** The pale keyline: invisible on a light card, an edge on a dark one. */
const KEYLINE = `<filter id="k" x="-8%" y="-8%" width="116%" height="116%"><feMorphology in="SourceAlpha" operator="dilate" radius="1.2" result="d"/><feFlood flood-color="#FFF6EE" flood-opacity="0.55"/><feComposite in2="d" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

/** One role's costume: what it does to the mark's hair, belly and glasses, and the layer it adds. */
interface Costume {
  hair: "full" | "trimmed" | "under-band" | "none";
  glasses?: "clear" | "no-right-lens" | "sunglasses";
  /** Drawn in place of the cream belly, clipped to the body. */
  belly?: string;
  front?: string;
}

const COSTUMES: Record<FrameRole, Costume> = {
  /* The agent with no role: black sunglasses and a tuxedo — black jacket,
     white shirt front and a black bow tie at the bottom of the circle. */
  neutral: {
    hair: "trimmed",
    glasses: "sunglasses",
    belly: `<path clip-path="url(#b)" fill="${INK}" d="M4 43.5C12 46.5 19 46.8 23.5 45.4L32 61 40.5 45.4C45 46.8 52 46.5 60 43.5V66H4Z"/>`
      + `<path clip-path="url(#b)" fill="#FFFFFF" d="M23.5 45.4H40.5L32 61Z"/>`
      + `<path fill="${INK}" d="M25.2 44.2 31 47.2 25.2 50.4Z"/><path fill="${INK}" d="M38.8 44.2 33 47.2 38.8 50.4Z"/><rect x="29.6" y="45.2" width="4.8" height="4.2" rx="1.2" fill="${INK}"/>`,
  },
  /* A dispatcher's headset: a lighter indigo band holding the hair, cups that
     hold on the dark accent card, a boom ending in a capsule at the mouth corner. */
  orchestrator: {
    hair: "under-band",
    front: band(HEADSET_ARC, "#818CF8", 3)
      + `<rect x="4.5" y="23" width="9" height="15" rx="4" fill="#818CF8" ${OUT}/><rect x="50.5" y="23" width="9" height="15" rx="4" fill="#818CF8" ${OUT}/>`
      + `<path d="M9 38C9 43.5 13 46 19.5 45.8" fill="none" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/><rect x="18.5" y="42.9" width="8" height="5.6" rx="2.8" fill="#818CF8" ${OUT}/>`,
  },
  /* A magnifier held over the right eye, the eye behind it magnified. */
  reviewer: {
    hair: "trimmed",
    glasses: "no-right-lens",
    front: band("M46 39.5 48.8 51.5", "#B7793F", 3.4)
      + `<circle cx="41" cy="30" r="10.5" fill="#E0F2FE"/>${band("M51.5 30A10.5 10.5 0 1 1 30.5 30A10.5 10.5 0 1 1 51.5 30", "#0EA5E9", 3)}<circle cx="41" cy="30.5" r="4.6" fill="${INK}"/>`,
  },
  /* An inspector's green cap worn with the peak to the side, a white check on its crown. */
  verifier: {
    hair: "none",
    front: `<path d="M47.5 13.5 56.5 16C58.6 16.6 58.8 19.6 56.6 19.9L47.5 20.4Z" fill="#15803D" ${OUT}/>`
      + `<path d="M13 21C13 9.5 21 3.5 32 3.5S51 9.5 51 21C42 18.5 22 18.5 13 21Z" fill="#22C55E" ${OUT}/>`
      + `<path d="M23 11.5 28.5 16 40 6.8" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  /* A yellow hard hat with a ridge and a full brim. */
  builder: {
    hair: "none",
    front: `<path d="M13 19.5C13 9 21 3.5 32 3.5S51 9 51 19.5Z" fill="#F6B60F" ${OUT}/><path d="M28.6 4.4H35.4V18.2H28.6Z" fill="#E39E00"/>`
      + `<rect x="6.5" y="16.5" width="51" height="6" rx="3" fill="#E39E00" ${OUT}/>`,
  },
  /* A 45° set square standing centred on the crown, and a yellow pencil
     behind the right ear, clear of the glasses. */
  architect: {
    hair: "none",
    front: `<path d="M15 21H49L32 4Z" fill="#0EA5E9" ${OUT}/><path d="M24 16.6H40L32 8.6Z" fill="#E0F2FE"/>`
      + `<path d="M21.5 21V18.2M27.5 21V18.2M36.5 21V18.2M42.5 21V18.2" stroke="${INK}" stroke-width="2"/>`
      + `<g transform="translate(53.4 9.8) rotate(-11.6)"><path d="M-2.6 0H2.6V11L0 16.4-2.6 11Z" fill="#F6B60F" ${OUT}/><path d="M-2.6 11H2.6L0 16.4Z" fill="#F7DCC6" ${OUT}/><path d="M-1 14H1L0 16.4Z" fill="${INK}"/></g>`,
  },
  /* A pink polka-dot bandana knotted at the right, and a broom leaning at the
     left side, outside the glasses (operator, round 2: keep the broom). */
  cleaner: {
    hair: "none",
    front: `<path d="M50.5 16 59.6 9.6 59.2 22.4Z" fill="#F472B6" ${OUT}/><path d="M50.5 19.5 59.6 27 52 28.6Z" fill="#DB2777" ${OUT}/>`
      + `<path d="M11.5 22C11.5 11 20 5 32 5S52.5 11 52.5 22C45 18.5 19 18.5 11.5 22Z" fill="#F472B6" ${OUT}/><circle cx="21" cy="12.5" r="1.8" fill="#fff"/><circle cx="31.5" cy="9.5" r="1.8" fill="#fff"/><circle cx="42" cy="12.5" r="1.8" fill="#fff"/><circle cx="26.5" cy="16.2" r="1.8" fill="#fff"/><circle cx="37" cy="16.2" r="1.8" fill="#fff"/>`
      + band("M6.8 19 8.4 43", "#8B5A2B", 3)
      + `<path d="M6.2 43H10.8L12.6 54H5Z" fill="#E8B04A" ${OUT}/><path d="M5.9 46.4H11.4" stroke="${INK}" stroke-width="2"/>`,
  },
  /* A headlamp: a rose strap, a large lamp, a beam leaving the head past its top left. */
  "prod-auditor": {
    hair: "trimmed",
    front: `<path d="M31 14 3.5 2.5 3.5 17Z" fill="#FDE047" opacity="0.9"/>`
      + band("M10.5 21C14 14.5 50 14.5 53.5 21", "#E11D48", 3)
      + `<circle cx="32" cy="14" r="8" fill="#E11D48" ${OUT}/><circle cx="32" cy="14" r="5" fill="#FEF9C3"/>`,
  },
  /* An orange flight cap over the hair, with a strap and small tinted goggles on it. */
  deployer: {
    hair: "none",
    front: `<path d="M11 23C10 11 19 4 32 4S54 11 53 23C46 19.5 18 19.5 11 23Z" fill="#F97316" ${OUT}/>`
      + `<path d="M12 16C20 11.8 44 11.8 52 16" fill="none" stroke="#7C2D12" stroke-width="3" stroke-linecap="round"/>`
      + `<ellipse cx="25" cy="13" rx="4.6" ry="3.9" fill="#0E7490" ${OUT}/><ellipse cx="39" cy="13" rx="4.6" ry="3.9" fill="#0E7490" ${OUT}/><path d="M29.6 13H34.4" stroke="${INK}" stroke-width="2.6"/>`,
  },
  /* A conductor's cap flaring to the top: bright blue crown, gold band, a
     dark-blue peak clear of the glasses, a gold merge badge. */
  merger: {
    hair: "none",
    front: `<path d="M15.5 16 13 5.5C21 2.6 43 2.6 51 5.5L48.5 16Z" fill="#2563EB"/><path d="M14.5 11.4H49.5L48.6 15.6H15.4Z" fill="#FBBF24"/><path d="M15.5 16 13 5.5C21 2.6 43 2.6 51 5.5L48.5 16Z" fill="none" ${OUT}/>`
      + `<path d="M14.5 16C23 19.5 41 19.5 49.5 16L50 17.6C42 21 22 21 14 17.6Z" fill="#1E3A8A" ${OUT}/>`
      + `<circle cx="32" cy="7.9" r="4" fill="#FBBF24"/><path d="M29.8 5.9 32 8.2 34.2 5.9M32 8.2V10.4" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  /* A teal knit beanie with a ribbed band and a pompom. */
  maintainer: {
    hair: "none",
    front: `<path d="M13.5 20C13.5 10 21.5 6 32 6S50.5 10 50.5 20Z" fill="#0D9488" ${OUT}/><circle cx="32" cy="7" r="3.6" fill="#F8FAFC" ${OUT}/>`
      + `<rect x="11.5" y="15" width="41" height="7.5" rx="3.5" fill="#2DD4BF" ${OUT}/><path d="M17 16.4H19V21.1H17ZM23 16.4H25V21.1H23ZM29 16.4H31V21.1H29ZM35 16.4H37V21.1H35ZM41 16.4H43V21.1H41ZM47 16.4H49V21.1H47Z" fill="#0F766E" opacity="0.6"/>`,
  },
  /* A reporter's tan fedora with an upright PRESS card, one red «!» on it. */
  "issue-reporter": {
    hair: "none",
    front: `<path d="M17.5 17 19.5 6.5C25 3 39 3 44.5 6.5L46.5 17Z" fill="#D4A95E" ${OUT}/><rect x="17.5" y="12.5" width="29" height="4.2" fill="${INK}"/>`
      + `<ellipse cx="32" cy="18.5" rx="25.5" ry="4.2" fill="#B8873A" ${OUT}/>`
      + `<rect x="35" y="5.2" width="10" height="11" rx="1.2" fill="#fff" ${OUT}/><rect x="38.8" y="7.2" width="2.4" height="4.8" rx="1.2" fill="#E0392B"/><circle cx="40" cy="14" r="1.3" fill="#E0392B"/>`,
  },
  /* A violet beret tipped to one side, with its stalk. */
  "visual-critic": {
    hair: "none",
    front: `<path d="M33.5 5.8 34.6 3.4" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/><path d="M10.5 18.5C8.5 11 20 5 33.5 5S57.5 10 55.5 16C53.5 22 41 22 31 21C21 20 12 23 10.5 18.5Z" fill="#6D28D9" ${OUT}/>`,
  },
};

/** One role's costume as a standalone SVG document on the mark's 64 grid. */
export function costumeSvg(role: FrameRole): string {
  const costume = COSTUMES[role];
  const hair = costume.hair === "none" ? "" : costume.hair === "under-band" ? HAIR_UNDER_BAND : costume.hair === "trimmed" ? HAIR_TRIMMED : HAIR;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${KEYLINE}<g filter="url(#k)">${BODY_CLIP}${BODY}${costume.belly ?? BELLY}${hair}${glasses(costume.glasses ?? "clear")}${costume.front ?? ""}</g></svg>`;
}
