/* Straight from lucide: `@/components/icons` imports this module for the engine
   glyph names, and a cycle through it would be needless. */
import { MessageCircle, Terminal } from "lucide-react";

import { engineBadgeFor } from "@/components/utils";

/**
 * The one engine mark the Viewer draws (#1743). Every surface that used to pick
 * its own glyph — a lucide `Sparkle`, a `Command`, a coloured dot, a filled
 * avatar — renders this instead, so Claude, Codex and Antigravity read the same
 * on a conversation card, a stage chip, a graph node, a pane header and a
 * limits footer.
 *
 * ## Where the marks come from
 *
 * **Claude** is the vendor's own mark, so it is recognisable rather than a
 * lookalike. The path is copied verbatim (geometry unaltered) from the
 * `simple-icons` package, v16.31.0, `icons/claude.svg`, whose icon set is
 * released under CC0 1.0 Universal; the package is NOT a dependency of this
 * repository, only the one path was taken. It is drawn monochrome in the engine
 * mark token — never a gradient, never re-proportioned — and the use is
 * nominative: it names which tool runs a stage.
 *
 * **Codex** is drawn for this product, because the vendor's mark cannot be
 * redistributed here: `simple-icons` removed OpenAI in v16.0.0 (PR 13944,
 * closing issue 12739) on the ground that the permission OpenAI's brand terms
 * grant is non-transferable, so a third-party repository may not ship the path.
 * The drawn mark is a prompt knocked out of a filled disc. A disc against the
 * outlined square of the shell's terminal glyph is a silhouette difference, not
 * a fill-and-hue one, so the two never read alike at 12 px.
 *
 * **Antigravity** is drawn for this product as the periodic-table tile for Neon
 * (atomic number 10 in the top-left corner above Ne) — the exact same drawing
 * `StageGlyph` uses for the `neon` model glyph (`NeonTileSvg`), painted in
 * `--color-antigravity-mark` / `--glyph-neon` and sharing the CSS neon glow
 * (`modelGlyph.css`) whenever `working` is true.
 *
 * Colour never carries the engine alone: Claude's open spark, Codex's solid
 * disc and Antigravity's periodic-table Ne tile differ in silhouette, so they
 * read in monochrome and for colour-blind operators. `--color-claude-mark`,
 * `--color-codex-mark` and `--color-antigravity-mark` are the mark tokens
 * (each clearing the 3:1 floor for a graphical object on light and dark
 * surfaces).
 *
 * Codex's cut-out strokes are painted in `--engine-mark-cut`, which defaults to
 * the card surface. A host that draws the mark inside a filled avatar sets that
 * variable to its own fill, so the prompt stays a hole rather than a smudge.
 */

export type EngineMarkSize = 12 | 14 | 16 | 18 | 24;

/* Periodic-table cell for Neon (element 10, symbol Ne) on a 16-unit grid:
   atomic number 10 in the top-left corner above Ne, plus an inner neon gas
   chamber (`.mg-neon-gas`) that glows and pulses over GLYPH_TURN_MS when live. */
const NEON_NUM = "M3.15 2.75V4.85";
const NEON_SYM = "M3.2 12.6V6.8L7.3 12.6V6.8M9.55 10.6H12.9C12.9 9.25 12.15 8.4 11.2 8.4C10.15 8.4 9.45 9.3 9.45 10.55C9.45 11.8 10.2 12.6 11.35 12.6C12 12.6 12.5 12.38 12.8 12.05";

/** Shared Neon periodic-table tile SVG drawn by both `EngineMark` and `StageGlyph`. */
export function NeonTileSvg({ style }: { style?: { width: string; height: string } }) {
  return (
    <svg viewBox="0 0 16 16" style={style} aria-hidden="true">
      <rect className="mg-neon-gas" x="2.1" y="2.1" width="11.8" height="11.8" rx="1.4" />
      <rect className="mg-tile" x="1" y="1" width="14" height="14" rx="2.3" />
      <path className="mg-neon-num" d={NEON_NUM} />
      <rect className="mg-neon-num" x="4.4" y="2.75" width="1.7" height="2.1" rx="0.8" />
      <path className="mg-neon-sym" d={NEON_SYM} />
    </svg>
  );
}

