# Captain's Deck

A kanban board for work a first mate runs in bb, and one honest record of the
calls waiting on you. Five fixed columns show what is charted, what is
underway, the captain's calls, merges awaiting review, and landings — and
**Needs my attention** puts the open calls in a tab beside your first mate
conversation.

## What you get

- **Charted Next, Underway, Captain's Call, Awaiting Merge, Landed** — one card
  per unit of work, with the worker bot, live thread state (working, queued,
  needs input, failed), the provider, the pull request link, and age.
- **Typed calls.** A call is DO (you do it), DECIDE (you choose) or APPROVE
  (you authorize one exact scope). Answering a DO records clarification and
  keeps it open; Complete clears the DO without claiming the work landed;
  Defer and Dismiss are neither approval nor completion.
- **Needs my attention.** A tab inside the configured first mate conversation,
  beside the chat, listing only open or due calls. Unresolved and unseen are
  counted separately, and it loads nothing in other conversations.
- **Exact sources.** A call raised natively keeps the committed message it came
  from, readable in place; one raised from the CLI says it has no source rather
  than inventing one. A chat reply becomes an answer only when you pick that
  exact message.
- **Honest receipts.** Each action is recorded before the first mate is
  notified, so a failed, queued or uncertain notice is visible and recoverable
  instead of being reported as sent.
- **Crew tabs and bearings.** Filter by worker bot, or read the same sections
  as a digest with `bb deck bearings` for a standup or scheduled sweep.

## How it works

The first mate drives the board from a shell:

```
bb deck chart --title "Dark mode" --brief "Settings toggle + tokens" --bot Designer
bb deck start a1b2c3d4 --thread thr_abc123
bb deck note  a1b2c3d4 --text "First pass done, contrast check running"
bb deck ask   a1b2c3d4 --kind DECIDE --question "Ship behind a flag?" \
  --option "Behind a flag" --option "Straight to users" --recommend 1
bb deck merge a1b2c3d4 --pr https://github.com/acme/app/pull/42
bb deck land  a1b2c3d4
```

Every command accepts `--json`, and `bb deck export` writes a full recovery
snapshot. The bundled `captains-deck` skill teaches any agent the lifecycle,
so the first mate keeps the board current without extra instructions.

Set the **First mate thread** setting to the conversation that should host the
attention tab and receive action notices. Leave it empty to record actions on
the board only.

## Requirements

bb 0.45 or newer. The plugin keeps its cards, calls and receipts in its own
database inside bb; no external service or account is needed. Upgrading from
0.3.x imports an existing board once and leaves the previous storage untouched.
