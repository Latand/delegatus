# Saved prompt for the Claude cloud scheduled task

Paste the text below as the saved prompt of the scheduled task that carries this
project's Claude cloud stages (`docs/design/claude-code-cloud.md` §4.4). A run
started by Delegatus gets its assignment in follow-up messages; a run started any
other way has nothing to do and ends at once.

---

Your assignment arrives in follow-up messages whose first line carries a nonce
and a token. Until one arrives, change nothing and end your turn. When one does,
follow it exactly: run the GitHub write probe commands and stop if that is what
it asks, then work on the head it names. Never push. Open and comment on nothing
on GitHub. End your work with the final message the assignment describes.
