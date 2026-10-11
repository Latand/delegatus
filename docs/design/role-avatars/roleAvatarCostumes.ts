/*
 * Variant 1 of docs/design/role-avatars.md, the direction the operator chose
 * on 2026-10-11: the Delegatus mark in a costume
 * per role. Every drawing is the shipped mark (public/brand/delegatus-mark.svg,
 * 64-unit grid) with one accessory layer, so the character, its glasses and its
 * red body stay identical across roles and only the silhouette's top or side
 * changes. Accessories carry the glasses' dark ink as their outline.
 *
 * Prototype source: render-frames.ts writes each drawing to svg/1-costume/ and
 * the conversation fixture patch inlines them as data URIs.
 */

export const AVATAR_ROLES = [
  "orchestrator", "reviewer", "verifier", "builder", "architect", "cleaner",
  "prod-auditor", "deployer", "merger", "maintainer", "issue-reporter", "visual-critic",
] as const;

export type AvatarRole = (typeof AVATAR_ROLES)[number] | "neutral";

const INK = "#231B1C";
const OUT = `stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"`;

const BODY_PATH = "M32 7C18 7 10 20 10 36C10 51 19 60 32 60C45 60 54 51 54 36C54 20 46 7 32 7Z";
const body = `<clipPath id="b"><path d="${BODY_PATH}"/></clipPath><path fill="#E0392B" d="${BODY_PATH}"/><ellipse clip-path="url(#b)" cx="32" cy="54" rx="15" ry="11" fill="#F7DCC6"/>`;
const hair = `<path fill="#7B6D68" d="M12 23C10 14 15 7 23 6C27 3 33 2 37 4C44 2 51 2 58 1C56 5 54 8 52 10C56 13 58 17 57 22C53 19 49 18 46 19C43 22 38 22 35 20C30 18 24 19 20 22C17 24 14 24 12 23Z"/><path fill="#ABA09B" d="M18 16Q34.4 12.1 50 6Q33.3 8.7 18 16Z"/>`;
/** The tuft that shows under a hat: the swept back of the hair. */
const tuft = `<path fill="#7B6D68" d="M50 20C54 19 57 17 59.5 13.5C59.5 18 57.5 21.5 54 23.5Z"/>`;
const lensL = `<rect x="13" y="25" width="16" height="11" rx="3"/>`;
const lensR = `<rect x="35" y="25" width="16" height="11" rx="3"/>`;
const glasses = (right = true) => `<g fill="#FBEBDD" stroke="${INK}" stroke-width="3.6" stroke-linejoin="round">${lensL}${right ? lensR : ""}</g><path d="M29 29.5H35" stroke="${INK}" stroke-width="3.2"/><circle cx="22" cy="31" r="2.3" fill="${INK}"/>${right ? `<circle cx="42" cy="31" r="2.3" fill="${INK}"/>` : ""}`;

/** A pale keyline around the whole silhouette. One file serves both schemes:
    on a light card it disappears, on a dark card it keeps dark-ink edges and
    dark hats off the background. */
