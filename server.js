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
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

function extractJsonArray(raw) {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in response.');
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

function buildScoutPrompt(criteria) {
  return `You are an expert SMB acquisition broker. Use web search to find business listings for sale that match the buyer criteria below. Search BizBuySell.com, BizQuest.com, and BusinessBroker.net. Perform several targeted searches to find 15-25 listings total across all three sites.

BUYER CRITERIA:
- Max asking price: ${criteria.price || '$750,000'}
- Min SDE / Cash Flow: ${criteria.sde || '$100,000'} — listings below this MUST be scored <= 3
- Min annual revenue: ${criteria.revenue || '$200,000'}
- Min net profit margin: ${criteria.margin || '15%'}
- Target area: ${criteria.distance || 'Brea, Chino Hills, Diamond Bar, Rowland Heights, La Habra, Placentia, Fullerton, Yorba Linda and surrounding cities within ~25 miles of Brea CA'}
- Preferred industries: ${criteria.industries || 'Janitorial, Services, B2B, Facilities'}
- Ownership model: ${criteria.model || 'Absentee / semi-absentee'} — absentee/semi-absentee gets a score bonus; owner-operator gets a penalty
- Deal-breakers: ${criteria.dealbreakers || 'none specified'}
- Financing context: ${criteria.notes || 'SBA 7(a) loan, max $750k, need $100k+ SDE, DSCR > 1.25x, prefer 5+ years in operation'}

Suggested searches:
- "businesses for sale Orange County California bizbuysell"
- "businesses for sale Brea CA bizbuysell"
- "businesses for sale Chino Hills Diamond Bar CA bizbuysell"
- "janitorial cleaning service business for sale Southern California"
- "B2B service business for sale Orange County bizquest"
- "absentee business for sale Southern California businessbroker"

After completing your searches, return ONLY a valid JSON array — no markdown, no explanation. Each element:
{
  "name": "Business name or type",
  "type": "Industry / category",
  "askingPrice": "$XXX,XXX or Not disclosed",
  "annualRevenue": "$XXX,XXX or Not disclosed",
  "cashFlow": "$XXX,XXX or Not disclosed",
  "location": "City, CA",
  "description": "1-2 sentence description",
  "url": "Direct URL to the listing",
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

async function runScout(criteria, onStatus) {
  const tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  const messages = [{ role: 'user', content: buildScoutPrompt(criteria) }];

  onStatus('Starting acquisition scout…');

  let iterations = 0;
  const MAX_ITERATIONS = 15;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await callAnthropic({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      tools,
      messages
    });

    const content = response.content || [];

    // Surface each web search query as a status update
    content
      .filter(b => b.type === 'tool_use' && b.name === 'web_search')
      .forEach(b => onStatus(`Searching: "${b.input?.query}"`));

    messages.push({ role: 'assistant', content });

    if (response.stop_reason === 'end_turn') {
      const text = content.find(b => b.type === 'text')?.text || '';
      onStatus('Parsing listings…');
      return extractJsonArray(text);
    }

    if (response.stop_reason === 'tool_use') {
      // Return tool_results to continue the loop; Anthropic executes web_search server-side
      const toolResults = content
        .filter(b => b.type === 'tool_use')
        .map(b => ({ type: 'tool_result', tool_use_id: b.id, content: '' }));
      if (toolResults.length) {
        messages.push({ role: 'user', content: toolResults });
      }
    }
  }

  throw new Error('Scout exceeded maximum search iterations. Try again.');
}

function buildAnalyzePrompt(pageText, criteria) {
  return `You are an expert SMB acquisition broker. A buyer near Brea, CA wants to acquire a business. Using the content below — extracted from BizBuySell, BusinessBroker.net, BusinessMart.com, or similar sites — extract every business listing you can find and evaluate each one against the buyer's criteria. Deduplicate listings that appear more than once. Where a "LISTING DIRECT LINKS" section is present, match each listing to its URL by title and populate the url field with the full absolute URL.

BUYER CRITERIA:
- Max asking price: ${criteria.price || '$750,000'}
- Min SDE / Cash Flow: ${criteria.sde || '$100,000'} — listings below this MUST be scored <= 3
- Min annual revenue: ${criteria.revenue || '$200,000'}
- Min net profit margin: ${criteria.margin || '15%'}
- Target area: ${criteria.distance || 'Brea, Chino Hills, Diamond Bar, Rowland Heights, La Habra, Placentia, Fullerton, Yorba Linda and surrounding cities within ~25 miles of Brea CA'}
- Preferred industries: ${criteria.industries || 'Janitorial, Services, B2B, Facilities'}
- Ownership model: ${criteria.model || 'Absentee / semi-absentee'} — absentee/semi-absentee gets a score bonus; owner-operator gets a penalty
- Deal-breakers: ${criteria.dealbreakers || 'none specified'}
- Financing context: ${criteria.notes || 'SBA 7(a) loan, max $750k, need $100k+ SDE, DSCR > 1.25x, prefer 5+ years in operation'}

PAGE TEXT:
${pageText.slice(0, 40000)}

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

http.createServer(async (req, res) => {
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
