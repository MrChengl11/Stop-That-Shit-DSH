/**
 * harness.mjs — standalone ctx stub + driver for the @deepseek-ai/dsh-hooks-claude-code bridge.
 *
 * The real bridge is an ESM cordis plugin. This harness implements only the
 * seams the bridge (and dsh-hook-protocol's runner) actually touch:
 *
 *   ctx.logger.warn(msg)                        index.js:148,150,195,196,232,324,337
 *   ctx.effect(disposeFn, label)                index.js:155
 *   ctx.on(event, handler)                      index.js:223,237,253,270,297,314,327
 *   ctx.get('agents')?.get(id)                  index.js:315
 *   ctx.sessionProjections.stateOf(s,'turnBoundary').lastTurn   index.js:351
 *   ctx.workingDirectory.get(session)           index.js:169
 *   ctx.workingDirectory.ensure(agent, signal)  index.js:169
 *   ctx.shell.resolve(request)                  protocol/index.js:210
 *   ctx.shell.execute(spec) -> {result()}       protocol/index.js:210
 *
 * Nothing else from DSH is loaded; no real DSH process is involved.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export function createShell({ cwd, env, log }) {
  function resolve(request) {
    return {
      command: request.command,
      workdir: request.workdir ?? cwd,
      timeoutMs: request.timeoutMs,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 65536,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
    };
  }

  async function execute(spec) {
    const started = process.hrtime.bigint();
    const child = spawn('bash', ['-c', spec.command], {
      cwd: spec.workdir,
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    if (spec.stdin !== undefined) child.stdin.end(spec.stdin);
    else child.stdin.end();

    const done = new Promise((resolveDone) => {
      let timedOut = false;
      let aborted = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch {}
      }, Math.max(1, spec.timeoutMs ?? 600000));
      const onAbort = () => {
        aborted = true;
        try { child.kill('SIGKILL'); } catch {}
      };
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        spec.signal?.removeEventListener('abort', onAbort);
        resolveDone({
          exitCode,
          signal,
          timedOut,
          aborted,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        });
      });
    });

    return {
      async result() {
        const outcome = await done;
        const handle = {
          ...outcome,
          stdout: { text: stdout, truncated: false },
          stderr: { text: stderr, truncated: false },
        };
        log?.spawn?.({
          command: spec.command,
          workdir: spec.workdir,
          env: spec.env,
          stdin: spec.stdin,
          exitCode: outcome.exitCode,
          durationMs: outcome.durationMs,
          stdout,
          stderr,
        });
        return handle;
      },
    };
  }

  return { resolve, execute, sandboxMode: 'danger-full-access' };
}

export function createCtx({ cwd, shellLog }) {
  const listeners = new Map();
  const warnings = [];
  const effects = [];

  const shell = createShell({ cwd, log: { spawn: (r) => shellLog?.push(r) } });

  const ctx = {
    __listeners: listeners,
    __warnings: warnings,
    __effects: effects,
    shell,
    logger: {
      warn: (msg) => { warnings.push(String(msg)); },
      info: () => {},
      error: (msg) => { warnings.push(String(msg)); },
      debug: () => {},
    },
    effect: (fn, label) => { effects.push({ fn, label }); return fn; },
    on: (event, handler, options) => {
      const list = listeners.get(event) ?? [];
      list.push({ handler, options });
      listeners.set(event, list);
      return () => {};
    },
    get: () => undefined,
    sessionProjections: {
      stateOf: (session, key) => (key === 'turnBoundary' ? { lastTurn: 1 } : null),
    },
    workingDirectory: {
      get: () => cwd,
      ensure: async () => cwd,
    },
  };
  return ctx;
}

/** Run the bridge's apply() against a fresh ctx and hand back the registered listeners. */
export async function loadBridge({ configPath, pluginRoot, projectDir, cwd }) {
  const mod = await import('@deepseek-ai/dsh-hooks-claude-code');
  const shellLog = [];
  const ctx = createCtx({ cwd, shellLog });
  const config = {
    configPath,
    ...(pluginRoot !== undefined ? { pluginRoot } : {}),
    ...(projectDir !== undefined ? { projectDir } : {}),
  };
  // Run the real schemastery schema so the defaults the plugin relies on are applied.
  const validated = mod.Config(config);
  mod.apply(ctx, validated);
  return { mod, ctx, config: validated, shellLog };
}

export function getHandler(ctx, event) {
  const list = ctx.__listeners.get(event);
  if (!list || list.length === 0) throw new Error('no listener registered for ' + event);
  return list[0].handler;
}

/** Dispatch tools/pre-execute through the bridge, with the same next() DSH uses. */
export async function dispatchPreExecute(ctx, exec) {
  const handler = getHandler(ctx, 'tools/pre-execute');
  return handler(exec, async () => ({ kind: 'allow' }));
}

export async function dispatchPostExecute(ctx, exec, result) {
  const handler = getHandler(ctx, 'tools/post-execute');
  return handler(exec, result, async () => ({ kind: 'enter' }));
}

export async function dispatchPreStep(ctx, { agent, text, turn = 1 }) {
  const handler = getHandler(ctx, 'agent/pre-step');
  return handler(
    {
      agent,
      messages: [{ content: [{ type: 'text', text }] }],
      turn,
      signal: new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
}

export async function dispatchTurnStopping(ctx, { agent, turn = 1 }) {
  const handler = getHandler(ctx, 'agent/turn-stopping');
  return handler({ agent, turn, signal: new AbortController().signal });
}

export function makeAgent({ id, cwd, injected = [], steered = [] }) {
  return {
    session: {
      header: { id, cwd },
      appended: [],
      append(type, data) { this.appended.push({ type, data }); },
    },
    ctx: { fiber: { assertActive() {} } },
    inject(msg) { injected.push(msg); },
    steer(msg) { steered.push(msg); },
    __injected: injected,
    __steered: steered,
  };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}