export function EngineMark({ engine, size = 12, tone = "engine", label, working = false, className }: {
  engine: string;
  /** Square box in px. The mark never shrinks inside a flex row. */
  size?: EngineMarkSize;
  /** `engine` paints the mark in its engine token; `inherit` takes `currentColor`,
      for a white mark inside a filled avatar. */
  tone?: "engine" | "inherit";
  /** Present: the mark is an image with this label. Absent: it is decoration
      beside text (or a host label) that already names the engine. */
  label?: string;
  /** True only while the agent's turn is actively running. For Antigravity,
      activates the shared CSS neon halo and gas pulse (steady under reduced motion). */
  working?: boolean;
  className?: string;
}) {
  const aria = label ? { role: "img" as const, "aria-label": label } : { "aria-hidden": true };
  const color = tone === "inherit" ? undefined
    : engine === "claude" ? "var(--color-claude-mark)"
      : engine === "codex" ? "var(--color-codex-mark)"
        : engine === "antigravity" ? "var(--color-antigravity-mark)"
          : engine === "openclaw" ? "var(--color-openclaw)"
            : "var(--color-muted)";
  const isAntigravity = engine === "antigravity";
  return (
    <span
      data-engine-mark={engine}
      data-live={isAntigravity && working ? "1" : undefined}
      className={`inline-grid shrink-0 place-items-center${isAntigravity ? " emark-neon" : ""}${className ? ` ${className}` : ""}`}
      style={{ width: `${size}px`, height: `${size}px`, color }}
      title={label}
      {...aria}
    >
      <EngineGlyph engine={engine} size={size} />
    </span>
  );
}

/* The Claude spark, verbatim from simple-icons v16.31.0 `icons/claude.svg`
   (CC0 1.0 Universal). Do not re-fit or re-path it: the amendment to the #1743
   design note requires the vendor's own geometry. */
const CLAUDE_SPARK = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

function EngineGlyph({ engine, size }: { engine: string; size: number }) {
  const box = { width: `${size}px`, height: `${size}px` } as const;
  if (engine === "claude") {
    return (
      <svg viewBox="0 0 24 24" style={box} fill="currentColor" aria-hidden>
        <path d={CLAUDE_SPARK} />
      </svg>
    );
  }
  if (engine === "codex") {
    return (
      <svg viewBox="0 0 16 16" style={box} aria-hidden>
        <circle cx="8" cy="8" r="7.25" fill="currentColor" />
        <path
          d="M5 5.6 7.6 8 5 10.4M8.9 10.8h2.6"
          fill="none"
          stroke="var(--engine-mark-cut, var(--surface-card))"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (engine === "antigravity") return <NeonTileSvg style={box} />;
  if (engine === "openclaw") return <MessageCircle style={box} aria-hidden />;
  if (engine === "shell") return <Terminal style={box} aria-hidden />;
  /* An engine this build has no mark for: a neutral dot, never a wrong mark. */
  return <span aria-hidden style={{ width: "6px", height: "6px", borderRadius: "999px", background: "currentColor" }} />;
}

/**
 * The engine as a pill: the one mark, then the engine's own word, in the engine
 * tint these badges have always carried (#1743).
 *
 * Every surface that named an engine as a bare tinted WORD — a conversation
 * card with no model of its own, the branch pane's header, global search, the
 * round deck, the incumbent orchestrator — draws this instead, so the icon
 * vocabulary and the word vocabulary are one. The pill's own padding and type
 * size stay the host's, because these sit in rows tuned to very different
 * densities; what is shared is the mark, the word and the tint.
 */
export function EngineBadge({ engine, className = "", title, size = 12, working = false }: {
  engine: string;
  className?: string;
  title?: string;
  size?: EngineMarkSize;
  working?: boolean;
}) {
  const badge = engineBadgeFor(engine);
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full ${className}`} style={badge.style} title={title}>
      <EngineMark engine={engine} size={size} tone={engine === "antigravity" ? "engine" : "inherit"} working={working} />
      {badge.label}
    </span>
  );
}
