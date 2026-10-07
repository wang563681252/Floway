import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterAll, expect, test } from 'vitest';
import { z } from 'zod';

import { SETUP_POWERSHELL_CODEX, SETUP_POWERSHELL_COMMON } from '../../../src/script-assets.generated.ts';

const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const shellProbe = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
  encoding: 'utf8',
  timeout: 30_000,
});
const shellAbsent = shellProbe.error !== undefined
  && 'code' in shellProbe.error
  && shellProbe.error.code === 'ENOENT';
if (!shellAbsent && (shellProbe.error || shellProbe.status !== 0)) {
  throw new Error(`PowerShell preflight failed: ${shellProbe.stderr}`, { cause: shellProbe.error });
}

const authSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
}).strict();
type AuthCommand = z.infer<typeof authSchema>;

const root = mkdtempSync(join(tmpdir(), 'floway-codex-auth.'));
const token = 'sk-floway-auth-test-canary';
const customHome = join(root, "home spaces ' !%&() \u96ea");
mkdirSync(customHome);
writeFileSync(join(customHome, 'floway-token'), token);
const defaultProfile = join(root, 'default-profile');
const defaultHome = join(defaultProfile, '.codex');
mkdirSync(defaultHome, { recursive: true });
writeFileSync(join(defaultHome, 'floway-token'), 'sk-floway-auth-default-test-canary');
const installerPath = join(root, 'codex-installer.ps1');
writeFileSync(installerPath, `${SETUP_POWERSHELL_COMMON}\n${SETUP_POWERSHELL_CODEX}`);
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const runPowerShell = (source: string): string => {
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', source], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Codex auth verification failed: ${result.stderr}`, { cause: result.error });
  }
  return result.stdout;
};
const authFor = (windows: boolean, nodeExe: string): AuthCommand => {
  const start = SETUP_POWERSHELL_CODEX.indexOf('function Get-SetupCodexAuth {');
  const end = SETUP_POWERSHELL_CODEX.indexOf('# Build the base-config edit batch', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const source = `${SETUP_POWERSHELL_CODEX.slice(start, end)}
$auth = Get-SetupCodexAuth -RunningOnWindows $${windows ? 'true' : 'false'} -NodeExe ${literal(nodeExe)}
$auth | ConvertTo-Json -Depth 4 -Compress`;
  return authSchema.parse(JSON.parse(runPowerShell(source)));
};

const readToken = (auth: AuthCommand, home: string | undefined) => new Promise<{
  stdout: string;
  stderr: string;
  elapsedMs: number;
}>((resolve, reject) => {
  const started = performance.now();
  execFile(auth.command, auth.args, {
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: home, HOME: defaultProfile, USERPROFILE: defaultProfile },
    timeout: 5_000,
  }, (error, stdout, stderr) => {
    if (error) {
      reject(error);
      return;
    }
    resolve({ stdout, stderr, elapsedMs: performance.now() - started });
  });
});

test.skipIf(shellAbsent)('the served Codex PowerShell installer parses with the host interpreter', () => {
  runPowerShell(`$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile(${literal(installerPath)}, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count -gt 0) {
  foreach ($error in $errors) { [Console]::Error.WriteLine($error.Message) }
  exit 1
}`);
});

test.skipIf(shellAbsent)('the Windows config writer wires the discovered Node credential helper into the app-server batch', async () => {
  const start = SETUP_POWERSHELL_CODEX.indexOf('function Get-SetupCodexAuth {');
  const end = SETUP_POWERSHELL_CODEX.indexOf('# Store the selected API key', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const source = `${SETUP_POWERSHELL_CODEX.slice(start, end)}
function Test-SetupIsWindows { return $true }
function Get-SetupTimeoutSeconds { param([int]$Default) return $Default }
function Write-SetupWarn { param([string]$Message) throw $Message }
function Invoke-SetupCodexAppServerBatchWrite {
  param([string]$Exe, $Edits, [int]$TimeoutSeconds)
  $script:CapturedAuth = ($Edits | Where-Object { $_.keyPath -eq 'model_providers.floway.auth' }).value
  return @{ status = 'ok'; filePath = 'fixture-config.toml' }
}
$SetupEndpoint = 'http://127.0.0.1:8788'
$SetupCodexModel = 'fixture-model'
$SetupCodexReasoningEffort = 'high'
$null = Write-SetupCodexConfig -Exe 'fixture-codex'
$script:CapturedAuth | ConvertTo-Json -Depth 4 -Compress`;
  const auth = authSchema.parse(JSON.parse(runPowerShell(source)));
  expect(auth.args[0]).toBe('-e');
  const result = await readToken(auth, customHome);
  expect(result.stdout).toBe(token);
  expect(result.stderr).toBe('');
});

test.skipIf(shellAbsent)('Windows Codex auth reads the exact token with Node from a special-character CODEX_HOME', async () => {
  const auth = authFor(true, process.execPath);
  expect(auth.command).toBe(process.execPath);
  expect(auth.args[0]).toBe('-e');
  const result = await readToken(auth, customHome);
  expect(result.stdout).toBe(token);
  expect(result.stderr).toBe('');
});

test.skipIf(shellAbsent)('Windows Codex auth reads the default profile token when CODEX_HOME is unset or empty', async () => {
  const auth = authFor(true, process.execPath);
  for (const home of [undefined, '']) {
    const result = await readToken(auth, home);
    expect(result.stdout).toBe('sk-floway-auth-default-test-canary');
    expect(result.stderr).toBe('');
  }
});

test.skipIf(shellAbsent)('eight concurrent Windows Codex token lookups finish within the five-second auth deadline', async () => {
  const auth = authFor(true, process.execPath);
  const results = await Promise.all(Array.from({ length: 8 }, async () => await readToken(auth, customHome)));
  for (const result of results) {
    expect(result.stdout).toBe(token);
    expect(result.stderr).toBe('');
    expect(result.elapsedMs).toBeLessThan(5_000);
  }
}, 15_000);

test.skipIf(shellAbsent)('Windows Codex auth propagates a missing token file instead of returning an empty credential', async () => {
  const auth = authFor(true, process.execPath);
  await expect(readToken(auth, join(root, 'missing-home'))).rejects.toMatchObject({ code: 1 });
});

test.skipIf(shellAbsent)('Windows Codex auth keeps a non-interactive PowerShell fallback without Node', () => {
  const auth = authFor(true, '');
  expect(auth.command).toBe('powershell');
  expect(auth.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
  expect(auth.args[3]).toContain('$env:CODEX_HOME');
  expect(auth.args[3]).toContain('[IO.File]::ReadAllText');
});

test.skipIf(shellAbsent)('Unix Codex auth keeps its existing shell contract even when Node is available', () => {
  const auth = authFor(false, process.execPath);
  expect(auth).toEqual({
    command: 'sh',
    args: ['-c', 'cat "${CODEX_HOME:-$HOME/.codex}/floway-token"'],
  });
});
