/**
 * Claude accounts as the usage panel tells them apart: a key for each
 * account and organization a session was signed in to, and the label Claude
 * Code itself gives it, `email (Organization)`, from what its configuration
 * named while the history was kept.
 *
 * Pure, and free of `vscode`: the report and the page both use it.
 */

import type { AccountName } from './store';
import type { SessionOwner } from './types';

/** The key of the sessions whose transcripts record no owner. */
export const NOT_RECORDED = 'none';
/** The filter that keeps every session. */
export const ALL_ACCOUNTS = 'all';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const KEY = new RegExp(`^${UUID}/(${UUID})?$`);
const ACCOUNT_ID = new RegExp(`^${UUID}$`);

/** An owner's key: its account and its organization, empty where it names none; NOT_RECORDED for none. */
export function accountKey(owner: SessionOwner | null | undefined): string {
    return owner ? `${owner.accountUuid}/${owner.organizationUuid ?? ''}` : NOT_RECORDED;
}

/** Whether `value` is a key `accountKey` could have made. */
export function isAccountKey(value: unknown): value is string {
    return value === NOT_RECORDED || (typeof value === 'string' && KEY.test(value));
}

/** Whether `value` is an account filter: every session, or one key's. */
export function isAccountFilter(value: unknown): value is string {
    return value === ALL_ACCOUNTS || isAccountKey(value);
}

/** Whether `value` is an account's own id, as the names you give accounts are keyed. */
export function isAccountId(value: unknown): value is string {
    return typeof value === 'string' && ACCOUNT_ID.test(value);
}

/**
 * An account in the history, by key: its number, and its organization's
 * among the account's, as the history gave them (see `numberAccounts`), how
 * many organizations of the account the history numbered, and when it was
 * first used. Null numbers for the sessions that record none.
 */
export interface AccountSeen {
    key: string;
    owner: SessionOwner | null;
    firstTs: number | null;
    ordinal: number | null;
    organizationOrdinal: number | null;
    organizations: number;
}

/** An account's number in the history, and its organization's among the account's. */
export interface AccountNumber {
    ordinal: number;
    organization: number;
}

/**
 * Number the owners of `unnumbered`, in the order given, which is first use,
 * after those `numbered` already: an account numbered before keeps its
 * number for an organization new to it, which takes the next one among the
 * account's own; a new account takes the next number. A number once given
 * never changes, so a label made of it stays as more accounts come, and as
 * an account's sessions go.
 *
 * @returns the numbers given, by key.
 */
export function numberAccounts(numbered: ReadonlyMap<string, AccountNumber>, unnumbered: readonly SessionOwner[]): Map<string, AccountNumber> {
    const ordinals = new Map<string, number>();
    const organizations = new Map<string, number>();
    let last = 0;
    for (const [key, n] of numbered) {
        const account = key.slice(0, key.indexOf('/'));
        ordinals.set(account, n.ordinal);
        organizations.set(account, Math.max(organizations.get(account) ?? 0, n.organization));
        last = Math.max(last, n.ordinal);
    }
    const given = new Map<string, AccountNumber>();
    for (const owner of unnumbered) {
        const key = accountKey(owner);
        if (numbered.has(key) || given.has(key)) {
            continue;
        }
        let ordinal = ordinals.get(owner.accountUuid);
        if (ordinal === undefined) {
            ordinal = ++last;
            ordinals.set(owner.accountUuid, ordinal);
        }
        const organization = (organizations.get(owner.accountUuid) ?? 0) + 1;
        organizations.set(owner.accountUuid, organization);
        given.set(key, { ordinal, organization });
    }
    return given;
}

/** How one account is shown: its label, and what tells it apart besides. */
export interface AccountLabel {
    label: string;
    /** The organization the label names in brackets, where it names one. */
    organization: string | null;
    /** The name Claude Code gives it, where you gave it another. */
    claudeName: string | null;
    /** Whether you named it, in the setting. */
    named: boolean;
}

/** Claude Code's longest label, which it cuts there. */
const MAX_LABEL = 80;

