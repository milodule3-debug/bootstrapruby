# ruby-code

**Model-agnostic AI coding agent. Part of the Ruby Diamond ecosystem.**

Works with Claude, GPT-4o, Gemini, Grok, local Llama via Ollama — or any OpenAI-compatible endpoint. Swap the model with one flag.

```bash
ruby-code "fix the authentication bug in src/auth/login.ts"
ruby-code -m gpt-4o "add unit tests for the payment module"
ruby-code -m ollama/llama3.2 "explain this codebase"   # fully local, no API key
ruby-code -m gemini-2.5-pro "refactor the database layer"
ruby-code --interactive   # REPL mode — keep the agent on
```

---

## Install

### npm (all platforms)

```bash
npm install -g ruby-code
```

### Fedora 44+ (RPM)

```bash
# Via COPR (recommended)
sudo dnf copr enable yourusername/ruby-code
sudo dnf install ruby-code

# Or from local RPM build
sudo dnf install rpm-build nodejs npm
rpmbuild -ba packaging/fedora/ruby-code.spec
sudo dnf install ~/rpmbuild/RPMS/noarch/ruby-code-*.rpm
```

The RPM installs the `ruby-code` binary, bash completion, a desktop entry
(for the web UI), and a systemd user service (`ruby-code-server.service`).

### From source

```bash
git clone https://github.com/YOUR_USERNAME/ruby-code
cd ruby-code
npm install
npm run build
npm link   # makes `ruby-code` available globally
```

---

## Setup

Set an API key for your chosen provider:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # Claude
export OPENAI_API_KEY="sk-..."          # GPT
export GOOGLE_API_KEY="..."             # Gemini
export XAI_API_KEY="..."               # Grok
export OPENROUTER_API_KEY="..."        # All models via OpenRouter
export XIAOMI_API_KEY="tp-..."         # Xiaomi MiMo (get from platform.xiaomimimo.com)
```

For Xiaomi MiMo (Token Plan — Singapore endpoint by default):
```bash
export XIAOMI_API_KEY="tp-your-key-here"
ruby-code -m mimo-v2.5-pro "your task"

# Different region? Override the endpoint:
ruby-code -m mimo-v2.5-pro --base-url https://token-plan-us.xiaomimimo.com/v1 "task"
```

For Ollama (fully local, no API key):
```bash
ollama pull llama3.2
ruby-code -m ollama/llama3.2 "review this code"
```

---

## Usage

```bash
# Single task
ruby-code "add error handling to the login function"

# Choose model
ruby-code -m gpt-4o "write tests for UserService"
ruby-code -m gemini-2.5-flash "what does this codebase do?"
ruby-code -m ollama/qwen2.5-coder "fix the TypeScript errors"

# Via OpenRouter (access any model)
ruby-code -m openrouter/meta-llama/llama-3.1-70b-instruct "refactor"

# Modes
ruby-code --readonly "explain the auth flow"    # read-only, no changes
ruby-code --auto "fix all linting errors"        # no confirmation prompts

# Interactive REPL
ruby-code --interactive

# Custom endpoint (LM Studio, proxies, etc.)
ruby-code --base-url http://localhost:1234/v1 --model local-model "task"

# List all known models
ruby-code --models
```

---

## How it works

The agent runs a loop:

```
Task → Read context → Plan → Execute tools → Observe → Repeat until done
```

### Tools available

| Tool | What it does |
|------|-------------|
| `read_file` | Read any file with optional line range |
| `list_dir` | Directory tree, respects .gitignore |
| `edit_file` | Targeted find-and-replace (not full rewrites) |
| `write_file` | Create or overwrite files |
| `search_code` | Ripgrep/grep across the codebase |
| `run_shell` | Execute shell commands |
| `run_tests` | Auto-detect and run the test suite |
| `git_status` | Current git state |
| `git_diff` | File diffs |

### Permission modes

- **normal** (default): reads auto-approved, writes shown, destructive ops need confirmation
- **readonly**: only read tools allowed
- **auto**: everything auto-approved (use for CI/scripted workflows)

---

## Supported models

```
claude-opus-4-5-20251001    Anthropic — most powerful
claude-sonnet-4-5-20251001  Anthropic — fast
gpt-4o                      OpenAI
gemini-2.5-pro              Google
grok-beta                   xAI
mimo-v2.5-pro               Xiaomi MiMo — near-Opus perf, ~1/7 the cost
mimo-v2.5                   Xiaomi MiMo — fast, 310B
mimo-v2-flash               Xiaomi MiMo — fastest
ollama/llama3.2             Local (Ollama)
ollama/qwen2.5-coder        Local coding model
openrouter/<any>            All models via OpenRouter
```

Run `ruby-code --models` for the full list.

---

## Project config

Add a `.rubycode.json` to your project root to set defaults:

```json
{
  "model": "claude-sonnet-4-5-20251001",
  "mode": "normal",
  "ignore": ["dist/", "*.generated.ts"]
}
```

---

## Orchestration

Ruby Code includes a multi-agent orchestration layer that
automatically decomposes complex tasks into specialist agents.

### How it works

1. Router decides: is this task complex enough to decompose?
2. Orchestrator builds an ExecutionPlan (3-5 steps maximum)
3. Specialists execute in parallel where possible:
   - Researcher: reads and maps the codebase (never writes)
   - Coder: implements changes (full tool access)
   - Reviewer: checks correctness and quality (never writes)
4. Results synthesised into a coherent outcome

### Usage

```bash
ruby-code --orchestrate "refactor the auth module"
ruby-code --plan "add error handling to all API calls"
```

### The Ruby Principle

Ruby is a small model (Qwen 1B/2B via Ollama) that learns
from every task. When Ruby struggles, a large model intervenes.
The episode is captured. Ruby is fine-tuned on the failure.
Over time Ruby handles more tasks autonomously.

```bash
ruby-code --ruby "implement the user settings page"
```

### Knowledge Graph

ruby-code automatically extracts a knowledge graph of your
project architecture. The orchestrator uses this to understand
dependencies, constraints, and project trajectory before
planning any task.

```bash
node -e "
const { extractPerception } = require('./dist/perception/index.js');
extractPerception(process.cwd()).then(p => {
  console.log('Nodes:', p.nodes.length);
  console.log('Edges:', p.edges.length);
});
"
```

---

Built by [Lean Progress IQ](https://leanprogressiq.com) · Part of the Ruby Diamond ecosystem.
