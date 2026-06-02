const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function loadEnv() {
  try {
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
      .split('\n')
      .forEach(line => {
        const eq = line.indexOf('=');
        if (eq === -1) return;
        const key = line.slice(0, eq).trim();
        const val = line.slice(eq + 1).trim();
        if (key) process.env[key] = val;
      });
  } catch (e) {
    console.warn('No .env file found.');
  }
}

loadEnv();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

function callAnthropic(body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(raw)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.error) return reject(new Error(data.error.message));
          resolve(data);
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(300000, () => { req.destroy(new Error('Anthropic API request timed out.')); });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

function extractJsonArray(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) {
    const preview = raw.slice(0, 400).replace(/\n/g, ' ');
    throw new Error(`No JSON array found in response. Model returned: "${preview}"`);
  }
  let jsonStr = raw.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch {
    const lastClose = jsonStr.lastIndexOf('},');
    if (lastClose === -1) throw new Error('Could not parse response as JSON. Try again.');
    jsonStr = jsonStr.slice(0, lastClose + 1) + ']';
    return JSON.parse(jsonStr);
  }
}

function buildCriteriaBlock(criteria) {
  return `- Max asking price: ${criteria.price || '$750,000'}
- Min SDE / Cash Flow: ${criteria.sde || '$100,000'} — listings below this MUST be scored <= 3
- Min annual revenue: ${criteria.revenue || '$200,000'}
- Min net profit margin: ${criteria.margin || '15%'}
- Target area: ${criteria.distance || 'Brea, Chino Hills, Diamond Bar, Rowland Heights, La Habra, Placentia, Fullerton, Yorba Linda and surrounding cities within ~25 miles of Brea CA'}
- Preferred industries: ${criteria.industries || 'No preference — any industry'}
- Ownership model: ${criteria.model || 'Absentee / semi-absentee'} — absentee/semi-absentee gets a score bonus; owner-operator gets a penalty
- Deal-breakers: ${criteria.dealbreakers || 'none specified'}
- Financing context: ${criteria.notes || 'SBA 7(a) loan, max $750k, need $100k+ SDE, DSCR > 1.25x, prefer 5+ years in operation'}`;
}

function buildScoutPrompt(criteria) {
  const industrySearch = criteria.industries
    ? `- "${criteria.industries} business for sale Southern California"`
    : '- "service business for sale Southern California bizbuysell"';

  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `You are an expert SMB acquisition broker. Today's date is ${today}. Use web search to find business listings for sale that match the buyer criteria below. Search BizBuySell.com, BizQuest.com, and BusinessBroker.net. Perform several targeted searches to find 15-25 listings total across all three sites.

BUYER CRITERIA:
${buildCriteriaBlock(criteria)}

Suggested searches:
- "businesses for sale Orange County California bizbuysell"
- "businesses for sale Brea CA bizbuysell"
- "businesses for sale Chino Hills Diamond Bar CA bizbuysell"
${industrySearch}
- "absentee business for sale Orange County bizquest"
- "absentee business for sale Southern California businessbroker"

═══ RULE 1 — DIRECT LISTING URLs (REQUIRED) ═══
The url field must link to the specific individual listing page, NOT a search results page or site directory.

CORRECT URLs (specific listing pages):
  https://www.bizbuysell.com/Business-Opportunity/some-business-name/1234567/
  https://www.bizquest.com/business-for-sale/some-business/BQ1234567/
  https://www.businessbroker.net/businessforsale/some-business-123456.aspx

WRONG URLs (do not use — these are directory/search pages, not listings):
  https://www.bizbuysell.com/california/orange-county-businesses-for-sale/
  https://www.bizbuysell.com/businesses-for-sale/?q=cleaning
  https://www.bizquest.com/business-for-sale/california/

For every listing you include: extract the direct listing-page URL from the search result. If you only have a directory URL and not the specific listing URL, do a follow-up search for the business by name (e.g. "Acme Cleaning Service Brea CA bizbuysell") to locate and confirm the exact listing URL before including it.

═══ RULE 2 — FINANCIAL DATA (NO LAZY "NOT DISCLOSED") ═══
Use "Not disclosed" ONLY if the listing page itself explicitly states the seller has chosen not to disclose that figure.

If a search snippet is missing the asking price, revenue, or cash flow:
  1. Do NOT assume it's undisclosed — it almost certainly IS on the listing page
  2. Search for the specific listing by name to open the actual listing page and read the numbers
  3. BizBuySell and BizQuest always display Asking Price and Cash Flow on every listing page

For any listing where your snippet is missing financials, run a targeted search such as:
  "[Business name] [city] bizbuysell" → open the listing → read the numbers

═══ RULE 3 — ACTIVE LISTINGS ONLY ═══
Only include listings that are currently active and available for sale as of ${today}.
  - Before including a listing, confirm it is still listed (not marked "sold", "pending", or removed)
  - If a listing page says "Business Sold", "Under Contract", or "No Longer Available", skip it
  - Extract the listed date from the listing page if shown (e.g. "Listed: March 2025")
  - Prefer recently listed businesses; flag anything listed more than 6 months ago in brokerNotes

═══ OUTPUT FORMAT ═══
After completing your searches, return ONLY a valid JSON array — no markdown, no explanation. Each element:
{
  "name": "Business name or type",
  "type": "Industry / category",
  "askingPrice": "$XXX,XXX or Not disclosed",
  "annualRevenue": "$XXX,XXX or Not disclosed",
  "cashFlow": "$XXX,XXX or Not disclosed",
  "location": "City, CA",
  "description": "1-2 sentence description",
  "url": "Direct URL to this specific listing page (see Rule 1)",
  "listedDate": "Month YYYY or null if not shown",
  "score": 7,
  "priority": "contact now",
  "brokerNotes": "2-3 sentences: criteria fit, what stands out, what to verify first",
  "strengths": ["up to 3 short labels"],
  "concerns": ["up to 3 short labels"]
}

score = 1-10 integer. priority = "contact now" (>=7), "investigate" (5-6), "pass" (<=4).
Sort by score descending. Include all listings found, even poor fits.
IMPORTANT: All string values must be valid JSON — no unescaped quotes, backslashes, or newlines.`;
}

