const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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

// BizBuySell content cache (1 hour)
let bzsCache = null;
let bzsCacheTime = 0;
const BZS_TTL = 60 * 60 * 1000;

async function fetchPageText(url) {
  const executablePath = require('puppeteer').executablePath();
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    const result = await page.evaluate(() => {
      const listingLinks = Array.from(document.querySelectorAll('a[href]'))
        .filter(a => {
          const h = a.href;
          return h.includes('/Business-Opportunity/') ||
                 h.includes('/business-for-sale/') ||
                 (/bizbuysell\.com/.test(h) && /\/\d+\/?$/.test(h));
        })
        .map(a => ({ href: a.href, text: a.innerText.trim() }))
        .filter(l => l.text.length > 2);

      const linkSection = listingLinks.length > 0
        ? 'LISTING DIRECT LINKS (use these as the url field — match by title):\n' +
          listingLinks.map(l => `URL: ${l.href} | Title: ${l.text}`).join('\n')
        : '';

      return (linkSection ? linkSection + '\n\n' : '') + 'PAGE TEXT:\n' + document.body.innerText;
    });
    console.log(`Fetched ${url} — ${result.length} chars (${result.split('\n').filter(l => l.startsWith('URL:')).length} listing links extracted)`);
    return result;
  } finally {
    await browser.close();
  }
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (data.error) return reject(new Error(data.error.message));
          resolve(data.content?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function extractJsonArray(raw) {
  // Find the outermost [...] block
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in response.');
  let jsonStr = raw.slice(start, end + 1);
  try {
    return JSON.parse(jsonStr);
  } catch {
    // Salvage: truncate to last complete object before the parse failure
    const lastClose = jsonStr.lastIndexOf('},');
    if (lastClose === -1) throw new Error('Could not parse Claude response as JSON. Try again.');
    jsonStr = jsonStr.slice(0, lastClose + 1) + ']';
    return JSON.parse(jsonStr);
  }
}

function buildPrompt(pageText, criteria) {
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

async function getListings(criteria) {
  if (bzsCache && Date.now() - bzsCacheTime < BZS_TTL) {
    console.log('Using cached BizBuySell content');
  } else {
    const urls = [
      'https://www.bizbuysell.com/businesses-for-sale/?q=Brea%2C+CA+92821&radius=25',
      'https://www.bizbuysell.com/california/orange-county-businesses-for-sale/',
      'https://www.bizbuysell.com/california/brea-businesses-for-sale/',
    ];
    for (const url of urls) {
      try {
        const text = await fetchPageText(url);
        const blocked = text.includes('Access Denied') || text.includes('access denied') || text.includes('edgesuite.net');
        if (text && text.length > 2000 && !blocked) {
          bzsCache = text;
          bzsCacheTime = Date.now();
          break;
        }
        if (blocked) console.warn('Akamai block page detected for', url);
      } catch (e) {
        console.warn(`Failed ${url}:`, e.message);
      }
    }
    if (!bzsCache) throw new Error('BizBuySell is blocking automated requests. Use the "Paste listings manually" option instead.');
  }

  const raw = await callClaude(buildPrompt(bzsCache, criteria));
  return extractJsonArray(raw);
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
  const raw = await callClaude(buildPrompt(processed, criteria));
  return extractJsonArray(raw);
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
  // Auto-fetch from BizBuySell
  if (req.method === 'POST' && req.url === '/api/listings') {
    try {
      const criteria = await parseBody(req);
      const listings = await getListings(criteria);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ listings, updatedAt: new Date().toISOString() }));
    } catch (e) {
      console.error('Listings error:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, blocked: e.message.includes('blocking') }));
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
