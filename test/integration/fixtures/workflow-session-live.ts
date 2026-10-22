/** Production workflow tool and real Pi reload/quit; no replacement manager. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import subagentsExtension from '../../../pi-extension/subagents/index.ts';

export default function fixture(pi: any) {
  const dir = process.env.PI_SESSION_LIVE_DIR!;
  const tools = new Map<string, any>();
  const register = pi.registerTool;
  pi.registerTool = (tool: any) => { tools.set(tool.name, tool); register.call(pi, tool); };
  subagentsExtension(pi);
  pi.registerTool = register;
  let generation = 0;
  pi.on('session_start', (_event: any, ctx: any) => {
    const path = join(dir, 'ready.json');
    generation = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).generation + 1 : 1;
    writeFileSync(path, JSON.stringify({ generation, pid: process.pid, sessionFile: ctx.sessionManager.getSessionFile() }));
  });
  pi.on('session_shutdown', () => writeFileSync(join(dir, `shutdown-${generation}.json`), JSON.stringify({ generation })));
  const invoke = async (params: any, ctx: any) => {
    const result = await tools.get('workflow').execute('lifecycle', params, new AbortController().signal, undefined, ctx);
    if (result.isError) throw new Error(result.content[0].text);
    return result.details;
  };
  const prompt = (command: string) => 'Use bash to execute exactly this command:\n```sh\n' + command + '\n```\nThen reply DONE. Do not delegate.';
  pi.registerCommand('lifecycle-manual', { description: 'Start a real manual child during workflow shutdown', handler: async (tag: string, ctx: any) => {
    if (!/^[a-z]+$/.test(tag)) throw new Error('invalid probe tag');
    const result = await tools.get('subagent').execute('manual', { agent: 'worker', name: 'manual-' + tag,
      task: prompt(`echo started > ${tag}-manual-start; while ! test -f ${tag}-manual-release; do sleep 0.2; done`) }, new AbortController().signal, undefined, ctx);
    if (result.isError || result.details?.error) throw new Error(result.content[0].text);
    writeFileSync(join(dir, tag + '-manual.json'), JSON.stringify(result.details));
  } });
  pi.registerCommand('lifecycle-start', { description: 'Start explicit real-provider lifecycle probe', handler: async (tag: string, ctx: any) => {
    if (!/^[a-z]+$/.test(tag)) throw new Error('invalid probe tag');
    const guardian = fileURLToPath(new URL('../../../pi-extension/subagents/surface-guardian.ts', import.meta.url));
    const source = `export const meta = {name:'lifecycle-${tag}',description:'Real session lifecycle'}
      const a = await agent(${JSON.stringify(prompt(`echo once >> ${tag}-saved`))}, {label:'saved'});
      if (!a) throw new Error('saved child failed');
      const b = await agent(${JSON.stringify(prompt(`timeout 240 sh -c 'echo $$ > ${tag}-pid; echo started >> ${tag}-blocked; while ! test -f ${tag}-release; do sleep 0.2; done; echo done > ${tag}-done # ${guardian}'`))}, {label:'blocked'});
      if (!b) throw new Error('child interrupted');
      return {a,b};`;
    const details = await invoke({ action: 'start', script: source }, ctx);
    writeFileSync(join(dir, tag + '.json'), JSON.stringify(details));
  } });
  pi.registerCommand('lifecycle-resume', { description: 'Resume explicit probe after actual reload', handler: async (tag: string, ctx: any) => {
    const previous = JSON.parse(readFileSync(join(dir, tag + '.json'), 'utf8'));
    const details = await invoke({ action: 'resume', runId: previous.runId }, ctx);
    writeFileSync(join(dir, tag + '-resumed.json'), JSON.stringify(details));
  } });
}