const HEARTBEAT_MSGS = [
  'Still searching — this can take a couple of minutes…',
  'Reviewing listing details across sites…',
  'Cross-referencing BizBuySell, BizQuest, and BusinessBroker.net…',
  'Gathering asking prices and cash-flow figures…',
  'Verifying financials for candidate listings…',
];

function checkUrlLive(url) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AcquisitionScout/1.0)' }
      }, res => {
        // 200–299 = active; 301/302 away from the same host likely = sold/removed
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        const redirectedAway = (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location && !res.headers.location.includes(u.hostname);
        res.resume();
        resolve(redirectedAway ? 'removed' : ok ? 'active' : 'unknown');
      });
      req.setTimeout(6000, () => { req.destroy(); resolve('unknown'); });
      req.on('error', () => resolve('unknown'));
      req.end();
    } catch { resolve('unknown'); }
  });
}

async function verifyListingsLive(listings, onStatus) {
  const withUrls = listings.filter(l => isDirectUrl(l.url));
  if (!withUrls.length) return listings;

  onStatus(`Checking ${withUrls.length} listing${withUrls.length !== 1 ? 's' : ''} are still active…`);

  const statuses = await Promise.all(withUrls.map(l => checkUrlLive(l.url)));

  const statusMap = new Map(withUrls.map((l, i) => [l.url, statuses[i]]));
  const removed = statuses.filter(s => s === 'removed').length;
  if (removed) onStatus(`Filtered out ${removed} listing${removed !== 1 ? 's' : ''} that appear sold or removed`);

  return listings
    .map(l => ({ ...l, urlStatus: statusMap.get(l.url) || 'unknown' }))
    .filter(l => l.urlStatus !== 'removed');
}

// Mirror of isDirectListingUrl from public/app.js — keep in sync
function isDirectUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.replace('www.', '');
    if (host === 'bizbuysell.com')
      return /\/Business-Opportunity\//i.test(url) || /\/\d{5,}\/?$/.test(u.pathname);
    if (host === 'bizquest.com')
      return /BQ\d+/i.test(url);
    if (host === 'businessbroker.net')
      return /\/businessforsale\/.+\d/i.test(url) || /\.aspx/i.test(url);
    return true; // trust other domains (individual broker sites)
  } catch { return false; }
}

async function lookupMissingUrls(listings, onStatus) {
  const needsFix = listings.filter(l => !isDirectUrl(l.url));
  if (!needsFix.length) return listings;

  onStatus(`Finding direct links for ${needsFix.length} listing${needsFix.length !== 1 ? 's' : ''}…`);

  const list = needsFix
    .map((l, i) => `${i + 1}. "${l.name}" — ${l.location || 'SoCal'}`)
    .join('\n');

  const prompt = `Use web search to find the direct listing page URL on BizBuySell, BizQuest, or BusinessBroker.net for each business below. Search for each one by name and location.

${list}

Return ONLY a JSON array — no explanation, no markdown:
[{"name": "business name exactly as given", "url": "https://direct-listing-page-url"}]

Rules:
- The URL must be a specific listing page (e.g. bizbuysell.com/Business-Opportunity/name/123456/ or bizquest.com/business-for-sale/name/BQ123456/)
- Omit any entry where you cannot find the specific listing page
- Never include directory, search-result, or category URLs`;

  try {
    const heartbeat = setInterval(() => onStatus('Still finding direct links…'), 15000);
    let response;
    try {
      response = await callAnthropic({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      });
    } finally {
      clearInterval(heartbeat);
    }

    const text = (response.content || [])
      .filter(b => b.type === 'text').map(b => b.text).join('\n');

    const fixes = extractJsonArray(text);
    const fixMap = new Map(
      fixes
        .filter(f => isDirectUrl(f.url))
        .map(f => [f.name.toLowerCase().trim(), f.url])
    );

    const fixed = listings.map(l => {
      const url = fixMap.get(l.name.toLowerCase().trim());
      return url ? { ...l, url } : l;
    });

    const count = fixed.filter((l, i) => l.url !== listings[i].url).length;
    if (count) onStatus(`Resolved ${count} direct link${count !== 1 ? 's' : ''}…`);
    return fixed;
  } catch (e) {
    console.warn('URL lookup step failed (non-fatal):', e.message);
    return listings;
  }
}

