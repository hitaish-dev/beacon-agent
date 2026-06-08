# Beacon Agent — UI tweaking handoff

Paste this into a new session before doing UI work. It's enough context to tweak
the frontend without re-reading the whole codebase.

## What this is
"Beacon by Luminark" — an agentic research PoC (Advanced Challenge for the
Odysseus AI assignment). One topic prompt → the agent **plans → researches the
web → writes a report → drafts social posts → makes a PDF → sends to WhatsApp →
stores in Supabase**, streaming each step live to the UI. Functionality is DONE
and working; this handoff is for **UI/visual polish only**.

- Project root: `C:\dev\luminark nexus\beacon-agent`
- Stack: React + Vite frontend, Node/Express backend, LangChain (Gemini), Twilio, Supabase.

## Run it
```
cd "C:\dev\luminark nexus\beacon-agent"
npm run dev          # server :8787, web :5173  → open http://localhost:5173
```
Keys are already in `.env.local` (Gemini, Tavily, Twilio, Supabase). It also runs
with zero keys in mock mode. Restart manually after server changes (no --watch — see gotchas).

## Files that matter for UI
- `web/src/App.jsx` — the entire React app (single component + 2 small helpers). Layout, tabs, slider, toggle, timeline, results.
- `web/src/styles.css` — ALL styling. CSS variables (brand tokens) at the top.
- `web/src/md.js` — tiny markdown→HTML renderer for the report tab.
- `web/index.html` — fonts loaded here (Google Fonts: Bricolage Grotesque, Sora, JetBrains Mono).
- Backend (don't need for UI): `server/index.js` (API), `server/agent/pipeline.js` (orchestrator), `server/agent/llm.js`, `server/integrations/*` (search, whatsapp, store, pdf).

## Design system (from styles.css `:root`)
- Brand: dark teal + amber accent. Key vars: `--teal-900` (bg) `#06201f`, `--teal-400` `#2bb3a8`, `--amber` `#f5a623`, `--amber-soft` `#ffc861`, `--ink` `#eafaf7`, `--ink-dim`, `--ink-faint`, `--line`/`--line-strong` (borders).
- Fonts: `--font-display` (Bricolage Grotesque, headings), `--font-body` (Sora), `--font-mono` (JetBrains Mono, pills/meta).
- Layout: `.app` max-width 1180px centered; `.grid` = `380px minmax(0,1fr)` two columns (left = controls + timeline + history, right = results card). Collapses to 1 col under 920px.

## UI structure (App.jsx)
- Header: brand + status pills (`LLM / Search / WhatsApp / Store`, each green=live or amber=mock).
- Left card "Run the agent": topic input, brand input, **depth slider** (range 1–5 → Concise…Comprehensive, mapped to ~5–15 pages via `DEPTH_LEVELS`), **Send-to-WhatsApp toggle** (`.switch`, shows recipient from `/api/status`), Run button, example chips.
- Left: "Agent timeline" (the `STEPS` array, each shows ✓ when done) + "Recent runs" (from `/api/runs`).
- Right card "results": tabs = Report | Social posts | WhatsApp | Sources. Report tab has a toolbar (word/page count + Download PDF button). Amber `degraded` banner shows if all LLMs are quota-exhausted.

## Data flow (don't break this)
- Run uses **SSE**: `EventSource('/api/run?topic=&brand=&depth=&sendToWhatsApp=')`. Events: `start`, `step:start`, `step:detail`, `step:done`, `done`, `error`. `done` payload = full result `{id, report, wordCount, depth, socialPosts:{linkedin,twitter,instagram}, sources:[{title,url}], whatsapp:{mode,ok,...}, pdfUrl, pdfReady, degraded, modes, elapsedMs}`.
- `/api/status` → `{llm:{enabled,providers}, search, whatsapp, whatsappTo, store}` (drives pills + recipient).
- PDF download: `/api/pdf/:id` (uses result.id).

## Gotchas
- **Don't add `node --watch` to dev:server** — it watches `server/.data/` which the pipeline writes (PDFs/runs.json) → restart loop that kills requests. Plain `node server/index.js`.
- **The Claude preview screenshot tool was flaky this session** (timed out, esp. on large reports). Use `preview_eval` to read DOM state if screenshots hang. The app itself is fine.
- Long reports (depth 15) are heavy to render in-browser; default depth is Concise (~5pg) for speed.
- `gemini-2.5-flash` free tier is **per-day** limited; the LLM chain auto-fails-over to `2.5-flash-lite`/`flash-latest`. If a run looks templated, check the `degraded` flag/banner — it means quota is exhausted, not a code bug.

## Status: everything works
Report (real, depth-scaled), social posts (in-depth, hashtags, no "link in bio" filler), PDF (branded, hosted on Supabase, sent via WhatsApp), Supabase storage, depth slider, WhatsApp toggle, degraded banner — all verified. UI polish is the only remaining work.
