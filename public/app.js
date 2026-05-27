const CHECKLIST_DEF = {
  'Financials': [
    '3 years of tax returns (business)',
    'P&L statements (3 years, monthly)',
    'Balance sheets (3 years)',
    'Cash flow statements',
    'Accounts receivable / payable aging reports',
    'SDE / EBITDA calculation independently verified'
  ],
  'Operations': [
    'Employee roster — key personnel identified',
    'Customer concentration analysis (< 20% single customer)',
    'Supplier / vendor contracts reviewed',
    'Equipment list and condition assessed',
    'Lease terms and transferability confirmed',
    'All licenses and permits transferable'
  ],
  'Legal': [
    'Entity formation documents reviewed',
    'Pending or threatened litigation check',
    'IP / trademark / brand ownership confirmed',
    'Non-compete agreement from seller drafted',
    'UCC lien search completed'
  ],
  'SBA / Financing': [
    'SBA 7(a) pre-approval obtained',
    'Independent business valuation completed',
    'Debt service coverage ratio ≥ 1.25x confirmed',
    'Chase private client SBA contact engaged',
    'Seller financing terms negotiated (if applicable)'
  ],
  'Market & Growth': [
    'Local competitor landscape mapped',
    'Google / Yelp reviews and reputation analyzed',
    'Revenue trend verified (growing / flat / declining)',
    'Reason for sale independently verified',
    'Post-acquisition growth thesis documented',
    'Transition / training period agreed with seller'
  ]
};

// ── State ─────────────────────────────────────────────────────────
let leads = [];
let checkState = {};
let criteria = {};
let currentListings = [];
let currentAnalysis = '';
let currentScore = null;
let batchTexts = [];

// ── Utils ─────────────────────────────────────────────────────────
function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Storage ───────────────────────────────────────────────────────
function load() {
  try {
    leads = JSON.parse(localStorage.getItem('acq_leads') || '[]');
    checkState = JSON.parse(localStorage.getItem('acq_checks') || '{}');
    criteria = JSON.parse(localStorage.getItem('acq_criteria') || '{}');

    if (criteria.price) document.getElementById('crit-price').value = criteria.price;
    if (criteria.sde) document.getElementById('crit-sde').value = criteria.sde;
    if (criteria.revenue) document.getElementById('crit-revenue').value = criteria.revenue;
    if (criteria.margin) document.getElementById('crit-margin').value = criteria.margin;
    if (criteria.distance) document.getElementById('crit-distance').value = criteria.distance;
    if (criteria.industries) document.getElementById('crit-industries').value = criteria.industries;
    if (criteria.model) document.getElementById('crit-model').value = criteria.model;
    if (criteria.dealbreakers) document.getElementById('crit-dealbreakers').value = criteria.dealbreakers;
    if (criteria.notes) document.getElementById('crit-notes').value = criteria.notes;

    const cached = localStorage.getItem('acq_listings');
    if (cached) {
      const { listings, updatedAt } = JSON.parse(cached);
      currentListings = listings;
      renderListings(listings, updatedAt);
    }
  } catch (e) {}
}

function persist() {
  localStorage.setItem('acq_leads', JSON.stringify(leads));
  localStorage.setItem('acq_checks', JSON.stringify(checkState));
}

// ── Criteria ──────────────────────────────────────────────────────
function getCriteria() {
  return {
    price: document.getElementById('crit-price').value,
    sde: document.getElementById('crit-sde').value,
    revenue: document.getElementById('crit-revenue').value,
    margin: document.getElementById('crit-margin').value,
    distance: document.getElementById('crit-distance').value,
    industries: document.getElementById('crit-industries').value,
    model: document.getElementById('crit-model').value,
    dealbreakers: document.getElementById('crit-dealbreakers').value,
    notes: document.getElementById('crit-notes').value,
  };
}

function saveCriteria() {
  criteria = getCriteria();
  localStorage.setItem('acq_criteria', JSON.stringify(criteria));
  const saved = document.getElementById('crit-saved');
  saved.style.display = 'inline';
  setTimeout(() => { saved.style.display = 'none'; }, 2000);
}