function describeSearch(query) {
  const siteMap = [
    [/bizbuysell/i, 'BizBuySell'],
    [/bizquest/i, 'BizQuest'],
    [/businessbroker/i, 'BusinessBroker.net'],
  ];
  let site = null;
  for (const [re, name] of siteMap) {
    if (re.test(query)) { site = name; break; }
  }
  const clean = query
    .replace(/bizbuysell\.com|bizbuysell|bizquest\.com|bizquest|businessbroker\.net|businessbroker/gi, '')
    .replace(/["""]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return site ? { site, topic: clean } : { site: null, topic: query };
}

async function runScout(criteria, onStatus) {
  const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  const messages = [{ role: 'user', content: buildScoutPrompt(criteria) }];

  onStatus('Connecting to Claude — starting acquisition scout…');

  let iterations = 0;
  let heartbeatIdx = 0;
  const MAX_ITERATIONS = 15;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    if (iterations > 1) {
      onStatus('Reviewing results, planning next searches…');
    }

    const heartbeat = setInterval(() => {
      onStatus(HEARTBEAT_MSGS[heartbeatIdx % HEARTBEAT_MSGS.length]);
      heartbeatIdx++;
    }, 20000);

    let response;
    try {
      response = await callAnthropic({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        tools,
        messages
      });
    } finally {
      clearInterval(heartbeat);
    }

    const content = response.content || [];

    // Surface each web search query as a status update
    const searches = content.filter(b => b.type === 'tool_use' && b.name === 'web_search');
    searches.forEach(b => {
      const { site, topic } = describeSearch(b.input?.query || '');
      onStatus(site ? `Searching ${site} — ${topic}` : `Searching — ${topic}`);
    });

    if (response.stop_reason === 'end_turn') {
      const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      console.log('Scout end_turn text blocks:', content.filter(b => b.type === 'text').length, '— first 800:', text.slice(0, 800));
      onStatus('Compiling and scoring listings…');
      const listings = extractJsonArray(text);
      const withUrls = await lookupMissingUrls(listings, onStatus);
      const verified = await verifyListingsLive(withUrls, onStatus);
      onStatus(`Found ${verified.length} listing${verified.length !== 1 ? 's' : ''} — ranking by score…`);
      return verified;
    }

    if (response.stop_reason === 'tool_use') {
      // Assistant message must only contain text + tool_use blocks (not tool_result)
      const assistantContent = content.filter(b => b.type === 'text' || b.type === 'tool_use');
      messages.push({ role: 'assistant', content: assistantContent });

      // Use server-provided tool_result blocks if present; otherwise acknowledge with empty content
      const serverResults = content.filter(b => b.type === 'tool_result');
      const toolResults = serverResults.length > 0
        ? serverResults
        : assistantContent
            .filter(b => b.type === 'tool_use')
            .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '' }));

      if (toolResults.length) {
        messages.push({ role: 'user', content: toolResults });
      } else {
        throw new Error('Unexpected: tool_use stop with no tool blocks.');
      }
      continue;
    }

    if (response.stop_reason === 'max_tokens') {
      // Model ran out of tokens mid-response — try to salvage partial JSON
      const text = content.find(b => b.type === 'text')?.text || '';
      if (text.includes('[')) {
        onStatus('Parsing partial results…');
        return extractJsonArray(text);
      }
      throw new Error('Scout response was cut off before any listings were returned. Try again.');
    }

    throw new Error(`Scout stopped unexpectedly (reason: ${response.stop_reason}). Try again.`);
  }

  throw new Error('Scout exceeded maximum search iterations. Try again.');
}

function buildAnalyzePrompt(pageText, criteria) {
  return `You are an expert SMB acquisition broker. A buyer near Brea, CA wants to acquire a business. Using the content below — extracted from BizBuySell, BusinessBroker.net, BusinessMart.com, or similar sites — extract every business listing you can find and evaluate each one against the buyer's criteria. Deduplicate listings that appear more than once. Where a "LISTING DIRECT LINKS" section is present, match each listing to its URL by title and populate the url field with the full absolute URL.

BUYER CRITERIA:
${buildCriteriaBlock(criteria)}

PAGE TEXT:
${pageText.slice(0, 40000)}

IMPORTANT — asking price, revenue, and cash flow: These listing sites always display the asking price. Extract it from the page text. Only use "Not disclosed" if the page itself explicitly says the price is withheld by the seller. Never use "Not disclosed" simply because the number did not appear in the snippet you reviewed.

Return ONLY a valid JSON array — no markdown, no explanation, just raw JSON. Each element:
{
  "name": "Business name or type",
  "type": "Industry / category",
  "askingPrice": "$XXX,XXX or Not disclosed",
  "annualRevenue": "$XXX,XXX or Not disclosed",
  "cashFlow": "$XXX,XXX or Not disclosed",
  "location": "City, CA",
  "description": "1-2 sentence description",
  "url": "URL if visible, else null",
  "score": 7,
  "priority": "contact now",
  "brokerNotes": "2-3 sentences: criteria fit, what stands out, what to verify first",
  "strengths": ["up to 3 short labels"],
  "concerns": ["up to 3 short labels"]
}

score = 1-10 integer. priority = "contact now" (>=7), "investigate" (5-6), "pass" (<=4).
Sort by score descending. Include all listings found, even poor fits.
IMPORTANT: All string values must be valid JSON — do not use unescaped double quotes, backslashes, or newlines inside strings.`;
}

function preprocessPastedContent(text) {
  const looksLikeHtml = /^\s*<!DOCTYPE|^\s*<html/i.test(text) || (text.indexOf('<a ') !== -1 && text.indexOf('href=') !== -1);
  if (!looksLikeHtml) return text;

  const linkRe = /href=["']([^"']*(?:business-opportunity|business-for-sale|businesses\/|listing)[^"']*|\d{5,}\/?)["'][^>]*>([^<]{3,80})/gi;
  const links = [];
  let m;
  while ((m = linkRe.exec(text)) !== null) {
    const href = m[1].startsWith('http') ? m[1] : `https://www.bizbuysell.com${m[1]}`;
    const title = m[2].trim();
    if (title) links.push(`URL: ${href} | Title: ${title}`);
  }

  const stripped = text
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const linkSection = links.length > 0
    ? 'LISTING DIRECT LINKS (use these as the url field — match by title):\n' + links.join('\n')
    : '';

  return (linkSection ? linkSection + '\n\n' : '') + 'PAGE TEXT:\n' + stripped;
}

async function analyzePassedText(pageText, criteria) {
  const processed = preprocessPastedContent(pageText);
  const response = await callAnthropic({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{ role: 'user', content: buildAnalyzePrompt(processed, criteria) }]
  });
  const text = (response.content || []).find(b => b.type === 'text')?.text || '';
  return extractJsonArray(text);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

if (require.main === module) http.createServer(async (req, res) => {
  // Agentic scout via SSE
  if (req.method === 'POST' && req.url === '/api/scout') {
    const { criteria } = await parseBody(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      const listings = await runScout(criteria || {}, msg => send('status', { message: msg }));
      send('done', { listings, updatedAt: new Date().toISOString() });
    } catch (e) {
      console.error('Scout error:', e.message);
      send('error', { error: e.message });
    } finally {
      res.end();
    }
    return;
  }

  // Manual paste analysis
  if (req.method === 'POST' && req.url === '/api/analyze-paste') {
    try {
      const { text, criteria } = await parseBody(req);
      if (!text || text.length < 100) throw new Error('Pasted text is too short — copy more of the page.');
      const listings = await analyzePassedText(text, criteria);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ listings, updatedAt: new Date().toISOString() }));
    } catch (e) {
      console.error('Paste analyze error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve dashboard
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, html) => {
      if (err) { res.writeHead(500); res.end('Could not read index.html'); return; }
      const injection = `<script>window.__ANTHROPIC_KEY__ = ${JSON.stringify(API_KEY)};</script>`;
      html = html.replace('</head>', injection + '\n</head>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  // Serve static assets from public/
  const staticTypes = { '.css': 'text/css', '.js': 'application/javascript' };
  const ext = path.extname(req.url);
  if (req.method === 'GET' && staticTypes[ext]) {
    fs.readFile(path.join(__dirname, 'public', path.basename(req.url)), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': staticTypes[ext] });
      res.end(data);
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}).listen(PORT, () => {
  console.log(`Acquisition Scout running at http://localhost:${PORT}`);
});

module.exports = { extractJsonArray, describeSearch, buildCriteriaBlock, preprocessPastedContent, buildScoutPrompt };
