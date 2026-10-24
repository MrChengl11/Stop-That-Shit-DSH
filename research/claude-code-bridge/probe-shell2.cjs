// probe-shell2.cjs — shell command classification corpus (what mapping ops_bash->Bash buys)
const path = require('node:path');
const STS = path.resolve('..','lead-sts');
const { analyzeClaudeTool } = require(path.join(STS,'src','adapters','claude-tool-classifier.cjs'));
const cmds = ['git status','git diff','ls -la','cat src/app.ts','npm test','rm -rf src','echo hi > src/app.ts','sed -i s/a/b/ src/app.ts','node -e "fs.writeFileSync(1,2)"','git commit -m x','git push'];
for (const command of cmds) {
  const a = analyzeClaudeTool('Bash', { command }, process.cwd());
  console.log(command.padEnd(38), a.mutability.padEnd(9), JSON.stringify(a.affectedPaths), a.analysisReason || '');
}
