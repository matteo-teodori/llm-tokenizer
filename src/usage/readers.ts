/**
 * The agents whose session records the usage panel reads: each by a reader
 * of its own, over the line engine they share (lines.ts), into the one
 * history. A reader finds its agent's files under a root, reads one from its
 * checkpoint into rows of the common shape, and says what more of a file the
 * importer keeps with them.
 *
 * Nothing here imports `vscode`.
 */

import type { MalformedCategory, ReadCheckpoint, Restart } from './lines';
import { ROWS_SINCE, needsOwnerScan, readTranscript, transcriptsAt, walkProjects, type TranscriptFile } from './transcripts';
import type { Compaction, LimitHit, OwnerChange, SessionOwner, UsageProvider, UsageRequest } from './types';

/** What reading a file found since its checkpoint. */
export interface ReadResult {
    /** Not read at all: size and mtime are as the checkpoint left them. */
    unchanged: boolean;
    /**
     * Read from the start rather than the checkpoint, and why. `parser` only
     * for a file that still holds every line the checkpoint read: one that
     * has also changed says how.
     */
    restarted: Restart;
    requests: UsageRequest[];
    compactions: Compaction[];
    limitHits: LimitHit[];
    /** The first cwd of a main transcript, when this read reached it, and its record's time. */
    firstCwd: string | null;
    firstCwdTs: number | null;
    /** The session id the records gave, for files whose path does not. */
    sessionId: string | null;
    /**
     * Each session's owner changing, in the order of the transcript: an
     * owner record that names another account than the one before it, the
     * same one written again with the session's metadata left out. Only in a
     * file that records its sessions' owners (see `recordsOwners`), and each
     * request read is stamped with the owner then.
     */
    ownerChanges: OwnerChange[];
    /**
     * Each session's first request in this read, by its time, where it
     * comes before any change of the session's owner in this read: what
     * gives the change an earlier read left at the file's end its time. A
     * change read first instead leaves that one with none, as one no
     * request was ever made under.
     */
    firstRequestTs: Map<string, number>;
    /** The newest version of the agent that wrote the lines read. */
    newestVersion: string | null;
    /** Claude Code's placeholders for requests that never reached a model, and its API errors: counted, not kept. */
    synthetic: number;
    apiErrors: number;
    oversize: number;
    malformed: Map<MalformedCategory, number>;
    checkpoint: ReadCheckpoint;
}

/** What a walk of one root found. */
export interface RootWalk {
    /**
     * The real path of the folder the agent keeps its records in under the
     * root, Claude Code's `projects`, or null when there is none.
     */
    folder: string | null;
    files: TranscriptFile[];
    symlinkedFolders: number;
    unreadableFolders: number;
    /** Files of the agent's passed over as holding no usage: Claude Code's journals. */
    passedOver: number;
}

/** One agent's reader. */
export interface AgentReader {
    provider: UsageProvider;
    /** Every file of the agent's under `root`, found by hand: never through a symlinked folder. */
    walk(root: string): RootWalk;
    /** Those of `paths` that are the agent's files under `root`, as the walk would find them: a watcher's hints. */
    filesAt(root: string, paths: readonly string[]): TranscriptFile[];
    /**
     * Read `file` on from `previous`, its checkpoint, or from its start when
     * that cannot be trusted. `inForce`: where the file records its
     * sessions' owners, each one's owner where its last read ended.
     *
     * @throws the file system's error, for the importer to count as a skip reason.
     */
    read(file: TranscriptFile, previous: ReadCheckpoint | undefined, progress?: () => void, inForce?: ReadonlyMap<string, SessionOwner>): ReadResult;
    /** Whether a read of `file` on from `previous` takes the whole file: what the read guard reckons it costs. */
    readsWhole(file: TranscriptFile, previous: ReadCheckpoint): boolean;
    /** Whether `file` records its sessions' owners: its changes of owner are kept with its rows. */
    recordsOwners(file: TranscriptFile): boolean;
    /**
     * Whether a read of `file` on from `previous` searches the bytes before
     * the checkpoint for owners too: the rows an older parser read from them
     * are then given theirs.
     */
    searchesOwners(file: TranscriptFile, previous: ReadCheckpoint): boolean;
}

/** Claude Code's: `<root>/projects`, read by transcripts.ts. */
export const CLAUDE_CODE_READER: AgentReader = {
    provider: 'claude-code',
    walk(root) {
        const walk = walkProjects(root);
        return {
            folder: walk.projects,
            files: walk.files,
            symlinkedFolders: walk.symlinkedFolders,
            unreadableFolders: walk.unreadableFolders,
            passedOver: walk.journals,
        };
    },
    filesAt: transcriptsAt,
    read: readTranscript,
    readsWhole: (file, previous) => previous.parserVersion < ROWS_SINCE || needsOwnerScan(file, previous),
    recordsOwners: file => file.kind === 'main',
    searchesOwners: needsOwnerScan,
};

const READERS: Partial<Record<UsageProvider, AgentReader>> = {
    'claude-code': CLAUDE_CODE_READER,
};

/** The reader of `provider`'s records, or undefined for an agent none reads yet. */
export function readerOf(provider: UsageProvider): AgentReader | undefined {
    return READERS[provider];
}
