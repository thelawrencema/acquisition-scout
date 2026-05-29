'use strict';
// Tests for pure utility functions in public/app.js.
// These functions are copied here because app.js targets the browser and
// cannot be require()'d directly. If you change isDirectListingUrl in app.js,
// update the copy below to match.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function isDirectListingUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.replace('www.', '');
    if (host === 'bizbuysell.com') {
      return /\/Business-Opportunity\//i.test(url) || /\/\d{5,}\/?$/.test(u.pathname);
    }
    if (host === 'bizquest.com') {
      return /BQ\d+/i.test(url);
    }
    if (host === 'businessbroker.net') {
      return /\/businessforsale\/.+\d/i.test(url) || /\.aspx/i.test(url);
    }
    return true;
  } catch {
    return false;
  }
}

describe('isDirectListingUrl', () => {
  describe('BizBuySell', () => {
    it('accepts /Business-Opportunity/ listing URLs', () => {
      assert.ok(isDirectListingUrl(
        'https://www.bizbuysell.com/Business-Opportunity/cleaning-service-brea-ca/1234567/'
      ));
    });

    it('accepts URLs whose path ends with a 5+ digit listing ID', () => {
      assert.ok(isDirectListingUrl('https://www.bizbuysell.com/buyer/result/detail/1234567'));
    });

    it('rejects city/county directory URLs', () => {
      assert.ok(!isDirectListingUrl(
        'https://www.bizbuysell.com/california/orange-county-businesses-for-sale/'
      ));
    });

    it('rejects search result URLs', () => {
      assert.ok(!isDirectListingUrl(
        'https://www.bizbuysell.com/businesses-for-sale/?q=cleaning+service'
      ));
    });

    it('rejects bare domain root', () => {
      assert.ok(!isDirectListingUrl('https://www.bizbuysell.com/'));
    });
  });

  describe('BizQuest', () => {
    it('accepts URLs containing a BQ listing ID', () => {
      assert.ok(isDirectListingUrl(
        'https://www.bizquest.com/business-for-sale/cleaning-service/BQ1234567/'
      ));
    });

    it('rejects state/city directory URLs', () => {
      assert.ok(!isDirectListingUrl(
        'https://www.bizquest.com/business-for-sale/california/los-angeles/'
      ));
    });

    it('rejects the site root', () => {
      assert.ok(!isDirectListingUrl('https://www.bizquest.com/'));
    });
  });

  describe('BusinessBroker.net', () => {
    it('accepts .aspx listing page URLs', () => {
      assert.ok(isDirectListingUrl(
        'https://www.businessbroker.net/businessforsale/cleaning-service-123456.aspx'
      ));
    });

    it('accepts /businessforsale/ URLs with a numeric slug', () => {
      assert.ok(isDirectListingUrl(
        'https://www.businessbroker.net/businessforsale/cleaning-service-1234/'
      ));
    });

    it('rejects plain /businessforsale/ directory without a slug', () => {
      assert.ok(!isDirectListingUrl(
        'https://www.businessbroker.net/businessforsale/'
      ));
    });
  });

  describe('other domains (individual broker sites)', () => {
    it('trusts any URL from an unrecognised domain', () => {
      assert.ok(isDirectListingUrl('https://socalbrokerage.com/listing/abc-cleaning-1234'));
      assert.ok(isDirectListingUrl('https://meridianbrokers.com/business/9876'));
    });
  });

  describe('invalid / empty inputs', () => {
    it('returns false for null', () => assert.ok(!isDirectListingUrl(null)));
    it('returns false for undefined', () => assert.ok(!isDirectListingUrl(undefined)));
    it('returns false for empty string', () => assert.ok(!isDirectListingUrl('')));
    it('returns false for a non-URL string', () => assert.ok(!isDirectListingUrl('not a url')));
  });
});
