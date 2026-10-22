import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip } from '../engine/lib/extract/zip.js';
import { extract, ExtractError } from '../engine/lib/extract/index.js';
import { decodeText } from '../engine/lib/extract/text.js';
import { makeZip, makeDocx, makePdf, w } from './fixtures.js';

const kinds = (out) => out.blocks.map((b) => b.kind + (b.level ? b.level : '') + ':' + b.text);

test('zip reads stored and deflated entries', () => {
  const buf = makeZip([
    { name: 'a.txt', data: 'stored text', deflate: false },
    { name: 'dir/b.xml', data: '<x>' + 'deflated '.repeat(50) + '</x>' },
  ]);
  const zip = readZip(buf);
  assert.deepEqual(zip.names(), ['a.txt', 'dir/b.xml']);
  assert.equal(zip.read('a.txt').toString(), 'stored text');
  assert.match(zip.read('dir/b.xml').toString(), /^<x>deflated deflated/);
  assert.equal(zip.read('missing'), null);
});

test('zip refuses damaged and encrypted archives by name', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all, just some bytes')), (e) => e.code === 'corrupt');
  const enc = readZip(makeZip([{ name: 'word/document.xml', data: 'x', encrypted: true }]));
  assert.throws(() => enc.read('word/document.xml'), (e) => e.code === 'encrypted');
});

test('docx keeps headings from style names, Title, outline levels and based-on styles', async () => {
  const out = await extract(makeDocx([
    w.p('Annual Report', 'Title'),
    w.p('Overview', 'Heading1'),
    w.p('Revenue grew.'),
    w.p('Regions', 'berschrift2'),
    w.p('Detail level', 'Outline'),
    w.p('Inherited heading', 'Derived'),
    w.p('Not a heading', 'Normal'),
  ]), '.docx');
  assert.deepEqual(kinds(out), [
    'heading1:Annual Report', 'heading1:Overview', 'para:Revenue grew.', 'heading2:Regions',
    'heading3:Detail level', 'heading1:Inherited heading', 'para:Not a heading',
  ]);
});

test('docx reads lists, tables, tabs, breaks and entities', async () => {
  const out = await extract(makeDocx([
    w.item('first point'),
    w.table([['Name', 'Amount'], ['Rent', '1,200'], ['', '']]),
    w.raw('<w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c &amp; d &lt;e&gt;</w:t></w:r>'),
  ]), '.docx');
  assert.deepEqual(kinds(out), ['para:- first point', 'table:Name | Amount\nRent | 1,200', 'para:a b\nc & d <e>']);
  assert.deepEqual(out.blocks[1].rows, ['Name | Amount', 'Rent | 1,200']);
});

test('docx leaves out deleted text, field codes and the fallback copy of a text box', async () => {
  const out = await extract(makeDocx([
    w.raw('<w:r><w:t>kept </w:t></w:r><w:del><w:r><w:delText>removed </w:delText></w:r></w:del><w:r><w:t>words</w:t></w:r>'),
    w.raw('<w:r><w:instrText> PAGE \\* MERGEFORMAT </w:instrText></w:r><w:r><w:t>after field</w:t></w:r>'),
    w.raw('<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><w:txbxContent>' +
      w.p('In the box') + '</w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>' +
      w.p('In the box') + '</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>beside the box</w:t></w:r>'),
  ]), '.docx');
  assert.deepEqual(kinds(out), ['para:kept words', 'para:after field', 'para:In the box', 'para:beside the box']);
});

test('docx without styles.xml still reads, with no headings', async () => {
  const out = await extract(makeDocx([w.p('Plain', 'Heading1')], { styles: false }), '.docx');
  assert.deepEqual(kinds(out), ['para:Plain']);
});

test('a zip that is not a Word document says so', async () => {
  await assert.rejects(extract(makeZip([{ name: 'x.txt', data: 'hi' }]), '.docx'), (e) => e.code === 'corrupt');
});

