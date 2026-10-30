import './tmux-isolation.ts';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { integrationRuntime } from './runtime.ts';
import { shellEscape } from '../../pi-extension/subagents/tmux.ts';

it('bundled worker inherits extension and MCP through Codemode on launch and resume; restricted child does not', { timeout: 90000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-inheritance-'));
  const config = join(dir, 'config');
  mkdirSync(config); mkdirSync(join(dir, '.pi', 'agents'), { recursive: true });
  const fixture = resolve(import.meta.dirname, 'fixtures/worker-inheritance-global.ts');
  const mcp = resolve(import.meta.dirname, 'fixtures/worker-inheritance-mcp.mjs');
  const extension = resolve(import.meta.dirname, '../../pi-extension/subagents/index.ts');
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ extensions: [fixture], defaultProvider: 'local', defaultModel: 'probe', defaultThinkingLevel: 'off' }));
  writeFileSync(join(config, 'mcp.json'), JSON.stringify({ mcpServers: { computer_use: { command: process.execPath, args: [mcp] } } }));
  writeFileSync(join(dir, '.pi', 'agents', 'restricted.md'), '---\nname: restricted\ndescription: restricted test\ntools: read\nauto-exit: true\n---\nTest agent.\n');
  const requests: any[] = [];
  const code = `const a = await Promise.allSettled([Promise.resolve().then(() => tools.inheritance_probe({})), Promise.resolve().then(() => tools.mcp__computer_use__get_app_state({}))]); console.log(JSON.stringify(a)); console.log('WORKFLOW_PRESENT=' + ('workflow' in tools));`;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const data = JSON.parse(body); requests.push(data);
    const messages = data.messages as any[];
    const last = messages.at(-1);
    const text = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
    let call: any;
    if (last?.role !== 'tool') {
      if (text.includes('LAUNCH_WORKER')) call = { name: 'subagent', arguments: { agent: 'worker', name: 'inherit-worker', task: 'CHILD_PROBE' } };
      else if (text.includes('RESUME_WORKER')) call = { name: 'subagent_message', arguments: { name: 'inherit-worker', message: 'CHILD_PROBE_RESUME' } };
      else if (text.includes('LAUNCH_RESTRICTED')) call = { name: 'subagent', arguments: { agent: 'restricted', name: 'restricted-child', task: 'CHILD_PROBE_RESTRICTED' } };
      else if (text.includes('LAUNCH_WORKFLOW')) call = { name: 'workflow', arguments: { action: 'start', script: `export const meta = { name: 'inheritance', description: 'Inheritance probe', phases: ['Probe'] };\nawait agent('CHILD_PROBE_WORKFLOW', { agent: 'worker', label: 'workflow-worker', phase: 'Probe' });` } };
      else if (text.includes('CHILD_PROBE')) call = { name: 'codemode', arguments: { code } };
    }
    const delta = call ? { tool_calls: [{ index: 0, id: 'call_' + requests.length, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { content: 'PROBE_COMPLETE' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    try { execFileSync('tmux', ['kill-server'], { stdio: 'ignore' }); } catch {}
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const port = (server.address() as any).port;
  writeFileSync(join(config, 'models.json'), JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions', apiKey: 'test', models: [{ id: 'probe', name: 'Probe', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  const runtime = integrationRuntime();
  const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8' }).trim();
  const pane = process.env.TMUX_PANE!;
  const session = join(dir, 'parent.jsonl');
  const command = `cd ${shellEscape(dir)} && env -i HOME=${shellEscape(dir)} PATH=${shellEscape(runtime.path)} TERM=xterm-256color TMUX=${shellEscape(process.env.TMUX!)} TMUX_PANE=${shellEscape(pane)} TMUX_SOCKET=${shellEscape(process.env.TMUX_SOCKET!)} PI_SUBAGENT_TREE=${shellEscape(pane)} PI_OFFLINE=1 PI_CODING_AGENT_DIR=${shellEscape(config)} ${shellEscape(runtime.executable)} --approve -ns -np -nc -e ${shellEscape(extension)} --model local/probe --session ${shellEscape(session)} LAUNCH_WORKER 2>${shellEscape(join(dir, 'stderr'))}`;
  tmux('respawn-pane', '-k', '-t', pane, command);
  const until = async (predicate: () => boolean, label: string) => {
    const end = Date.now() + 25000;
    while (Date.now() < end) { if (predicate()) return; await new Promise(r => setTimeout(r, 100)); }
    throw new Error(`${label}\n${tmux('capture-pane', '-p', '-t', pane)}\nstderr: ${existsSync(join(dir, 'stderr')) ? readFileSync(join(dir, 'stderr'), 'utf8') : ''}\nparent: ${existsSync(session) ? readFileSync(session, 'utf8').slice(-12000) : ''}\nlogs: ${existsSync(join(config, 'extension-calls.jsonl')) ? readFileSync(join(config, 'extension-calls.jsonl'), 'utf8') : ''}`);
  };
  const childRequests = () => requests.filter(r => r.messages.some((m: any) => JSON.stringify(m.content).includes('CHILD_PROBE')));
  const calls = (kind: string) => {
    const path = join(config, kind + '-calls.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  };
  const parentIdleAfter = (name: string, count = 1) => {
    if (!existsSync(session)) return false;
    const rows = readFileSync(session, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const results = rows.filter(row => row.type === 'custom_message' && row.customType === 'subagent_result' && row.details?.name === name);
    const last = rows.at(-1);
    return results.length >= count && last?.type === 'message' && last.message?.role === 'assistant' && JSON.stringify(last.message.content).includes('PROBE_COMPLETE') && rows.indexOf(last) > rows.indexOf(results.at(-1));
  };
  await until(() => calls('extension').length === 1 && calls('mcp').length === 1, 'worker calls');
  const first = calls('extension')[0];
  assert.ok(first.session && first.id && first.pid);
  assert.equal(calls('mcp')[0].id, first.id);
  assert.equal(calls('mcp')[0].session, first.session);
  const shutdowns = () => {
    const path = join(config, 'shutdowns.jsonl');
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  };
  await until(() => shutdowns().some((entry: any) => entry.id === first.id && entry.exit) && parentIdleAfter('inherit-worker'), 'worker wrote exit and parent handled its result');
  tmux('send-keys', '-t', pane, 'RESUME_WORKER', 'Enter');
  await until(() => calls('extension').length === 2 && calls('mcp').length === 2, 'resumed worker made fresh calls');
  const resumed = calls('extension')[1];
  assert.equal(resumed.session, first.session);
  assert.notEqual(resumed.id, first.id);
  assert.notEqual(resumed.pid, first.pid);
  assert.equal(calls('mcp')[1].session, resumed.session);
  assert.equal(calls('mcp')[1].id, resumed.id);
  await until(() => shutdowns().some((entry: any) => entry.id === resumed.id && entry.exit) && parentIdleAfter('inherit-worker', 2) && requests.some(r => r.messages.some((m: any) => m.role === 'tool' && JSON.stringify(m.content).includes('resumed'))), 'resumed worker exited and parent handled its result');
  tmux('send-keys', '-t', pane, 'LAUNCH_RESTRICTED', 'Enter');
  await until(() => childRequests().some(r => r.messages.some((m: any) => m.role === 'tool' && JSON.stringify(m.content).includes('rejected')) && r.messages.some((m: any) => JSON.stringify(m.content).includes('CHILD_PROBE_RESTRICTED'))), 'restricted child call');
  const restricted = childRequests().find(r => r.messages.some((m: any) => m.role === 'tool' && JSON.stringify(m.content).includes('rejected')) && r.messages.some((m: any) => JSON.stringify(m.content).includes('CHILD_PROBE_RESTRICTED')));
  const output = JSON.stringify(restricted.messages.filter((m: any) => m.role === 'tool'));
  assert.equal((output.match(/rejected/g) ?? []).length, 2, output);
  assert.doesNotMatch(output, /GLOBAL_EXTENSION_OK|MOCK_COMPUTER_USE_OK/);
  const workerRequest = childRequests().find(r => r.messages.some((m: any) => JSON.stringify(m.content).includes('CHILD_PROBE')));
  const names = workerRequest.tools.map((tool: any) => tool.function.name);
  for (const name of ['codemode', 'subagent', 'subagent_message', 'subagents_list']) assert.ok(names.includes(name), `${name} missing from worker tools`);
  assert.ok(requests.some(r => r.messages.some((m: any) => m.role === 'tool' && JSON.stringify(m.content).includes('resumed'))), 'same-name message must resume the completed worker');
  await until(() => parentIdleAfter('restricted-child'), 'restricted child exited and parent handled its result');
  assert.equal(calls('extension').length, 2);
  assert.equal(calls('mcp').length, 2);
  tmux('send-keys', '-t', pane, 'LAUNCH_WORKFLOW', 'Enter');
  await until(() => calls('extension').length === 3 && calls('mcp').length === 3, 'workflow worker made fresh calls');
  const workflowCall = calls('extension')[2];
  assert.notEqual(workflowCall.session, first.session);
  assert.notEqual(workflowCall.id, resumed.id);
  assert.equal(calls('mcp')[2].session, workflowCall.session);
  assert.equal(calls('mcp')[2].id, workflowCall.id);
  const workflowRequest = () => childRequests().find(r => r.messages.some((m: any) => JSON.stringify(m.content).includes('CHILD_PROBE_WORKFLOW')) && r.messages.some((m: any) => m.role === 'tool' && JSON.stringify(m.content).includes('GLOBAL_EXTENSION_OK') && JSON.stringify(m.content).includes('MOCK_COMPUTER_USE_OK')));
  await until(() => !!workflowRequest(), 'workflow worker inherited tools');
  const workflowNames = workflowRequest().tools.map((tool: any) => tool.function.name);
  assert.ok(workflowNames.includes('subagent'));
  assert.ok(!workflowNames.includes('workflow'), 'nested workflow must be excluded');
  assert.match(JSON.stringify(workflowRequest().messages.filter((m: any) => m.role === 'tool')), /WORKFLOW_PRESENT=false/, 'nested workflow must also be unavailable to Codemode');
});
