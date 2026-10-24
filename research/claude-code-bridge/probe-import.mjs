import { apply, Config, inject, name } from "@deepseek-ai/dsh-hooks-claude-code";
console.log("imported ok", { name, inject, hasConfig: !!Config, applyType: typeof apply });
console.log("Config keys:", Object.keys(Config || {}));