// ── Batch import ──────────────────────────────────────────────────
function addToBatch() {
  const text = document.getElementById('paste-input').value.trim();
  if (!text) { alert('Paste some text first.'); return; }
  batchTexts.push(text);
  document.getElementById('paste-input').value = '';
  document.getElementById('paste-char-count').textContent = '';
  updateBatchUI();
}

function clearBatch() {
  batchTexts = [];
  document.getElementById('paste-input').value = '';
  document.getElementById('paste-char-count').textContent = '';
  updateBatchUI();
}

function removeBatchItem(i) {
  batchTexts.splice(i, 1);
  updateBatchUI();
}

function updateBatchUI() {
  const count = batchTexts.length;
  const totalChars = batchTexts.reduce((s, t) => s + t.length, 0);
  document.getElementById('batch-badge').textContent = count + (count === 1 ? ' search added' : ' searches added');
  document.getElementById('analyze-batch-btn').disabled = count === 0;

  const listEl = document.getElementById('batch-list');
  const itemsEl = document.getElementById('batch-items');
  if (count === 0) { listEl.style.display = 'none'; return; }

  listEl.style.display = '';
  itemsEl.innerHTML = batchTexts.map((t, i) =>
    `<div style="display:flex; align-items:center; justify-content:space-between; font-size:13px; background:var(--bg); border:1px solid var(--border); border-radius:var(--radius); padding:8px 12px;">
      <span style="color:var(--text-muted);">Search ${i + 1} — ${t.length.toLocaleString()} chars</span>
      <button class="btn btn-danger btn-sm" onclick="removeBatchItem(${i})">✕</button>
    </div>`
  ).join('');
  itemsEl.innerHTML += `<div style="font-size:12px; color:var(--text-faint); padding:4px 2px;">${totalChars.toLocaleString()} total chars across ${count} search${count > 1 ? 'es' : ''}</div>`;
}

async function analyzePaste() {
  if (!batchTexts.length) { alert('Add at least one search to the batch first.'); return; }

  const btn = document.getElementById('analyze-batch-btn');
  const spinner = document.getElementById('paste-spinner');
  const stateEl = document.getElementById('listings-state');

  btn.disabled = true;
  spinner.style.display = 'inline-block';
  stateEl.innerHTML = `<div class="state-box"><p>Analyzing ${batchTexts.length} batched search${batchTexts.length > 1 ? 'es' : ''}…</p><small>Running broker analysis against your criteria.</small></div>`;
  stateEl.style.display = '';
  document.getElementById('listings-container').innerHTML = '';

  try {
    const combinedText = batchTexts.join('\n\n--- NEXT SEARCH RESULTS ---\n\n');
    const res = await fetch('/api/analyze-paste', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: combinedText, criteria: getCriteria() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);

    currentListings = data.listings;
    localStorage.setItem('acq_listings', JSON.stringify({ listings: data.listings, updatedAt: data.updatedAt }));
    renderListings(data.listings, data.updatedAt);
    clearBatch();
  } catch (e) {
    stateEl.innerHTML = `<div class="state-box error-box"><p>Analysis failed</p><small>${escHtml(e.message)}</small></div>`;
    stateEl.style.display = '';
  } finally {
    btn.disabled = false;
    spinner.style.display = 'none';
  }
}

