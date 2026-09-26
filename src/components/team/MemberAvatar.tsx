import { MEMBER_COLOR_HEX, MEMBER_COLOR_INK, type MemberColor } from "@/lib/team/contract";

/**
 * A member's mark: their initials on their colour (sign-in-and-team §10.1).
 * Never a photo. Decoration beside a name that says the same thing, so it is
 * hidden from assistive technology; the ink is whichever of two reads better
 * on the colour (`contract.test.ts` pins the contrast).
 */
export function MemberAvatar({ name, initials, color, size = 16, className = "" }: {
  name: string;
  initials: string;
  color: MemberColor;
  size?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-member-avatar={color}
      title={name}
      className={`inline-flex shrink-0 select-none items-center justify-center rounded-full font-bold leading-none ${className}`}
      style={{
        width: size,
        height: size,
        backgroundColor: MEMBER_COLOR_HEX[color],
        color: MEMBER_COLOR_INK[color],
        fontSize: Math.max(8, Math.round(size * (initials.length > 1 ? 0.42 : 0.5))),
        letterSpacing: initials.length > 1 ? "-0.02em" : undefined,
      }}
    >
      {initials}
    </span>
  );
}
