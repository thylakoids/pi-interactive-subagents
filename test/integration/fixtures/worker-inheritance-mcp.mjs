import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result;
  if (request.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'computer-use-test', version: '1' } };
  else if (request.method === 'tools/list') result = { tools: [{ name: 'get_app_state', description: 'Mock computer state', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] };
  else if (request.method === 'tools/call') {
    appendFileSync(join(process.env.PI_CODING_AGENT_DIR, 'mcp-calls.jsonl'), JSON.stringify({ session: process.env.PI_SUBAGENT_SESSION, id: process.env.PI_SUBAGENT_ID, pid: process.pid, parentPid: process.ppid, tool: request.params.name }) + '\n');
    result = { content: [{ type: 'text', text: 'MOCK_COMPUTER_USE_OK' }] };
  }
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
}
