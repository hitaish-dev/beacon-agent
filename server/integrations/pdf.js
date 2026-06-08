// Render a markdown report into a Beacon-branded, multi-page PDF using pdfkit
// (pure JS — no headless browser required).

import PDFDocument from 'pdfkit';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_DIR = path.join(__dirname, '..', '.data', 'pdfs');

// Beacon palette
const TEAL = '#0f4441';
const TEAL_DK = '#06201f';
const TEAL_BR = '#2bb3a8';
const AMBER = '#f5a623';
const INK = '#1c2b2a';
const DIM = '#5f7572';

function pdfPath(id) {
  return path.join(PDF_DIR, `${id}.pdf`);
}

// pdfkit's built-in fonts use WinAnsi and cannot encode emoji / many symbols.
// Map common smart punctuation to ASCII and strip anything unencodable.
function sanitize(s = '') {
  return String(s)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/₹/g, 'Rs ')
    .replace(/•/g, '*')
    // drop emoji & other astral-plane / symbol characters
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '');
}

// Split a markdown line into inline runs for **bold** handling.
function inlineRuns(text) {
  const runs = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ t: text.slice(last, m.index), bold: false });
    runs.push({ t: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ t: text.slice(last), bold: false });
  return runs.length ? runs : [{ t: text, bold: false }];
}

function writeInline(doc, text, opts = {}) {
  const runs = inlineRuns(text);
  runs.forEach((r, i) => {
    doc.font(r.bold ? 'Helvetica-Bold' : 'Helvetica');
    doc.text(sanitize(r.t), { continued: i < runs.length - 1, ...opts });
  });
}

export async function generatePdf({ id, topic, brand, report, sources = [], meta = {} }) {
  await fs.mkdir(PDF_DIR, { recursive: true });
  const file = pdfPath(id);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 64, bottom: 64, left: 64, right: 64 },
      info: { Title: `${topic} — Beacon report`, Author: 'Beacon' },
    });
    const stream = createWriteStream(file);
    doc.pipe(stream);

    // ── Cover ──
    doc.rect(0, 0, doc.page.width, 220).fill(TEAL_DK);
    doc.rect(0, 220, doc.page.width, 6).fill(AMBER);
    doc.fillColor(AMBER).fontSize(13).font('Helvetica-Bold').text('BEACON', 64, 70, { characterSpacing: 3 });
    doc.fillColor('#9fc4bf').fontSize(11).font('Helvetica').text('AI research briefing', 64, 90);
    doc.fillColor('#eafaf7').fontSize(28).font('Helvetica-Bold').text(sanitize(topic), 64, 124, { width: doc.page.width - 128 });
    doc.fillColor('#9fc4bf').fontSize(12).font('Helvetica').text(`Prepared for ${sanitize(brand)}`, 64, 188);

    doc.moveDown(4);
    doc.y = 260;
    doc.fillColor(DIM).fontSize(9).font('Helvetica').text(
      `Generated ${new Date().toLocaleString()}  ·  ${meta.providers || ''}  ·  ${sources.length} sources`,
      64,
      244
    );

    // ── Body ──
    doc.fillColor(INK);
    const bodyW = doc.page.width - 128;
    const lines = (report || '').split('\n');

    for (let raw of lines) {
      const line = raw.trimEnd();
      if (!line) {
        doc.moveDown(0.5);
        continue;
      }
      if (/^#\s+/.test(line)) {
        // Skip the top H1 (already on the cover) unless it differs from topic
        const h1 = line.replace(/^#\s+/, '');
        if (h1.trim().toLowerCase() === topic.trim().toLowerCase()) continue;
        doc.moveDown(0.8);
        doc.fillColor(TEAL).fontSize(20).font('Helvetica-Bold').text(sanitize(h1), { width: bodyW });
        doc.moveDown(0.3);
      } else if (/^##\s+/.test(line)) {
        doc.moveDown(0.7);
        doc.fillColor(TEAL_BR).fontSize(15).font('Helvetica-Bold').text(sanitize(line.replace(/^##\s+/, '')), { width: bodyW });
        doc.moveDown(0.2);
      } else if (/^###\s+/.test(line)) {
        doc.moveDown(0.5);
        doc.fillColor(TEAL).fontSize(12.5).font('Helvetica-Bold').text(sanitize(line.replace(/^###\s+/, '')), { width: bodyW });
        doc.moveDown(0.1);
      } else if (/^[-*]\s+/.test(line)) {
        doc.fillColor(INK).fontSize(10.5).font('Helvetica');
        const txt = line.replace(/^[-*]\s+/, '');
        doc.text('•  ', { continued: true, indent: 8 });
        writeInline(doc, txt, { width: bodyW - 16 });
        doc.moveDown(0.15);
      } else if (/^\d+\.\s+/.test(line)) {
        doc.fillColor(INK).fontSize(10.5).font('Helvetica');
        writeInline(doc, line, { width: bodyW, indent: 8 });
        doc.moveDown(0.15);
      } else {
        doc.fillColor(INK).fontSize(10.5).font('Helvetica');
        writeInline(doc, line, { width: bodyW, align: 'justify', lineGap: 1.5 });
        doc.moveDown(0.35);
      }
    }

    // ── Sources page ──
    if (sources.length) {
      doc.addPage();
      doc.fillColor(TEAL).fontSize(18).font('Helvetica-Bold').text('Sources');
      doc.moveDown(0.5);
      sources.forEach((s, i) => {
        doc.fillColor(INK).fontSize(10).font('Helvetica-Bold').text(sanitize(`[${i + 1}] ${s.title || s.url}`), { width: bodyW });
        doc.fillColor('#2b6f9c').fontSize(9).font('Helvetica').text(s.url, { width: bodyW, link: s.url, underline: true });
        doc.moveDown(0.4);
      });
    }

    // ── Footers ──
    const range = doc.bufferedPageRange?.() || { start: 0, count: 0 };
    // (page numbering kept simple; pdfkit streams pages, so we annotate as we go)

    doc.end();
    stream.on('finish', () => resolve({ file, filename: `${id}.pdf` }));
    stream.on('error', reject);
  });
}

export async function readPdf(id) {
  const file = pdfPath(id);
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

export { pdfPath };