/** Control characters and line breaks, and the blank Braille cell, which draws as a space: each a space. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}\u2800]/gu;
/**
 * Format characters, bidirectional ones among them, and every other one
 * Unicode says draws nothing, assigned or not: variation selectors, fillers,
 * tags. None is shown; each could hide or reorder what a name shows, or make
 * two names that read alike differ.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * `value` as a name can be shown: no character that hides or reorders
 * others, in one normal form, so that two names that read alike are alike,
 * its spaces collapsed, cut to `max`; null when nothing is left.
 */
export function showable(value: unknown, max: number): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const shown = value.replace(INVISIBLE, '').replace(BREAKS, ' ').replace(/\s+/g, ' ').trim().normalize('NFC');
    return shown === '' ? null : [...shown].slice(0, max).join('');
}

/** The longest name you can give an account. */
export const MAX_GIVEN_NAME = 60;

/**
 * The names you gave accounts, from the setting as settings.json has it:
 * only an account id with a name that can be shown, each one cut to
 * MAX_GIVEN_NAME.
 */
export function givenNames(setting: unknown): Record<string, string> {
    const names: Record<string, string> = {};
    if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) {
        return names;
    }
    for (const [id, name] of Object.entries(setting)) {
        const shown = showable(name, MAX_GIVEN_NAME);
        if (isAccountId(id.toLowerCase()) && shown) {
            names[id.toLowerCase()] = shown;
        }
    }
    return names;
}

/**
 * Each account's label, by key.
 *
 * As Claude Code labels an account: its email, then its organization's name
 * in brackets, unless that is the one Claude Code gives a personal account,
 * `<email>'s Organization`, which names the email where nothing else does.
 * An account with no name is `Account 3`, by the number the history gave
 * it: a number stays as accounts are named, as more come, and as an
 * account's sessions go. One the history has not numbered yet, while the
 * pass that found it reads, is `Account 0f1e2d3c`, by the first digits of
 * its id. A name given in the setting, by account id, stands in place of
 * the email. An account with two organizations, one unnamed, calls that one
 * `organization 2` by its own number. Two labels that would read alike end
 * with the first digits of what tells them apart.
 */
export function accountLabels(seen: readonly AccountSeen[], names: readonly AccountName[], given: Readonly<Record<string, string>>): Map<string, AccountLabel> {
    const named = new Map(names.map(n => [accountKey(n), n]));
    const emails = emailsOf(names);
    const labels = new Map<string, AccountLabel>();
    for (const s of seen) {
        if (!s.owner) {
            labels.set(s.key, { label: 'Not recorded', organization: null, claudeName: null, named: false });
            continue;
        }
        const email = emails.get(s.owner.accountUuid) ?? null;
        const organizationName = named.get(s.key)?.organizationName ?? null;
        const personal = organizationName !== null && (organizationName === `${email}'s Organization` || PERSONAL.test(organizationName));
        const unnamed = s.organizationOrdinal !== null ? `organization ${s.organizationOrdinal}` : s.owner.organizationUuid ? `organization ${s.owner.organizationUuid.slice(0, 8)}` : 'no organization';
        const organization = organizationName !== null && !personal ? organizationName : s.organizations > 1 && organizationName === null ? unnamed : null;
        const withOrganization = (base: string) => labelOf(base, organization);
        const own = given[s.owner.accountUuid]?.trim();
        const claudeName = email !== null ? withOrganization(email) : null;
        if (own) {
            labels.set(s.key, { label: withOrganization(own), organization, claudeName, named: true });
        } else {
            const number = `Account ${s.ordinal ?? s.owner.accountUuid.slice(0, 8)}`;
            labels.set(s.key, { label: claudeName ?? withOrganization(number), organization, claudeName: null, named: false });
        }
    }
    return tellApart(labels, seen);
}

/**
 * Each account's email, wherever one of its organizations gave it, the
 * first given; else the one its personal organization's name holds.
 */
