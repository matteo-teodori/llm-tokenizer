/**
 * Constants and configuration values for LLM Tokenizer extension
 */

/** Storage key for persisting selected model */
export const STORAGE_KEY = 'llm-tokenizer.selectedModel';

/** Debounce delay for status bar updates (ms) */
export const DEBOUNCE_DELAY_MS = 300;

/** Debounce delay for project-wide token count updates (ms) */
export const PROJECT_UPDATE_DELAY_MS = 2000;

/** Context limit warning threshold (percentage) */
export const CONTEXT_WARNING_THRESHOLD = 80;

/** Context limit error threshold (percentage) */
export const CONTEXT_ERROR_THRESHOLD = 100;

/** 
 * Binary file extensions to skip during token counting
 * These files cannot be meaningfully tokenized
 */
export const BINARY_EXTENSIONS = new Set([
    // Images
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.tiff',
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
