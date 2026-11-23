/* The bounds the server and the Files view share. No imports: the client
   bundle reads this file. */

/** The largest committed file the preview reads. */
export const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/** Lanes per list request, and per page of the view. */
export const LANES_PER_REQUEST = 5;