function emailsOf(names: readonly AccountName[]): Map<string, string> {
    const emails = new Map<string, string>();
    const withEmail = new Set<string>();
    for (const n of names) {
        if (n.email !== null && !withEmail.has(n.accountUuid)) {
            emails.set(n.accountUuid, n.email);
            withEmail.add(n.accountUuid);
        }
        const personal = n.email === null ? PERSONAL.exec(n.organizationName ?? '')?.[1] : undefined;
        if (personal !== undefined && !emails.has(n.accountUuid)) {
            emails.set(n.accountUuid, personal);
        }
    }
    return emails;
}

/** What a name you give an account stands in place of: its email, as its labels show it, else its number. */
export function nameReplaces(accountUuid: string, seen: readonly AccountSeen[], names: readonly AccountName[]): string {
    const email = emailsOf(names).get(accountUuid);
    const ordinal = seen.find(s => s.owner?.accountUuid === accountUuid)?.ordinal;
    return email ?? (ordinal != null ? `Account ${ordinal}` : 'its number');
}

/** The name Claude Code gives a personal account's organization, and the email in it. */
const PERSONAL = /^(.+@.+)'s Organization$/;

/** The longest an organization's name runs in a label: past it, the email goes first. */
const MAX_ORGANIZATION_IN_LABEL = 40;

/** `base (organization)`, cut to MAX_LABEL: the base cut first, so that the organization stays. */
function labelOf(base: string, organization: string | null): string {
    if (organization === null) {
        return cut(base, MAX_LABEL);
    }
    const kept = cut(organization, MAX_ORGANIZATION_IN_LABEL);
    return `${cut(base, MAX_LABEL - [...kept].length - 3)} (${kept})`;
}

/** The filter's own options, whose labels no account's may take. */
const TAKEN = ['All accounts'];

/**
 * A label as two that read alike share it: in one compatibility form, so
 * that letters drawn in another style are the letters they show, and in one
 * case. Letters of another script that look alike are not folded.
 */
function readAs(label: string): string {
    return label.normalize('NFKC').toLowerCase();
}

/**
 * Labels that would read alike, as two organizations of one name, or a name
 * you gave that is another account's email, or that is the filter's own, each
 * followed by the first digits of its account's id, and of its
 * organization's where one account is there twice; the whole ids where that
 * still leaves two alike.
 */
function tellApart(labels: Map<string, AccountLabel>, seen: readonly AccountSeen[]): Map<string, AccountLabel> {
    const owners = new Map(seen.map(s => [s.key, s.owner]));
    const byLabel = new Map<string, string[]>(TAKEN.map(label => [readAs(label), ['']]));
    for (const [key, label] of labels) {
        byLabel.set(readAs(label.label), [...(byLabel.get(readAs(label.label)) ?? []), key]);
    }
    const alike = [...byLabel.values()].filter(keys => keys.length > 1);
    const told = new Map(labels);
    const tell = (keys: string[], digits: number) => {
        const accounts = keys.map(key => owners.get(key)?.accountUuid);
        for (const key of keys) {
            const owner = owners.get(key);
            const label = labels.get(key);
            // The sessions that record none, and the filter's own, are never the ones told apart.
            if (!owner || !label) {
                continue;
            }
            const account = owner.accountUuid.slice(0, digits);
            const twice = accounts.indexOf(owner.accountUuid) !== accounts.lastIndexOf(owner.accountUuid);
            told.set(key, { ...label, label: `${label.label} · ${twice ? `${account}/${owner.organizationUuid?.slice(0, digits) ?? 'no organization'}` : account}` });
        }
    };
    for (const keys of alike) {
        tell(keys, 8);
    }
    const counts = new Map<string, number>(TAKEN.map(label => [readAs(label), 1]));
    for (const label of told.values()) {
        counts.set(readAs(label.label), (counts.get(readAs(label.label)) ?? 0) + 1);
    }
    for (const keys of alike) {
        if (keys.some(key => (counts.get(readAs(told.get(key)?.label ?? '')) ?? 0) > 1)) {
            tell(keys, 36);
        }
    }
    return told;
}

function cut(text: string, max: number): string {
    const chars = [...text];
    return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : text;
}
