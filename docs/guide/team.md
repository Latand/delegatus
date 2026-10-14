# Team and linked installs

One Delegatus can be shared by a team, and two installs can share one board.
This page covers both.

## Team

Each person signs in as themselves. Until someone sets a team up, nothing changes: a Delegatus used by one
person has no sign-in page and no names.

### Set up

Open the sidebar's ⋯ menu → **Team** and press **Make me the owner**. From
then on, anyone else who reaches this Delegatus is asked to sign in. The
access key (phone access, `LLV_TOKEN`) still decides who can reach it at
all.

### Invite

**Team → Invite** makes a link that works once, for seven days.
The person opens it, types their name and is in.

### Sign in on another device

Use a passkey (on a named HTTPS address, or
on `localhost`), through the install's Telegram bot, or by approving it
from a device that is already signed in. **Open on phone** in the ⋯ menu
signs the phone in as you.

### Who did what

The chat shows the sender's name above each person's
message. **Team → Activity** lists who sent messages, answered questions,
started agents and changed tasks. Agents read the same names through the
MCP tools.

### Revoke a member

Do it from their row; every session of theirs ends at once. To take away their
access entirely, also rotate the access key with `--new-token`
([options](configuration.md)); the old key and its cookies stop working.

If the owner loses every signed-in device, run this on the machine itself:

```bash
delegatus team recover --origin https://your-delegatus.example
# Docker: docker compose exec viewer bun-container bin/cli.mjs team recover --origin https://your-delegatus.example
```

It prints a one-time owner link that works for 15 minutes.
`delegatus team revoke-sessions` signs everyone out everywhere. The design and
its reasoning are in [docs/design/sign-in-and-team.md](../design/sign-in-and-team.md).

## Linked installs

Two Delegatus installs, for example your laptop and a server, can share one
board for the projects you choose. Open **Linked installs** from **Settings**
in the sidebar's ⋯ menu (the board's ⋯ menu on a phone).

### Pick a role

The dialog opens on two roles, each with three numbered
steps. **This machine accepts a connection** is for the machine with an
HTTPS address, such as a server. **This machine connects to another** is
for a machine without one, such as a home computer: it opens every
connection itself and needs no address.

### This install

On the accepting machine, enter the address other
machines use to reach it. A public address needs HTTPS, and the access key
must be on. **Check this address** confirms that it reaches this machine
and that the proxy in front of it does not open the board to anyone. When
this machine cannot test its own address from the inside, the dialog shows
a warning, "Not checked from here", with the address to check from the
other machine. A problem that would make linking unsafe stays red.

### Pair

On the accepting machine press **Allow a connection**. It shows
its address beside a pairing code that works once, each with a Copy
button. On the other machine, **Connect to another install** takes that
address and code, and a failed attempt says why under the form.

### Share projects

Nothing is shared until you choose. Share projects one
at a time, here or from the board's ⋯ menu, or share every project,
including new ones. A project needs a git remote to be shared, and it is
linked once both machines share it.

### Tasks sync both ways

A task created, changed or deleted on one machine
appears on the other within seconds while the board is open. Each task
belongs to the machine that runs it, and the other machine will not start
agents or pipelines for it.

### See the other machine's agents

Its agents on a shared project show as
one collapsed, read-only row, such as "On server: 3 agents · 1 working",
on their task's card or in the Inbox. Only a title and a state cross over.
A linked task's card also shows its pipeline (stages, states and the
current stage) and a "Managed on" chip with the machine's name.

### Orchestrators talk across machines

A project's orchestrator can send
a message to the orchestrator of a shared project on the other machine,
and each message arrives once. Both machines need 1.11.0 or later.

### Revoke or remove a link

Use **Revoke** or **Remove** at any time from the same dialog.

The design is in [docs/design/linked-installs.md](../design/linked-installs.md).
