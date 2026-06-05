#!/usr/bin/env node
import * as path from 'path';
import * as readline from 'readline';
import * as fs from 'fs';
import minimist from 'minimist';
import chalk from 'chalk';

import { KNOWN_MODELS, getAllModels, registerCustomProviders } from '../providers/factory.js';
import { createResilientProvider } from '../providers/resilient-factory.js';
import { loadProjectContext } from '../agent/context.js';
import { runAgentLoop } from '../agent/loop.js';
import { PermissionSystem } from '../safety/permissions.js';
import { createTerminalDisplay } from './display.js';
import { startServer } from '../server/index.js';
import type { PermissionLevel } from '../safety/permissions.js';
import { loadProjectConfig, resolveConfig } from '../config/project-config.js';
import { DEFAULTS } from '../config/defaults.js';
import { sessionStore } from '../agent/session-store.js';
import type { LLMProvider } from '../providers/types.js';
import { loadGlobalConfig, globalConfigPath } from '../setup/global-config.js';
import { needsWizard, runFirstRunWizard, hasGlobalConfig, hasAnyEnvKey } from '../setup/first-run.js';
import { routeTask, createPlan, executePlan } from '../orchestration/index.js';
import { loadPerception, isStale, extractPerception } from '../perception/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Parse args
// ─────────────────────────────────────────────────────────────────────────────

const argv = minimist(process.argv.slice(2), {
  string:  ['model', 'm', 'api-key', 'base-url', 'mode', 'cwd', 'rate-limit-rpm', 'rate-limit-tpm', 'max-retries', 'fallback'],
  boolean: ['help', 'h', 'version', 'v', 'auto', 'readonly', 'models', 'no-session', 'no-setup', 'reset-setup', 'orchestrate', 'plan'],
  alias:   { m: 'model', h: 'help', v: 'version' },
  default: {
    model: process.env.RUBY_MODEL,
    mode:  'normal',
  },
});

