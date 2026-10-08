# Captain's Deck

**See the whole crew. Unblock what matters. Let the first mate ship the rest.**

Captain's Deck is a kanban board inside bb for work a first mate runs: charted
tasks, what is underway, the captain's calls waiting on you, merges awaiting
review, and landings. Every explicit captain action — do it, decide it,
approve it — is recorded on the card with a receipt before any notice is sent,
and **Needs my attention** puts the open ones in a tab beside your first mate
conversation.

The first mate owns the work lanes through the `bb deck` CLI; the board never
invents work, and answering a call never moves a lane by itself.

## Install

```sh
bb plugin install git:https://github.com/deimantasnork/bb-plugin-captains-deck.git@semver:^0.4.0
```

Requires bb 0.45 or newer. On an in-place update, the existing board is imported
once into the plugin database and the old KV storage is left untouched.

BB 0.45 refuses a same-ID managed Git/catalog source replacement. Do not remove
an installed Deck to work around that refusal: removal deletes configuration
and can remove data. Keep the existing installation until a supported
non-destructive source-switch route is available.

## The board

| Column | Meaning |
| --- | --- |
| **Charted Next** | Briefed, not started |
| **Underway** | Agents are on it (a failed task stays here with a failed badge) |
| **Captain's Call** | Cards with an unresolved DO, DECIDE or APPROVE, plus threads blocked on you |
| **Awaiting Merge** | A PR is ready and waiting on review or merge |
| **Landed** | Recently finished work |

- **Crew tabs** and lane counts cover the loaded board. **Load more cards**
  pages the rest newest-activity first; the loaded/total indicator is explicit.
- Cards show the task, its worker bot, live thread state (working, queued,
  needs input, failed), the provider, the PR link, and how long ago it moved.
- A call shows its ask, recommendation and options on the card and opens the
  same controls the tab uses: answer, complete a DO, defer, dismiss, reopen.
  Earlier calls and their answers stay on the task.
- A deck-linked thread that hits a native bb prompt appears under **Waiting in
  threads** in the same column; open it to answer.

## Needs my attention

Open the right panel in your configured first mate conversation, choose
**New tab → Needs my attention**, and the open or due calls appear beside the
chat. Selecting a call opens a compact dialog inside the tab without replacing
the list. Context, evidence and exact provenance remain available in expandable
sections; long context has its own bounded scroll area. Escape, Close or Back
returns focus to the selected call. If the card is removed or no longer carries
a call, the dialog closes and the list refreshes without a handler error.

The tab is scoped to that conversation: opened anywhere else it loads no Deck
contents. It separates *unresolved* from *unseen* — opening a call marks it seen
and never resolves it — and pages Deferred and Closed views too.

Each call shows its exact native source when one was recorded. A call raised
from the CLI says so rather than inventing an origin. To record a reply the
captain wrote in chat, pick that exact committed message from the candidate
list; nothing is associated automatically, and ambiguous or conditional text
stays open.

## Captain actions

| Action | Meaning |
| --- | --- |
| **Answer** | Records a decision or approval. On a DO it records clarification and the call stays open. |
| **Complete** | Closes a DO only. It does not claim the underlying work landed. |
| **Defer** | Keeps the call unresolved until a date, or indefinitely. |
| **Dismiss** | Closes the call without approving or completing anything. |
| **Reopen** | Starts a new generation of a closed call. |

An approval records the exact scope the first mate stated; it never executes
anything. Every action carries the card revision, call generation and an
operation id, so a retry after an unclear response returns the original
receipt instead of acting twice. The receipt is saved first: a failed, queued
or uncertain first-mate notice is shown on the card with explicit
reconciliation and retry, and an uncertain notice is never resent
automatically.

## Driving it

```sh
bb deck chart --title "Dark mode" --brief "Settings toggle + tokens" --bot Designer
bb deck start a1b2c3d4 --thread thr_abc123
bb deck note  a1b2c3d4 --text "First pass done, contrast check running"
bb deck ask   a1b2c3d4 --kind DECIDE --question "Ship behind a flag?" \
  --option "Behind a flag :: Additive and reversible" \
  --option "Straight to users :: Simpler surface, bigger blast radius" --recommend 1
bb deck merge a1b2c3d4 --pr https://github.com/acme/app/pull/42
bb deck land  a1b2c3d4
bb deck bearings
```

Every command accepts `--json`. `bb deck list` and `bb deck bearings` return
one page of cards plus a `nextCursor`, newest activity first. Unresolved,
unseen and due counts are global; lane digests cover the current page.
`bb deck answer|complete|defer|dismiss|reopen` take
`--revision`, `--generation` and `--operation`. `bb deck export --json` writes
a full recovery snapshot and `bb deck import --snapshot '<json>'` restores it.
Inside the first mate conversation, agents raise calls with the native
`deck_call_post` tool and reproduce its block verbatim in a visible reply.
Agents learn the workflow from the bundled `captains-deck` skill.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| First mate thread | empty | Hosts the Needs my attention tab and receives action notices as agent-only notes. The thread id looks like `thr_xxxx`; leave empty to only record actions on the board. |

Set it with `bb plugin config captains-deck set firstMateThreadId thr_xxxx`, or
from Settings → Installed plugins → Captain's Deck.

## Development

```sh
npm install
npm test             # behavior regressions
bb plugin dev        # rebuild + reload on save
```

## License

MIT
