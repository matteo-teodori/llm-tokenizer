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

/** An account in the history: its number, once the history gave it one, and when it was first used. */
export interface AccountSeen {
    key: string;
    owner: SessionOwner | null;
    firstTs: number | null;
    ordinal?: number | null;
}

/** How one account is shown: its label, and what tells it apart besides. */
export interface AccountLabel {
    label: string;
    /** The name Claude Code gives it, where you gave it another. */
    claudeName: string | null;
    /** Whether you named it, in the setting. */
    named: boolean;
}

/** Claude Code's longest label, which it cuts there. */
const MAX_LABEL = 80;

/** Control and format characters, bidirectional and invisible ones among them, and line breaks: none can hide or reorder what a name shows. */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** `value` as a name can be shown: no character that hides or reorders others, its spaces collapsed, cut to `max`; null when nothing is left. */
export function showable(value: unknown, max: number): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const shown = value.replace(UNSHOWABLE, ' ').replace(/\s+/g, ' ').trim();
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
 * it, and those not numbered yet by first use after them: a number stays as
 * accounts are named, as more come, and as an older session is resumed
 * under a newer account. A name given in the setting, by account id, stands
 * in place of the email. An account with two organizations, one unnamed,
 * calls that one `organization 2` by the same order. Two labels that would
 * read alike end with the first digits of what tells them apart.
 */
export function accountLabels(seen: readonly AccountSeen[], names: readonly AccountName[], given: Readonly<Record<string, string>>): Map<string, AccountLabel> {
    const named = new Map(names.map(n => [accountKey(n), n]));
    // An account's email, wherever one of its organizations gave it, the
    // first given; else the one its personal organization's name holds.
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
    const order = (a: AccountSeen, b: AccountSeen) =>
        (a.ordinal ?? Infinity) - (b.ordinal ?? Infinity) || (a.firstTs ?? Infinity) - (b.firstTs ?? Infinity) || compareText(a.key, b.key);
    // An account comes where the first of its organizations does.
    const ordered = [...seen].sort(order);
    const accountNumbers = new Map<string, number>();
    const organizationNumbers = new Map<string, number>();
    const organizations = new Map<string, number>();
    for (const s of ordered) {
        if (!s.owner) {
            continue;
        }
        if (!accountNumbers.has(s.owner.accountUuid)) {
            accountNumbers.set(s.owner.accountUuid, accountNumbers.size + 1);
        }
        const count = (organizations.get(s.owner.accountUuid) ?? 0) + 1;
        organizations.set(s.owner.accountUuid, count);
        organizationNumbers.set(s.key, count);
    }

    const labels = new Map<string, AccountLabel>();
    for (const s of ordered) {
        if (!s.owner) {
            labels.set(s.key, { label: 'Not recorded', claudeName: null, named: false });
            continue;
        }
        const email = emails.get(s.owner.accountUuid) ?? null;
        const organizationName = named.get(s.key)?.organizationName ?? null;
        const several = (organizations.get(s.owner.accountUuid) ?? 0) > 1;
        const personal = organizationName !== null && (organizationName === `${email}'s Organization` || PERSONAL.test(organizationName));
        const organization =
            organizationName !== null && !personal
                ? organizationName
                : several && organizationName === null
                  ? `organization ${organizationNumbers.get(s.key)}`
                  : null;
        const withOrganization = (base: string) => labelOf(base, organization);
        const own = given[s.owner.accountUuid]?.trim();
        const claudeName = email !== null ? withOrganization(email) : null;
        if (own) {
            labels.set(s.key, { label: withOrganization(own), claudeName, named: true });
        } else {
            labels.set(s.key, { label: claudeName ?? withOrganization(`Account ${accountNumbers.get(s.owner.accountUuid)}`), claudeName: null, named: false });
        }
    }
    return tellApart(labels, seen);
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

/**
 * Labels that would read alike, as two organizations of one name, or a name
 * you gave that is another account's email, each followed by the first
 * digits of its account's id, or of its organization's where the account is
 * the same.
 */
function tellApart(labels: Map<string, AccountLabel>, seen: readonly AccountSeen[]): Map<string, AccountLabel> {
    const owners = new Map(seen.map(s => [s.key, s.owner]));
    const byLabel = new Map<string, string[]>();
    for (const [key, label] of labels) {
        byLabel.set(label.label, [...(byLabel.get(label.label) ?? []), key]);
    }
    for (const keys of byLabel.values()) {
        const alike = keys.filter(key => owners.get(key));
        if (alike.length < 2 && keys.length < 2) {
            continue;
        }
        const accounts = new Set(alike.map(key => owners.get(key)?.accountUuid));
        for (const key of alike) {
            const owner = owners.get(key);
            const label = labels.get(key);
            if (!owner || !label) {
                continue;
            }
            const tell = accounts.size === alike.length ? owner.accountUuid : (owner.organizationUuid ?? 'no organization');
            labels.set(key, { ...label, label: `${label.label} · ${tell.slice(0, 8)}` });
        }
    }
    return labels;
}

function cut(text: string, max: number): string {
    const chars = [...text];
    return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : text;
}

function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