// ── Listings render ───────────────────────────────────────────────
function renderListings(listings, updatedAt) {
  const stateEl = document.getElementById('listings-state');
  const container = document.getElementById('listings-container');

  stateEl.style.display = 'none';

  if (!listings || !listings.length) {
    stateEl.innerHTML = `<div class="state-box"><p>No listings found</p><small>BizBuySell may have returned no results. Try refreshing.</small></div>`;
    stateEl.style.display = '';
    container.innerHTML = '';
    return;
  }

  if (updatedAt) {
    const d = new Date(updatedAt);
    document.getElementById('listings-timestamp').textContent =
      'Updated ' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  container.innerHTML = listings.map((l, i) => {
    const priorityClass = l.priority === 'contact now' ? 'contact' : l.priority === 'investigate' ? 'investigate' : 'pass';
    const priorityLabel = l.priority === 'contact now' ? '● Contact now' : l.priority === 'investigate' ? '◐ Investigate' : '○ Pass';
    const strengths = (l.strengths || []).map(s => `<span class="tag tag-strength">${escHtml(s)}</span>`).join('');
    const concerns = (l.concerns || []).map(c => `<span class="tag tag-concern">${escHtml(c)}</span>`).join('');
    const searchUrl = `https://www.bizbuysell.com/businesses-for-sale/?q=${encodeURIComponent(l.name + ' ' + (l.location || ''))}`;
    const viewLink = l.url
      ? `<a class="btn btn-sm" href="${escHtml(l.url)}" target="_blank" rel="noreferrer noopener">View listing →</a>`
      : `<a class="btn btn-sm" href="${searchUrl}" target="_blank" rel="noreferrer noopener">Search BizBuySell →</a>`;
    return `<div class="listing-card priority-${priorityClass}">
      <div class="listing-card-top">
        <div class="listing-card-meta">
          <span class="priority-badge ${priorityClass}">${priorityLabel}</span>
          <div class="listing-name">${escHtml(l.name)}</div>
          <div class="listing-type-loc">${escHtml(l.type)}${l.location ? ' · ' + escHtml(l.location) : ''}</div>
        </div>
        <div class="score-block">
          <div class="score-num">${l.score}<span class="score-denom">/10</span></div>
          <div class="score-label">broker score</div>
        </div>
      </div>
      <div class="listing-metrics">
        <div class="metric-item"><div class="metric-label">Asking price</div><div class="metric-value">${escHtml(l.askingPrice || '—')}</div></div>
        <div class="metric-item"><div class="metric-label">Annual revenue</div><div class="metric-value">${escHtml(l.annualRevenue || '—')}</div></div>
        <div class="metric-item"><div class="metric-label">Cash flow</div><div class="metric-value">${escHtml(l.cashFlow || '—')}</div></div>
      </div>
      <div class="broker-notes">
        <div class="broker-notes-label">Broker analysis</div>
        <p>${escHtml(l.brokerNotes || '')}</p>
      </div>
      ${(strengths || concerns) ? `<div class="listing-tags">${strengths}${concerns}</div>` : ''}
      <div class="listing-actions">
        ${viewLink}
        <button class="btn btn-sm btn-primary" onclick="saveListingToLeads(${i})">+ Save to pipeline</button>
      </div>
    </div>`;
  }).join('');

  const hot = listings.filter(l => l.priority === 'contact now').length;
  const avg = listings.length ? (listings.reduce((s, l) => s + (l.score || 0), 0) / listings.length).toFixed(1) : '—';
  document.getElementById('stat-total').textContent = listings.length;
  document.getElementById('stat-hot').textContent = hot;
  document.getElementById('stat-avg').textContent = avg;
}

function saveListingToLeads(index) {
  const l = currentListings[index];
  if (!l) return;
  leads.push({
    id: Date.now(),
    name: l.name || 'Unnamed business',
    analysis: `${l.brokerNotes}\n\nAsking: ${l.askingPrice} | Revenue: ${l.annualRevenue} | Cash Flow: ${l.cashFlow}\nLocation: ${l.location}`,
    score: l.score,
    listing: l.description || '',
    url: l.url || null,
    date: new Date().toISOString()
  });
  persist();
  renderLeads();
  updateStats();
  document.getElementById('pipeline-panel').open = true;
}

// ── Manual analyzer ───────────────────────────────────────────────
async function analyzeBusiness() {
  const input = document.getElementById('biz-input').value.trim();
  if (!input) { alert('Paste some business details first.'); return; }

  const apiKey = window.__ANTHROPIC_KEY__ || localStorage.getItem('acq_api_key') || '';
  if (!apiKey) { alert('No API key found. Make sure the server is running with a valid .env file.'); return; }

  const resultEl = document.getElementById('ai-result');
  const saveRow = document.getElementById('save-row');
  const spinner = document.getElementById('analyze-spinner');

  resultEl.style.display = 'block';
  resultEl.classList.add('loading');
  resultEl.textContent = 'Analyzing against your criteria…';
  saveRow.style.display = 'none';
  spinner.style.display = 'inline-block';
  currentAnalysis = '';
  currentScore = null;

  const c = getCriteria();
  const prompt = `You are an expert SMB acquisition advisor helping a buyer near Brea, CA evaluate a business to acquire.

BUYER CRITERIA:
- Max asking price: ${c.price}
- Min annual revenue: ${c.revenue}
- Min net profit margin: ${c.margin}
- Max distance from Brea, CA: ${c.distance}
- Preferred industries: ${c.industries}
- Ownership model preference: ${c.model}
- Deal-breakers: ${c.dealbreakers || 'none specified'}
- Financing & context: ${c.notes}

BUSINESS LISTING:
${input}

Provide a structured analysis in this exact format:

SCORE: [number 1-10]

SUMMARY
2 sentences covering what this business is and whether it's worth pursuing.

STRENGTHS
• [point]
• [point]
• [point]

CONCERNS & RED FLAGS
• [point]
• [point]
• [point]

CRITERIA FIT
Asking price: [Pass / Fail / Unknown — one sentence]
Revenue: [Pass / Fail / Unknown — one sentence]
Location: [Pass / Fail / Unknown — one sentence]
Industry: [Pass / Fail / Unknown — one sentence]
Ownership model: [Pass / Fail / Unknown — one sentence]
SBA / DSCR: [Pass / Fail / Unknown — one sentence]

NEXT STEPS
1. [Specific action]
2. [Specific action]
3. [Specific action]

Be direct and skeptical. Flag anything that could kill the deal.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || `API error ${res.status}`);
    }

    const data = await res.json();
    const text = data.content?.[0]?.text || 'No response received.';
    currentAnalysis = text;
    resultEl.classList.remove('loading');
    resultEl.textContent = text;

    const scoreMatch = text.match(/SCORE:\s*(\d+(?:\.\d+)?)/i);
    if (scoreMatch) currentScore = parseFloat(scoreMatch[1]);
    saveRow.style.display = 'flex';
  } catch (e) {
    resultEl.classList.remove('loading');
    resultEl.textContent = 'Error: ' + e.message;
  } finally {
    spinner.style.display = 'none';
  }
}

function clearAnalysis() {
  document.getElementById('biz-input').value = '';
  const r = document.getElementById('ai-result');
  r.style.display = 'none';
  r.textContent = '';
  document.getElementById('save-row').style.display = 'none';
  currentAnalysis = '';
  currentScore = null;
}

// ── Pipeline ──────────────────────────────────────────────────────
function saveLead() {
  const name = document.getElementById('save-name').value.trim() || 'Unnamed business';
  leads.push({
    id: Date.now(),
    name,
    analysis: currentAnalysis,
    score: currentScore,
    listing: document.getElementById('biz-input').value.trim(),
    date: new Date().toISOString()
  });
  persist();
  renderLeads();
  updateStats();
  document.getElementById('save-name').value = '';
  clearAnalysis();
  document.getElementById('pipeline-panel').open = true;
}

function removeLead(id) {
  if (!confirm('Remove this lead from your pipeline?')) return;
  leads = leads.filter(l => l.id !== id);
  persist();
  renderLeads();
  updateStats();
}

function renderLeads() {
  const container = document.getElementById('leads-list');
  const countBadge = document.getElementById('pipeline-count-badge');
  countBadge.textContent = leads.length ? leads.length + ' saved' : '0 saved';
  document.getElementById('stat-pipeline').textContent = leads.length;

  if (!leads.length) {
    container.innerHTML = `<div class="empty-state"><p>No leads saved yet</p><small>Save listings from the broker feed or the manual analyzer.</small></div>`;
    return;
  }

  const sort = document.getElementById('sort-select').value;
  const sorted = [...leads].sort((a, b) => {
    if (sort === 'score-desc') return (b.score || 0) - (a.score || 0);
    if (sort === 'score-asc') return (a.score || 0) - (b.score || 0);
    return new Date(b.date) - new Date(a.date);
  });

  container.innerHTML = sorted.map(l => {
    const scoreClass = l.score >= 7 ? 'badge-hot' : l.score >= 5 ? 'badge-warm' : 'badge-cold';
    const scoreLabel = l.score >= 7 ? '🔥 Hot' : l.score >= 5 ? '🌤 Warm' : '❄️ Pass';
    const dateStr = new Date(l.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const searchUrl = `https://www.bizbuysell.com/businesses-for-sale/?q=${encodeURIComponent(l.name)}`;
    return `<div class="lead-card">
      <div class="lead-header">
        <div>
          <div class="lead-name">${escHtml(l.name)}</div>
          <div class="lead-meta">Saved ${dateStr}</div>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          ${l.score ? `<span class="badge ${scoreClass}">${scoreLabel} · ${l.score}/10</span>` : ''}
          <button class="btn btn-danger btn-sm" onclick="removeLead(${l.id})" title="Remove">✕</button>
        </div>
      </div>
      ${(l.url || l.name) ? `<a href="${escHtml(l.url || searchUrl)}" target="_blank" rel="noreferrer noopener" style="font-size:12px; color:var(--accent); text-decoration:none; display:inline-block; margin-bottom:6px;">${l.url ? 'View listing →' : 'Search BizBuySell →'}</a>` : ''}
      <details class="lead-detail">
        <summary>View analysis</summary>
        <div class="lead-analysis">${escHtml(l.analysis)}</div>
      </details>
    </div>`;
  }).join('');
}

