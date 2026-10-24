/**
 * dsh-stop-that-shit — the Stop That Shit task-boundary guard as a native
 * DeepSeek Harness cordis plugin.
 *
 * Host seams used (all public):
 *   - agent/inbox/claimed  : the real user prompt, before any harness context
 *                            is merged into it, so a $stop-that-shit directive
 *                            is still the first non-empty line.
 *   - agent/pre-step       : append the guard's contract/notice as a user
 *                            message for the step that prompt belongs to.
 *   - tools/pre-execute    : the before-action event. Returning {kind:"deny",
 *                            reason} is a real deny; the reason reaches the
 *                            model as "Error: <reason>".
 *   - tools/post-execute   : the after-action event, used only to release a
 *                            delegation reservation.
 *   - systemPrompt.context : the live contract state, refreshed per request so
 *                            the stable system prompt is never rewritten.
 *
 * The plugin imports nothing from @deepseek-ai: a third-party profile bundle is
 * resolved through a linked layer, where a host package that the profile does
 * not re-export falls back to the bundle's own node_modules and fails. It only
 * uses node: builtins plus the vendored Stop That Shit sources.
 */
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { handleControlEvent, runtimeCommand } = require("../vendor-sts/src/controller.cjs");
const { readState } = require("../vendor-sts/src/state.cjs");
const { analyzeDshTool } = require("./adapter.js");

export const name = "sts-native";
/** systemPrompt is the only service this plugin must see before it applies. */
export const inject = ["systemPrompt"];

const LOG_PREFIX = "[sts-native] ";
const DENIAL_TIMEOUT_MS = 4000;

function log(message) {
  try {
    process.stderr.write(LOG_PREFIX + message + "\n");
  } catch {
    /* a closed stderr must never break a tool call */
  }
}

function configOf(raw) {
  const config = raw && typeof raw === "object" ? raw : {};
  const dataDir = typeof config.dataDir === "string" && config.dataDir
    ? config.dataDir
    : path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "sts-data");
  return {
    dataDir,
    /** Emit the contract as runtime context while the session is unarmed. */
    announceWhenUnarmed: config.announceWhenUnarmed !== false,
    /** Inject the contract text after each prompt. */
    announceOnPrompt: config.announceOnPrompt !== false
  };
}

/* ------------------------------------------------------------------ */
/* message helpers                                                     */
/* ------------------------------------------------------------------ */

function textOfMessage(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n");
}

function noticeMessage(text) {
  // user/message source shape is not validated by the session service, so a
  // plain object is enough — and it avoids importing a host message factory.
  return {
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "sts", form: "notice", summary: "Stop That Shit contract" }
  };
}

function sessionIdOf(agent) {
  const id = agent && agent.session && agent.session.id;
  return typeof id === "string" && id ? id : "";
}

