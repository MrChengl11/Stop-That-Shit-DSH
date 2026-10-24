// probe-names.cjs - how STS classifies each DSH tool name WITHOUT a shim.
// Names are the ones the model actually sees in this DSH profile.
const path = require('node:path');
const STS = path.resolve('..','lead-sts');
const { analyzeClaudeTool } = require(path.join(STS,'src','adapters','claude-tool-classifier.cjs'));
const cases = [
  ['read', {path:'src/app.ts'}],
  ['write', {path:'src/app.ts', content:'x'}],
  ['edit', {path:'src/app.ts', old_string:'a', new_string:'b'}],
  ['glob', {pattern:'**/*.ts'}],
  ['grep', {pattern:'export'}],
  ['ops_bash', {command:'git status'}],
  ['ops_bash', {command:'npm test'}],
  ['ops_inspect_local_file', {path:'src/app.ts'}],
  ['run_code', {code:'1+1'}],
  ['subagent', {description:'x', prompt:'y'}],
  ['subagent_fork', {description:'x', prompt:'y'}],
  ['spawn_teammate', {name:'x', prompt:'y'}],
  ['send_message', {agent_id:'a', message:'m'}],
  ['todo_write', {todos:[]}],
  ['list_agents', {scope:'children'}],
  ['job_output', {job_id:'j1'}],
  ['job_kill', {job_id:'j1'}],
  ['present', {files:[]}],
  ['ask_user_question', {questions:[]}],
  ['create_goal', {objective:'o'}],
  ['update_goal', {goal_id:'g', revision:1, action:'complete'}],
  ['compress', {content:'x'}],
  ['decompress', {blockId:'b1'}],
  ['schedule_create', {title:'t', prompt:'p'}],
  ['terminal_open', {type:'shell'}],
  ['terminal_send', {sessionId:'s', text:'ls'}],
  ['working_directory', {cd:'..'}],
  ['web_fetch', {url:'https://example.com'}],
  ['web_search', {queries:['x']}],
];
const rows = cases.map(([name, input]) => {
  const a = analyzeClaudeTool(name, input, process.cwd());
  return { name, mutability: a.mutability, paths: a.affectedPaths, reason: a.analysisReason || null };
});
const fs = require('node:fs');
fs.mkdirSync('results', { recursive: true });
fs.writeFileSync(path.join('results','name-matrix.json'), JSON.stringify(rows, null, 2) + String.fromCharCode(10));
for (const r of rows) console.log(r.name.padEnd(24), String(r.mutability).padEnd(9), JSON.stringify(r.paths), r.reason || '');
