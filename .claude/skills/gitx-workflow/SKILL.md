---
name: gitx-workflow
description: How to work in a repository that keeps a GitX record (a .gitx folder) - catch up at the start, check a plan against what was decided before building, record decisions, rejected alternatives, costs and findings as they happen, cite them in code comments, and name them in commit trailers so the reasoning travels with the code. Use whenever you change code, plan a change, or commit in a GitX repository.
---

# Working the GitX way

GitX keeps a project's reasoning beside its code. Three layers:

- **Commit graph** - commits linked by their trailers (`.gitx/commits` is the only part shared with the repository).
- **Context graph** - thinking that no commit has settled yet: plans, open questions, decisions not built (`.gitx/context`).
- **Thought graph** - thinking a commit settled, with what supported it and what lost to it (`.gitx/thoughts`).

Thoughts are the owner's, private and git-ignored. Never track, commit or push them.

The record is only as good as what you put in it. A future agent - or you after a compaction - finds *why* the code is the way it is only if you wrote it down when you knew.

## The loop

1. **Catch up.** At the start of a session in the repository, before changing anything: `gitx_thought_catch_up`. Follow the rules it lists - they were learned from corrections.
2. **Search before working it out.** Ask `gitx_search` in your own words, one call per sub-task, naming the parts by the project's names. Read what it gives before opening files.
3. **Check the plan.** Before the first edit of anything designed in conversation, write the plan and check each part: `gitx_search` with `lens: ["why"]`, `include: ["rejected", "decided"]`. Read any decision it surfaces by id with `gitx_thought`. A first search can miss: try a second wording and follow SUPERSEDED links before concluding nothing is on record. **A decision made by the user is the user's to change - ask, never override it.**
4. **Record as you go.** Every decision, alternative turned down, cost accepted, finding or rule learned from a correction goes in with `gitx_thought_record` when it happens - not at the end, when the reasons are gone. See `references/thoughts.md`.
5. **Cite in code.** A comment that exists because of a decision says why in plain words and cites the thought: `(t-4629c7c9a0)`. See `references/comments.md`.
6. **Commit with the record.** Stage, run `gitx_find_related`, then write the message with the trailer block. See `references/commits.md`.
7. **Check it landed.** After the commit, the thoughts it named should have moved from the context graph to the thought graph. If not, `references/remedies.md`.

## Order matters

- **Record first, then commit - one after the other, never in parallel.** Ids are minted by `gitx_thought_record`; an id typed before the call returns is invented.
- **Run `gitx_find_related` before writing the message**, never guess the parent.
- **Plan check before the first edit**, not after the code exists.

## What not to do

- Do not write thoughts at the end of a session as a summary of the work - the record is reasoning, not a changelog.
- Do not record noise: a rename, a typo fix, a step that changed nothing. If nothing was decided, there is nothing to record.
- Do not delete a thought you disagree with. Turn it down: a new thought with `outcome: "rejected"` and its reason, or a `supersedes` link from the one that replaces it. Delete only noise.
- Do not rewrite history to fix a commit message. `references/remedies.md` has the fixes that leave the commit alone.

## The hook

`mcp/workflow-hook.js` (Claude Code) watches the three moments this loop is usually dropped - an id cited that is not on record, a commit without its trailers, a session that changed code and recorded nothing - and tells you what is missing. It never refuses: it says, with the fix. When it sends you back at the end of a session and nothing was decided, say so in one line.
