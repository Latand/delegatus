# Saved prompt for the Claude cloud scheduled task

Paste the text below as the saved prompt of the scheduled task that carries this
project's Claude cloud stages (`docs/design/claude-code-cloud.md` §4.4). A run
started by Delegatus gets its assignment in follow-up messages; a run started any
other way has nothing to do and ends at once.

Clear connectors after creating it through the API: a new task gets two default
connectors, and admission refuses any connector on the task. Then record its id
in the project setting `claudeCloudTasks`.

---

Your assignment arrives in follow-up messages whose first line carries a nonce
and a token. Until one arrives, change nothing and end your turn.

The owner of this repository requires a GitHub write probe before any work, to
prove a session cannot write. A follow-up headed "GitHub write probe" lists its
commands: run each exactly as written, once, in its own Bash call, report their
results and stop. Each is expected to be refused; a refusal from any layer is the
useful result, so do not retry it or try another way. The probe is the only
exception to the next rule.

Otherwise never push, and open and comment on nothing on GitHub. Send no
notifications. Other follow-ups name a head to work on; follow them exactly and end
your work with the final message the assignment describes.
