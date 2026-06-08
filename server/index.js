import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env.local first (Vite convention, used here too), then .env as fallback.
// dotenv does not override already-set vars, so .env.local wins.
const __envdir = path.dirname(fileURLToPath(import.meta.url));
const __root = path.join(__envdir, '..');
dotenv.config({ path: path.join(__root, '.env') });
dotenv.config({ path: path.join(__root, '.env.local'), override: true });

import express from 'express';
import cors from 'cors';

import { runAgent } from './agent/pipeline.js';
import { listRuns, storeMode } from './integrations/store.js';
import { activeProviders, llmEnabled, getLLM } from './agent/llm.js';
import { searchMode } from './integrations/search.js';
import { whatsappMode, whatsappRecipient } from './integrations/whatsapp.js';
import { readPdf } from './integrations/pdf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health / capability report — the UI uses this to show which modes are live.
app.get('/api/status', async (req, res) => {
  await getLLM(); // build the provider chain so the report is accurate
  res.json({
    ok: true,
    llm: { enabled: llmEnabled(), providers: activeProviders() },
    search: searchMode(),
    whatsapp: whatsappMode(),
    whatsappTo: whatsappRecipient(),
    store: storeMode(),
  });
});

// Run the agent with live Server-Sent Events.
app.get('/api/run', async (req, res) => {
  const topic = (req.query.topic || '').toString().trim();
  const brand = (req.query.brand || 'your brand').toString().trim();
  const whatsappTo = (req.query.whatsappTo || '').toString().trim() || undefined;
  const sendToWhatsApp = req.query.sendToWhatsApp !== 'false';
  const depth = Number(req.query.depth) || 5;

  if (!topic) {
    res.status(400).json({ error: 'topic is required' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  const emit = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await runAgent({ topic, brand, whatsappTo, sendToWhatsApp, depth }, emit);
  } catch (err) {
    console.error('[run] pipeline error:', err);
    emit('error', { message: err.message });
  } finally {
    res.end();
  }
});

// Non-streaming variant (handy for scripts / curl).
app.post('/api/run', async (req, res) => {
  const { topic, brand, whatsappTo, sendToWhatsApp, depth } = req.body || {};
  if (!topic) {
    res.status(400).json({ error: 'topic is required' });
    return;
  }
  try {
    const result = await runAgent({ topic, brand, whatsappTo, sendToWhatsApp, depth });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Download a generated PDF report by run id.
app.get('/api/pdf/:id', async (req, res) => {
  const buf = await readPdf(req.params.id.replace(/[^a-zA-Z0-9_-]/g, ''));
  if (!buf) {
    res.status(404).send('PDF not found (it may have been generated on a previous server run).');
    return;
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="beacon-${req.params.id}.pdf"`);
  res.send(buf);
});

app.get('/api/runs', async (req, res) => {
  try {
    const runs = await listRuns(20);
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve the built frontend in production.
app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'), (err) => {
    if (err) res.status(404).send('Build the frontend with `npm run build` first.');
  });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`\n🔦 Beacon agent server → http://localhost:${PORT}`);
  console.log(`   LLM:      ${llmEnabled() ? activeProviders().join(' → ') : 'mock (no keys)'}`);
  console.log(`   Search:   ${searchMode()}`);
  console.log(`   WhatsApp: ${whatsappMode()}`);
  console.log(`   Store:    ${storeMode()}\n`);
});
