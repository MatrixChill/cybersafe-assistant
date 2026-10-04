// DOCX structural validator / fingerprinter.
// Usage: node output/pap-sprint/docx-validate.mjs "<path.docx>" [label]
// Exit 0 = structurally valid, 1 = invalid. Prints JSON fingerprint to stdout.
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const target = process.argv[2];
const label = process.argv[3] || 'DOCX';
if (!target) {
  console.error('usage: node docx-validate.mjs <path.docx> [label]');
  process.exit(1);
}

const out = { label, path: target, valid: false };
try {
  const bytes = fs.readFileSync(target);
  out.bytes = bytes.length;
  out.sha256 = createHash('sha256').update(bytes).digest('hex');

  const zip = new AdmZip(target);
  const entries = zip.getEntries();
  out.zipEntryCount = entries.length;

  const docEntry = entries.find((e) => e.entryName === 'word/document.xml');
  if (!docEntry) throw new Error('word/document.xml ausente');

  const xml = docEntry.getData().toString('utf8');
  out.documentXmlBytes = Buffer.byteLength(xml, 'utf8');
  out.documentXmlSha256 = createHash('sha256').update(xml).digest('hex');

  const count = (re) => (xml.match(re) || []).length;
  out.paragraphs = count(/<w:p[\s>]/g);
  out.tables = count(/<w:tbl>/g);
  out.rows = count(/<w:tr[\s>]/g);
  out.cells = count(/<w:tc>/g);
  out.images = count(/<a:blip[\s>]/g);
  out.drawings = count(/<w:drawing>/g);
  out.headings = count(/<w:pStyle w:val="(Heading[1-9]|Titulo[1-9]|Ttulo[1-9])"/g);
  out.bookmarks = count(/<w:bookmarkStart/g);
  out.sections = count(/<w:sectPr[\s>]/g);
  out.pageBreaks = count(/w:type="page"/g);
  out.footnotes = entries.some((e) => e.entryName === 'word/footnotes.xml');
  out.endnotes = entries.some((e) => e.entryName === 'word/endnotes.xml');
  out.numbering = entries.some((e) => e.entryName === 'word/numbering.xml');
  out.styles = entries.some((e) => e.entryName === 'word/styles.xml');
  out.mediaEntries = entries.filter((e) => e.entryName.startsWith('word/media/')).length;
  out.rels = entries.some((e) => e.entryName === 'word/_rels/document.xml.rels');
  out.contentTypes = entries.some((e) => e.entryName === '[Content_Types].xml');

  const balance = (tag) => {
    const open = count(new RegExp(`<w:${tag}[\\s>]`, 'g'));
    const close = count(new RegExp(`</w:${tag}>`, 'g'));
    return { open, close, balanced: open === close };
  };
  out.balance = {
    p: balance('p'),
    tbl: balance('tbl'),
    tc: balance('tc'),
    body: (() => {
      const open = count(/<w:body>/g);
      const close = count(/<\/w:body>/g);
      return { open, close, balanced: open === close && open === 1 };
    })(),
  };

  const text = xml
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  out.textChars = text.length;
  out.textSample = text.replace(/\s+/g, ' ').trim().slice(0, 400);

  out.allBalanced = Object.values(out.balance).every((b) => b.balanced);
  out.valid = out.allBalanced && out.textChars > 1000 && out.paragraphs > 10;
} catch (err) {
  out.error = String(err && err.message ? err.message : err);
}

console.log(JSON.stringify(out, null, 2));
process.exit(out.valid ? 0 : 1);