test('pdf rebuilds headings, paragraphs, hyphenated words and page numbers', async () => {
  const out = await extract(makePdf([
    [
      { text: 'Lease Agreement', size: 20, y: 720 },
      { text: 'The tenant agrees to pay rent on the first day', y: 690 },
      { text: 'of each month by bank trans-', y: 676 },
      { text: 'fer to the landlord.', y: 662 },
      { text: 'Repairs are the landlord\'s responsibility.', y: 620 },
      { text: '1', y: 40, x: 300 },
    ],
    [
      { text: 'Termination', size: 16, y: 720 },
      { text: 'Either party may end the lease with two months notice.', y: 690 },
    ],
  ]), '.pdf');
  assert.equal(out.pages, 2);
  assert.deepEqual(kinds(out), [
    'heading1:Lease Agreement',
    'para:The tenant agrees to pay rent on the first day of each month by bank transfer to the landlord.',
    'para:Repairs are the landlord\'s responsibility.',
    'heading2:Termination',
    'para:Either party may end the lease with two months notice.',
  ]);
  assert.deepEqual(out.blocks.map((b) => b.page), [1, 1, 1, 2, 2]);
});

test('pdf joins a two-line title, reads a large-type lead as text and letter-spaced caps as words', async () => {
  // As pdfjs reads letter-spaced type: one run per word, a space between glyphs.
  const out = await extract(makePdf([[
    { text: 'D E S I G N', size: 9, x: 72, y: 760 },
    { text: 'R E C O R D', size: 9, x: 140, y: 760 },
    { text: 'The Layers, the Stack,', size: 28, y: 720 },
    { text: 'and the Agent\'s Walk', size: 28, y: 690 },
    { text: 'How it arranges what a project already knows into', size: 14, y: 650 },
    { text: 'a stack of linked layers, and how it assembles a small', size: 14, y: 634 },
    { text: 'stack for each question an agent asks.', size: 14, y: 618 },
    { text: 'Body text in the usual size follows here.', y: 580 },
  ]]), '.pdf');
  assert.deepEqual(kinds(out), [
    'para:DESIGN RECORD',
    'heading1:The Layers, the Stack, and the Agent\'s Walk',
    'para:How it arranges what a project already knows into a stack of linked layers, and how it assembles a small stack for each question an agent asks.',
    'para:Body text in the usual size follows here.',
  ]);
});

test('a pdf with no text layer is reported as scanned', async () => {
  await assert.rejects(extract(makePdf([[], []]), '.pdf'), (e) => e instanceof ExtractError && e.code === 'scanned');
});

test('a damaged pdf is reported as corrupt', async () => {
  await assert.rejects(extract(Buffer.from('%PDF-1.4 nothing else'), '.pdf'), (e) => e.code === 'corrupt');
});

test('markdown keeps headings, code, tables and lists, and drops front matter and link targets', async () => {
  const md = [
    '---', 'title: ignored', '---',
    '# Guide', '',
    'Read the [manual](https://example.com/manual) first.', 'Then continue.', '',
    'Setup', '=====',
    '```js', 'const a = 1;', '', 'const b = 2;', '```',
    '| Key | Value |', '|-----|------:|', '| a | 1 |', '| b | 2 |', '',
    '- one', '- two',
    '## Next ##',
    '***',
    '![diagram](d.png) shows it.',
  ].join('\r\n');
  const out = await extract(Buffer.from(md), '.md');
  assert.deepEqual(kinds(out), [
    'heading1:Guide', 'para:Read the manual first.\nThen continue.', 'heading1:Setup',
    'code:const a = 1;\n\nconst b = 2;', 'table:Key | Value\na | 1\nb | 2',
    'para:- one', 'para:- two', 'heading2:Next', 'para:diagram shows it.',
  ]);
});

test('text decodes UTF-8 with and without a BOM, and UTF-16 either way round', () => {
  const s = 'Café — naïve';
  assert.equal(decodeText(Buffer.from(s)), s);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s)])), s);
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')])), s);
  assert.equal(decodeText(Buffer.from('Plain notes without a mark', 'utf16le')), 'Plain notes without a mark');
  const be = Buffer.from(s, 'utf16le');
  be.swap16();
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), s);
});

test('text splits paragraphs at blank lines', async () => {
  const out = await extract(Buffer.from('First line\r\nsame paragraph\r\n\r\n  \r\nSecond paragraph\n'), '.txt');
  assert.deepEqual(kinds(out), ['para:First line\nsame paragraph', 'para:Second paragraph']);
});

test('unsupported and empty files are refused by name', async () => {
  await assert.rejects(extract(Buffer.from('x'), '.rtf'), (e) => e.code === 'unsupported');
  await assert.rejects(extract(Buffer.from('\n\n  \n'), '.txt'), (e) => e.code === 'empty');
});
