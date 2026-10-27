import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSubagentPicker } from '../pi-extension/subagents/subagent-picker.ts';
import { registerName, writeSubagentLoadout } from '../pi-extension/subagents/session.ts';
import { createStatusState, observeStatus } from '../pi-extension/subagents/status.ts';

it('native selector orders live children first, deduplicates session identity, and focuses closed history', async t => {
  const dir=mkdtempSync(join(tmpdir(),'pi-picker-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const saved=join(dir,'saved.jsonl'), live=join(dir,'live.jsonl');
  registerName(dir,'saved-agent',{sessionFile:saved});
  registerName(dir,'old-live-name',{sessionFile:live});
  writeSubagentLoadout(saved,{agent:'worker',model:'provider/recorded',toolAllowlist:'read',thinking:null,identity:null,
    systemPromptMode:null,spawnable:null,autoExit:true,cwd:dir,agentDir:null});
  const focused:any[]=[];
  await openSubagentPicker({hasUI:true,ui:{notify(){assert.fail();},async select(title: string,items: string[]){
    assert.equal(title,'Focus subagent');
    assert.deepEqual(items,['live-agent · starting','saved-agent · closed · provider/recorded']);
    return items[1];
  }}} as any,dir,[{name:'live-agent',sessionFile:live,statusState:createStatusState({source:'pi',startTimeMs:Date.now()})}] as any,
  async (name,file)=>{focused.push({name,file});return {ok:true};});
  assert.deepEqual(focused,[{name:'saved-agent',file:saved}]);
});

it('cancel and empty lists never launch a child; Focus failures are visible',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pi-picker-cancel-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const notices:any[]=[];
  const ctx:any={hasUI:true,ui:{notify:(...args:any[])=>notices.push(args),select:async()=>undefined}};
  await openSubagentPicker(ctx,dir,[],async()=>assert.fail('empty list cannot Focus'));
  assert.deepEqual(notices,[['No subagents in this session.','info']]);
  registerName(dir,'missing-agent',{sessionFile:join(dir,'missing.jsonl')});
  await openSubagentPicker(ctx,dir,[],async()=>assert.fail('cancel cannot Focus'));
  ctx.ui.select=async (_title:string,items:string[])=>items[0];
  await openSubagentPicker(ctx,dir,[],async()=>({error:'The original session file is unavailable.'}));
  assert.deepEqual(notices.at(-1),['The original session file is unavailable.','error']);
});

it('picker uses the current time at the stall boundary without expiring active tools or native CLIs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-picker-status-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = 120_000;
  t.mock.method(Date, 'now', () => now);
  const child = (name: string, statusState: ReturnType<typeof createStatusState>) => ({ name, sessionFile: join(dir, name + '.jsonl'), statusState });
  const active = observeStatus(createStatusState({ source: 'pi', startTimeMs: 0 }), {
    snapshot: 'present', updatedAt: 1, sequence: 1, phase: 'active', activeScope: 'tool',
  }, 1);
  const running = [
    child('starting', createStatusState({ source: 'pi', startTimeMs: now - 59_999 })),
    child('stalled', createStatusState({ source: 'pi', startTimeMs: now - 60_000 })),
    child('active', active),
    child('native', createStatusState({ source: 'codex', startTimeMs: 0 })),
  ];
  await openSubagentPicker({ hasUI: true, ui: {
    notify() { assert.fail('live children should open the picker'); },
    async select(_title: string, items: string[]) {
      assert.deepEqual(items, ['starting · starting', 'stalled · stalled', 'active · active', 'native · running']);
      return undefined;
    },
  } } as any, dir, running as any, async () => assert.fail('cancel must not Focus'));
});
