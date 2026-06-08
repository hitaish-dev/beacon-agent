import React, { useEffect, useState, useRef } from 'react';
import { renderMarkdown } from './md.js';

const STEPS = [
  { key: 'plan', icon: '🧭', label: 'Plan research' },
  { key: 'research', icon: '🔎', label: 'Research the web' },
  { key: 'report', icon: '📝', label: 'Write in-depth report' },
  { key: 'social', icon: '📣', label: 'Draft social posts' },
  { key: 'pdf', icon: '📄', label: 'Generate PDF report' },
  { key: 'whatsapp', icon: '💬', label: 'Send to WhatsApp' },
  { key: 'store', icon: '🗄️', label: 'Store results' },
];

// Collapsed report height (px) — keep in sync with .report-wrap.clamped max-height.
const REPORT_CLAMP = 520;

const EXAMPLES = [
  'AI answer-engine optimization for restaurants',
  'Craft beer trends in India 2026',
  'Local-first AI tools for small business',
];

// Slider position → research depth. Lowest is already a solid ~5-page report.
const DEPTH_LEVELS = {
  1: { pages: 5, name: 'Concise', note: 'fast' },
  2: { pages: 7, name: 'Standard', note: '' },
  3: { pages: 9, name: 'Detailed', note: '' },
  4: { pages: 12, name: 'Deep', note: '' },
  5: { pages: 15, name: 'Comprehensive', note: 'slow' },
};

function Pill({ label, value, mock }) {
  return (
    <span className={`pill ${mock ? 'mock' : ''}`}>
      {label} <b>{value}</b>
    </span>
  );
}