const KEYLINE = `<filter id="k" x="-8%" y="-8%" width="116%" height="116%"><feMorphology in="SourceAlpha" operator="dilate" radius="1.7" result="d"/><feFlood flood-color="#FFF6EE" flood-opacity="0.7"/><feComposite in2="d" operator="in"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

type Layers = { behind?: string; hair?: "full" | "tuft" | "none"; front?: string; rightLens?: boolean };

const COSTUME: Record<AvatarRole, Layers> = {
  neutral: {},
  /* A dispatcher's headset: the band over the hair, indigo cups, a boom mic. */
  orchestrator: {
    front: `<path d="M8 28C6 11 18 3.5 32 3.5S58 11 56 28" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/><path d="M8 28C6 11 18 3.5 32 3.5S58 11 56 28" fill="none" stroke="#6366F1" stroke-width="2.2" stroke-linecap="round"/>`
      + `<rect x="2.5" y="22" width="10" height="15" rx="4" fill="#4F46E5" ${OUT}/><rect x="51.5" y="22" width="10" height="15" rx="4" fill="#4F46E5" ${OUT}/>`
      + `<path d="M7.5 37C7.5 46 13 50.5 21 50.5" fill="none" stroke="${INK}" stroke-width="2.8" stroke-linecap="round"/><circle cx="23.5" cy="50.5" r="3.4" fill="${INK}"/>`,
  },
  /* A big magnifier held over the right eye: a thick sky-blue rim that juts
     past the head's right edge, the eye behind it magnified. */
  reviewer: {
    rightLens: false,
    front: `<path d="M54 42 62.5 55" stroke="${INK}" stroke-width="7.6" stroke-linecap="round"/><path d="M54.6 42.9 61.9 54.1" stroke="#B7793F" stroke-width="4" stroke-linecap="round"/>`
      + `<circle cx="45" cy="30" r="13" fill="#E0F2FE" stroke="${INK}" stroke-width="7.4"/><circle cx="45" cy="30" r="13" fill="none" stroke="#0EA5E9" stroke-width="3.6"/><circle cx="45" cy="30.5" r="4.8" fill="${INK}"/><circle cx="46.8" cy="28.6" r="1.5" fill="#fff"/>`,
  },
  /* An inspector's green cap worn with the peak to the side, a white check on its crown. */
  verifier: {
    hair: "tuft",
    front: `<path d="M48 14.5 62.5 18.5C63.5 20.5 62 22.5 60 22.5L48 21.5Z" fill="#15803D" ${OUT}/>`
      + `<path d="M13 21C13 9.5 21 3.5 32 3.5S51 9.5 51 21C42 18.5 22 18.5 13 21Z" fill="#22C55E" ${OUT}/><circle cx="32" cy="3.8" r="1.8" fill="${INK}"/>`
      + `<path d="M22.5 11.5 28.5 16.5 40.5 6.5" fill="none" stroke="#fff" stroke-width="3.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  /* The operator's example: a yellow hard hat with a ridge and a full brim. */
  builder: {
    hair: "tuft",
    front: `<path d="M13 19.5C13 9 21 3.5 32 3.5S51 9 51 19.5Z" fill="#F6B60F" ${OUT}/><path d="M28.5 5H35.5V19H28.5Z" fill="#FFD84D"/>`
      + `<rect x="6.5" y="16.5" width="51" height="6" rx="3" fill="#E39E00" ${OUT}/>`,
  },
  /* A blue set square worn on the head like a hat, its ruler edge ticked,
     and a yellow pencil behind the ear. */
  architect: {
    hair: "tuft",
    front: `<g transform="rotate(-38 56 20)"><rect x="47" y="17.4" width="16" height="5.2" fill="#F6B60F" ${OUT}/><path d="M47 17.4 41 20 47 22.6Z" fill="#F7DCC6" ${OUT}/></g>`
      + `<path d="M12 21.5H50L14.5 1Z" fill="#0EA5E9" ${OUT}/><path d="M18.5 17.5H36L19.5 8Z" fill="#E0F2FE" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round"/>`
      + `<path d="M40.5 21.5V18.5M44 21.5V19.5M47 21.5V18.5" stroke="${INK}" stroke-width="1.3"/>`,
  },
  /* A green bandana knotted at the back, a broom's bristles at the side. */
  cleaner: {
    hair: "none",
    behind: `<path d="M8 8 46 52" stroke="#8B5A2B" stroke-width="3.6" stroke-linecap="round"/><path d="M44 48 56 41 63 58 52 63Z" fill="#E8B04A" ${OUT}/><path d="M50 50 57.5 46M52 54 59.5 50M54 58 61 54" stroke="${INK}" stroke-width="1.5"/>`,
    front: `<path d="M11.5 22C11.5 11 20 5 32 5S52.5 11 52.5 22C45 18.5 19 18.5 11.5 22Z" fill="#65A30D" ${OUT}/><circle cx="21" cy="12" r="1.6" fill="#ECFCCB"/><circle cx="31" cy="9.5" r="1.6" fill="#ECFCCB"/><circle cx="41" cy="12" r="1.6" fill="#ECFCCB"/>`
      + `<path d="M51 17 61 12 59 21Z" fill="#65A30D" ${OUT}/><path d="M51 19 60 25 54 26Z" fill="#4D7C0F" ${OUT}/>`,
  },
  /* A headlamp: dark strap over the forehead, a lit lamp and its glow. */
  "prod-auditor": {
    behind: "",
    front: `<path d="M10.5 22C14 15 50 15 53.5 22" fill="none" stroke="${INK}" stroke-width="4.4" stroke-linecap="round"/><circle cx="32" cy="16" r="11.5" fill="#FDE68A" opacity="0.75"/><circle cx="32" cy="16" r="7" fill="#BE123C" ${OUT}/><circle cx="32" cy="16" r="3.8" fill="#FDE047"/>`,
  },
  /* Flight goggles pushed up on the hair and a launch flame underneath. */
  deployer: {
    behind: `<path d="M20 55C22 62 26 64 26 64S29 60 32 64C35 60 38 64 38 64S42 62 44 55Z" fill="#F97316"/><path d="M26 56C27 60 29.5 62 32 62.5C34.5 62 37 60 38 56Z" fill="#FDE047"/>`,
    front: `<path d="M8 15.5C18 12 46 12 56 15.5" fill="none" stroke="#8B5A2B" stroke-width="3.6" stroke-linecap="round"/>`
      + `<circle cx="24" cy="14" r="6" fill="#7DD3FC" ${OUT}/><circle cx="40" cy="14" r="6" fill="#7DD3FC" ${OUT}/><path d="M30 14H34" stroke="${INK}" stroke-width="2.4"/><circle cx="22.4" cy="12.4" r="1.4" fill="#fff"/><circle cx="38.4" cy="12.4" r="1.4" fill="#fff"/>`,
  },
  /* A railway conductor's peaked cap: bright blue crown, gold band, merge badge. */
  merger: {
    hair: "tuft",
    front: `<path d="M14 19 15.5 6C24 2.5 40 2.5 48.5 6L50 19Z" fill="#2563EB" ${OUT}/><rect x="14" y="13" width="36" height="5.5" fill="#FBBF24"/>`
      + `<path d="M13 19C22 25 42 25 51 19V21.5C42 27.5 22 27.5 13 21.5Z" fill="${INK}"/><path d="M27.5 6.5 32 10.5 36.5 6.5M32 10.5V12.5" fill="none" stroke="#FDE68A" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
  },
  /* A teal knit beanie with a folded rib band and a pompom. */
  maintainer: {
    hair: "tuft",
    front: `<path d="M13.5 20C13.5 10 21.5 5 32 5S50.5 10 50.5 20Z" fill="#0D9488" ${OUT}/><circle cx="32" cy="4.6" r="4.4" fill="#F8FAFC" ${OUT}/>`
      + `<rect x="11.5" y="15" width="41" height="7.5" rx="3.5" fill="#2DD4BF" ${OUT}/><path d="M18 16.5V21M23 16.5V21M28 16.5V21M33 16.5V21M38 16.5V21M43 16.5V21M48 16.5V21" stroke="#0F766E" stroke-width="1.4"/>`,
  },
  /* A reporter's tan fedora with a PRESS card in the band. */
  "issue-reporter": {
    hair: "tuft",
    front: `<path d="M17.5 17 19.5 6.5C25 3 39 3 44.5 6.5L46.5 17Z" fill="#D4A95E" ${OUT}/><path d="M28 5.5 32 8.5 36 5.5" fill="none" stroke="${INK}" stroke-width="1.6"/><rect x="17.5" y="12.5" width="29" height="4.2" fill="${INK}"/>`
      + `<ellipse cx="32" cy="18.5" rx="25.5" ry="4.2" fill="#B8873A" ${OUT}/><g transform="rotate(12 41 10)"><rect x="35.5" y="5" width="12" height="8.5" rx="1" fill="#fff" stroke="${INK}" stroke-width="1.4"/><path d="M37.8 7.8H45.2M37.8 10.6H43.2" stroke="#E0392B" stroke-width="1.5"/></g>`,
  },
  /* A violet beret tipped to one side, with its stalk. */
  "visual-critic": {
    hair: "tuft",
    front: `<path d="M33 4.2 34.5 0.8" stroke="${INK}" stroke-width="2.6" stroke-linecap="round"/><path d="M10.5 18C8.5 10.5 20 4 33.5 4S57.5 9 55.5 15.5C53.5 21.5 41 21.5 31 20.5C21 19.5 12 22.5 10.5 18Z" fill="#6D28D9" ${OUT}/>`
      + `<path d="M16 14C24 9.5 38 8.5 48 10.5" fill="none" stroke="#A78BFA" stroke-width="1.6" stroke-linecap="round"/>`,
  },
};

/** One role's costume as a standalone SVG document on the mark's 64 grid. */
export function costumeSvg(role: AvatarRole): string {
  const layer = COSTUME[role];
  const hairLayer = layer.hair === "none" ? "" : layer.hair === "tuft" ? tuft : hair;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${KEYLINE}<g filter="url(#k)">${layer.behind ?? ""}${body}${hairLayer}${glasses(layer.rightLens !== false)}${layer.front ?? ""}</g></svg>`;
}