function cwdOf(exec, fallback) {
  const session = exec && exec.agent && exec.agent.session;
  const cwd = session && session.header && session.header.cwd;
  if (typeof cwd === "string" && cwd) return cwd;
  return fallback();
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, rawConfig) {
  const config = configOf(rawConfig);
  /** Per-agent contract text waiting to be attached to the next step. */
  const pendingNotices = new WeakMap();
  /** Set of session ids already reported as started. */
  const startedSessions = new Set();

  const workingDirectory = () => {
    try {
      return ctx.reflect.get("workingDirectory");
    } catch {
      return undefined;
    }
  };

  const fallbackCwd = () => {
    try {
      return process.cwd();
    } catch {
      return os.tmpdir();
    }
  };

  function dispatch(event) {
    return handleControlEvent(event, { dataDir: config.dataDir, denialResponseOutcome: "execution_denial_returned" });
  }

  function stateIsArmed(sessionId) {
    try {
      const state = readState(sessionId, config.dataDir);
      return Boolean(state && state.contract && state.contract.mode && state.contract.mode !== "unconfirmed");
    } catch {
      return false;
    }
  }

  /* ---- session.start -------------------------------------------- */

  function ensureSessionStarted(sessionId) {
    if (!sessionId || startedSessions.has(sessionId)) return;
    startedSessions.add(sessionId);
    try {
      dispatch({ protocolVersion: 2, lifecycleVersion: 2, kind: "session.start", sessionId, host: "dsh" });
    } catch (error) {
      log("session.start failed: " + String(error && error.message ? error.message : error));
    }
  }

  /* ---- agent/inbox/claimed: the real user prompt ------------------ */

  ctx.on("agent/inbox/claimed", ({ agent, message }) => {
    try {
      if (!message || !message.source || message.source.kind !== "user") return;
      const sessionId = sessionIdOf(agent);
      if (!sessionId) return;
      ensureSessionStarted(sessionId);
      const prompt = textOfMessage(message);
      if (!prompt.trim()) return;

      const result = dispatch({
        protocolVersion: 2,
        lifecycleVersion: 2,
        kind: "prompt.submit",
        sessionId,
        host: "dsh",
        prompt
      });

      if (!config.announceOnPrompt) return;
      if (!result || (result.kind !== "context" && result.kind !== "prompt-error")) return;

      // A plain prompt in an unarmed session only yields the watch-only
      // preamble. Inject it only when the user is actually steering the guard,
      // so an ordinary task stays clean.
      const steers = /^(?:[ \t]*\r?\n)* {0,3}\$(?:stop-that-shit:)?stop-that-shit(?=$|[\s,:])/i.test(prompt)
        || result.kind === "prompt-error"
        || stateIsArmed(sessionId);
      if (!steers) return;

      const text = result.kind === "prompt-error" ? String(result.message || "") : String(result.text || "");
      if (!text) return;
      pendingNotices.set(agent, text);
    } catch (error) {
      log("prompt.submit failed: " + String(error && error.message ? error.message : error));
    }
  });

  /* ---- agent/pre-step: attach the notice to this step -------------- */

  ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
    const decision = await next();
    try {
      if (pendingNotices.has(agent)) {
        const text = pendingNotices.get(agent);
        pendingNotices.delete(agent);
        const rejectable = !decision || decision.kind !== "reject";
        if (rejectable && Array.isArray(decision.messages) && text && !signal?.aborted) {
          return { ...decision, messages: [...decision.messages, noticeMessage(text)] };
        }
      }
    } catch (error) {
      log("pre-step notice failed: " + String(error && error.message ? error.message : error));
    }
    return decision;
  });

  /* ---- tools/pre-execute: the real deny -------------------------- */

  ctx.on("tools/pre-execute", async (exec, next) => {
    let sessionId = "";
    try {
      sessionId = sessionIdOf(exec.agent);
      if (!sessionId) return next();
      ensureSessionStarted(sessionId);

      const cwd = cwdOf(exec, () => {
        const service = workingDirectory();
        try {
          const resolved = service && service.get(exec.agent.session);
          return typeof resolved === "string" && resolved ? resolved : fallbackCwd();
        } catch {
          return fallbackCwd();
        }
      });

      const args = exec.arguments && typeof exec.arguments === "object" ? exec.arguments : {};
      const facts = analyzeDshTool(exec.name, args, cwd);

      const event = {
        protocolVersion: 2,
        lifecycleVersion: 2,
        kind: "action.before",
        sessionId,
        host: "dsh",
        action: {
          name: exec.name,
          id: exec.callId,
          mutability: facts.mutability,
          affectedPaths: facts.affectedPaths,
          cwd,
          ...(facts.analysisReason === undefined ? {} : { analysisReason: facts.analysisReason }),
          hashIntent: facts.hashIntent,
          dependencyIntent: facts.dependencyIntent,
          unboundedDelegation: facts.unboundedDelegation,
          ...(facts.mutability === "delegate" ? { delegationCount: 1, completionScope: "call" } : {}),
          delegationLifecycleUnproven: false
        }
      };

      const result = await withTimeout(Promise.resolve(dispatch(event)), DENIAL_TIMEOUT_MS);
      if (!result || result.kind === "none") return next();

      if (result.kind === "deny") {
        const reasonCode = result.decision && result.decision.reasonCode ? result.decision.reasonCode : "denied";
        log("DENY " + exec.name + " " + reasonCode + " — " + String(result.message || "").split("\n").slice(0, 2).join(" | "));
        return { kind: "deny", reason: String(result.message || reasonCode) };
      }

      if (result.kind === "context" && result.text && typeof exec.deferContext === "function") {
        log("WATCH " + exec.name + " — context returned, action allowed");
        exec.deferContext(noticeMessage(String(result.text)));
      }
      return next();
    } catch (error) {
      // A guard must never take the host down: log and let the action through,
      // exactly like the Stop That Shit hooks fail open.
      log("pre-execute guard error for " + String(exec && exec.name) + ": " + String(error && error.message ? error.message : error));
      return next();
    }
  }, { prepend: true });

  /* ---- tools/post-execute: release a delegation reservation -------- */

  ctx.on("tools/post-execute", async (exec, result, next) => {
    try {
      const sessionId = sessionIdOf(exec.agent);
      if (sessionId && (exec.name === "subagent" || exec.name === "subagent_fork" || exec.name === "spawn_teammate")) {
        dispatch({
          protocolVersion: 2,
          lifecycleVersion: 2,
          kind: "action.after",
          sessionId,
          host: "dsh",
          action: { id: exec.callId, lifecycle: "joined" }
        });
      }
    } catch (error) {
      log("post-execute bookkeeping failed: " + String(error && error.message ? error.message : error));
    }
    return next();
  });

  /* ---- systemPrompt.context: live contract state ------------------ */

  try {
    ctx.systemPrompt.context({
      name: "sts:contract",
      order: 550,
      text: (context) => {
        try {
          const agent = context && context.agent;
          const sessionId = sessionIdOf(agent);
          if (!sessionId || !startedSessions.has(sessionId)) return "";
          const state = readState(sessionId, config.dataDir);
          if (!state || !state.contract) return "";
          const { contractContext } = require("../vendor-sts/src/controller.cjs");
          const mode = state.contract.mode;
          if (mode === "unconfirmed") return config.announceWhenUnarmed ? contractContext(state.contract, state.delegation) : "";
          return contractContext(state.contract, state.delegation, "active", state.directiveWarning, state.storageError);
        } catch {
          return "";
        }
      }
    });
  } catch (error) {
    log("prompt context registration failed: " + String(error && error.message ? error.message : error));
  }

  log("loaded pid=" + process.pid + " dataDir=" + config.dataDir);
  log("hooked tools/pre-execute, tools/post-execute, agent/inbox/claimed, agent/pre-step, systemPrompt.context");
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), ms); })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
