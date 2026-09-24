/**
 * The reading measure of prose in a wide reader (#2148): 68ch, about 60 to 78
 * characters of text a line. A desktop reader otherwise sets an answer across
 * its whole width, near 160 characters, and the eye loses its place at every
 * line break.
 *
 * One class for every surface that sets the same message, so an answer does
 * not change width when its settled row replaces the live one. On the phone
 * the screen is narrower than the measure, so it changes nothing there.
 */
export const READING_MEASURE = "max-w-[68ch]";

/** The operator's own bubble: three quarters of the reader, up to the measure. */
export const BUBBLE_MEASURE = "max-w-[min(75%,68ch)]";
