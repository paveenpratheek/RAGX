/* Documents built by code, so the tests carry no binary fixtures and each
 * test shows exactly what is in the file it reads (t-0b8379132e). */
import zlib from 'node:zlib';

export function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.deflate === false ? 0 : 8;
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, 'utf8');
    const flags = 0x800 | (e.encrypted ? 1 : 0);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Paragraph helpers for makeDocx. */
export const w = {
  p: (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`,
  raw: (inner) => `<w:p>${inner}</w:p>`,
  item: (text) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${esc(text)}</w:t></w:r></w:p>`,
  table: (rows) => `<w:tbl>${rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${w.p(c)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`,
  // A picture as Word inlines one, its part named by a relationship id; text runs beside it in the same paragraph.
  picture: (rid, { alt = '', text = '' } = {}) => `<w:p>${text ? `<w:r><w:t>${esc(text)}</w:t></w:r>` : ''}<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="${esc(alt)}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
  chart: (rid) => `<w:p><w:r><w:drawing><wp:inline><wp:docPr id="2" name="Chart 1"/><a:graphic><a:graphicData><c:chart r:id="${rid}"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
};

/* A native Word chart part: series of [name, [[category, value], ...]]. */
export function chartXml({ title = '', kind = 'barChart', series }) {
  const pts = (vals) => `<c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(String(v))}</c:v></c:pt>`).join('')}`;
  const ser = series.map(([name, points], i) => `<c:ser><c:idx val="${i}"/><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>${esc(name)}</c:v></c:pt></c:strCache></c:strRef></c:tx>` +
    `<c:cat><c:strRef><c:strCache>${pts(points.map((pt) => pt[0]))}</c:strCache></c:strRef></c:cat>` +
    `<c:val><c:numRef><c:numCache>${pts(points.map((pt) => pt[1]))}</c:numCache></c:numRef></c:val></c:ser>`).join('');
  const t = title ? `<c:title><c:tx><c:rich><a:p><a:r><a:t>${esc(title)}</a:t></a:r></a:p></c:rich></c:tx></c:title>` : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace><c:chart>${t}<c:plotArea><c:${kind}>${ser}</c:${kind}></c:plotArea></c:chart></c:chartSpace>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="paragraph" w:styleId="Outline"><w:name w:val="My Outline"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Derived"><w:name w:val="Derived"/><w:basedOn w:val="Heading1"/></w:style>
</w:styles>`;

/* parts: { 'rId5': { name: 'media/image1.png', data } } - each becomes
 * word/<name> and a relationship from the document. */
export function makeDocx(paragraphs, { styles = true, parts = {} } = {}) {
  const body = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${paragraphs.join('')}<w:sectPr/></w:body></w:document>`;
  const entries = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: body },
  ];
  if (styles) entries.push({ name: 'word/styles.xml', data: STYLES, deflate: false });
  const ids = Object.keys(parts);
  if (ids.length) {
    const rels = ids.map((id) => `<Relationship Id="${id}" Type="x" Target="${parts[id].name}"/>`).join('');
    entries.push({ name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0"?><Relationships>${rels}</Relationships>` });
    for (const id of ids) entries.push({ name: 'word/' + parts[id].name, data: parts[id].data });
  }
  return makeZip(entries);
}

/* pages: [[{ text, size = 11, x = 72, y } | { raw }]] - y from the bottom, as
 * PDF has it; raw is drawing operators put into the page as they are. */
export function makePdf(pages) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const lines of pages) {
    const pdfEsc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const stream = lines.map((l) => (l.raw !== undefined ? l.raw : `BT /F1 ${l.size || 11} Tf ${l.x ?? 72} ${l.y} Td (${pdfEsc(l.text)}) Tj ET`)).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += String(o).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/* Drawing operators for makePdf. */
export const draw = {
  // A filled rectangle; rgb as '0.9 0.5 0.1'.
  rect: (x, y, wd, h, rgb = '0.85 0.5 0.1') => ({ raw: `q ${rgb} rg ${x} ${y} ${wd} ${h} re f Q` }),
  // A stroked line.
  line: (x0, y0, x1, y1) => ({ raw: `q 0.3 0.3 0.3 RG 1 w ${x0} ${y0} m ${x1} ${y1} l S Q` }),
  // What real PDFs open with: a white page-sized background and a clip, neither of them a mark.
  background: () => ({ raw: 'q 1 1 1 rg 0 0 612 792 re f Q 0 0 612 792 re W n' }),
  // A picture over the whole page, as a scanner writes one: a 2x2 grey inline image scaled up.
  scan: () => ({ raw: `q 612 0 0 792 0 0 cm BI /W 2 /H 2 /CS /RGB /BPC 8 ID ${'\x80\x80\x80'.repeat(4)} EI Q` }),
};

/* A bar chart drawn as a chart tool exports it: axis lines, bars and labels,
 * with its caption below - at the top of a US Letter page. */
export function barChartPage({ caption = 'Figure 1 - Costs by region in 2024.', top = 720 } = {}) {
  // Labels sit close to their bars and the title close above, as chart tools set them.
  const lines = [draw.background(), { text: 'Costs by region', size: 12, x: 150, y: top - 12 }];
  lines.push(draw.line(150, top - 160, 150, top - 20), draw.line(150, top - 160, 450, top - 160));
  [['Asia', 120], ['Europe', 90], ['Africa', 60]].forEach(([name, len], i) => {
    const y = top - 50 - i * 40;
    lines.push({ text: name, size: 9, x: 112, y: y + 7 }, draw.rect(150, y, len * 2, 22));
  });
  if (caption) lines.push({ text: caption, size: 10, x: 72, y: top - 185 });
  return lines;
}
