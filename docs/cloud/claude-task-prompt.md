# Saved prompt for the Claude cloud scheduled task

Paste the text below as the saved prompt of the scheduled task that carries this
project's Claude cloud stages (`docs/design/claude-code-cloud.md` §4.4). A run
started by Delegatus gets its assignment in follow-up messages; a run started any
other way has nothing to do and ends at once.

Clear connectors after creating it through the API: a new task gets two default
connectors, and admission refuses any connector on the task. Then record its id
in the project setting `claudeCloudTasks`.

GitHub write access on the account's connection is allowed and does not block
cloud stages. Existing tasks can keep their older saved prompt: every assignment
part explicitly supersedes its obsolete probe requirement. Results return through
the patch export; the controller publishes them.

---

Your assignment arrives in follow-up messages whose first line carries a nonce
and a token. Until one arrives, change nothing and end your turn.

GitHub write access on this connection is allowed. Accept the assignment without
checking whether the connection can write.

Never push, and open and comment on nothing on GitHub. Send no
notifications. Other follow-ups name a head to work on; follow them exactly and end
your work with the final message the assignment describes.
