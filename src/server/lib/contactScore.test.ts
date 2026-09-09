import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeDialStatus } from './contactScore.js';
import { nanpDigits } from './veriphone.js';

describe('nanpDigits', () => {
  it('accepts 10-digit and +1 numbers', () => {
    assert.equal(nanpDigits('(214) 555-1212'), '2145551212');
    assert.equal(nanpDigits('+1 214-555-1212'), '2145551212');
  });

  it('rejects junk that is not a NANP number', () => {
    assert.equal(nanpDigits(''), null);
    assert.equal(nanpDigits('N/A'), null);
    assert.equal(nanpDigits('call office'), null);
    assert.equal(nanpDigits('123'), null);
  });
});

describe('computeDialStatus', () => {
  it('promotes match + mobile to owner_cell even when the email looks generic', () => {
    assert.equal(
      computeDialStatus({
        owner_score: 'office_likely',
        email_kind: 'generic',
        line_type: 'mobile',
        officer_match: 'match',
        owner_cell: null,
      }),
      'owner_cell',
    );
  });

  it('does not treat registered-agent-only as owner identity', () => {
    assert.equal(
      computeDialStatus({
        owner_score: 'owner_likely',
        email_kind: 'other',
        line_type: 'mobile',
        officer_match: 'agent',
        owner_cell: null,
      }),
      'needs_enrichment',
    );
  });

  it('does not treat a different officer as the Shovels phone owner', () => {
    assert.equal(
      computeDialStatus({
        owner_score: 'owner_likely',
        email_kind: 'other',
        line_type: 'mobile',
        officer_match: 'different',
        owner_cell: null,
      }),
      'needs_enrichment',
    );
  });

  it('uses email name_match + mobile as owner_cell', () => {
    assert.equal(
      computeDialStatus({
        owner_score: 'owner_likely',
        email_kind: 'name_match',
        line_type: 'mobile',
        officer_match: 'none',
        owner_cell: null,
      }),
      'owner_cell',
    );
  });

  it('promotes a verified mobile with no officer source to mobile_unverified_owner', () => {
    assert.equal(
      computeDialStatus({
        owner_score: 'owner_likely',
        email_kind: 'other',
        line_type: 'mobile',
        officer_match: null,
        owner_cell: null,
      }),
      'mobile_unverified_owner',
    );
    assert.equal(
      computeDialStatus({
        owner_score: 'owner_likely',
        email_kind: 'other',
        line_type: 'mobile',
        officer_match: 'unavailable',
        owner_cell: null,
      }),
      'mobile_unverified_owner',
    );
  });

  it('skips invalid line types', () => {
    assert.equal(
      computeDialStatus({
        owner_score: 'owner_likely',
        email_kind: 'name_match',
        line_type: 'invalid',
        officer_match: 'match',
        owner_cell: null,
      }),
      'skip',
    );
  });
});
