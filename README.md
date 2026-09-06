# pi-async-fork

`pi-async-fork` runs bounded Pi work in durable pi-fleet agents without blocking the main Pi agent.

It provides `create_fork`, `steer_fork`, and `fork_status`. Forks use a separate retained Pi session, return results as parent steering messages, and preserve branch-scoped ownership in the parent Pi session.

## Configuration

Add this to global or project Pi settings:

```json
{
  "pi-async-fork": {
    "agentDir": "/absolute/path/to/fork-agent-profile",
    "stateDir": "/absolute/path/to/pi-fleet-state",
    "fast": { "provider": "openai-codex", "model": "gpt-5.6-luna", "thinking": "medium" },
    "balanced": { "provider": "openai-codex", "model": "gpt-5.6-terra", "thinking": "high" },
    "deep": { "provider": "openai-codex", "model": "gpt-5.6-sol", "thinking": "high" }
  }
}
```

`agentDir` is optional. Omit it, or set it to `null`, to use pi-fleet's default Pi profile. Set a non-empty path to use a dedicated fork profile. A project `agentDir: null` overrides a configured global path.

`stateDir` is optional. Omit it, or set it to `null`, to use pi-fleet's default state directory, `~/.pi-fleet`. Set a non-empty path to isolate fork state. A project `stateDir: null` overrides a configured global path.

A dedicated fork profile controls child resources and extensions. When the default profile loads `pi-async-fork` inside a child, an extension-owned session marker prevents all three async-fork tools from starting or managing forks. The tools remain visible so an attempted call can return a task-focused error.

After adding or changing this configuration, run `/reload` or restart Pi. Until valid configuration exists, the extension stays inactive and its tools return the configuration error.

## Operational limits

Forks share the parent project working directory. Concurrent writes are unsafe without separate workspace isolation, so use asynchronous forks for read-only work unless the caller coordinates writes.

The child-session marker blocks `create_fork`, `steer_fork`, and `fork_status` inside async forks. It does not block direct pi-fleet CLI commands through a shell. Use a restricted profile or sandbox when workers must not have shell access to pi-fleet.

The extension retains child session files under the parent session directory after normal completion. If creation cleanup cannot destroy an unregistered pi-fleet agent, it also retains that child session and returns the agent name and cleanup error. Inspect it with `pif status <name>`, or add `--state-dir <path>` for custom state. Destroy only that named agent with `pif destroy <name>`, or add `--state-dir <path>`.

A terminal fork waits ten seconds for delayed activity replay before it sends a no-result notice. This wait is a first-version heuristic. Removing or disabling the extension does not destroy active pi-fleet agents, so inspect the configured state directory before rollback.

## Development

```bash
npm install
npm test
npm run typecheck
```
