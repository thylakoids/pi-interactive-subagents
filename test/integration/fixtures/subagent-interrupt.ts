/** Local provider blocks inside a real Pi generation until Escape aborts it. */
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';

export default function fixture(pi: any) {
  const dir = process.env.PI_INTERRUPT_DIR!;
  pi.on('session_start', () => writeFileSync(join(dir, 'ready-' + process.env.PI_SUBAGENT_ID), 'ready'));
  pi.registerProvider('interrupt-probe', {
    api: 'interrupt-test', apiKey: 'local', baseUrl: 'http://unused.invalid',
    models: [{ id: 'probe', name: 'Interrupt probe', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model: any, context: any, options: any) {
      const stream = createAssistantMessageEventStream();
      const id = process.env.PI_SUBAGENT_ID;
      const resumed = JSON.stringify(context).includes('RESUME_WITH_RESULT');
      const message: any = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [{ type: 'text', text: resumed ? 'RESUMED_RESULT' : '' }], stopReason: 'stop',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        if (resumed) { stream.push({ type: 'done', reason: 'stop', message }); stream.end(); return; }
        writeFileSync(join(dir, 'generating-' + id), String(process.pid));
        options.signal.addEventListener('abort', () => {
          appendFileSync(join(dir, 'aborted'), id + '\n');
          stream.push({ type: 'error', reason: 'aborted', error: { ...message, stopReason: 'aborted' } });
          stream.end();
        }, { once: true });
      });
      return stream;
    },
  });
}
