/**
 * The tour's five pictures (#1876 slice 3, design §2.4 "Schematics"): inline
 * SVG on a 160 × 100 box, strokes in `currentColor` over `text-muted`, fills
 * from the app's own tokens, and no text inside, so nothing needs translating
 * and nothing can overflow. Decorative: the card's title and body carry the
 * meaning.
 */

const STROKE = { stroke: "currentColor", strokeWidth: 1.5, fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;

function Frame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 160 100" aria-hidden focusable="false" className={`h-full w-full text-muted ${className ?? ""}`} preserveAspectRatio="xMidYMid meet">
      {children}
    </svg>
  );
}

const card = (x: number, y: number, bar?: string) => (
  <g key={`${x}-${y}`}>
    <rect x={x} y={y} width={36} height={12} rx={2.5} fill="var(--color-sunken)" stroke="currentColor" strokeWidth={1} />
    {bar ? <rect x={x} y={y} width={3} height={12} rx={1} fill={bar} /> : null}
  </g>
);

/** 1. The board: three columns and the cards on them. */
export function BoardSchematic() {
  return (
    <Frame>
      {[8, 58, 108].map((x) => <rect key={x} x={x} y={8} width={44} height={84} rx={4} fill="var(--color-card)" stroke="currentColor" strokeWidth={1} strokeOpacity={0.5} />)}
      {card(12, 16, "var(--color-accent)")}
      {card(12, 32)}
      {card(12, 48)}
      {card(62, 16, "var(--color-accent)")}
      {card(62, 32)}
      {card(112, 16, "var(--color-success)")}
      {card(112, 32, "var(--color-success)")}
    </Frame>
  );
}

/** 2. The seat: one agent in the middle, the work around it, a message in
    and a small "z" for sleep. */
export function SeatSchematic() {
  const corners: Array<[number, number, number, number]> = [[14, 12, 46, 22], [110, 12, 114, 22], [14, 76, 46, 78], [110, 76, 114, 78]];
  return (
    <Frame>
      {corners.map(([x, y, tx, ty]) => (
        <g key={`${x}-${y}`}>
          <rect x={x} y={y} width={36} height={12} rx={2.5} fill="var(--color-card)" stroke="currentColor" strokeWidth={1} />
          <path d={`M80 50 L${tx} ${ty}`} {...STROKE} strokeWidth={1} />
        </g>
      ))}
      <circle cx={80} cy={50} r={14} fill="var(--color-accent)" />
      <path d="M80 98 L80 68" {...STROKE} strokeDasharray="3 3" />
      <path d="M76 72 L80 66 L84 72" {...STROKE} />
      <path d="M92 26 h6 l-6 6 h6 M100 18 h4 l-4 4 h4 M105 12 h3 l-3 3 h3" {...STROKE} strokeWidth={1.2} />
    </Frame>
  );
}

/** 3. A pipeline: build, review, verify; a fail edge back, and a decision. */
export function PipelineSchematic() {
  return (
    <Frame>
      {[10, 60, 110].map((x) => <rect key={x} x={x} y={30} width={40} height={26} rx={4} fill="var(--color-card)" stroke="currentColor" strokeWidth={1.5} />)}
      <path d="M50 43 L60 43 M56 40 L60 43 L56 46" {...STROKE} />
      <path d="M100 43 L110 43 M106 40 L110 43 L106 46" {...STROKE} />
      <path d="M80 30 C80 10 30 10 30 28" stroke="var(--color-warning)" strokeWidth={1.5} fill="none" strokeLinecap="round" />
      <path d="M26 24 L30 29 L34 24" stroke="var(--color-warning)" strokeWidth={1.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M52 12 l2 3 M56 12 l2 3" stroke="var(--color-warning)" strokeWidth={1.5} strokeLinecap="round" />
      <path d="M80 56 L80 66" {...STROKE} />
      <path d="M80 66 L88 76 L80 86 L72 76 Z" fill="var(--color-danger)" />
    </Frame>
  );
}

/** 4. Needs you: the board, a pill in its corner, and the waiting cards
    pointing at it. */
export function NeedsYouSchematic() {
  return (
    <Frame>
      <rect x={10} y={14} width={140} height={78} rx={6} fill="var(--color-card)" stroke="currentColor" strokeWidth={1} strokeOpacity={0.5} />
      <rect x={116} y={6} width={30} height={16} rx={8} fill="var(--color-danger)" />
      <circle cx={131} cy={14} r={3} fill="var(--color-card)" />
      {card(20, 34)}
      {card(20, 64)}
      {card(66, 52)}
      <path d="M56 40 L118 20 M56 70 L120 22 M102 58 L124 22" {...STROKE} strokeWidth={1} strokeDasharray="2 3" />
    </Frame>
  );
}

/** 5. Start here: a project, a new seat on it, and an empty conversation. */
export function StartSchematic() {
  return (
    <Frame>
      <rect x={10} y={20} width={70} height={60} rx={6} fill="var(--color-card)" stroke="currentColor" strokeWidth={1} strokeOpacity={0.5} />
      <circle cx={78} cy={24} r={11} fill="var(--color-accent)" />
      <path d="M78 19 v10 M73 24 h10" stroke="var(--color-card)" strokeWidth={2} strokeLinecap="round" />
      <path d="M90 30 L104 42 M98 42 L104 42 L104 36" {...STROKE} />
      <rect x={106} y={40} width={46} height={44} rx={6} fill="var(--color-card)" stroke="currentColor" strokeWidth={1.5} />
      <path d="M114 74 h30" {...STROKE} strokeWidth={1} />
    </Frame>
  );
}
