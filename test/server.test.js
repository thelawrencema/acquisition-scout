'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractJsonArray,
  describeSearch,
  buildCriteriaBlock,
  preprocessPastedContent,
  buildScoutPrompt,
} = require('../server.js');

// ── extractJsonArray ──────────────────────────────────────────────────────────
describe('extractJsonArray', () => {
  it('parses a bare JSON array', () => {
    const result = extractJsonArray('[{"name":"Biz","score":7}]');
    assert.deepEqual(result, [{ name: 'Biz', score: 7 }]);
  });

  it('extracts JSON from surrounding prose', () => {
    const raw = 'Here are the listings I found:\n[{"name":"Biz","score":7}]\nEnd of response.';
    assert.deepEqual(extractJsonArray(raw), [{ name: 'Biz', score: 7 }]);
  });

  it('extracts JSON from a markdown code block', () => {
    const raw = '```json\n[{"name":"Biz","score":7}]\n```';
    assert.deepEqual(extractJsonArray(raw), [{ name: 'Biz', score: 7 }]);
  });

  // Regression: model returns multiple text blocks joined with \n — the first
  // block is prose ("Now let me do more searches…"), JSON is in a later block.
  it('finds JSON when it appears after a prose text block', () => {
    const raw = [
      'Now let me do a few more targeted searches to get specific financial details.',
      '[{"name":"Cleaning Biz","score":8,"askingPrice":"$450,000"}]',
    ].join('\n');
    assert.deepEqual(extractJsonArray(raw), [
      { name: 'Cleaning Biz', score: 8, askingPrice: '$450,000' },
    ]);
  });

  it('handles nested arrays inside listing objects', () => {
    const raw = '[{"name":"Biz","strengths":["absentee","cash flow"]}]';
    assert.deepEqual(extractJsonArray(raw), [
      { name: 'Biz', strengths: ['absentee', 'cash flow'] },
    ]);
  });

  it('parses multiple listings and preserves order', () => {
    const raw = '[{"name":"A","score":9},{"name":"B","score":5},{"name":"C","score":2}]';
    const result = extractJsonArray(raw);
    assert.equal(result.length, 3);
    assert.equal(result[0].name, 'A');
    assert.equal(result[2].score, 2);
  });

  it('recovers from truncated JSON by dropping the incomplete last object', () => {
    // Truncated mid-way, but a nested array has already supplied a ']' so the
    // recovery path can kick in (strips after the last complete "},").
    const raw = '[{"name":"Biz A","score":8},{"name":"Biz B","score":5,"strengths":["absentee"],"concerns":["seasonal';
    const result = extractJsonArray(raw);
    assert.deepEqual(result, [{ name: 'Biz A', score: 8 }]);
  });

  it('throws with "No JSON array found" when there are no brackets', () => {
    assert.throws(
      () => extractJsonArray('The scout could not find any listings.'),
      /No JSON array found/
    );
  });

  it('throws with a preview of the returned text so errors are diagnosable', () => {
    try {
      extractJsonArray('I was unable to complete the web searches.');
      assert.fail('should have thrown');
    } catch (e) {
      assert.match(e.message, /Model returned:/);
      assert.match(e.message, /unable to complete/);
    }
  });

  it('throws on empty input', () => {
    assert.throws(() => extractJsonArray(''), /No JSON array found/);
  });
});

// ── describeSearch ────────────────────────────────────────────────────────────
describe('describeSearch', () => {
  it('identifies BizBuySell and strips the site name from the topic', () => {
    const { site, topic } = describeSearch('businesses for sale Orange County California bizbuysell');
    assert.equal(site, 'BizBuySell');
    assert.match(topic, /Orange County/);
    assert.ok(!topic.toLowerCase().includes('bizbuysell'));
  });

  it('identifies BizQuest', () => {
    const { site } = describeSearch('absentee business for sale Southern California bizquest');
    assert.equal(site, 'BizQuest');
  });

  it('identifies BusinessBroker.net', () => {
    const { site } = describeSearch('service businesses for sale SoCal businessbroker');
    assert.equal(site, 'BusinessBroker.net');
  });

  it('returns null site when no known site is in the query', () => {
    const { site, topic } = describeSearch('businesses for sale Orange County California');
    assert.equal(site, null);
    assert.equal(topic, 'businesses for sale Orange County California');
  });

  it('is case-insensitive', () => {
    assert.equal(describeSearch('BizBuySell Orange County').site, 'BizBuySell');
    assert.equal(describeSearch('BIZQUEST SoCal').site, 'BizQuest');
  });
});

