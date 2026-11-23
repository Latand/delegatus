/**
 * The reasons a message effect carries when it was handed to the engine and
 * the host never answered for it.
 *
 * The delivery queue writes them, and the settlement reads them: a journal
 * that refused the absorbing `uncertain` status leaves `failed` with this
 * reason instead, and that `failed` still means "may have arrived". Kept in a
 * module of their own so the settlement can read them without importing the
 * queue, which imports the settlement.
 */
export const DELIVERY_UNVERIFIED_AFTER_ACTUATION =
  "delivery was started and the structured host did not answer; whether it reached the recipient is unverified";
export const INJECTION_UNVERIFIED_AFTER_ACTUATION =
  "injection was issued and the structured host did not answer; whether it reached the thread is unverified";
