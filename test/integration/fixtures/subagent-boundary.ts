/** Script only provider responses; official Pi owns retries, continuations and settlement. */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import child from '../../../pi-extension/subagents/subagent-done.ts';

export default function fixture(pi: any) {
  child(pi);
  const dir = process.env.PI_BOUNDARY_DIR!;
  const ready = join(dir,'generation');
  pi.on('session_start', () => writeFileSync(ready,String(existsSync(ready) ? Number(readFileSync(ready,'utf8'))+1 : 1)));
  pi.on('input', (event:any) => {
    if (event.text === 'INBOX_RELOAD_PROOF') {
      writeFileSync(join(dir,'received'),event.text);
      return {action:'handled'};
    }
  });
  const record = (event: string, detail: any = {}) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({event, ...detail}) + '\n');
  let requests = 0, continuations = 0;
  pi.registerProvider('boundary', {
    api: 'boundary-test', apiKey: 'test-owned', baseUrl: 'http://unused.invalid',
    models: [{ id: 'probe', name: 'Boundary probe', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model: any) {
      const stream = createAssistantMessageEventStream();
      const round = ++requests;
      record('provider-request', {round, prematureExit: existsSync(process.env.PI_SUBAGENT_SESSION + '.exit')});
      const deliveryProbe = process.env.PI_BOUNDARY_DELIVERY === '1';
      const error = !deliveryProbe && round === 1;
      const message: any = {role:'assistant',api:model.api,provider:model.provider,model:model.id,
        timestamp:Date.now(),content:round === 1 ? [] : [{type:'text',text:deliveryProbe ? 'RECOVERED_DELIVERY' : round === 2 ? 'BEFORE_CONTINUE' : 'FINAL_SETTLED'}],
        stopReason:error ? 'error' : 'stop', ...(error ? {errorMessage:'529 overloaded'} : {}),
        usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      queueMicrotask(() => {
        stream.push(error ? {type:'error',reason:'error',error:message} : {type:'done',reason:'stop',message});
        stream.end();
      });
      return stream;
    },
  });
  pi.on('agent_end', () => record('agent-end', {prematureExit:existsSync(process.env.PI_SUBAGENT_SESSION + '.exit')}));
  pi.on('agent_before_settle', () => {
    if (process.env.PI_BOUNDARY_DELIVERY !== '1' && continuations++ === 0) return { entries:[{type:'custom_message',customType:'boundary-probe',content:'Continue with the final response.',display:false}], continue:true };
  });
  pi.on('agent_settled', (event: any) => record('settled', {aborted:event.aborted,exitWritten:existsSync(process.env.PI_SUBAGENT_SESSION + '.exit')}));
}
