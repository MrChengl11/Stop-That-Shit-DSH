
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBridge, dispatchPreExecute, dispatchPreStep, makeAgent } from './harness.mjs';

const cwd = mkdtempSync(join(tmpdir(), 'sts-fresh-'));
mkdirSync(join(cwd, 'src'), { recursive: true });
writeFileSync(join(cwd, 'src/app.ts'), 'export const a = 1;\n');
const pluginRoot = process.argv[2];
const sid = 'dsh-fresh-' + Date.now();
const bridge = await loadBridge({ configPath: join(process.cwd(), 'hooks-raw.json'), pluginRoot, projectDir: cwd, cwd });
const agent = makeAgent({ id: sid, cwd });
const r = await dispatchPreStep(bridge.ctx, { agent, messages: [{ role: 'user', content: [{ type: 'text', text: 'please fix the bug in src/app.ts' }] }], turn: 1 });
console.log('WATCH-ONLY NOTICE:', JSON.stringify(r?.messages?.[0]?.content?.[0]?.text ?? null));

// arm and time 10 pre-tool calls
await dispatchPreStep(bridge.ctx, { agent, messages: [{ role: 'user', content: [{ type: 'text', text: '$stop-that-shit change files=src/app.ts -- implement null check' }] }], turn: 1 });
const t0 = process.hrtime.bigint();
for (let i = 0; i < 10; i++) await dispatchPreExecute(bridge.ctx, { callId: 'c'+i, name: 'read', arguments: { path: 'src/app.ts' }, agent });
const t1 = process.hrtime.bigint();
console.log('avg ms per intercepted tool call:', Number(t1 - t0) / 1e6 / 10);
