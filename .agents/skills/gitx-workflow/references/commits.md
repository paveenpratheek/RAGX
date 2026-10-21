# Commits - the message GitX builds the graph from

## Steps

1. Stage the work.
2. Run `gitx_find_related` with a one-line description of what you built (it reads the staged diff itself - do not paste it). With nothing staged, pass `paths` - `"file.js::function name"`, a file, or a folder - or it loses most of its accuracy.
3. Read each result's `why`. Cite only results whose shared regions or words match the work. The right parent is often inside a result's `thread`, not at the top of the list: a small edit in a shared file can outrank the commit the work truly continues.
4. Write the message.

## The message

```
feat(scope): what changed, in the project's words

Why it changed, what it replaces, what was weighed. Numbers if
anything was measured. What is still open.

GitX-Builds-On: f7a0591
GitX-Relates-To: 5465ee2
GitX-Thoughts: t-d906ad90c4, t-06de59f577
Co-Authored-By: ...
```

- **Subject** - `type(scope): ...` (feat, fix, refactor, docs, chore, merge, ...). GitX reads the type and scope.
- **Body** - the why. The diff already says what.
- **The trailer block is the LAST paragraph, one block, no blank line inside it.** Git reads trailers only from the final paragraph: a blank line before Co-Authored-By leaves every GitX line above it unread, and the thoughts it names never settle.

## The trailers

| Trailer | When |
|---|---|
| `GitX-Builds-On: <hash>` | The work continues that commit. The usual case. |
| `GitX-Fixes` / `GitX-Extends` / `GitX-Refactors` / `GitX-Supersedes: <hash>` | The relation is more exact than builds-on |
| `GitX-Relates-To: <hash>` | Related, not continued |
| `GitX-Root: <feature name>` | **Only** for work that genuinely starts something new. Not because the parent was hard to find - find it. |
| `GitX-Thoughts: <ids>` | The waiting thoughts this commit carries out - the `settle_with` lines from `gitx_thought_record`. Accepted decisions and costs; findings and rejections move with the decision that rests on them. |

Every commit gets a relation trailer. A missing one breaks the chain for everyone reading the shared commit graph.

## After the commit

The thoughts named in `GitX-Thoughts` move from the context graph (`.gitx/context/thoughts`) to the thought graph (`.gitx/thoughts`). The broker does this only for the repository it is watching - check that they moved; if not, see `remedies.md`.
