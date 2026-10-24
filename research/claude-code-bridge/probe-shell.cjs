// probe-shell.cjs — how does STS classify a Bash payload carrying arbitrary code?
const path = require('node:path');
const STS = path.resolve('..','lead-sts');
const { analyzeClaudeTool } = require(path.join(STS,'src','adapters','claude-tool-classifier.cjs'));
const samples = [
  ['run_code-as-Bash-empty', 'Bash', { command: '' }],
  ['run_code-as-Bash-code', 'Bash', { command: 'return 1' }],
  ['run_code-as-Bash-code-write', 'Bash', { command: "await tools.write({file_path:'src/x.ts',content:'y'})" }],
  ['grep', 'Grep', { pattern: 'foo', path: 'src' }],
  ['edit', 'Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }],
  ['Read', 'Read', { file_path: 'src/app.ts' }],
];
for (const [label, tool, input] of samples) {
  const a = analyzeClaudeTool(tool, input, process.cwd());
  console.log(label.padEnd(28), a.mutability.padEnd(9), JSON.stringify(a.affectedPaths));
}
