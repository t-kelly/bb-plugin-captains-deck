---
name: captains-deck
description: Drive the Captain's Deck kanban board with the `bb deck` CLI and the native Captain's Call tools. Use when charting new work, starting or finishing a task, asking the captain to do, decide or approve something, or when asked what is underway, waiting on the captain, awaiting merge, or landed.
---

# Captain's Deck

The Captain's Deck is the captain's board for work the first mate runs, and the
one store of explicit Captain actions. The first mate owns the work lanes
through `bb deck`. The captain answers calls on the full board or in the
**Needs my attention** tab inside the configured first mate conversation, and
each action is recorded with a receipt before any notice is sent.

One card is one unit of work. Keep cards current — a stale board is worse than
no board.

## Work lifecycle

| Moment | Command |
| --- | --- |
| Work is agreed or charted, no worker started | `bb deck chart --title "<title>" [--brief "<one line>"] [--kind ship\|scout] [--project <id>] [--bot <name>]` |
| A worker thread actually starts | `bb deck start <task-id> --thread <thread-id>` |
| A short status belongs on the card | `bb deck note <task-id> --text "<one line>"` |
| PR is ready and needs review/merge | `bb deck merge <task-id> --pr <url>` |
| Work landed | `bb deck land <task-id>` |
| Work failed | `bb deck fail <task-id> --reason "<what failed>"` |
| Task no longer relevant | `bb deck remove <task-id>` |

Work lanes and Captain actions are independent: answering a call never moves a
lane, and landing work never answers a call.

## Captain's Calls

A call is `DO` (the captain must do something themselves), `DECIDE` (choose
between options) or `APPROVE` (authorize one exact scope). One current call per
card; a new call archives the previous one and takes the next generation.

- In the configured first mate conversation, use the native `deck_call_post`
  tool, then reproduce its returned block **verbatim** in your visible final
  reply. The call publishes only when that exact block is committed in one
  completed assistant message, so the previous call stays current until then.
  `deck_call_cancel` withdraws an unpublished proposal.
- Anywhere else, `bb deck ask <task-id> --question "<question>" [--kind DO|DECIDE|APPROVE] --option "<label> :: <detail>" [--recommend <number|label>] [--context "<why now>"]`
  records a local call. It is labelled as having no native source, because it has none.
- `APPROVE` requires `--scope-action`, `--scope-target` and `--scope-constraints`,
  optionally `--expires-at <epoch-ms>`. Recording an approval executes nothing.

The captain's actions are `answer`, `complete`, `defer`, `dismiss`, `reopen`,
also available as `bb deck <action> <task-id> --revision <n> --generation <n> --operation <id>`.
Their meanings do not overlap:

- Answering a `DO` records clarification; the call stays open.
- `complete` closes a `DO` only. It does not claim the underlying work landed.
- `defer` keeps a call unresolved until a date or indefinitely.
- `dismiss` closes a call without approval or completion.
- `reopen` starts a new generation of a closed call.

To record a captain reply that was written in chat, use `deck_call_associate`
with the exact committed native row. Never infer an answer from conversation:
ambiguous text stays open, and an approval needs an unqualified "approve" or
"decline" as the whole response.

## Rules

1. Run `bb deck list` before changing anything; never guess a task id. `list`,
   `bearings`, `show` and the action commands accept `--json`; `list` and
   `bearings` return one page plus `nextCursor`, newest activity first.
2. Chart work when it is accepted, and start the card in the same dispatch
   when a worker exists — do not leave running work in Charted Next.
3. Only raise a call when the captain genuinely has to act: scope or direction
   changes, money, external/public actions, brand decisions, approvals, or two
   defensible paths. Progress, retries and worker failures are not calls.
4. Give every `DECIDE` a recommended option when one is defensible, and a
   one-line detail after ` :: ` so the captain can decide without opening
   anything else.
5. Pass the card's current `revision` and the call's `generation` with every
   action, plus a stable `--operation` id. Replaying the same operation returns
   the original receipt instead of acting twice.
6. A receipt is saved before the first mate notice is sent. A failed, queued or
   uncertain notice is visible on the card; it never means the action was lost,
   and an uncertain notice is never resent automatically.
7. `bb deck export --json` writes a complete recovery snapshot; `bb deck import
   --snapshot '<json>'` restores it into an empty Deck or replays it exactly.
