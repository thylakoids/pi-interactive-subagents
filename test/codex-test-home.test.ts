import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedCodexHome } from './integration/codex-home.ts';

it('native test home copies only auth and contains child writes and credential refreshes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-isolation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'normal');
  const testDir = join(dir, 'test');
  mkdirSync(source); mkdirSync(testDir);
  const files = { 'auth.json': '{"token":"fixture-auth"}', 'config.toml': 'model="normal-model"', 'session_index.jsonl': 'normal history', 'state_5.sqlite': 'normal database' };
  for (const [file, text] of Object.entries(files)) writeFileSync(join(source, file), text);
  const test = isolatedCodexHome(testDir, join(source, 'auth.json'));
  assert.deepEqual(readdirSync(test.home).sort(), ['auth.json', 'config.toml']);
  assert.equal(statSync(test.home).mode & 0o777, 0o700);
  assert.equal(statSync(join(test.home, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(test.home, 'auth.json'), 'utf8'), files['auth.json']);
  assert.equal(readFileSync(join(test.home, 'config.toml'), 'utf8'), 'cli_auth_credentials_store = "file"\n');
  execFileSync(process.execPath, ['-e', `
    const fs = require('node:fs'), path = require('node:path');
    for (const name of ['auth.json','config.toml','session_index.jsonl','state_5.sqlite'])
      fs.writeFileSync(path.join(process.env.CODEX_HOME, name), 'test writes');
    fs.mkdirSync(path.join(process.env.CODEX_HOME, 'sessions'));
  `], { env: { ...process.env, CODEX_HOME: test.home } });
  for (const [file, text] of Object.entries(files)) assert.equal(readFileSync(join(source, file), 'utf8'), text);
  test.cleanup();
  assert.equal(existsSync(test.home), false, 'credentials and isolated history must be removed after testing');
  for (const [file, text] of Object.entries(files)) assert.equal(readFileSync(join(source, file), 'utf8'), text);
});

it('missing native test auth fails without falling back to the normal home', t => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-home-missing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => isolatedCodexHome(dir, join(dir, 'missing-auth.json')), /ENOENT/);
  assert.equal(existsSync(join(dir, 'codex-home')), false);
});
