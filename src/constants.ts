/**
 * Constants and configuration values for LLM Tokenizer extension
 */

/** Storage key for persisting selected model */
export const STORAGE_KEY = 'llm-tokenizer.selectedModel';

/** Debounce delay for status bar updates (ms) */
export const DEBOUNCE_DELAY_MS = 300;

/** Debounce delay for project-wide token count updates (ms) */
export const PROJECT_UPDATE_DELAY_MS = 2000;

/**
 * Longest a project scan may be deferred while changes keep arriving (ms).
 *
 * The debounce above restarts on every change, which is right for a burst — an
 * agent rewriting twenty files — but wrong for a workspace that never goes
 * quiet for two seconds. Without a ceiling the total simply stopped updating.
 */
export const PROJECT_SCAN_MAX_DELAY_MS = 10_000;

/** Context limit warning threshold (percentage) */
export const CONTEXT_WARNING_THRESHOLD = 80;

/** Context limit error threshold (percentage) */
export const CONTEXT_ERROR_THRESHOLD = 100;

/**
 * Largest file we will tokenize.
 *
 * Cost per input byte depends on the backend: measured at ~5 bytes of heap for
 * a tiktoken rank table, and ~90 for the Hugging Face one, where a 30 MB input
 * took 8.5 seconds and peaked at 3.3 GB of RSS. Files above this are reported
 * as skipped rather than counted, and text that reaches the tokenizer by
 * another route is estimated rather than tokenized (see TokenizerService.count).
 */
export const MAX_TOKENIZED_FILE_BYTES = 10 * 1024 * 1024;

/** 
 * Binary file extensions to skip during token counting
 * These files cannot be meaningfully tokenized
 */
export const BINARY_EXTENSIONS = new Set([
    // Images. `.svg` is deliberately absent: it is XML text, it tokenizes fine,
    // and it is one of the more common things to paste into a context window.
    // Grouping it with the raster formats meant every SVG was excluded from
    // every total and reported to the user as an unsupported binary file.
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff',
    // Archives
    '.zip', '.tar', '.gz', '.7z', '.rar', '.bz2', '.xz',
    // Executables
    '.exe', '.dll', '.so', '.dylib', '.bin', '.msi', '.app',
    // Documents
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
    // Media
    '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.flac', '.ogg', '.webm',
    // Databases
    '.db', '.sqlite', '.sqlite3', '.sqlitedb',
    // Fonts
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    // Lock files and compiled
    '.lock', '.pyc', '.pyo', '.class', '.o', '.obj'
]);

/**
 * Directories to skip during recursive token counting
 */
export const IGNORED_DIRECTORIES = new Set([
    'node_modules',
    'dist',
    'out',
    'build',
    '__pycache__',
    '.git',
    '.svn',
    '.hg',
    'vendor',
    'coverage',
    '.nyc_output',
    '.next',
    '.nuxt',
    'target'
]);
