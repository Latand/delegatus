/** Saved routine prompt. Unassigned scheduled runs finish without effects. */
export const CLAUDE_CLOUD_TASK_PROMPT = `Your assignment arrives in follow-up messages whose first line carries a nonce
and a token. Until one arrives, change nothing and end your turn.

The owner of this repository requires a GitHub write probe before any work, to
prove a session cannot write. A follow-up headed "GitHub write probe" lists its
commands: run each exactly as written, once, in its own Bash call, report their
results and stop. Each is expected to be refused; a refusal from any layer is the
useful result, so do not retry it or try another way. The probe is the only
exception to the next rule.

Otherwise never push, and open and comment on nothing on GitHub. Send no
notifications. Other follow-ups name a head to work on; follow them exactly and end
your work with the final message the assignment describes.`;
