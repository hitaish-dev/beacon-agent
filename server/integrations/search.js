// Web search — Tavily (best) → DuckDuckGo (free, no key) → mock.
// Returns: [{ title, url, snippet }]

async function tavilySearch(query, max = 5) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: max,
      search_depth: 'basic',
    }),
  });
  if (!res.ok) throw new Error(`Tavily ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
  }));
}

// DuckDuckGo HTML endpoint — no API key required.
async function duckSearch(query, max = 5) {
  const res = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeaconAgent/0.1)' } }
  );
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const html = await res.text();
  const results = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gs;
  let m;
  while ((m = re.exec(html)) && results.length < max) {
    const rawUrl = m[1];
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    // DDG wraps targets in a redirect; pull out the real uddg= param.
    let url = rawUrl;
    const uddg = rawUrl.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (title) results.push({ title, url, snippet: '' });
  }
  return results;
}

function mockSearch(query, max = 5) {
  return Array.from({ length: Math.min(max, 3) }, (_, i) => ({
    title: `[mock] Result ${i + 1} for "${query}"`,
    url: `https://example.com/${encodeURIComponent(query)}/${i + 1}`,
    snippet:
      'Mock search result. Add TAVILY_API_KEY (or rely on live DuckDuckGo) ' +
      'for real sources. This placeholder lets the pipeline run end-to-end.',
  }));
}

// Fetch a page and extract readable text (strips scripts/styles/tags).
// Used to give the analyst real source material, not just snippets.
export async function fetchPageText(url, maxChars = 4000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeaconAgent/0.1)' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const ct = res.headers.get('content-type') || '';
    if (!res.ok || !ct.includes('text/html')) return '';
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, maxChars);
  } catch {
    return '';
  }
}

export function searchMode() {
  if (process.env.TAVILY_API_KEY) return 'tavily';
  return 'duckduckgo'; // falls through to mock at runtime if it fails
}

export async function webSearch(query, max = 5) {
  if (process.env.TAVILY_API_KEY) {
    try {
      return await tavilySearch(query, max);
    } catch (err) {
      console.warn('[search] Tavily failed, falling back:', err.message);
    }
  }
  try {
    const r = await duckSearch(query, max);
    if (r.length) return r;
  } catch (err) {
    console.warn('[search] DuckDuckGo failed, using mock:', err.message);
  }
  return mockSearch(query, max);
}
