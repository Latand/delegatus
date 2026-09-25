/**
 * The measures of the two sides of a conversation in a wide reader.
 *
 * The operator's bubble keeps the reading measure of #2148: 68ch, about 60 to
 * 78 characters a line, and three quarters of the reader at most.
 *
 * The agent's reply is where the long reports are, with their lists, code and
 * tables, and at the same 68ch it wrapped into a narrow ribbon down the left of
 * a seat that had room beside it (#2179). It takes 85 % of the pane instead,
 * never less than the bubble's measure and never more than 100ch, so it grows
 * as the pane is dragged wider and still ends at a line length that can be
 * read on the widest one. On a wide pane that leaves the agent a column on the
 * left and the operator one on the right.
 *
 * One class for every surface that sets the same message, so an answer does
 * not change width when its settled row replaces the live one. On the phone
 * the screen is narrower than either measure, so they change nothing there.
 */
export const READING_MEASURE = "max-w-[clamp(68ch,85%,100ch)]";

/** The operator's own bubble: three quarters of the reader, up to 68ch. */
export const BUBBLE_MEASURE = "max-w-[min(75%,68ch)]";