// ── buildCriteriaBlock ────────────────────────────────────────────────────────
describe('buildCriteriaBlock', () => {
  it('includes all provided criteria values', () => {
    const result = buildCriteriaBlock({
      price: '$500,000',
      sde: '$80,000',
      revenue: '$300,000',
      margin: '20%',
      distance: 'Brea, CA',
      industries: 'Janitorial',
      model: 'Absentee',
      dealbreakers: 'Highly seasonal',
      notes: 'SBA pre-approved',
    });
    assert.match(result, /\$500,000/);
    assert.match(result, /\$80,000/);
    assert.match(result, /\$300,000/);
    assert.match(result, /20%/);
    assert.match(result, /Janitorial/);
    assert.match(result, /Absentee/);
    assert.match(result, /Highly seasonal/);
    assert.match(result, /SBA pre-approved/);
  });

  it('falls back to sensible defaults when criteria fields are missing', () => {
    const result = buildCriteriaBlock({});
    assert.match(result, /\$750,000/);   // default price
    assert.match(result, /\$100,000/);   // default SDE
    assert.match(result, /No preference/); // default industries
  });

  it('absentee ownership model produces a score bonus note', () => {
    const result = buildCriteriaBlock({ model: 'Absentee / semi-absentee' });
    assert.match(result, /bonus/i);
  });
});

// ── preprocessPastedContent ───────────────────────────────────────────────────
describe('preprocessPastedContent', () => {
  it('returns plain text unchanged', () => {
    const input = 'Asking price $450,000. Cash flow $120,000. Located in Brea, CA.';
    assert.equal(preprocessPastedContent(input), input);
  });

  it('strips HTML tags and preserves text content', () => {
    const input = '<html><body><p>Asking price <strong>$450,000</strong></p></body></html>';
    const result = preprocessPastedContent(input);
    assert.ok(!result.includes('<p>'));
    assert.ok(!result.includes('<strong>'));
    assert.ok(result.includes('$450,000'));
  });

  it('removes script and style blocks entirely (not just their tags)', () => {
    const input = [
      '<!DOCTYPE html><html><head>',
      '<style>body { color: red; font-size: 14px; }</style>',
      '<script>var secret = "do not leak";</script>',
      '</head><body>Price: $450,000</body></html>',
    ].join('');
    const result = preprocessPastedContent(input);
    assert.ok(!result.includes('color: red'));
    assert.ok(!result.includes('do not leak'));
    assert.ok(result.includes('$450,000'));
  });

  it('extracts BizBuySell listing links and adds a LISTING DIRECT LINKS section', () => {
    const input = [
      '<!DOCTYPE html><html><body>',
      '<a href="/Business-Opportunity/cleaning-service/1234567/">Cleaning Service Brea CA</a>',
      '<a href="/Business-Opportunity/auto-shop/9876543/">Auto Shop Diamond Bar</a>',
      '</body></html>',
    ].join('');
    const result = preprocessPastedContent(input);
    assert.match(result, /LISTING DIRECT LINKS/);
    assert.match(result, /Cleaning Service Brea CA/);
    assert.match(result, /Auto Shop Diamond Bar/);
    assert.match(result, /bizbuysell\.com/);
  });

  it('does not add LISTING DIRECT LINKS section when no listing URLs are found', () => {
    const input = '<html><body><p>Some text with no links</p></body></html>';
    const result = preprocessPastedContent(input);
    assert.ok(!result.includes('LISTING DIRECT LINKS'));
  });
});

// ── buildScoutPrompt ──────────────────────────────────────────────────────────
describe('buildScoutPrompt', () => {
  it('includes buyer criteria in the prompt', () => {
    const prompt = buildScoutPrompt({ price: '$600,000', industries: 'Landscaping' });
    assert.match(prompt, /\$600,000/);
    assert.match(prompt, /Landscaping/);
  });

  it('includes instructions about direct listing URLs', () => {
    const prompt = buildScoutPrompt({});
    assert.match(prompt, /Business-Opportunity/);  // example of correct URL format
    assert.match(prompt, /RULE 1/i);
  });

  it('includes instructions about not using lazy "Not disclosed"', () => {
    const prompt = buildScoutPrompt({});
    assert.match(prompt, /Not disclosed/);
    assert.match(prompt, /RULE 2/i);
  });

  it('uses custom industry search when industries are specified', () => {
    const prompt = buildScoutPrompt({ industries: 'Janitorial' });
    assert.match(prompt, /Janitorial/);
  });
});
