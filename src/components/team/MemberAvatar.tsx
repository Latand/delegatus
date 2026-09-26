import { MEMBER_COLOR_HEX, MEMBER_COLOR_INK, type MemberColor } from "@/lib/team/contract";

/**
 * A member's mark: their initials on their colour (sign-in-and-team §10.1).
 * Never a photo. Decoration beside a name that says the same thing, so it is
 * hidden from assistive technology; the ink is whichever of two reads better
 * on the colour (`contract.test.ts` pins the contrast). Below 20 px two
 * letters blur into the edge of the circle at DPR 1, so a small mark is the
 * colour alone.
 */
export function MemberAvatar({ name, initials, color, size = 16, className = "" }: {
  name: string;
  initials: string;
  color: MemberColor;
  size?: number;
  className?: string;
}) {
  if (size < 20) {
    const dot = Math.round(size * 0.625);
    return (
      <span
        aria-hidden
        data-member-avatar={color}
        title={name}
        className={`inline-flex shrink-0 items-center justify-center ${className}`}
        style={{ width: size, height: size }}
      >
        <span className="rounded-full" style={{ width: dot, height: dot, backgroundColor: MEMBER_COLOR_HEX[color] }} />
      </span>
    );
  }
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
        fontSize: Math.max(10, Math.round(size * (initials.length > 1 ? 0.42 : 0.5))),
        letterSpacing: initials.length > 1 ? "-0.02em" : undefined,
      }}
    >
      {initials}
    </span>
  );
}
