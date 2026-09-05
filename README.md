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

The fork profile controls child resources and extensions. Version one must not load `pi-async-fork`, so recursive async forks stay disabled.

After adding or changing this configuration, run `/reload` or restart Pi. Until valid configuration exists, the extension stays inactive and its tools return the configuration error.

## Development

```bash
npm install
npm test
npm run typecheck
```
