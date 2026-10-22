/** Networked deployment test; deliberately separate from the offline unit suite. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

it('the production package installs cleanly and offline, then runs one worker backend in official Pi', {timeout:240000}, t => {
  const root = resolve(import.meta.dirname, '../..');
  const dir = mkdtempSync(join(tmpdir(), 'pi-package-install-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const npm = (args: string[], cwd = dir) => execFileSync('npm',args,{cwd,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});
  const packed = JSON.parse(npm(['pack','--json','--ignore-scripts','--pack-destination',dir],root))[0];
  const manifest = JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  writeFileSync(join(dir,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{
    [manifest.name]:'file:'+join(dir,packed.filename),
    ...manifest.devDependencies,
  }}));
  npm(['install','--omit=dev','--no-audit','--no-fund','--cache',join(dir,'cache')]);
  rmSync(join(dir,'node_modules'),{recursive:true});
  npm(['ci','--omit=dev','--offline','--no-audit','--no-fund','--cache',join(dir,'cache')]);
  const installed = join(dir,'node_modules',manifest.name);
  assert.equal(existsSync(join(dir,'node_modules/@mariozechner')),false,'no legacy Pi packages may be pulled in');
  assert.equal(existsSync(join(dir,'node_modules/@sinclair/typebox')),false,'no legacy TypeBox copy may be pulled in');
  // The fixture's relative imports must resolve INSIDE the installed tarball,
  // never back to the development checkout and its node_modules.
  const fixture = join(installed,'test/packaging/sandbox-fixture.ts');
  assert.ok(existsSync(fixture));
  const pi = join(dir,'node_modules/.bin/pi');
  assert.equal(execFileSync(pi,['--version'],{encoding:'utf8'}).trim(),manifest.devDependencies['@earendil-works/pi-coding-agent']);
  const config = join(dir,'agent-config');
  mkdirSync(config);
  const report = join(dir,'report.json');
  const output = execFileSync(pi,['-p','-ne','-ns','-np','-nc','--no-mcp','-e',fixture,'--no-session','package sandbox probe'],{
    cwd:dir,env:{...process.env,PI_CODING_AGENT_DIR:config,PI_PACKAGE_REPORT:report,PI_OFFLINE:'1'},
    encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe'],
  });
  assert.ok(existsSync(report),output);
  const result = JSON.parse(readFileSync(report,'utf8'));
  assert.equal(result.ok,true,result.error);
  assert.deepEqual(result.checks,['extension-load','isolated-vm','responsive-abort','run-after-abort']);
  t.diagnostic(`Official Pi ${manifest.devDependencies['@earendil-works/pi-coding-agent']}; production-only offline reinstall; ${result.ticks} event-loop ticks during CPU loop`);
});
