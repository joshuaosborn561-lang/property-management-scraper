import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { computeDialStatus, contactLooksLikePerson, nextOfficerMatch } from './contactScore.js';
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

  it('does not treat registered-agent-only as owner identity, but keeps a verified mobile dialable', () => {
    assert.equal(
      computeDialStatus({
        owner_score: 'owner_likely',
        email_kind: 'other',
        line_type: 'mobile',
        officer_match: 'agent',
        owner_cell: null,
      }),
      'mobile_unverified_owner',
    );
  });

  it('does not demote a verified mobile when the officer is a different person', () => {
    assert.equal(
      computeDialStatus({
        owner_score: 'owner_likely',
        email_kind: 'other',
        line_type: 'mobile',
        officer_match: 'different',
        owner_cell: null,
      }),
      'mobile_unverified_owner',
    );
  });

  it('promotes a resolved officer + mobile to owner_cell (PermitStack company contact)', () => {
    assert.equal(
      computeDialStatus({
        owner_score: 'no_dm',
        email_kind: 'generic',
        line_type: 'mobile',
        officer_match: 'resolved',
        owner_cell: null,
      }),
      'owner_cell',
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

describe('contactLooksLikePerson / nextOfficerMatch', () => {
  it('treats PermitStack company contacts as not a person', () => {
    assert.equal(contactLooksLikePerson('ADERHOLD ROOFING CORPORATION', 'ADERHOLD ROOFING CORPORATION'), false);
    assert.equal(contactLooksLikePerson('CERTIFIED BUILDERS INC', 'CERTIFIED BUILDERS INC'), false);
    assert.equal(contactLooksLikePerson('John Doe', 'ADERHOLD ROOFING CORPORATION'), true);
  });

  it('reinterprets company-name different + officer_name as resolved', () => {
    assert.equal(
      nextOfficerMatch({
        officer_match: 'different',
        officer_name: 'ADERHOLD BRIAN P',
        contact_name: 'ADERHOLD ROOFING CORPORATION',
        company_name: 'ADERHOLD ROOFING CORPORATION',
        owner_score: 'no_dm',
        evidence: 'Shovels name looks like the company, not a person',
      }),
      'resolved',
    );
  });

  it('leaves a genuine person-name conflict as different', () => {
    assert.equal(
      nextOfficerMatch({
        officer_match: 'different',
        officer_name: 'JANE SMITH',
        contact_name: 'John Doe',
        company_name: 'ACME ROOFING LLC',
        owner_score: 'owner_likely',
      }),
      'different',
    );
  });

  it('does not rewrite existing match rows', () => {
    assert.equal(
      nextOfficerMatch({
        officer_match: 'match',
        officer_name: 'SANJAY CHANDRANAS',
        contact_name: 'SANJAY CHANDRAHAS',
        company_name: 'TOM PLUMBER INC',
        owner_score: 'owner_likely',
      }),
      'match',
    );
  });
});
