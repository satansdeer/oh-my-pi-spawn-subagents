# oh-my-pi-spawn-subagents

Pi package that adds **real spawned subagents** for [`oh-my-pi`](https://github.com/acidsugarx/oh-my-pi) while continuing to use the same `.oh-my-pi.jsonc` configuration file.

The main Pi session can run on a planning model such as OpenAI Codex Sol high, while configured specialists run in isolated nested `pi -p` subprocesses on OpenRouter Qwen or any other Pi model provider.

## Why

Current `oh-my-pi` subagents are persona activations inside the current model session. This package adds a separate tool, `oh_my_pi_spawn_subagent`, that reads the same oh-my-pi config and actually spawns a child Pi process for agents with `spawn.enabled: true`.

## Install locally

From this checkout:

```bash
pi install /Users/maksimivanov/Workspace/plugins/oh-my-pi-spawn-subagents
```

Or test for one run:

```bash
pi -e /Users/maksimivanov/Workspace/plugins/oh-my-pi-spawn-subagents
```

After install/reload, start your orchestrator on the planning model:

```bash
pi --model openai-codex/gpt-5.6-sol:high
```

## Provider auth

Authenticate providers normally in Pi:

```text
/login openai-codex
/login openrouter
```

Or set OpenRouter API key:

```bash
export OPENROUTER_API_KEY=...
```

Check model IDs:

```bash
pi --list-models "sol"
pi --list-models "qwen3.8"
```

## Configuration

Use the existing oh-my-pi config cascade:

1. `~/.pi/oh-my-pi.jsonc`
2. `~/.pi/oh-my-pi.json`
3. `<project>/.oh-my-pi.jsonc`
4. `<project>/.oh-my-pi.json`

Project config overrides global config.

Example:

```jsonc
{
  "orchestrator": {
    "agentName": "oh-my-pi",
    "promptTemplate": "sisyphus",
    "defaultModel": "openai-codex/gpt-5.6-sol:high"
  },

  "agents": {
    "oracle": {
      "model": "openrouter/qwen/qwen3.8-2.4t-a95b",
      "variant": "max",
      "thinking": 0.9,
      "spawn": {
        "enabled": true,
        "provider": "openrouter",
        "model": "qwen/qwen3.8-2.4t-a95b",
        "thinking": "high",
        "tools": ["read", "grep", "glob"],
        "timeoutMs": 300000,
        "includeOhMyPiPrompt": false
      }
    },

    "explore": {
      "model": "openrouter/qwen/qwen3.8-max",
      "variant": "low",
      "spawn": {
        "enabled": true,
        "provider": "openrouter",
        "model": "qwen/qwen3.8-max",
        "thinking": "low",
        "tools": ["read", "grep", "glob"],
        "timeoutMs": 120000,
        "includeOhMyPiPrompt": false
      }
    }
  }
}
```

## Spawn settings

Supported `agents.<name>.spawn` fields:

| Field | Meaning |
|---|---|
| `enabled` | When `true`, run this agent through a child `pi -p` process. Otherwise return persona text fallback. |
| `provider` | Optional Pi provider, e.g. `openrouter`. |
| `model` | Child model ID, e.g. `qwen/qwen3.8-max`. If `provider` is omitted, full IDs like `openrouter/qwen/qwen3.8-max` are fine. |
| `thinking` | Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `tools` | Tool allowlist passed as `--tools`. |
| `excludeTools` | Tool blocklist passed as `--exclude-tools`. |
| `cwd` | `inherit` or a path. Relative paths resolve from the parent Pi cwd. |
| `timeoutMs` | Child process timeout. Defaults to 300000. |
| `includeContextFiles` | `false` adds `--no-context-files`. |
| `includeSkills` | `false` adds `--no-skills`. |
| `includeExtensions` | `false` adds `--no-extensions`. |
| `includeOhMyPiPrompt` | `false` also adds `--no-extensions` to prevent recursive orchestration. Recommended for spawned specialists. |
| `extraArgs` | Extra raw Pi CLI args before the prompt. |
| `env` | Extra child environment variables. |
| `piCommand` | Override Pi binary, useful for tests or wrappers. |
| `noSession` | Defaults to `true`; set `false` to omit `--no-session`. |

## Tool behavior

This package registers:

```text
oh_my_pi_spawn_subagent(agent, task, model?, provider?, thinking?)
```

It also appends system-prompt guidance telling the oh-my-pi orchestrator to prefer this tool when an agent has `spawn.enabled=true`.

If `spawn.enabled` is absent or false, the tool returns an oh-my-pi-style persona activation instead of spawning.

## Recursion prevention

Child processes receive:

```text
OH_MY_PI_SPAWN_SUBAGENT_CHILD=1
```

The extension does not inject its orchestration guidance in child mode. Setting `includeOhMyPiPrompt: false` additionally passes `--no-extensions`, preventing oh-my-pi itself from loading in the child.

## Tests

The integration tests use a fake `pi` binary and verify actual subprocess execution, argument construction, cwd, env propagation, fallback behavior, and non-zero exits.

```bash
npm install
npm run check
```
