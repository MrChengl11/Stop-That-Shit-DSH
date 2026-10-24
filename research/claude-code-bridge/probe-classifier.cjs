/**
 * probe-classifier.cjs — what STS's Claude classifier says for each DSH tool name
 * (no mapping), so the report can show exactly which names mis-classify.
 */
const path = require('node:path');
const STS = path.resolve('..', 'lead-sts');
const { classifyClaudeTool, analyzeClaudeTool } = require(path.join(STS, 'src', 'adapters', 'claude-tool-classifier.cjs'));

const samples = [
  ['read', { path: 'src/app.ts' }],
  ['write', { path: 'src/app.ts', content: 'x' }],
  ['edit', { path: 'src/app.ts', old_string: 'a', new_string: 'b' }],
  ['glob', { pattern: '**/*.ts' }],
  ['grep', { pattern: 'foo', path: 'src' }],
  ['ops_bash', { command: 'git status' }],
  ['ops_inspect_local_file', { path: 'a.txt' }],
  ['ops_result', { action: 'page', id: 'r1' }],
  ['run_code', { code: 'return 1' }],
  ['subagent', { description: 'x', prompt: 'y' }],
  ['subagent_fork', { description: 'x', prompt: 'y' }],
  ['spawn_teammate', { prompt: 'y' }],
  ['todo_write', { todos: [] }],
  ['web_fetch', { url: 'https://example.com' }],
  ['web_search', { queries: ['x'] }],
  ['read_image', { file_path: 'a.png' }],
  ['present', { files: [] }],
  ['skill', { name: 'x' }],
  ['ask_user_question', { questions: [] }],
  ['compress', { content: 'x' }],
  // CC-shaped names for contrast
  ['Read', { path: 'src/app.ts' }],
  ['Glob', { pattern: '**/*.ts' }],
  ['Grep', { pattern: 'foo' }],
  ['Write', { file_path: 'src/app.ts', content: 'x' }],
  ['Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }],
  ['Bash', { command: 'git status' }],
  ['Agent', { prompt: 'x' }],
  ['ToolSearch', { query: 'x' }],
];

const rows = samples.map(([name, input]) => {
  const analysis = analyzeClaudeTool(name, input, process.cwd());
  return {
    tool: name,
    mutability: analysis.mutability,
    affectedPaths: analysis.affectedPaths,
    hashIntent: analysis.hashIntent,
    dependencyIntent: analysis.dependencyIntent,
  };
});
console.log(JSON.stringify(rows, null, 2));
