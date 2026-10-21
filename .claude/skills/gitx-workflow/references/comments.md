# Comments - why, and the thought behind it

A comment in a GitX repository explains **why the code is the way it is**, in plain sentences, and cites the thought that decided it in parentheses:

```js
/* Strict, outside a setup: an answer that cites code it never opened
 * goes back to open it (t-38a352d0c5), at most twice a session. */
```

```js
 * Two things the first learning rounds missed (t-6d46b4df16), both here:
```

## The rules

- **Say the reason in the comment.** The id is where to read more, not a replacement for the sentence. A reader without GitX must still understand the code.
- **Cite only ids `gitx_thought_record` returned**, or ids you found with `gitx_search` / `gitx_thought`. Never type an id from memory.
- **Cite where the decision bites:** the line someone would "simplify", the value that looks arbitrary, the check that looks redundant. Not every function.
- **Name what was turned down when it is the obvious alternative** - "a CSS grid was the obvious model and the wrong one: its tracks are shared" saves the next agent from trying it.
- **Keep it true.** When a change makes a comment wrong, fix the comment in the same commit, and record what changed if a decision did.
- **Write it the way the surrounding code does** - same density, same voice. A file with few comments does not need a paragraph on every line.

## What does not belong in a comment

- History ("changed on Tuesday", "was X before") - that is the commit's and the thought's.
- A restatement of what the code plainly does.
- A thought's whole text pasted in.
