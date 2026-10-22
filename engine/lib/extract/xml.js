/* Just enough XML to walk WordprocessingML: tags, their attributes and the
 * text between them, in order. No tree is built - a .docx body can be tens of
 * megabytes, and the reader only needs to know where it is as it goes.
 */

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

export function* tokens(xml) {
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(xml))) {
    if (m[1] !== undefined) yield { type: 'text', text: m[1] };
    else if (m[3]) {
      const kind = m[2] ? 'close' : m[5] ? 'self' : 'open';
      yield { type: kind, name: m[3], attrs: m[4] || '' };
    } else if (m[6] !== undefined) yield { type: 'text', text: decode(m[6]) };
  }
}

export function attr(attrs, name) {
  const m = new RegExp('(?:^|\\s)' + name.replace(/[.:]/g, '\\$&') + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')').exec(attrs);
  return m ? decode(m[1] ?? m[2]) : null;
}
