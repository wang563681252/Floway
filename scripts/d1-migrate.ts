// Remote D1 migration runner.
//
// This replaces `wrangler d1 migrations apply --remote`, which cannot apply
// any migration that contains a compound statement (`CREATE TRIGGER ... BEGIN
// ... END;`). The reason is in wrangler's own `executeRemotely`: when it is
// handed a `--command` string it posts the SQL verbatim to the D1 `/query`
// API, and that endpoint splits statements on `;` without tracking BEGIN/END
// nesting. A trigger body is therefore severed at its first inner `;` and D1
// rejects the fragment with `incomplete input: SQLITE_ERROR [code: 7500]`.
// `migrations apply` builds exactly such a `--command` (migration file text +
// the ledger INSERT), so every trigger-bearing migration is unapplicable that
// way. Migration 0025 is the first one that trips it, which is why remote
// could not advance past 0024 while local sat at 0067.
//
// The `--file` path does not have this problem: wrangler uploads the file and
// D1 ingests it server-side as a unit, parsing it with a real SQL parser. That
// path is also atomic — a failed import leaves the database untouched — so
// appending the ledger INSERT to the migration text keeps "migration applied"
// and "migration recorded" in the same all-or-nothing operation, which is the
// property `migrations apply` was relying on the batch for.
//
// Local stays on `wrangler d1 migrations apply`, which is unaffected: it
// splits client-side via wrangler's own BEGIN/END-aware `splitSqlQuery`.
//
// Reading `wrangler.jsonc` here also removes the POSIX `$(node -p ...)`
// substitution the npm scripts used to carry, which silently produced a
// literal `$(...)` argument on Windows/cmd.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'jsonc-parser';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = resolve(ROOT, 'node_modules/wrangler/bin/wrangler.js');
const MIGRATIONS_TABLE = 'd1_migrations';

const remote = process.argv.includes('--remote');

interface D1Binding {
  database_name?: string;
  migrations_dir?: string;
}

const config = parse(readFileSync(resolve(ROOT, 'wrangler.jsonc'), 'utf8')) as {
  d1_databases?: D1Binding[];
};

const binding = config.d1_databases?.[0];
if (!binding?.database_name) {
  console.error('wrangler.jsonc: d1_databases[0].database_name is missing');
  process.exit(1);
}
const dbName = binding.database_name;
const migrationsDir = resolve(ROOT, binding.migrations_dir ?? 'migrations');

// `CI=1` keeps wrangler non-interactive: the `--file` path otherwise prompts
// to confirm that the database may be briefly unavailable.
const runWrangler = (args: string[]): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    env: { ...process.env, CI: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

if (!remote) {
  const result = spawnSync(process.execPath, [WRANGLER, 'd1', 'migrations', 'apply', dbName], {
    cwd: ROOT,
    env: { ...process.env, CI: '1' },
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

// wrangler prints a banner before the JSON payload, so start at the first
// top-level `[`.
const parseJsonOutput = (stdout: string): unknown => {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`could not find JSON in wrangler output:\n${stdout}`);
  }
  return JSON.parse(stdout.slice(start, end + 1));
};

const execRemote = (args: string[], what: string): { stdout: string } => {
  const result = runWrangler(['d1', 'execute', dbName, '--remote', ...args]);
  if (result.status !== 0) {
    console.error(`${what} failed:\n${result.stderr || result.stdout}`);
    process.exit(1);
  }
  return { stdout: result.stdout };
};

// Matches the ledger wrangler creates, so a database migrated either way stays
// interchangeable.
execRemote(
  [
    '--json',
    '--command',
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE}(
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`,
  ],
  'creating the migrations table',
);

const appliedOut = execRemote(
  ['--json', '--command', `SELECT name FROM ${MIGRATIONS_TABLE};`],
  'reading applied migrations',
);

const appliedPayload = parseJsonOutput(appliedOut.stdout) as Array<{
  results?: Array<{ name?: string }>;
}>;
const applied = new Set(
  appliedPayload.flatMap(entry => entry.results ?? []).flatMap(row => (row.name ? [row.name] : [])),
);

const pending = readdirSync(migrationsDir)
  .filter(name => name.endsWith('.sql'))
  .sort()
  .filter(name => !applied.has(name));

if (pending.length === 0) {
  console.log('No migrations to apply!');
  process.exit(0);
}

console.log(`Applying ${pending.length} migration(s) to ${dbName} (remote):`);

const scratch = mkdtempSync(join(tmpdir(), 'floway-d1-'));
try {
  for (const name of pending) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    // Single quotes are the only character that could break out of the
    // string literal; migration filenames never contain one, but doubling
    // it keeps the statement well-formed regardless.
    const ledgerName = name.replaceAll("'", "''");
    const bundle = `${sql}\nINSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ('${ledgerName}');\n`;
    const bundlePath = join(scratch, name);
    writeFileSync(bundlePath, bundle, 'utf8');

    const result = runWrangler(['d1', 'execute', dbName, '--remote', '--file', bundlePath]);
    if (result.status !== 0) {
      console.error(`  ${name} FAILED`);
      console.error(result.stderr || result.stdout);
      process.exit(1);
    }
    console.log(`  ${name} OK`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`Applied ${pending.length} migration(s).`);
