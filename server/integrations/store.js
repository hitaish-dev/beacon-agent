// Run storage — Supabase (Postgres) with a local JSON-file fallback.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskPhone } from './whatsapp.js';

// Runs stored before recipient-masking was added still hold full numbers in the
// DB. Mask on read so the public /api/runs never exposes them, old rows included.
function sanitizeRun(row) {
  if (row?.whatsapp?.to) {
    return { ...row, whatsapp: { ...row.whatsapp, to: maskPhone(row.whatsapp.to) } };
  }
  return row;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '.data');
const DATA_FILE = path.join(DATA_DIR, 'runs.json');

let _supabase = null;

function supabaseConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
}

async function getSupabase() {
  if (_supabase) return _supabase;
  const { createClient } = await import('@supabase/supabase-js');
  _supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  return _supabase;
}

export function storeMode() {
  return supabaseConfigured() ? 'supabase' : 'local';
}

// Upload a PDF buffer to a public Supabase Storage bucket and return its public
// URL — needed because Twilio fetches WhatsApp media from a public URL.
// Returns null if Supabase isn't configured or the upload fails.
const BUCKET = 'beacon-reports';
let _bucketReady = false;

export async function uploadPdf(filename, buffer) {
  if (!supabaseConfigured()) return null;
  try {
    const sb = await getSupabase();
    if (!_bucketReady) {
      // Idempotent: create the public bucket if it doesn't exist yet.
      await sb.storage.createBucket(BUCKET, { public: true }).catch(() => {});
      _bucketReady = true;
    }
    const { error } = await sb.storage
      .from(BUCKET)
      .upload(filename, buffer, { contentType: 'application/pdf', upsert: true });
    if (error) throw error;
    const { data } = sb.storage.from(BUCKET).getPublicUrl(filename);
    return data?.publicUrl || null;
  } catch (err) {
    console.warn('[store] PDF upload failed:', err.message);
    return null;
  }
}

// ── Local JSON fallback ──────────────────────────────────────────────────────
async function readLocal() {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeLocal(rows) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(rows, null, 2));
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function saveRun(run) {
  if (supabaseConfigured()) {
    try {
      const sb = await getSupabase();
      const { data, error } = await sb
        .from('beacon_runs')
        .insert({
          topic: run.topic,
          brand: run.brand,
          report: run.report,
          social_posts: run.socialPosts,
          sources: run.sources,
          whatsapp: run.whatsapp,
          providers: run.providers,
          created_at: new Date().toISOString(),
        })
        .select()
        .single();
      if (error) throw error;
      return { mode: 'supabase', id: data.id, run: data };
    } catch (err) {
      console.warn('[store] Supabase insert failed, using local:', err.message);
    }
  }

  const rows = await readLocal();
  const row = { id: `local_${Date.now()}`, created_at: new Date().toISOString(), ...run };
  rows.unshift(row);
  await writeLocal(rows.slice(0, 100));
  return { mode: 'local', id: row.id, run: row };
}

export async function listRuns(limit = 20) {
  if (supabaseConfigured()) {
    try {
      const sb = await getSupabase();
      const { data, error } = await sb
        .from('beacon_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data.map(sanitizeRun);
    } catch (err) {
      console.warn('[store] Supabase list failed, using local:', err.message);
    }
  }
  const rows = await readLocal();
  return rows.slice(0, limit).map(sanitizeRun);
}
