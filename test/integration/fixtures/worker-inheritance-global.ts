import { Type } from 'typebox';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export default function (pi: any) {
  pi.on('session_shutdown', () => {
    if (process.env.PI_SUBAGENT_SESSION) appendFileSync(join(process.env.PI_CODING_AGENT_DIR!, 'shutdowns.jsonl'), JSON.stringify({ session: process.env.PI_SUBAGENT_SESSION, id: process.env.PI_SUBAGENT_ID, exit: existsSync(process.env.PI_SUBAGENT_SESSION + '.exit') }) + '\n');
  });
  pi.registerTool({
    name: 'inheritance_probe', label: 'Inheritance probe', description: 'Deterministic global extension probe',
    parameters: Type.Object({}),
    async execute() {
      appendFileSync(join(process.env.PI_CODING_AGENT_DIR!, 'extension-calls.jsonl'), JSON.stringify({ session: process.env.PI_SUBAGENT_SESSION, id: process.env.PI_SUBAGENT_ID, pid: process.pid }) + '\n');
      return { content: [{ type: 'text', text: 'GLOBAL_EXTENSION_OK' }] };
    },
  });
}
