# 🔦 Beacon by Luminark — Agentic Research Console

**Advanced Challenge PoC** for the Luminark Studio / Odysseus AI assignment.

A self-contained, **agentic** pipeline (no n8n) that, from a single topic prompt:

1. **Plans** the research (LLM breaks the topic into sub-questions)
2. **Researches** the web (Tavily → DuckDuckGo → mock), synthesizing each finding with sources
3. **Writes a report** (structured markdown briefing)
4. **Drafts social posts** (LinkedIn, X/Twitter, Instagram)
5. **Sends to WhatsApp** (Twilio)
6. **Stores results** (Supabase, with local JSON fallback)

The React UI streams every step live (Server-Sent Events) so you watch the agent work.

## Stack (maps to the challenge brief)

| Requirement        | Implementation                                                        |
| ------------------ | --------------------------------------------------------------------- |
| LLM API            | **Gemini → OpenAI → Claude** fallback chain via LangChain             |
| Orchestration      | LangChain + custom agentic pipeline (replaces n8n)                    |
| Frontend           | **React + Vite**                                                      |
| Database           | **Supabase** (Postgres) — local JSON fallback                         |
| WhatsApp           | **Twilio** WhatsApp API — mock fallback                               |
| Research           | Tavily / DuckDuckGo                                                   |

## Why a fallback chain?

Only **Gemini** has a genuinely free tier, so the agent tries it first, then fails
over to OpenAI (`gpt-4o-mini`) and Claude (Haiku) on quota/rate-limit/auth errors —
using LangChain's `.withFallbacks()`. Set whichever keys you have.

## Quick start

```bash
cd beacon-agent
npm install
cp .env.example .env     # (Windows: copy .env.example .env) — fill in any keys you have
npm run dev              # server on :8787, web on :5173
```

Open **http://localhost:5173**. With **zero keys** it still runs end-to-end in
mock mode. Add keys incrementally — the status pills in the header show what's live.

### Getting keys (all optional)

- **Gemini (free):** https://aistudio.google.com/apikey → `GOOGLE_API_KEY`
- **Tavily (free search):** https://tavily.com → `TAVILY_API_KEY`
- **Twilio WhatsApp sandbox:** Twilio Console → Messaging → Try it out → join the
  sandbox from your phone, then set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_WHATSAPP_TO` (your number, `whatsapp:+91…`).
- **Supabase:** create a project, run `server/db/schema.sql` in the SQL editor,
  then set `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`.

## Production build

```bash
npm run build     # bundles React into dist/
npm start         # Express serves API + static frontend on :8787
```

## API

- `GET  /api/status` — which providers/modes are live
- `GET  /api/run?topic=…&brand=…&whatsappTo=…` — SSE stream of agent steps
- `POST /api/run` — `{ topic, brand, whatsappTo }` → full result JSON (no stream)
- `GET  /api/runs` — recent stored runs

## Architecture

```
web/ (React + Vite)
  └─ EventSource ──► server/index.js (Express, SSE)
                        └─ agent/pipeline.js  ── plan→research→report→social→whatsapp→store
                              ├─ agent/llm.js          (Gemini→OpenAI→Claude fallback)
                              ├─ integrations/search.js (Tavily→DuckDuckGo→mock)
                              ├─ integrations/whatsapp.js (Twilio→mock)
                              └─ integrations/store.js   (Supabase→local JSON)
```
