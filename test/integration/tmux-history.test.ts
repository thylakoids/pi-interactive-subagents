/** Real interactive shells; the server and history files belong only to this test. */
import { it } from 'node:test';
import { isolatedTmux } from '../helpers/tmux.ts';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendCommand, sendLongCommand, shellEscape } from '../../pi-extension/subagents/tmux.ts';

async function waitForFile(path: string) {
  const deadline = Date.now() + 10000;
  while (!existsSync(path) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(existsSync(path), 'shell did not produce ' + path);
}

for (const shell of process.platform === 'darwin' ? ['bash', 'zsh'] : ['bash']) {
  it('script launches execute without polluting opt-in ' + shell + ' history', {timeout:15000}, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-shell-history-'));
    const socket = join(dir, 'tmux.sock');
    const previous = process.env.TMUX;
    const tmux = isolatedTmux(socket);
    t.after(() => {
      try { tmux('kill-server'); } catch {}
      if (previous === undefined) delete process.env.TMUX;
      else process.env.TMUX = previous;
      rmSync(dir, {recursive:true,force:true});
    });
    const history = join(dir, 'history');
    const command = `env HISTFILE=${shellEscape(history)} HISTSIZE=1000 /bin/${shell} ${shell === 'bash' ? '--noprofile --norc -i' : '-f'}`;
    const pane = tmux('new-session', '-d', '-s', 'history', '-x', '100', '-y', '30', '-P', '-F', '#{pane_id}', command);
    process.env.TMUX = tmux('display-message', '-p', '-t', pane, '#{socket_path},#{pid},0');
    const ready = join(dir, 'ready');
    sendCommand(pane, (shell === 'bash' ? `HISTFILE=${shellEscape(history)}; HISTSIZE=1000; HISTFILESIZE=1000; HISTCONTROL=ignorespace; set -o history; history -c;` : 'SAVEHIST=1000; setopt HIST_IGNORE_SPACE INC_APPEND_HISTORY;')
      + ` printf READY > ${shellEscape(ready)}`);
    await waitForFile(ready);
    const output = join(dir, 'output');
    const script = join(dir, "launch 'quoted' script.sh");
    assert.equal(sendLongCommand(pane, `printf 'EXECUTED\\n' > ${shellEscape(output)}`, {scriptPath:script}), script);
    await waitForFile(output);
    assert.equal(readFileSync(output, 'utf8'), 'EXECUTED\n');
    const flushed = join(dir, 'flushed');
    sendCommand(pane, `echo HISTORY_CONTROL_SENTINEL; ${shell === 'bash' ? 'history -w' : 'fc -AI'}; printf DONE > ${shellEscape(flushed)}`);
    await waitForFile(flushed);
    const saved = readFileSync(history, 'utf8');
    assert.match(saved, /HISTORY_CONTROL_SENTINEL/, 'history must be enabled; an empty history proves nothing');
    assert.ok(!saved.includes('quoted'), 'the generated script launch must not enter shell history');
  });
}
