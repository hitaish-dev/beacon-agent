// The Beacon agent pipeline.
//
// An agentic, multi-step orchestrator (no n8n): each node is an LLM-driven
// "agent" with a clear job. Steps stream progress events to the caller so the
// UI can render a live timeline.
//
//   plan → research → report → social → pdf → whatsapp → store
//
// Every step degrades gracefully: no LLM keys → deterministic mock content;
// no search key → DuckDuckGo/mock; no Twilio → logged message; no Supabase →
// local JSON. The PoC therefore runs end-to-end with zero configuration.

import { complete, llmEnabled, activeProviders } from './llm.js';
import { webSearch, fetchPageText, searchMode } from '../integrations/search.js';
import { sendWhatsApp, whatsappMode } from '../integrations/whatsapp.js';
import { saveRun, storeMode, uploadPdf } from '../integrations/store.js';
import { generatePdf, readPdf } from '../integrations/pdf.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Track whether LLM calls actually succeeded this run, so we can flag when the
// output silently fell back to templates (e.g. all providers quota-exhausted).
let _llmStats = { ok: 0, fail: 0 };

// Extract the first JSON value from a model response (handles ```json fences).
function parseJSON(text, fallback) {
  if (!text) return fallback;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate.trim());
  } catch {
    const start = candidate.search(/[[{]/);
    const end = Math.max(candidate.lastIndexOf(']'), candidate.lastIndexOf('}'));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    return fallback;
  }
}

async function llmJSON(system, user, fallback) {
  if (!llmEnabled()) return fallback;
  try {
    const out = await complete([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    _llmStats.ok++;
    return parseJSON(out, fallback);
  } catch (err) {
    _llmStats.fail++;
    console.warn('[agent] LLM JSON step failed, using fallback:', err.message);
    return fallback;
  }
}

async function llmText(system, user, fallback) {
  if (!llmEnabled()) return fallback;
  try {
    const out = await complete([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);
    _llmStats.ok++;
    return out && out.trim() ? out : fallback;
  } catch (err) {
    _llmStats.fail++;
    console.warn('[agent] LLM text step failed, using fallback:', err.message);
    return fallback;
  }
}

// Map a target page count (5-20) to how many research sub-questions to run.
// Fewer questions = fewer LLM/search calls = faster runs.
function subQuestionCount(pages) {
  return Math.min(6, Math.max(3, Math.round(pages / 3.5) + 1));
}

// ── Step 1: Plan ─────────────────────────────────────────────────────────────
async function plan(topic, brand, pages) {
  const n = subQuestionCount(pages);
  const allFallback = [
    `What is ${topic} and why does it matter now?`,
    `What are the key trends and recent developments in ${topic}?`,
    `Who are the major players, tools, or approaches in ${topic}?`,
    `What are the challenges, risks, or controversies around ${topic}?`,
    `What real-world examples or case studies exist for ${topic}?`,
    `What does the future outlook for ${topic} look like, and what should ${brand} do about it?`,
  ];
  const fallback = {
    angle: `A practical analysis of "${topic}" and its implications for ${brand}.`,
    subQuestions: allFallback.slice(0, n),
  };
  const result = await llmJSON(
    'You are a senior research planner. Respond ONLY with JSON.',
    `Topic: "${topic}"\nBrand context: "${brand}"\n\n` +
      `Produce a research plan as JSON: {"angle": string, "subQuestions": string[${n}]}. ` +
      `Generate EXACTLY ${n} sub-questions that are specific, non-overlapping, and searchable — ` +
      'covering definition/why-now, trends, key players/tools, challenges/risks, and outlook/implications.',
    fallback
  );
  // Safety: cap to the requested count.
  if (Array.isArray(result.subQuestions)) result.subQuestions = result.subQuestions.slice(0, n);
  return result;
}

// ── Step 2: Research (reads real page content, not just snippets) ─────────────
// Sub-questions are researched in parallel for speed.
async function research(subQuestions, emit, pages = 5) {
  const readPerQ = pages >= 10 ? 2 : 1; // read fewer pages for quick/shallow runs
  emit('step:detail', { step: 'research', message: `Investigating ${subQuestions.length} questions in parallel…` });

  const perQuestion = await Promise.all(
    subQuestions.map(async (q) => {
      const results = await webSearch(q, 4);
      const top = results.slice(0, readPerQ);
      const excerpts = await Promise.all(top.map((r) => fetchPageText(r.url, 2800)));
      const context = results
        .map((r, i) => {
          const body = excerpts[i] ? `\nExcerpt: ${excerpts[i]}` : '';
          return `[${i + 1}] ${r.title}\n${r.snippet || ''}${body}\n${r.url}`;
        })
        .join('\n\n');
      const finding = await llmText(
        'You are a rigorous research analyst. Using the provided sources, write a substantive, ' +
          'fact-rich answer of 4-6 sentences. Include concrete details, numbers, names, and examples ' +
          'where available. Cite sources inline as [n]. Do not pad or speculate beyond the sources.',
        `Question: ${q}\n\nSources:\n${context}`,
        `Based on available sources, ${q.toLowerCase().replace(/\?$/, '')} involves several considerations relevant to current practice. [1]`
      );
      return { question: q, finding, results };
    })
  );

  const findings = perQuestion.map(({ question, finding }) => ({ question, finding }));
  // De-duplicate sources by URL across all questions.
  const seen = new Set();
  const sources = [];
  for (const { results } of perQuestion) {
    for (const s of results) {
      if (!s.url || seen.has(s.url)) continue;
      seen.add(s.url);
      sources.push(s);
    }
  }
  return { findings, sources };
}

// ── Step 3: Depth-aware report ───────────────────────────────────────────────
async function report(topic, brand, angle, findings, sources, pages = 5) {
  const findingsText = findings.map((f, i) => `### Research finding ${i + 1}: ${f.question}\n${f.finding}`).join('\n\n');
  const sourceList = sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n');

  const targetWords = Math.round(pages * 450);
  const maxWords = Math.round(targetWords * 1.2);

  const fallback =
    `# ${topic}\n\n_Prepared for ${brand} by Beacon._\n\n## Executive summary\n${angle}\n\n` +
    `${findingsText}\n\n## Sources\n${sourceList}`;

  // Extra sections only for deeper reports, so short demos stay tight & fast.
  const deepSections =
    pages >= 12
      ? '## Competitive & Market Landscape\n## Risks, Challenges & Open Questions\n## Outlook (12-24 months)\n'
      : '';

  return llmText(
    'You are a McKinsey-grade senior analyst writing a focused research report in Markdown. ' +
      `Write approximately ${targetWords} words (about ${pages} pages). Be concise and analytical — ` +
      `synthesize the research into original insight, do not just restate it. Do NOT exceed ${maxWords} words. ` +
      'Required structure:\n' +
      '# <Title>\n' +
      '## Executive Summary (4-6 sentences)\n' +
      '## Introduction & Context\n' +
      'Then a dedicated ## section for EACH research finding, with analysis, the occasional ### sub-heading, ' +
      'bullet points, and concrete examples.\n' +
      deepSections +
      `## Strategic Implications for ${brand} (specific, actionable)\n` +
      '## Recommendations (numbered, prioritized)\n' +
      '## Conclusion\n' +
      'Cite sources inline as [n]. Use markdown headings, bold for key terms, and bullet lists. ' +
      'Do NOT include a sources list (it is appended separately). Stay within the word budget.',
    `Topic: ${topic}\nBrand: ${brand}\nAngle: ${angle}\n\nResearch findings:\n${findingsText}\n\n` +
      `Available sources (cite as [n]):\n${sourceList}`,
    fallback
  );
}

// Pull a few concrete takeaways from the report for the (LLM-less) fallback.
function reportHighlights(reportText, n = 3) {
  const clean = (reportText || '').replace(/\*\*/g, '');
  const bullets = (clean.match(/^[-*]\s+(.+)$/gm) || []).map((b) => b.replace(/^[-*]\s+/, '').trim());
  if (bullets.length >= n) return bullets.slice(0, n);
  const sentences = clean
    .replace(/^#.*$/gm, '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 50 && !/^\[/.test(s));
  return [...bullets, ...sentences].slice(0, n);
}

const tag = (s) => s.replace(/[^a-zA-Z0-9]/g, '');

// ── Step 4: Social posts (summarize the report, modern tone, hashtags) ────────
async function social(topic, brand, reportText) {
  const hl = reportHighlights(reportText, 3);
  const bulletBlock = hl.map((h) => `🔹 ${h}`).join('\n');
  const fallback = {
    linkedin:
      `🔦 ${topic}: what it actually means for ${brand}.\n\n` +
      `We ran the research so you don't have to. Three things standing out:\n\n${bulletBlock}\n\n` +
      `The takeaway: the brands that act on this early will define the category. ` +
      `Here's our read on where to focus next. 👇\n\n` +
      `#${tag(topic)} #AI #Strategy #Innovation #${tag(brand)}`,
    twitter:
      `${topic} — the one thing ${brand} can't ignore:\n\n${hl[0] || 'The landscape is shifting fast.'}\n\n` +
      `Full breakdown 🧵\n\n#${tag(topic)} #AI`,
    instagram:
      `✨ ${topic}, decoded for ${brand}.\n\n${bulletBlock}\n\n` +
      `Save this one. 📌\n\n#${tag(topic)} #ai #innovation #strategy #${tag(brand)} #beacon`,
  };
  return llmJSON(
    'You are an elite social media strategist writing posts that summarize a research report. ' +
      'Respond ONLY with JSON. Each post must contain SPECIFIC, substantive insights pulled from the report ' +
      '(real facts, numbers, named trends) — not vague filler. Modern, punchy, value-first tone with a strong ' +
      'hook, short line breaks, tasteful emojis, and relevant hashtags. ' +
      'NEVER say "link in bio", "full report in the comments", or reference attachments — the post must stand alone.',
    `Topic: ${topic}\nBrand: ${brand}\n\nReport to summarize:\n${(reportText || '').slice(0, 7000)}\n\n` +
      'Return JSON with three platform-tailored posts, each summarizing the report\'s actual key insights:\n' +
      '{"linkedin": string (bold thought-leadership: hook + 3-4 specific insights as short lines/bullets + a ' +
      'clear takeaway, ~900-1300 chars, 4-6 hashtags), ' +
      '"twitter": string (punchy hook + the single most surprising concrete insight, <=270 chars, 2-3 hashtags), ' +
      '"instagram": string (warm, visual, emoji-rich: hook + 3 bite-size highlights + a save/share CTA, 5-8 hashtags)}.',
    fallback
  );
}

// ── WhatsApp summary text ────────────────────────────────────────────────────
function buildWhatsAppSummary(topic, brand, reportText, posts, hasPdf) {
  // Pull the executive summary paragraph(s) for a meaningful preview.
  const clean = (reportText || '').replace(/^#.*$/gm, '').replace(/\*\*/g, '');
  const exec = (clean.match(/Executive Summary([\s\S]{0,600})/i)?.[1] || clean)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 5)
    .join('\n');
  return (
    `🔦 *Beacon report: ${topic}*\n` +
    `_for ${brand}_\n\n` +
    `${exec}\n\n` +
    (hasPdf ? `📄 Full report attached (PDF).\n\n` : '') +
    `📣 *LinkedIn:* ${posts.linkedin}\n\n` +
    `🐦 *X:* ${posts.twitter}\n\n` +
    `📸 *Instagram:* ${posts.instagram}`
  );
}

// ── Orchestrator ─────────────────────────────────────────────────────────────
export async function runAgent(
  { topic, brand = 'your brand', whatsappTo, sendToWhatsApp = true, depth = 5 },
  emit = () => {}
) {
  const t0 = Date.now();
  const pages = Math.min(15, Math.max(5, Number(depth) || 5));
  _llmStats = { ok: 0, fail: 0 };
  const id = (globalThis.crypto?.randomUUID?.() || `run_${Date.now()}`);
  const modes = {
    llm: llmEnabled() ? activeProviders().join(' → ') : 'mock',
    search: searchMode(),
    whatsapp: whatsappMode(),
    store: storeMode(),
  };
  emit('start', { topic, brand, modes });

  // 1. Plan
  emit('step:start', { step: 'plan', label: 'Planning research' });
  const planResult = await plan(topic, brand, pages);
  emit('step:done', { step: 'plan', data: planResult });

  // 2. Research
  emit('step:start', { step: 'research', label: 'Researching the web' });
  const { findings, sources } = await research(planResult.subQuestions, emit, pages);
  emit('step:done', { step: 'research', data: { findings, sourceCount: sources.length } });

  // 3. Report
  emit('step:start', { step: 'report', label: `Writing report (~${pages} pages)` });
  const reportText = await report(topic, brand, planResult.angle, findings, sources, pages);
  const wordCount = (reportText || '').split(/\s+/).filter(Boolean).length;
  emit('step:done', { step: 'report', data: { report: reportText, wordCount } });

  // 4. Social
  emit('step:start', { step: 'social', label: 'Drafting social posts' });
  const posts = await social(topic, brand, reportText);
  emit('step:done', { step: 'social', data: { posts } });

  // 5. PDF (generate + upload for a public media URL)
  emit('step:start', { step: 'pdf', label: 'Generating PDF report' });
  let pdfUrl = null;
  let pdfReady = false;
  try {
    await generatePdf({ id, topic, brand, report: reportText, sources, meta: { providers: modes.llm } });
    pdfReady = true;
    const buf = await readPdf(id);
    if (buf) pdfUrl = await uploadPdf(`${id}.pdf`, buf);
  } catch (err) {
    console.warn('[agent] PDF step failed:', err.message);
  }
  emit('step:done', { step: 'pdf', data: { ready: pdfReady, hosted: Boolean(pdfUrl) } });

  // 6. WhatsApp (optional)
  let whatsapp;
  if (sendToWhatsApp) {
    emit('step:start', { step: 'whatsapp', label: 'Sending to WhatsApp' });
    const summary = buildWhatsAppSummary(topic, brand, reportText, posts, Boolean(pdfUrl));
    whatsapp = await sendWhatsApp(summary, { to: whatsappTo, mediaUrl: pdfUrl });
    emit('step:done', { step: 'whatsapp', data: whatsapp });
  } else {
    whatsapp = { mode: 'skipped', ok: true, note: 'WhatsApp delivery turned off' };
    emit('step:done', { step: 'whatsapp', data: whatsapp });
  }

  // 7. Store
  emit('step:start', { step: 'store', label: 'Storing results' });
  const saved = await saveRun({
    topic,
    brand,
    report: reportText,
    socialPosts: posts,
    sources,
    whatsapp: { ...whatsapp, pdfUrl },
    providers: modes,
  });
  emit('step:done', { step: 'store', data: { mode: saved.mode, id: saved.id } });

  const degraded = llmEnabled() && _llmStats.ok === 0;
  const result = {
    id, // local pdf id (used for /api/pdf/:id download)
    storeId: saved.id,
    topic,
    brand,
    plan: planResult,
    findings,
    sources,
    report: reportText,
    wordCount,
    depth: pages,
    socialPosts: posts,
    whatsapp,
    pdfUrl,
    pdfReady,
    modes,
    degraded,
    llmStats: { ..._llmStats },
    elapsedMs: Date.now() - t0,
  };
  emit('done', result);
  return result;
}
