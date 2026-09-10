import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  namesLooselyMatch,
  levenshtein,
  pickOwnerOfficer,
  pickBestEntity,
  rankFranchiseHits,
  looksLikePersonName,
  cpaErrorText,
  isNonFranchiseTaxpayerMessage,
  TexasCpaError,
  type ComptrollerEntity,
} from './texasComptroller.js';

describe('levenshtein', () => {
  it('counts a one-character last-name typo', () => {
    assert.equal(levenshtein('CHANDRAHAS', 'CHANDRANAS'), 1);
  });
});

describe('namesLooselyMatch', () => {
  it('treats CHANDRAHAS vs CHANDRANAS as the same person', () => {
    assert.equal(namesLooselyMatch('SANJAY CHANDRAHAS', 'SANJAY CHANDRANAS'), true);
  });

  it('still matches first-initial + last name', () => {
    assert.equal(namesLooselyMatch('Sanjay K Chandrahas', 'S Chandrahas'), true);
  });

  it('does not match unrelated last names', () => {
    assert.equal(namesLooselyMatch('SANJAY CHANDRAHAS', 'SANJAY PATEL'), false);
  });
});

describe('pickOwnerOfficer', () => {
  const entity: ComptrollerEntity = {
    taxpayer_id: '1',
    name: 'TOM PLUMBER INC',
    dba: null,
    sos_file_number: null,
    right_to_transact: null,
    registered_agent: 'CT CORPORATION SYSTEM',
    officers: [
      {
        name: 'SANJAY CHANDRANAS',
        title: 'PRESIDENT',
        year: '2024',
        street: null,
        city: 'HOUSTON',
        state: 'TX',
        zip: null,
        source: 'PIR',
        is_registered_agent: false,
      },
    ],
  };

  it('fuzzy-matches Shovels contact to Comptroller officer', () => {
    const picked = pickOwnerOfficer('SANJAY CHANDRAHAS', entity);
    assert.equal(picked.match, 'match');
    assert.equal(picked.officer?.name, 'SANJAY CHANDRANAS');
  });

  it('resolves a PermitStack company contact to the officer instead of different', () => {
    const picked = pickOwnerOfficer('TOM PLUMBER INC', entity, 'TOM PLUMBER INC');
    assert.equal(picked.match, 'resolved');
    assert.equal(picked.officer?.name, 'SANJAY CHANDRANAS');
  });

  it('keeps different when a person contact conflicts with the officer', () => {
    const picked = pickOwnerOfficer('JANE SMITH', entity, 'TOM PLUMBER INC');
    assert.equal(picked.match, 'different');
    assert.equal(picked.officer?.name, 'SANJAY CHANDRANAS');
  });
});

describe('TexasCpaError', () => {
  it('marks 400 as permanent and 429 as retryable', () => {
    assert.equal(new TexasCpaError('detail', 400, 'Texas CPA detail 400: Bad Request').permanent, true);
    assert.equal(new TexasCpaError('detail', 429, 'Texas CPA detail 429').permanent, false);
    assert.equal(new TexasCpaError('detail', 500, 'Texas CPA detail 500').permanent, false);
  });

  it('classifies franchise-tax 400s from the Comptroller error field', () => {
    const text = cpaErrorText(
      { success: false, error: 'Taxpayer Number 12643018745 is not set up for Franchise Tax' },
      'Bad Request',
    );
    assert.equal(text, 'Taxpayer Number 12643018745 is not set up for Franchise Tax');
    assert.equal(isNonFranchiseTaxpayerMessage(text), true);
    assert.equal(
      new TexasCpaError('detail', 400, `Texas CPA detail 400: ${text}`).notFranchiseTax,
      true,
    );
    assert.equal(new TexasCpaError('detail', 400, 'Texas CPA detail 400: Bad Request').notFranchiseTax, false);
  });
});

describe('person-style CPA entity pick', () => {
  const abelHits = [
    { taxpayerId: '12643018745', name: 'ABEL GARCIA AND DANIEL LONGORIA' },
    { taxpayerId: '32037985085', name: 'ABEL GARCIA [RAOULSITALIANGRILL@SBCGLOBAL.NET]' },
    { taxpayerId: '32087001890', name: 'ABEL GARCIA TRUCKING LLC' },
  ];

  it('treats two-word personal names as person-style', () => {
    assert.equal(looksLikePersonName('ABEL GARCIA'), true);
    assert.equal(looksLikePersonName('ALEJANDRO MARTINEZ'), true);
    assert.equal(looksLikePersonName('ABEL GARCIA TRUCKING LLC'), false);
    assert.equal(looksLikePersonName('TOM PLUMBER INC'), false);
  });

  it('does not pick a partnership or LLC substring for a person-style company name', () => {
    const ranked = rankFranchiseHits('ABEL GARCIA', abelHits);
    assert.deepEqual(
      ranked.map((h) => h.taxpayerId),
      ['32037985085'],
    );
    assert.equal(pickBestEntity('ABEL GARCIA', abelHits)?.taxpayerId, '32037985085');
  });

  it('prefers an exact person-name taxpayer over AND-partnerships and similarly named LLCs', () => {
    const hits = [
      { taxpayerId: '1', name: 'ALEJANDRO MARTINEZ & ALFREDO AGUILAR' },
      { taxpayerId: '2', name: 'ALEJANDRO MARTINEZ TRUCKING LLC' },
      { taxpayerId: '3', name: 'ALEJANDRO MARTINEZ' },
      { taxpayerId: '4', name: 'ALEJANDRO MARTINEZ AND OSCAR SERNA' },
    ];
    const best = pickBestEntity('ALEJANDRO MARTINEZ', hits);
    assert.equal(best?.taxpayerId, '3');
    assert.deepEqual(
      rankFranchiseHits('ALEJANDRO MARTINEZ', hits).map((h) => h.taxpayerId),
      ['3'],
    );
  });

  it('still substring-matches trade names that are not person-style', () => {
    const hits = [
      { taxpayerId: '9', name: 'TOM PLUMBER INC AND SONS' },
      { taxpayerId: '8', name: 'UNRELATED ROOFING LLC' },
    ];
    assert.equal(pickBestEntity('TOM PLUMBER INC', hits)?.taxpayerId, '9');
  });
});