function num(s: unknown): number | undefined {
  if (s === undefined || s === null || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

const cliMaxRetries  = num(argv['max-retries']) ?? num(process.env.RUBY_MAX_RETRIES);
const cliRpm         = num(argv['rate-limit-rpm']) ?? num(process.env.RUBY_API_RPM);
const cliTpm         = num(argv['rate-limit-tpm']) ?? num(process.env.RUBY_API_TPM);
const cliFallbacks: string[] =
  Array.isArray(argv.fallback)
    ? argv.fallback.map(String)
    : typeof argv.fallback === 'string'
      ? [argv.fallback]
      : process.env.RUBY_FALLBACK_MODEL
        ? [process.env.RUBY_FALLBACK_MODEL]
        : [];

// ─────────────────────────────────────────────────────────────────────────────
// Help / version
// ─────────────────────────────────────────────────────────────────────────────

if (argv.version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
  console.log(`ruby-code v${pkg.version}`);
  process.exit(0);
}

if (argv.models) {
  console.log('\n' + chalk.hex('#cc785c').bold('  Supported models:\n'));
  const allModels = getAllModels();
  const byProvider = allModels.reduce<Record<string, typeof allModels>>((acc, m) => {
    (acc[m.provider] ??= []).push(m);
    return acc;
  }, {});
  for (const [provider, models] of Object.entries(byProvider)) {
    console.log(chalk.hex('#8a7768')(`  ${provider}`));
    for (const m of models) {
      console.log(`    ${chalk.hex('#cc785c')(m.id.padEnd(45))} ${chalk.hex('#4e3d30')(m.speed)}`);
    }
  }
  console.log(chalk.hex('#4e3d30')('\n  Use --model <id> or set RUBY_MODEL env var'));
  console.log(chalk.hex('#4e3d30')('  For Ollama: --model ollama/llama3.2'));
  console.log(chalk.hex('#4e3d30')('  For OpenRouter: --model openrouter/<provider>/<name>\n'));
  process.exit(0);
}

if (argv.help) {
  printHelp();
  process.exit(0);
}
// When run with no args and nothing in stdin, show help then exit.
// When run with no args + a TTY or piped input, fall through to the REPL/wizard.
// Skip this gate when --reset-setup is set (the wizard should fire even if env
// vars make needsWizard() return false).
if (argv._.length === 0 && !argv.interactive && process.stdin.isTTY !== true && !argv['reset-setup']) {
  if (!needsWizard({})) {
    printHelp();
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve config — CLI > .rubycode.json > global config > first-run wizard
// ─────────────────────────────────────────────────────────────────────────────

const cwd = argv.cwd ? path.resolve(argv.cwd) : process.cwd();
const fileConfig = loadProjectConfig(cwd);

// Pull global config (saved by the first-run wizard) so the user doesn't have
// to re-set their provider on every run.
const globalCfg = loadGlobalConfig();

// Effective model = CLI > RUBY_MODEL env > .rubycode.json > global config > undefined
const cliModel = typeof argv.model === 'string' ? argv.model : undefined;
const effectiveModel = cliModel ?? fileConfig.model ?? globalCfg?.defaultModel ?? process.env.RUBY_MODEL;

// Effective base URL = CLI > .rubycode.json > global config > undefined
const cliBaseUrl = typeof argv['base-url'] === 'string' ? argv['base-url'] : undefined;
const effectiveBaseUrl = cliBaseUrl ?? fileConfig.baseUrl ?? globalCfg?.baseUrl;

const resolved = resolveConfig(
  { ...fileConfig, model: effectiveModel, baseUrl: effectiveBaseUrl },
  {
    model: cliModel,
    baseUrl: cliBaseUrl,
    auto: argv.auto === true,
    readonly: argv.readonly === true,
    rateLimitRpm: cliRpm,
    rateLimitTpm: cliTpm,
    maxRetries: cliMaxRetries,
    fallbacks: cliFallbacks.length > 0 ? cliFallbacks : undefined,
  },
  { model: undefined as unknown as string, mode: 'normal', ignore: [] },
);

// Register custom providers from .rubycode.json
registerCustomProviders(resolved.providers);

const permissionLevel: PermissionLevel = resolved.mode;

// Mutable runtime state — :model command updates this
const runtimeConfig = {
  model: resolved.model,
  baseUrl: resolved.baseUrl,
  apiKey: typeof argv['api-key'] === 'string' ? argv['api-key'] : undefined,
};

function buildProvider(display: ReturnType<typeof createTerminalDisplay>): LLMProvider {
  // Caller guarantees resolved.model is set (guarded in main()).
  const model = resolved.model!;
  return createResilientProvider(
    {
      model,
      apiKey:  runtimeConfig.apiKey,
      baseUrl: runtimeConfig.baseUrl ?? undefined,
    },
    {
      rpm: resolved.rateLimitRpm,
      tpm: resolved.rateLimitTpm,
      maxRetries: resolved.maxRetries,
      fallbacks: resolved.fallbacks,
    },
    display,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  const display = createTerminalDisplay();

  // ── First-run wizard ───────────────────────────────────────────────────────
  // Skip if: --no-setup flag, --api-key on CLI, env var set, or global config exists.
  // Non-interactive modes (one-shot, --models, --help) skip the wizard too.
  // Wizard only fires when we're in an interactive terminal (TTY + no other args).
  // Wizard is eligible when there are no other args (no one-shot task) AND
  // we're not in a strict TTY-less script context. Accept both TTY and pipe:
  //   - TTY = real interactive use
  //   - pipe = test harnesses (and `ruby-code | tee log`)
  // The one-shot path (`ruby-code "task"`) has argv._.length > 0 so the
  // wizard can't fire there. --reset-setup alone is treated as interactive
  // since the whole point is to launch the wizard.
  const isInteractive = argv.interactive === true
    || process.argv.slice(2).length === 0
    || argv['reset-setup'] === true;
  const cliApiKey = typeof argv['api-key'] === 'string' ? argv['api-key'] : undefined;
  const cliModel = typeof argv.model === 'string' ? argv.model : undefined;
  const skipSetup = argv['no-setup'] === true || argv.help === true || argv.h === true || argv.models === true || argv.version === true || argv.v === true;
  const resetSetup = argv['reset-setup'] === true;
  if (resetSetup) {
    // Wipe global config so the wizard fires unconditionally.
    try { fs.unlinkSync(globalConfigPath()); } catch { /* not present */ }
  }
  // When --reset-setup is set, force the wizard to fire (overrides env-var
  // detection — the user explicitly wants to reconfigure).
  const shouldRunWizard = !skipSetup && isInteractive && (
    resetSetup || needsWizard({ cliApiKey, cliModel })
  );
  if (shouldRunWizard) {
    // If stdin is not a TTY and there's nothing piped in, the wizard will
    // hang. Skip with a helpful message instead.
    if (process.stdin.isTTY !== true && !process.stdin.readable) {
      console.error(chalk.hex('#b15439')('\n  ✗ No interactive input available.'));
      console.error(chalk.hex('#8a7768')('  Set an API key env var (e.g. export OPENAI_API_KEY=...)'));
      console.error(chalk.hex('#8a7768')('  or pass --api-key <key> --model <id> on the command line,\n'));
      process.exit(1);
    }
    const cfg = await runFirstRunWizard();
    if (!cfg) {
      console.error(chalk.hex('#b15439')('\n  ✗ Setup cancelled. Set an API key env var (e.g. export OPENAI_API_KEY=...) or run with --api-key.\n'));
      process.exit(1);
    }
    // Re-resolve with the new global config
    const fresh = loadGlobalConfig();
    if (fresh) {
      resolved.model = fresh.defaultModel;
      resolved.baseUrl = fresh.baseUrl;
      runtimeConfig.model = fresh.defaultModel;
      runtimeConfig.baseUrl = fresh.baseUrl;
    }
  }

  let ctx;
  try {
    ctx = await loadProjectContext(cwd);
  } catch (e) {
    display.error(`Could not load project context: ${String(e)}`);
    process.exit(1);
  }

  // ── Guard: we need a model before we can build a provider ─────────────────
  if (!resolved.model) {
    console.error(chalk.hex('#b15439')('\n  ✗ No model configured.'));
    console.error(chalk.hex('#8a7768')('  Run `ruby-code` with no args in a TTY to launch the setup wizard,'));
    console.error(chalk.hex('#8a7768')('  or pass --model <id> --api-key <key> on the command line,'));
    console.error(chalk.hex('#8a7768')('  or set the model in .rubycode.json (`"model": "..."`).'));
    process.exit(1);
  }

  let provider;
  try {
    provider = buildProvider(display);
  } catch (e) {
    display.error(`Could not initialize provider: ${String(e)}`);
    process.exit(1);
  }

  const permissions = new PermissionSystem(permissionLevel);
  const sessionPath = argv['no-session'] ? undefined : path.join(sessionStore.defaultDir(),
    (ctx.root || cwd).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80), 'latest.json');

  display.header(
    `ruby-code — ${ctx.name}`,
    `${provider.name} · ${runtimeConfig.model} · ${ctx.language} · ${permissionLevel} mode` +
    (fileConfig.model ? ` · .rubycode.json loaded` : ''),
  );

  const cumulative = { turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  // ── Single task mode: ruby-code "fix the bug" ──────────────────────────────
  if (argv._.length > 0) {
    const task = argv._.join(' ');
    console.log(chalk.hex('#8a7768')(`\n  Task: ${chalk.hex('#ede0cc')(task)}\n`));

    const doOrchestrate = argv.orchestrate === true;

    // If --orchestrate or auto-detection, try the orchestrator path
    if (doOrchestrate) {
      await runOrchestratedTask(task, provider, ctx, display, doOrchestrate);
      return;
    }

    // Auto-detect: run router, decompose if high confidence
    try {
      let perception = await loadPerception(ctx.root);
      if (!perception || isStale(perception)) {
        display.agentThinking();
        perception = await extractPerception(ctx.root);
      }

      const decision = await routeTask({ provider, context: ctx, task, perception: perception ?? undefined });
      if (decision.shouldDecompose && decision.confidence > 0.8) {
        await runOrchestratedTask(task, provider, ctx, display, false, perception ?? undefined);
        return;
      }
    } catch {
      // Router failed — fall through to single agent
    }

    // Single agent (existing behaviour)
    const result = await runAgentLoop({
      provider, task, context: ctx, permissions, display,
      spawnConfig: {
        apiKey: argv['api-key'] ?? undefined,
        baseUrl: resolved.baseUrl ?? undefined,
      },
      sessionPath,
    });

    if (result.success) {
      display.summary(result.summary, result.turns, result.toolCallCount);
      printUsageFooter(display, result.usage, result.costUsd);
    } else {
      display.error(result.summary);
      process.exit(1);
    }
    return;
  }

  // ── Interactive REPL mode: ruby-code --interactive ─────────────────────────
  console.log(chalk.hex('#8a7768')('  Type a task, or :help for commands. Ctrl+C to exit.\n'));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () => {
    rl.question(chalk.hex('#cc785c')('  ▸ '), async (line) => {
      const input = line.trim();
      if (!input) { ask(); return; }

      // Slash / colon commands
      if (handleReplCommand(input, {
        ctx, display,
        providerConfig: { model: resolved.model!, apiKey: runtimeConfig.apiKey, baseUrl: runtimeConfig.baseUrl ?? undefined },
        permissions, cumulative,
      })) {
        ask();
        return;
      }

      // Run task
      let result;
      try {
        const currentProvider = buildProvider(display);
        result = await runAgentLoop({
          provider: currentProvider, task: input,
          context: ctx, permissions, display,
          spawnConfig: {
            apiKey: runtimeConfig.apiKey,
            baseUrl: runtimeConfig.baseUrl ?? undefined,
          },
          sessionPath,
        });
      } catch (err) {
        const msg = err instanceof Error ? (err.stack || err.message) : String(err);
        console.error(chalk.hex('#b15439')(`\n  ✗ Unhandled error: ${msg}\n`));
        ask();
        return;
      }

      cumulative.turns += result.turns;
      cumulative.toolCalls += result.toolCallCount;
      cumulative.inputTokens += result.usage.inputTokens;
      cumulative.outputTokens += result.usage.outputTokens;
      cumulative.costUsd += result.costUsd;

      if (result.success) {
        display.summary(result.summary, result.turns, result.toolCallCount);
        printUsageFooter(display, result.usage, result.costUsd);
      } else {
        display.error(result.summary);
      }

      ask();
    });
  };

  // Ctrl+C: if a task is running, prompt to force-quit; second Ctrl+C exits.
  let ctrlC = 0;
  rl.on('SIGINT', () => {
    ctrlC++;
    if (ctrlC === 1) {
      console.log(chalk.hex('#cc785c')('\n  ⏳ Press Ctrl+C again to exit (current task will keep running).'));
      setTimeout(() => { ctrlC = 0; }, 3000);
    } else {
      console.log(chalk.hex('#4e3d30')('\n  ruby-code closed.\n'));
      process.exit(0);
    }
  });

  ask();
  rl.on('close', () => {
    console.log(chalk.hex('#4e3d30')('\n  ruby-code closed.\n'));
    process.exit(0);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// REPL command handler
// ─────────────────────────────────────────────────────────────────────────────

interface ReplCtx {
  ctx: Awaited<ReturnType<typeof loadProjectContext>>;
  display: ReturnType<typeof createTerminalDisplay>;
  providerConfig: { model: string; apiKey?: string; baseUrl?: string };
  permissions: PermissionSystem;
  cumulative: { turns: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsd: number };
}

function trySetModel(c: ReplCtx, newModel: string): { ok: true } | { ok: false; err: string } {
  const prevModel = runtimeConfig.model;
  runtimeConfig.model = newModel;
  try {
    const test = buildProvider(c.display);
    c.providerConfig.model = newModel;
    console.log(chalk.hex('#5a9e6e')(`  ✓ Switched to ${test.name} · ${newModel}`));
    return { ok: true };
  } catch (e) {
    runtimeConfig.model = prevModel;  // rollback on error
    return { ok: false, err: String(e) };
  }
}

/**
 * Interactive model selector — shows all models grouped by provider,
 * lets the user pick by number or type a custom model ID.
 */
function showModelSelector(c: ReplCtx): void {
  const allModels = getAllModels();

  // Build flat numbered list grouped by provider
  const entries: { id: string; label: string; provider: string }[] = [];
  let currentProvider = '';
  for (const m of allModels) {
    if (m.provider !== currentProvider) {
      currentProvider = m.provider;
      entries.push({ id: '', label: chalk.hex('#8a7768').bold(`  ── ${currentProvider} ──`), provider: currentProvider });
    }
    entries.push({
      id: m.id,
      label: `    ${chalk.hex('#cc785c')(String(entries.length + 1).padStart(2))}. ${chalk.hex('#ede0cc')(m.name.padEnd(30))} ${chalk.hex('#4e3d30')(m.speed)}`,
      provider: m.provider,
    });
  }

  console.log(chalk.hex('#cc785c').bold('\n  Model Selector\n'));
  for (const e of entries) {
    console.log(e.label);
  }
  console.log(chalk.hex('#4e3d30')(`\n  Current: ${runtimeConfig.model}`));
  console.log(chalk.hex('#4e3d30')('  Type a number, model ID, or press Enter to cancel:\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(chalk.hex('#cc785c')('  ▸ '), (answer) => {
    const choice = answer.trim();
    rl.close();

    if (!choice) {
      console.log(chalk.hex('#4e3d30')('  Cancelled.\n'));
      return;
    }

    // Try as a number
    const num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= entries.length) {
      const selected = entries[num - 1];
      if (selected.id) {
        trySetModel(c, selected.id);
      } else {
        console.log(chalk.hex('#b15439')('  ✗ That\'s a section header, pick a model number.'));
      }
      return;
    }

    // Treat as a raw model ID
    trySetModel(c, choice);
  });
}

function handleReplCommand(input: string, c: ReplCtx): boolean {
  if (input === ':quit' || input === ':q' || input === '/exit') {
    process.exit(0);
  }
  if (input === ':help' || input === '/help') {
    console.log(chalk.hex('#8a7768')([
      '',
      '  :quit, :q, /exit        Exit',
      '  :model                  Interactive model selector',
      '  :model <id>             Switch to a specific model',
      '  :apikey <key>           Set API key for current session',
      '  :mode <level>           Switch permission level (read-only/normal/auto)',
      '  :context                Show loaded project context',
      '  :models                 List all available models',
      '  /clear, /reset          Reset cumulative usage stats',
      '  /stats                  Show token + cost usage this session',
      '  /usage                  Same as /stats',
      '',
    ].join('\n')));
    return true;
  }
  if (input === ':context') {
    console.log(chalk.hex('#8a7768')(`\n  Project: ${c.ctx.name} · ${c.ctx.language} · ${c.ctx.framework}`));
    console.log(chalk.hex('#4e3d30')(`  Root: ${c.ctx.root}\n`));
    return true;
  }
  if (input === ':models') {
    const allModels = getAllModels();
    const byProvider = allModels.reduce<Record<string, typeof allModels>>((acc, m) => {
      (acc[m.provider] ??= []).push(m);
      return acc;
    }, {});
    for (const [provider, models] of Object.entries(byProvider)) {
      console.log(chalk.hex('#8a7768')(`\n  ${provider}`));
      for (const m of models) {
        console.log(`    ${chalk.hex('#cc785c')(m.id.padEnd(45))} ${chalk.hex('#4e3d30')(m.speed)}`);
      }
    }
    console.log();
    return true;
  }
  if (input === ':model' || input === '/model') {
    // Interactive model selector
    showModelSelector(c);
    return true;   // model switch is async — handled inside
  }
  if (input.startsWith(':model ') || input.startsWith('/model ')) {
    const sep = input.startsWith(':model ') ? ':model ' : '/model ';
    const newModel = input.slice(sep.length).trim();
    const r = trySetModel(c, newModel);
    if (!r.ok) console.log(chalk.hex('#b15439')(`  ✗ ${r.err}`));
    return true;
  }
  if (input.startsWith(':apikey ') || input.startsWith('/apikey ')) {
    const sep = input.startsWith(':apikey ') ? ':apikey ' : '/apikey ';
    const newKey = input.slice(sep.length).trim();
    runtimeConfig.apiKey = newKey;
    c.providerConfig.apiKey = newKey; // Need to update the active config if used later
    console.log(chalk.hex('#5a9e6e')('  ✓ API key set for current session.'));
    return true;
  }
  if (input === '/clear' || input === '/reset') {
    c.cumulative.turns = 0;
    c.cumulative.toolCalls = 0;
    c.cumulative.inputTokens = 0;
    c.cumulative.outputTokens = 0;
    c.cumulative.costUsd = 0;
    console.log(chalk.hex('#5a9e6e')('  ✓ Session stats reset'));
    return true;
  }
  if (input === '/stats' || input === '/usage') {
    const u = c.cumulative;
    const total = u.inputTokens + u.outputTokens;
    console.log(chalk.hex('#8a7768')([
      '',
      `  Session usage:`,
      `    Turns:        ${u.turns}`,
      `    Tool calls:   ${u.toolCalls}`,
      `    Input tokens: ${u.inputTokens.toLocaleString()}`,
      `    Output tokens:${u.outputTokens.toLocaleString()}`,
      `    Total tokens: ${total.toLocaleString()}`,
      `    Est. cost:    $${u.costUsd.toFixed(4)}`,
      '',
    ].join('\n')));
    return true;
  }
  return false;
}

async function runOrchestratedTask(
  task: string,
  provider: LLMProvider,
  ctx: Awaited<ReturnType<typeof loadProjectContext>>,
  display: ReturnType<typeof createTerminalDisplay>,
  forceOrchestrate: boolean,
  perception?: Awaited<ReturnType<typeof extractPerception>>,
): Promise<void> {
  display.header('Orchestrator', 'Planning multi-agent execution...');

  let plan;
  try {
    plan = await createPlan({ provider, context: ctx, task, perception });
  } catch (e) {
    display.error(`Failed to create plan: ${String(e)}`);
    process.exit(1);
  }

  // If --plan flag, show plan and ask for confirmation
  if (argv.plan === true) {
    display.showPlan?.(plan);

    // Use a simple readline prompt for confirmation
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const approved = await new Promise<boolean>(resolve => {
      rl.question(chalk.hex('#cc785c')('\n  Run this plan? [y/N] '), answer => {
        rl.close();
        resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
      });
    });

    if (!approved) {
      console.log(chalk.hex('#4e3d30')('  Plan cancelled.\n'));
      process.exit(0);
    }
  }

  // Execute the plan
  let executedPlan;
  try {
    executedPlan = await executePlan({
      provider,
      context: ctx,
      perception,
      plan,
      display,
    });
  } catch (e) {
    display.error(`Plan execution error: ${String(e)}`);
    process.exit(1);
  }

  // Display outcome
  if (executedPlan.outcome) {
    display.summary(executedPlan.outcome, executedPlan.steps.length, 0);
  }

  const totalTokens = executedPlan.totalTokens ?? 0;
  console.log(chalk.hex('#4e3d30')(
    `  ↳ ${totalTokens.toLocaleString()} tokens · ${executedPlan.steps.length} steps · status: ${executedPlan.status}`,
  ));
}

function printUsageFooter(
  display: ReturnType<typeof createTerminalDisplay>,
  usage: { inputTokens: number; outputTokens: number },
  costUsd: number,
): void {
  const total = usage.inputTokens + usage.outputTokens;
  console.log(chalk.hex('#4e3d30')(
    `  ↳ ${total.toLocaleString()} tokens (${usage.inputTokens.toLocaleString()} in / ${usage.outputTokens.toLocaleString()} out) · est. $${costUsd.toFixed(4)}`,
  ));
}

function printHelp() {
  console.log(`
${chalk.hex('#cc785c').bold('  ruby-code')} ${chalk.hex('#8a7768')('— model-agnostic AI coding agent')}

  ${chalk.hex('#4e3d30')('Usage:')}
    ruby-code ${chalk.hex('#8a7768')('"<task>"')}                Run a single task
    ruby-code ${chalk.hex('#8a7768')('--interactive')}           Start interactive REPL
    ruby-code ${chalk.hex('#8a7768')('--models')}                List available models

  ${chalk.hex('#4e3d30')('Options:')}
    --model, -m <id>         Model to use (default: from ~/.config/ruby-code/config.json)
    --api-key <key>          API key (overrides env var)
    --base-url <url>         Custom API endpoint (for Ollama, proxies, etc.)
    --auto                   Auto-approve all tool calls (no confirmation)
    --readonly               Read-only mode (no file writes or shell commands)
    --cwd <path>             Working directory (default: current)
    --models                 List all known model IDs
    --no-session             Disable conversation history persistence
    --no-setup               Skip the first-run setup wizard
    --reset-setup            Wipe saved config and re-run the setup wizard
    --orchestrate            Force multi-agent orchestration mode
    --plan                   Preview execution plan before running

    --rate-limit-rpm <n>     Cap requests per minute (default: 0=unlimited, Google: 30)
    --rate-limit-tpm <n>     Cap tokens per minute (Google only; default: 0=unlimited)
    --max-retries <n>        Max retry attempts on 429/5xx (default: 5, Google: 6)
    --fallback <model>       Fallback model if primary exhausts retries (repeatable)

  ${chalk.hex('#4e3d30')('Resilience:')}
    All API calls automatically:
    1. Honour Retry-After / Google's retryDelay on 429s
    2. Back off with exponential + jitter (capped at 60s)
    3. Trip a circuit breaker after 5 consecutive failures
    4. Fail over to the next --fallback model if retries exhaust
    5. Pace requests when --rate-limit-rpm / --rate-limit-tpm is set

  ${chalk.hex('#4e3d30')('Project config (.rubycode.json):')}
    {
      "model": "claude-sonnet-4-5-20251001",
      "mode":  "auto",
      "providers": [
        {
          "name": "DeepSeek",
          "baseUrl": "https://api.deepseek.com/v1",
          "apiKeyEnv": "DEEPSEEK_API_KEY",
          "prefixes": ["deepseek/"],
          "models": [
            { "id": "deepseek/deepseek-chat", "name": "DeepSeek Chat", "speed": "Fast" },
            { "id": "deepseek/deepseek-reasoner", "name": "DeepSeek R1", "speed": "Reasoning" }
          ]
        }
      ],
      "rateLimitRpm": 30,
      "rateLimitTpm": 1000000,
      "maxRetries": 6,
      "fallbacks": ["gpt-4o-mini", "gemini-2.5-flash"],
      "ignore": ["dist/", "*.generated.ts"]
    }
    CLI flags always override .rubycode.json.
    Custom providers are OpenAI-compatible endpoints.

  ${chalk.hex('#4e3d30')('Model examples:')}
    ruby-code -m claude-opus-4-5-20251001  "refactor auth"
    ruby-code -m gpt-4o                    "add unit tests"
    ruby-code -m gemini-2.5-pro --rate-limit-rpm 20  "explain this codebase"
    ruby-code -m ollama/llama3.2           "local model, no API key needed"

  ${chalk.hex('#4e3d30')('API keys (set as env vars):')}
    ANTHROPIC_API_KEY    Claude models
    OPENAI_API_KEY       GPT models
    GOOGLE_API_KEY       Gemini models
    XAI_API_KEY          Grok models
    OPENROUTER_API_KEY   OpenRouter (access to all models)
    XIAOMI_API_KEY       Xiaomi MiMo
    RUBY_MODEL           Default model (overridden by --model)
    RUBY_API_RPM         Default request rate limit
    RUBY_API_TPM         Default token rate limit (Gemini)
    RUBY_MAX_RETRIES     Default max retry attempts
    RUBY_FALLBACK_MODEL  Comma-separated fallback models
`);
}

if (argv._[0] === 'serve') {
  const port = Number(argv.port ?? argv.p ?? 7337);
  startServer({ port, cwd, model: argv.model, apiKey: argv['api-key'] ?? undefined, baseUrl: argv['base-url'] ?? undefined, open: argv.open !== false }).catch(e => { console.error('Fatal:', String(e)); process.exit(1); });
} else {
  main().catch(e => { console.error(chalk.hex('#b15439')(`\nFatal: ${String(e)}`)); process.exit(1); });
}
