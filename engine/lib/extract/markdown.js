/* Markdown: headings, paragraphs, list items, fenced code and pipe tables as
 * blocks. Inline markup is left as written except links and images, which
 * keep their visible text - a URL in the middle of a sentence is noise to
 * both kinds of search.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;

function inline(s) {
  return s
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => inline(c.trim()));

/* An image the document links on this machine: ![name](file:///E:/...). It
 * is noted with the heading path it sits under - the same path the chunker
 * gives that heading's chunks - so a cited passage can bring its images to
 * the page; it is never read, embedded or copied (t-d112dfa471,
 * t-56d38f786b). Only file:/// links: a path in a document opens nothing
 * until the user lists its folder in Settings (t-1cfacc1b16). */
// Balanced brackets may stay in the URL, as Markdown allows: Node's pathToFileURL leaves "(3)" unencoded.
const LINKED = /!\[([^\]]*)\]\((file:\/\/\/(?:[^()\s]|\([^()\s]*\))+)\)/g;

function linkedImages(line, heading) {
  const out = [];
  for (const m of line.matchAll(LINKED)) {
    let file;
    try { file = fileURLToPath(m[2]); } catch (_) { continue; }
    out.push({ heading, name: m[1].trim() || path.basename(file), path: file });
  }
  return out;
}

export function extractMarkdown(text) {
  let src = text.replace(/\r\n?/g, '\n');
  // Front matter is metadata, not content.
  src = src.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)\n/, '');
  const lines = src.split('\n');
  const blocks = [];
  const links = [];
  const stack = []; // open headings, as the chunker keeps them
  const headingPath = () => stack.map((h) => h.text).join(' > ');
  const opened = (level, t) => {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, text: t });
  };
  let para = [];

  const flush = () => {
    const t = inline(para.join('\n'));
    if (t) blocks.push({ kind: 'para', text: t });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flush();
      const close = new RegExp('^ {0,3}' + fence[1][0] + '{' + fence[1].length + ',}\\s*$');
      const body = [];
      for (i++; i < lines.length && !close.test(lines[i]); i++) body.push(lines[i]);
      if (body.join('').trim()) blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      flush();
      const t = inline(atx[2]);
      if (t) { blocks.push({ kind: 'heading', level: atx[1].length, text: t }); opened(atx[1].length, t); }
      continue;
    }

    // Setext: a paragraph line underlined with === or ---.
    if (para.length === 1 && /^ {0,3}(=+|-+)\s*$/.test(line)) {
      const t = inline(para[0]);
      para = [];
      if (t) { const level = line.trim()[0] === '=' ? 1 : 2; blocks.push({ kind: 'heading', level, text: t }); opened(level, t); }
      continue;
    }

    if (line.includes('](file:///')) links.push(...linkedImages(line, headingPath()));

    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      flush();
      const rows = [cells(line).join(' | ')];
      for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]).join(' | '));
      i--;
      blocks.push({ kind: 'table', rows, text: rows.join('\n') });
      continue;
    }

    if (!line.trim() || HR.test(line)) { flush(); continue; }

    const item = ITEM.exec(line);
    if (item) {
      flush();
      para = ['- ' + item[1]];
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return { blocks, pages: null, links };
}