export default function App() {
  const [topic, setTopic] = useState('');
  const [brand, setBrand] = useState('');
  const [depthLevel, setDepthLevel] = useState(1);
  const [sendWa, setSendWa] = useState(true);
  const [status, setStatus] = useState(null);
  const [running, setRunning] = useState(false);
  const [stepState, setStepState] = useState({}); // key -> 'active'|'done'
  const [stepDetail, setStepDetail] = useState({});
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('report');
  const [history, setHistory] = useState([]);
  const [reportExpanded, setReportExpanded] = useState(false);
  const [reportOverflows, setReportOverflows] = useState(false);
  // Auth gate (active only when the backend has APP_PASSWORD set).
  const [authGate, setAuthGate] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [pwInput, setPwInput] = useState('');
  const [authError, setAuthError] = useState('');
  const tokenRef = useRef(localStorage.getItem('beacon_token') || '');
  const reportRef = useRef(null);
  const esRef = useRef(null);

  // fetch wrapper that attaches the bearer token when we have one.
  const authFetch = (url, opts = {}) =>
    fetch(url, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        ...(tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {}),
      },
    });

  // Decide whether the report is long enough to warrant a "Read more" toggle.
  useEffect(() => {
    setReportExpanded(false);
    const el = reportRef.current;
    setReportOverflows(el ? el.scrollHeight > REPORT_CLAMP : false);
  }, [result]);

  const loadStatus = () => authFetch('/api/status').then((r) => r.json()).then(setStatus).catch(() => {});
  const loadHistory = () =>
    authFetch('/api/runs').then((r) => r.json()).then((d) => Array.isArray(d) && setHistory(d)).catch(() => {});

  // On mount, find out whether a login gate is active and whether a stored token
  // still works. If no gate, go straight in.
  useEffect(() => {
    fetch('/api/auth')
      .then((r) => r.json())
      .then(async (d) => {
        setAuthGate(Boolean(d.required));
        if (!d.required) {
          setAuthed(true);
        } else if (tokenRef.current) {
          const ok = await authFetch('/api/status').then((r) => r.ok).catch(() => false);
          if (ok) setAuthed(true);
          else {
            tokenRef.current = '';
            localStorage.removeItem('beacon_token');
          }
        }
      })
      .catch(() => setAuthed(true)) // if /api/auth is unreachable, fail open
      .finally(() => setAuthChecked(true));
  }, []);

  // Load data once we're authenticated.
  useEffect(() => {
    if (!authed) return;
    loadStatus();
    loadHistory();
  }, [authed]);

  const login = (e) => {
    e?.preventDefault?.();
    setAuthError('');
    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwInput }),
    })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.ok) {
          tokenRef.current = d.token || '';
          localStorage.setItem('beacon_token', tokenRef.current);
          setPwInput('');
          setAuthed(true);
        } else {
          setAuthError(d.error || 'Incorrect password');
        }
      })
      .catch(() => setAuthError('Login failed — try again'));
  };

  const logout = () => {
    tokenRef.current = '';
    localStorage.removeItem('beacon_token');
    setAuthed(false);
    setStatus(null);
    setResult(null);
    setHistory([]);
  };

  const run = () => {
    if (!topic.trim() || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setStepState({});
    setStepDetail({});
    setTab('report');

    const params = new URLSearchParams({
      topic,
      brand,
      depth: String(DEPTH_LEVELS[depthLevel].pages),
      sendToWhatsApp: String(sendWa),
    });
    if (tokenRef.current) params.set('token', tokenRef.current);
    const es = new EventSource(`/api/run?${params.toString()}`);
    esRef.current = es;

    es.addEventListener('step:start', (e) => {
      const { step } = JSON.parse(e.data);
      setStepState((s) => ({ ...s, [step]: 'active' }));
    });
    es.addEventListener('step:detail', (e) => {
      const { step, message } = JSON.parse(e.data);
      setStepDetail((s) => ({ ...s, [step]: message }));
    });
    es.addEventListener('step:done', (e) => {
      const { step, data } = JSON.parse(e.data);
      setStepState((s) => ({ ...s, [step]: 'done' }));
      if (step === 'research' && data?.sourceCount != null)
        setStepDetail((s) => ({ ...s, research: `${data.sourceCount} sources gathered` }));
    });
    es.addEventListener('done', (e) => {
      setResult(JSON.parse(e.data));
      setRunning(false);
      es.close();
      loadHistory();
    });
    es.addEventListener('error', (e) => {
      let msg = 'Stream error';
      try {
        msg = JSON.parse(e.data).message;
      } catch {
        /* connection drop */
      }
      setError(msg);
      setRunning(false);
      es.close();
    });
  };

  const copy = (text) => navigator.clipboard?.writeText(text);

  const modesView = status && (
    <div className="modes">
      <Pill label="LLM" value={status.llm.enabled ? 'gemini' : 'mock'} mock={!status.llm.enabled} />
      <Pill label="Search" value={status.search} mock={status.search === 'mock'} />
      <Pill label="WhatsApp" value={status.whatsapp} mock={status.whatsapp === 'mock'} />
      <Pill label="Store" value={status.store} mock={status.store === 'local'} />
    </div>
  );

  const wa = result?.whatsapp;
  const waClass = !wa ? '' : wa.mode === 'skipped' ? 'mock' : wa.mode === 'mock' ? 'mock' : wa.ok ? 'ok' : 'bad';
  const waLabel = !wa
    ? ''
    : wa.mode === 'skipped'
    ? 'Skipped — WhatsApp delivery turned off'
    : wa.mode === 'mock'
    ? 'Mock — logged to server console'
    : wa.ok
    ? `Sent via Twilio (${wa.status || 'queued'})${wa.mediaUrl ? ' · with PDF' : ''}`
    : `Failed: ${wa.error}`;

  // ── Login gate ──
  if (!authChecked) {
    return <div className="auth-wrap" />; // brief blank while we check /api/auth
  }
  if (authGate && !authed) {
    return (
      <div className="auth-wrap">
        <form className="auth-card" onSubmit={login}>
          <div className="beacon-mark auth-mark">🔦</div>
          <h1 className="auth-title">Beacon</h1>
          <p className="auth-sub">Enter the access password to continue.</p>
          <input
            type="password"
            className="auth-input"
            placeholder="Password"
            value={pwInput}
            onChange={(e) => setPwInput(e.target.value)}
            autoFocus
          />
          {authError && <div className="auth-error">{authError}</div>}
          <button type="submit" className="run-btn auth-btn">Unlock</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <div className="beacon-mark">🔦</div>
          <div>
            <h1>Beacon</h1>
            <p>Agentic research → report → social → WhatsApp</p>
          </div>
        </div>
        <div className="header-right">
          {modesView}
          {authGate && authed && (
            <button className="signout-btn" onClick={logout}>Sign out</button>
          )}
        </div>
      </header>

      <div className="grid">
        {/* ── Left: control + timeline ── */}
        <div>
          <div className="card">
            <h2>Run the agent</h2>
            <label>Topic to research</label>
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && run()}
              placeholder="e.g. AI answer-engine visibility for breweries"
            />
            <label>Brand context</label>
            <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="Your brand name" />

            <div className="depth-head">
              <label style={{ margin: 0 }}>Report depth</label>
              <span className="depth-val">
                {DEPTH_LEVELS[depthLevel].name} · ~{DEPTH_LEVELS[depthLevel].pages} pages
                {DEPTH_LEVELS[depthLevel].note ? ` · ${DEPTH_LEVELS[depthLevel].note}` : ''}
              </span>
            </div>
            <div className="slider-wrap" style={{ '--pct': (depthLevel - 1) / 4 }}>
              <input
                type="range"
                className="slider"
                min="1"
                max="5"
                step="1"
                value={depthLevel}
                onChange={(e) => setDepthLevel(Number(e.target.value))}
                disabled={running}
              />
            </div>
            <div className="slider-ticks"><span>Concise</span><span>Comprehensive</span></div>

            <div className="wa-toggle-row">
              <div>
                <div className="wa-toggle-title">Send to WhatsApp</div>
                <div className="wa-toggle-sub">
                  {status?.whatsappConfigured
                    ? 'Recipient configured'
                    : 'No recipient configured (.env TWILIO_WHATSAPP_TO)'}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={sendWa}
                className={`switch ${sendWa ? 'on' : ''}`}
                onClick={() => setSendWa((v) => !v)}
              >
                <span className="knob" />
              </button>
            </div>

            <button className="run-btn" onClick={run} disabled={running || !topic.trim()}>
              {running ? 'Agent working…' : '🔦 Run Beacon agent'}
            </button>
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex} className="chip" onClick={() => setTopic(ex)} disabled={running}>
                  {ex}
                </button>
              ))}
            </div>
          </div>

          {(running || result) && (
            <div className="card" style={{ marginTop: 18 }}>
              <h2>Agent status</h2>
              {(() => {
                const doneCount = STEPS.filter((s) => stepState[s.key] === 'done').length;
                const active = STEPS.find((s) => stepState[s.key] === 'active');
                const pct = Math.round((doneCount / STEPS.length) * 100);

                let cls, icon, label, detail;
                if (active) {
                  cls = 'active';
                  icon = active.icon;
                  label = active.label;
                  detail = stepDetail[active.key] || `Step ${doneCount + 1} of ${STEPS.length}`;
                } else if (running) {
                  cls = 'active';
                  icon = '⏳';
                  label = 'Working…';
                  detail = `${doneCount} of ${STEPS.length} steps complete`;
                } else {
                  cls = 'done';
                  icon = '✓';
                  label = 'All steps complete';
                  detail = 'Your report is ready →';
                }

                return (
                  <>
                    <div className={`tl-step ${cls}`}>
                      <div className="tl-icon">{icon}</div>
                      <div className="tl-body">
                        <div className="tl-label">{label}</div>
                        <div className="tl-detail">{detail}</div>
                      </div>
                    </div>
                    <div className="step-progress">
                      <span style={{ width: `${running ? pct : 100}%` }} />
                    </div>
                  </>
                );
              })()}
            </div>
          )}

          {history.length > 0 && (
            <div className="history">
              <h2>Recent runs</h2>
              {history.slice(0, 3).map((h) => (
                <div key={h.id} className="hist-item" onClick={() => hydrateFromHistory(h, setResult, setTab)}>
                  <span className="hist-topic">{h.topic}</span>
                  <span className="hist-meta">{new Date(h.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Right: results ── */}
        <div className="card">
          {error && <div className="err-banner">⚠ {error}</div>}
          {result?.degraded && (
            <div className="err-banner" style={{ background: 'rgba(245,166,35,0.1)', borderColor: 'rgba(245,166,35,0.4)', color: 'var(--amber-soft)' }}>
              ⚠ LLM quota exhausted — this output is templated, not AI-generated. Every free Gemini model hit its
              daily limit. Try again later (limits reset daily) or add an OpenAI/Anthropic key to `.env.local`.
            </div>
          )}

          {!result && !running && !error && (
            <div className="empty">
              <div className="big">🔦</div>
              <p>Enter a topic and run the agent.<br />It researches, writes, drafts posts, messages WhatsApp, and stores everything — autonomously.</p>
            </div>
          )}

          {!result && running && (
            <div className="empty">
              <div className="big">🔦</div>
              <p>The agent is working… watch the timeline on the left.</p>
            </div>
          )}

          {result && (
            <div className="results">
              <div className="tabs">
                <button className={`tab ${tab === 'report' ? 'active' : ''}`} onClick={() => setTab('report')}>Report</button>
                <button className={`tab ${tab === 'social' ? 'active' : ''}`} onClick={() => setTab('social')}>Social posts</button>
                <button className={`tab ${tab === 'whatsapp' ? 'active' : ''}`} onClick={() => setTab('whatsapp')}>WhatsApp</button>
                <button className={`tab ${tab === 'sources' ? 'active' : ''}`} onClick={() => setTab('sources')}>Sources</button>
              </div>

              {tab === 'report' && (
                <div>
                  <div className="report-toolbar">
                    <span className="report-stats">
                      {result.wordCount ? `${result.wordCount.toLocaleString()} words · ~${Math.max(1, Math.round(result.wordCount / 450))} pages` : ''}
                    </span>
                    {(result.pdfUrl || result.pdfReady) && (
                      // Prefer the hosted Supabase URL (survives server restarts on
                      // free hosting); fall back to the local disk route otherwise.
                      <a className="pdf-btn" href={result.pdfUrl || `/api/pdf/${result.id}${tokenRef.current ? `?token=${encodeURIComponent(tokenRef.current)}` : ''}`} target="_blank" rel="noreferrer">
                        📄 Download PDF
                      </a>
                    )}
                  </div>
                  <div className={`report-wrap ${reportExpanded ? '' : 'clamped'}`}>
                    <div ref={reportRef} className="report-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(result.report) }} />
                  </div>
                  {reportOverflows && (
                    <button className="read-more-btn" onClick={() => setReportExpanded((v) => !v)}>
                      {reportExpanded ? 'Show less ▲' : 'Read full report ▼'}
                    </button>
                  )}
                </div>
              )}

              {tab === 'social' && result.socialPosts && (
                <div>
                  {[
                    ['LinkedIn', result.socialPosts.linkedin],
                    ['X / Twitter', result.socialPosts.twitter],
                    ['Instagram', result.socialPosts.instagram],
                  ].map(([platform, body]) => (
                    <div className="post" key={platform}>
                      <div className="post-head">
                        <span className="post-platform">{platform}</span>
                        <button className="copy-btn" onClick={() => copy(body)}>copy</button>
                      </div>
                      <div className="post-body">{body}</div>
                    </div>
                  ))}
                </div>
              )}

              {tab === 'whatsapp' && (
                <div className="wa-card">
                  <span className={`wa-status ${waClass}`}>● {waLabel}</span>
                  {wa?.to && <div className="hist-meta" style={{ marginBottom: 10 }}>to: {wa.to}</div>}
                  {result.pdfUrl && (
                    <div className="hist-meta" style={{ marginBottom: 10 }}>
                      📄 PDF attached: <a href={result.pdfUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--amber-soft)' }}>hosted link</a>
                    </div>
                  )}
                  {wa?.mode !== 'skipped' && <div className="wa-preview">{buildWaPreview(result)}</div>}
                </div>
              )}

              {tab === 'sources' && (
                <ul className="sources">
                  {(result.sources || []).map((s, i) => (
                    <li key={i}>
                      [{i + 1}] <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.url}</a>
                    </li>
                  ))}
                  {(!result.sources || !result.sources.length) && <li>No sources recorded.</li>}
                </ul>
              )}

              {result.elapsedMs != null && (
                <div className="hist-meta" style={{ marginTop: 4 }}>
                  Completed in {(result.elapsedMs / 1000).toFixed(1)}s · stored as {result.modes?.store} ({result.id})
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="footer">
        <b>Beacon</b> · React + LangChain agent · Gemini→OpenAI→Claude fallback · Twilio WhatsApp · Supabase
      </div>
    </div>
  );
}

function buildWaPreview(result) {
  const p = result.socialPosts || {};
  const first = (result.report || '')
    .replace(/^#.*$/gm, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join('\n');
  return (
    `🔦 Beacon report: ${result.topic}\nfor ${result.brand}\n\n${first}\n\n` +
    `📣 LinkedIn: ${p.linkedin || ''}\n\n🐦 X: ${p.twitter || ''}\n\n📸 Instagram: ${p.instagram || ''}`
  );
}

function hydrateFromHistory(h, setResult, setTab) {
  setResult({
    id: h.id,
    topic: h.topic,
    brand: h.brand,
    report: h.report,
    socialPosts: h.social_posts || h.socialPosts,
    sources: h.sources,
    whatsapp: h.whatsapp,
    // Hosted PDF URL is persisted nested under whatsapp; surface it so the
    // Download PDF button works for past runs (local disk files are long gone).
    pdfUrl: h.whatsapp?.pdfUrl || null,
    modes: h.providers,
  });
  setTab('report');
}