// ── Checklist ─────────────────────────────────────────────────────
function renderChecklist() {
  const container = document.getElementById('checklist-container');
  let html = '';
  let total = 0, done = 0;
  for (const [section, items] of Object.entries(CHECKLIST_DEF)) {
    html += `<div class="checklist-section"><div class="checklist-section-title">${section}</div>`;
    items.forEach((item, i) => {
      const key = section + '__' + i;
      const checked = !!checkState[key];
      total++;
      if (checked) done++;
      html += `<label class="checklist-item ${checked ? 'done' : ''}">
        <input type="checkbox" ${checked ? 'checked' : ''} onchange="toggleCheck('${key}', this)" />
        <span>${item}</span>
      </label>`;
    });
    html += '</div>';
  }
  container.innerHTML = html;
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById('checklist-progress-text').textContent = `${done} of ${total} complete`;
  document.getElementById('checklist-bar').style.width = pct + '%';
  document.getElementById('checklist-count-badge').textContent = pct + '%';
}

function toggleCheck(key, el) {
  checkState[key] = el.checked;
  persist();
  renderChecklist();
}

function resetChecklist() {
  if (!confirm('Reset all checklist items?')) return;
  checkState = {};
  persist();
  renderChecklist();
}

// ── Stats ─────────────────────────────────────────────────────────
function updateStats() {
  document.getElementById('stat-pipeline').textContent = leads.length;
  document.getElementById('pipeline-count-badge').textContent = leads.length ? leads.length + ' saved' : '0 saved';
}

// ── Password gate ─────────────────────────────────────────────────
function submitGate() {
  const input = document.getElementById('gate-pw');
  const errorEl = document.getElementById('gate-error');
  if (input.value === 'Brea2025') {
    sessionStorage.setItem('acq_auth', '1');
    document.getElementById('gate').style.display = 'none';
  } else {
    errorEl.textContent = 'Incorrect password. Try again.';
    input.classList.remove('shake');
    void input.offsetWidth;
    input.classList.add('shake');
    input.value = '';
    input.focus();
  }
}

// ── Init ──────────────────────────────────────────────────────────
if (sessionStorage.getItem('acq_auth') === '1') {
  document.getElementById('gate').style.display = 'none';
} else {
  setTimeout(() => document.getElementById('gate-pw').focus(), 50);
}

document.getElementById('paste-input').addEventListener('input', function () {
  const n = this.value.length;
  document.getElementById('paste-char-count').textContent = n > 0 ? n.toLocaleString() + ' chars — click Add to batch' : '';
});

load();
renderLeads();
renderChecklist();
updateStats();
