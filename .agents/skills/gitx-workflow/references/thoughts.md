# Thoughts - what to record and how

`gitx_thought_record` with `cwd` (the repository's absolute path, required) and one to twenty thoughts, recorded together or not at all.

## One thought

| Field | What |
|---|---|
| `kind` | `decision` - something chosen; `finding` - something measured or found true; `cost` - a downside accepted with a decision; `learned` - a rule taken from a correction |
| `text` | **One sentence that stands on its own.** What was decided, found, accepted or learned - not the reasoning, which goes in forces. A reader with no context must understand it. |
| `outcome` | `accepted` - decided (built or not); `rejected` - turned down; `open` - a question nobody has settled; `stashed` - set aside on purpose |
| `decided_by` | For a decision: `user`, `agent`, or `agent-delegated` (the user left the choice to you). Say `user` only when the user made it. |
| `forces` | What pushed it forward (`direction: "forward"`) or held it back (`"backward"`). A backward force is `structural` if it cannot change, `contingent` if it can - and a contingent one needs `revisit_if`: what would have to change for the idea to come back. |
| `links` | To a key in the same call or a thought id on record: `lost-to`, `cost-of`, `supports`, `refines`, `derived-from`, `supersedes`, `contradicts` |
| `topic` | Optional `tp-...`; left out, it is filed with what it links to |

## Record the alternatives, not just the winner

A decision is half a record without what it beat. Record them in one call with keys:

```json
{ "cwd": "E:/work/app", "thoughts": [
  { "key": "d", "kind": "decision", "outcome": "accepted", "decided_by": "user",
    "text": "Panes split as a binary tree, each divider owned by exactly one node.",
    "forces": [{ "direction": "forward", "text": "Dragging a divider moves only the pane beside it." }] },
  { "key": "r", "kind": "decision", "outcome": "rejected",
    "text": "Lay panes out with a CSS grid.",
    "forces": [{ "direction": "backward", "kind": "structural", "text": "Grid tracks are shared, so widening one column widens every pane in it." }],
    "links": [{ "type": "lost-to", "to": "d" }] },
  { "key": "c", "kind": "cost", "outcome": "accepted",
    "text": "Closing a pane rebuilds its parent node, so dividers cannot be cached by position.",
    "links": [{ "type": "cost-of", "to": "d" }] }
] }
```

The rules GitX checks - nothing is written unless every thought passes:

- `lost-to` runs from a rejection to an accepted thought.
- `cost-of` runs from a cost to an accepted decision.
- A contingent force needs `revisit_if`.
- An exact repeat of a thought on record is refused.

## Read the reply

- **`id`** for each thought - the only ids you may cite.
- **`settle_with`** on accepted decisions and costs - the line for the commit that carries them out.
- **`maybe_related`** - thoughts on record this continues, repeats, answers or contradicts. If one is what this continues, record a link to it (`refines`, `supersedes`, `supports`, `contradicts`, `derived-from`) instead of leaving two unconnected thoughts; if it says the same thing, yours is a repeat.
- **`summaries_to_update`** - topics whose summary has fallen behind. Rewrite one with `summary: { topic, text }`: what that part does *today*, in a few lines.

## When

Record at the moment the thing is decided or found:

- the user chooses between options you offered - a `user` decision, the others `rejected` with `lost-to`;
- you measured something - a `finding`, with the numbers;
- the user corrects you - a `learned` rule;
- a question comes up that nobody settles now - `open`.

Thoughts are files, and editable. When one turns out wrong, record the correction and link it (`supersedes`, `contradicts`) - the record should end up the useful shape, not every step that reached it.
