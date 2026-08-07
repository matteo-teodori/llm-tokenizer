/**
 * Extension → language name, for the summary's language breakdown.
 *
 * Only needs to cover what actually turns up in a repository being counted for
 * an LLM context. Anything unlisted falls back to showing the extension, which
 * is honest and needs no maintenance.
 */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
    // Web
    ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
    html: 'HTML', htm: 'HTML',
    css: 'CSS', scss: 'SCSS', sass: 'Sass', less: 'Less',

    // Systems
    rs: 'Rust', go: 'Go', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++',
    hpp: 'C++', hh: 'C++', zig: 'Zig',

    // JVM / .NET
    java: 'Java', kt: 'Kotlin', kts: 'Kotlin', scala: 'Scala', groovy: 'Groovy',
    cs: 'C#', fs: 'F#', vb: 'Visual Basic',

    // Scripting
    py: 'Python', pyi: 'Python', rb: 'Ruby', php: 'PHP', pl: 'Perl',
    lua: 'Lua', r: 'R', jl: 'Julia', dart: 'Dart', swift: 'Swift',
    ex: 'Elixir', exs: 'Elixir', erl: 'Erlang', clj: 'Clojure', hs: 'Haskell',
    ml: 'OCaml', nim: 'Nim', cr: 'Crystal',

    // Shell & config
    sh: 'Shell', bash: 'Shell', zsh: 'Shell', fish: 'Shell',
    ps1: 'PowerShell', bat: 'Batch', cmd: 'Batch',
    json: 'JSON', jsonc: 'JSON', json5: 'JSON',
    yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', cfg: 'INI',
    env: 'Env', properties: 'Properties',

    // Data & query
    sql: 'SQL', graphql: 'GraphQL', gql: 'GraphQL', proto: 'Protobuf',
    csv: 'CSV', tsv: 'TSV', xml: 'XML', jsonl: 'JSONL', ndjson: 'JSONL',

    // Docs
    md: 'Markdown', mdx: 'MDX', markdown: 'Markdown',
    rst: 'reStructuredText', adoc: 'AsciiDoc', txt: 'Plain text', tex: 'LaTeX',

    // Infrastructure
    tf: 'Terraform', tfvars: 'Terraform', hcl: 'HCL',
    dockerfile: 'Dockerfile', nix: 'Nix', gradle: 'Gradle', cmake: 'CMake',
    make: 'Makefile', mk: 'Makefile',

    // Notebooks & templates
    ipynb: 'Jupyter', j2: 'Jinja', jinja: 'Jinja', hbs: 'Handlebars',
    ejs: 'EJS', pug: 'Pug', liquid: 'Liquid', twig: 'Twig', erb: 'ERB',
});
