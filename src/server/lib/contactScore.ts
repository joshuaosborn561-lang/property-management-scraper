const GENERIC_EMAIL = /^(info|office|admin|contact|sales|estimating|estimator|bids?|support|hello|mail|service|services|customerservice|csr|dispatch|ops|operations|frontdesk|reception|accounting|ap|ar|hr|jobs|careers|webmaster|noreply|no-?reply|permits?|licensing)$/i;

const COMPANY_IN_NAME =
  /\b(LLC|INC|LP|LLP|CO|COMPANY|CORP|CONSTRUCTION|HOMES|ROOFING|SERVICES|GROUP|HOLDINGS)\b/i;

export type OwnerScore = 'owner_likely' | 'office_likely' | 'no_dm' | 'skip';
export type DialStatus =
  | 'owner_cell'
  | 'owner_landline'
  | 'company_line'
  | 'mobile_unverified_owner'
  | 'needs_enrichment'
  | 'skip';

export interface ScoreInput {
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  city?: string;
  phone_share_count?: number;
}

export interface ContactScore {
  owner_score: OwnerScore;
  flags: string[];
  email_kind: 'none' | 'generic' | 'name_match' | 'other';
  personish_name: boolean;
  evidence: string;
}

function digits(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

function emailLocal(email: string): string {
  const t = email.trim().toLowerCase();
  if (!t.includes('@')) return '';
  return t.split('@', 1)[0] || '';
}

/** True when contact_name is a person, not the company copied into the name field. */
export function contactLooksLikePerson(contactName: string, companyName = ''): boolean {
  const contact = (contactName || '').trim();
  const company = (companyName || '').trim();
  return (
    Boolean(contact) &&
    contact.split(/\s+/).length >= 2 &&
    !COMPANY_IN_NAME.test(contact) &&
    contact.toUpperCase() !== company.toUpperCase()
  );
}

function firstToken(name: string): string {
  const n = name.replace(/[^A-Za-z ]/g, ' ').trim();
  return (n.split(/\s+/)[0] || '').toLowerCase();
}

function lastToken(name: string): string {
  const parts = name.replace(/[^A-Za-z ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  return (parts[parts.length - 1] || '').toLowerCase();
}

export function scoreContact(input: ScoreInput): ContactScore {
  const flags: string[] = [];
  const phone = digits(input.phone);
  const contact = (input.contact_name || '').trim();
  const company = (input.company_name || '').trim();
  const local = emailLocal(input.email);
  const personish = contactLooksLikePerson(contact, company);

  if (!phone) {
    return {
      owner_score: 'skip',
      flags: ['no_phone'],
      email_kind: local ? 'other' : 'none',
      personish_name: personish,
      evidence: 'No phone on the Shovels row',
    };
  }

  let emailKind: ContactScore['email_kind'] = 'none';
  if (!local) emailKind = 'none';
  else if (GENERIC_EMAIL.test(local) || /^(info|office|admin|service|permits)/i.test(local)) {
    emailKind = 'generic';
    flags.push('generic_email');
  } else {
    const first = firstToken(contact);
    const last = lastToken(contact);
    if (first && (local.includes(first) || (first.length >= 4 && local.startsWith(first.slice(0, 4))))) {
      emailKind = 'name_match';
      flags.push('email_matches_first_name');
    } else if (last && last.length >= 4 && local.includes(last)) {
      emailKind = 'name_match';
      flags.push('email_matches_last_name');
    } else {
      emailKind = 'other';
    }
  }

  if (!personish) {
    flags.push('name_is_company_or_thin');
    return {
      owner_score: 'no_dm',
      flags,
      email_kind: emailKind,
      personish_name: false,
      evidence: 'Shovels name looks like the company, not a person',
    };
  }

  if ((input.phone_share_count ?? 1) >= 2) flags.push('shared_phone');
  if (emailKind === 'generic' || (input.phone_share_count ?? 1) >= 3) {
    return {
      owner_score: 'office_likely',
      flags,
      email_kind: emailKind,
      personish_name: true,
      evidence: flags.includes('generic_email')
        ? 'Role email (info/service/permits) — treat as company line'
        : 'Phone is shared across companies — likely office',
    };
  }

  if (emailKind === 'name_match') {
    flags.push('owner_likely');
    return {
      owner_score: 'owner_likely',
      flags,
      email_kind: emailKind,
      personish_name: true,
      evidence: 'Person name plus first/last name in the email',
    };
  }

  flags.push('needs_owner_confirm');
  return {
    owner_score: 'owner_likely',
    flags,
    email_kind: emailKind,
    personish_name: true,
    evidence: 'Person name on file but not proven as legal owner yet',
  };
}

export type OfficerMatch = 'match' | 'resolved' | 'different' | 'none' | 'agent' | 'error';

/** Company-name contacts that already have a human officer were stamped `different`. Reinterpret as `resolved`. */
export function nextOfficerMatch(opts: {
  officer_match: string | null | undefined;
  officer_name?: string | null;
  contact_name?: string | null;
  company_name?: string | null;
  owner_score?: string | null;
  evidence?: string | null;
}): string | null {
  const current = opts.officer_match ?? null;
  const companyContact =
    opts.owner_score === 'no_dm' ||
    /looks like the company, not a person/i.test(opts.evidence || '') ||
    !contactLooksLikePerson(opts.contact_name || '', opts.company_name || '');
  if (current === 'different' && opts.officer_name && companyContact) {
    return 'resolved';
  }
  return current;
}

const DIALABLE = new Set(['owner_cell', 'mobile_unverified_owner']);

export function isDialableStatus(status: string | null | undefined): boolean {
  return DIALABLE.has(String(status || ''));
}

export function computeDialStatus(opts: {
  owner_score: OwnerScore | string;
  email_kind?: string | null;
  line_type: string | null;
  officer_match: string | null;
  owner_cell: string | null;
}): DialStatus {
  if (opts.owner_cell) return 'owner_cell';
  if (opts.owner_score === 'skip' || opts.line_type === 'invalid') return 'skip';
  const mobile = opts.line_type === 'mobile';
  const landline = opts.line_type === 'landline' || opts.line_type === 'voip';
  // match = contact person equals officer. resolved = contact was the company; registry named the human.
  const identity =
    opts.officer_match === 'match' ||
    opts.officer_match === 'resolved' ||
    opts.email_kind === 'name_match';
  if (mobile && identity) return 'owner_cell';
  if (landline && identity) return 'owner_landline';
  // Verified mobile stays dialable. agent/different must not demote to needs_enrichment.
  if (mobile) return 'mobile_unverified_owner';
  if (opts.owner_score === 'office_likely' || opts.line_type === 'toll_free') return 'company_line';
  return 'needs_enrichment';
}
