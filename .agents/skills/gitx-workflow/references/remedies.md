# Remedies - when the record went wrong

None of these rewrites history. A commit, once made, is left as it is.

## A commit named thoughts, but they are still waiting

The broker promotes only in the repository it is watching. Settle them yourself - the same code the broker runs. The import takes a `file:///` URL, spaces as `%20`: on Windows a bare `E:/...` path is read as a URL with scheme `e:` and refused (`ERR_UNSUPPORTED_ESM_URL_SCHEME`).

```bash
node --input-type=module -e "import { promote } from 'file:///<GitX>/mcp/tools/promote.js'; console.log(JSON.stringify(promote('<repo>', '<full commit hash>', ['t-...', 't-...'])))"
```

Running it twice changes nothing: a promoted thought is no longer waiting.

## A commit should have named thoughts and did not

Same call, with the ids the commit carried out. The trailer stays missing from git's message; the thoughts now point at the commit (`resulted_in`).

## A commit has no relation trailer, or its trailers were split off by a blank line

Run `gitx_find_related` with the commit's paths and a one-line description to find the parent, then write the full message - body and a correct trailer block - to `.gitx/commits/<full hash>.txt`. The commit graph reads that file instead of git's message. If the lost lines included `GitX-Thoughts`, promote those ids as above.

## A comment or message cites an id that is not on record

It was typed before `gitx_thought_record` returned it, or mistyped. Find the real one with `gitx_search` (by the thought's words) and correct the comment. If the thought was never recorded, record it now and cite what comes back.

## You recorded a thought that turned out wrong

Record the correction and link it - `supersedes` the old one, or `contradicts` it with the evidence. Do not quietly delete it: what was believed and why it was wrong is part of the record. Delete only noise.

## You built something without checking the plan first

Check it now - `gitx_search` with `lens: ["why"]`, `include: ["rejected", "decided"]` - before committing. If it breaks a decision on record, say so to the user, and if it was the user's decision, ask before keeping it.

## You find you did a session's work and recorded nothing

Record now what was decided, with the reasons you still have - not a summary of the work, the decisions and what lost to them. Better late than reconstructed by someone else from the diff.
