'use strict';
// Web search (Brave) and AI drafting (Anthropic). Server-side ONLY: keys come from env and never reach the client.
const rateLimit = require('express-rate-limit');
const { HttpError } = require('../lib/errors');
const { z, text, parse, hostMatches } = require('../lib/validate');

const SYSTEM = `You help AV technicians write short equipment notes. Use ONLY the source text provided. \
Never invent specifications, model numbers, ratings, URLs or procedures. If something is not stated in the provided text, \
list it under "unknown" instead of guessing. Reply with JSON only: {"summary": string, "unknown": string[]}.`;

module.exports = function externalRoutes(api, ctx) {
  const { P } = api;
  const { db, config, audit } = ctx;
  const limiter = rateLimit({ windowMs: 3600000, limit: config.aiRatePerHour, standardHeaders: true, legacyHeaders: false,
    keyGenerator: req => req.user.id,
    handler: (_req, res) => res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Search/AI limit reached for this hour.' } }) });
  const domains = () => db.prepare('SELECT domain FROM source_domains ORDER BY domain').all().map(r => r.domain);

  // Official sources only: the query is restricted to admin-listed domains AND results are re-filtered here.
  api.post('/research', P('research.use'), limiter, async (req, res) => {
    const b = parse(z.object({ query: text(200, 3) }).strict(), req.body);
    if (!config.braveApiKey) throw new HttpError(503, 'NOT_CONFIGURED', 'Web search is not configured on this server (BRAVE_API_KEY).');
    const list = domains().slice(0, 10);
    if (!list.length) throw new HttpError(409, 'NO_SOURCES', 'No official source domains are listed yet. An administrator must add some first.');
    const q = `${b.query} (${list.map(d => `site:${d}`).join(' OR ')})`;
    let r;
    try {
      r = await ctx.fetch('https://api.search.brave.com/res/v1/web/search?count=10&q=' + encodeURIComponent(q),
        { headers: { Accept: 'application/json', 'X-Subscription-Token': config.braveApiKey }, signal: AbortSignal.timeout(10000) });
    } catch { throw new HttpError(502, 'SEARCH_FAILED', 'Web search is unavailable right now.'); }
    if (!r.ok) throw new HttpError(502, 'SEARCH_FAILED', 'Web search is unavailable right now.');
    const data = await r.json();
    const results = (data.web?.results || []).filter(x => typeof x.url === 'string' && hostMatches(x.url, list))
      .slice(0, 8).map(x => ({ title: String(x.title || '').slice(0, 200), url: x.url, snippet: String(x.description || '').slice(0, 500), host: new URL(x.url).hostname }));
    db.transaction(() => audit(req, 'research.search', null, null, { query: b.query, results: results.length }))();
    res.json({ results, restricted_to: list });
  });

  // The draft is returned labelled "ai" and is NEVER saved or approved here; a human must accept it into a record.
  api.post('/ai/draft', P('research.use'), limiter, async (req, res) => {
    const b = parse(z.object({ source_text: text(6000, 10), purpose: z.enum(['description', 'install_notes']).default('description') }).strict(), req.body);
    if (!config.anthropicApiKey) throw new HttpError(503, 'NOT_CONFIGURED', 'AI drafting is not configured on this server (ANTHROPIC_API_KEY).');
    const ask = b.purpose === 'install_notes' ? 'Draft short setup/installation notes' : 'Draft a two-sentence plain description';
    let r;
    try {
      r = await ctx.fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: AbortSignal.timeout(30000),
        headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: config.anthropicModel, max_tokens: 700, system: SYSTEM,
          messages: [{ role: 'user', content: `${ask} from this source text only.\n\n<source_text>\n${b.source_text}\n</source_text>` }] }) });
    } catch { throw new HttpError(502, 'AI_FAILED', 'AI drafting is unavailable right now.'); }
    if (!r.ok) throw new HttpError(502, 'AI_FAILED', 'AI drafting is unavailable right now.');
    const raw = ((await r.json()).content || []).map(c => c.text || '').join('').trim();
    let out; try { out = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim()); } catch { out = { summary: raw, unknown: [] }; }
    const summary = String(out.summary || '').slice(0, 2000);
    const unknown = (Array.isArray(out.unknown) ? out.unknown : []).map(x => String(x).slice(0, 200)).slice(0, 20);
    db.transaction(() => audit(req, 'ai.draft', null, null, { purpose: b.purpose }))();
    res.json({ draft: { provenance: 'ai', label: 'AI-drafted — review before use', summary, unknown, auto_approved: false } });
  });
};
