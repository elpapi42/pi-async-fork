# pi-async-fork

`pi-async-fork` runs bounded Pi work in durable pi-fleet agents without blocking the main Pi agent.

It provides `create_fork`, `steer_fork`, and `fork_status`. Forks use a separate retained Pi session, send meaningful progress and final reports as parent steering messages, and preserve branch-scoped ownership in the parent Pi session.

## Configuration

Add this to global or project Pi settings:

```json
{
  "pi-async-fork": {
    "agentDir": "/absolute/path/to/fork-agent-profile",
    "stateDir": "/absolute/path/to/pi-fleet-state",
    "env": { "PI_OBSERVATIONAL_MEMORY_PASSIVE": "1" },
    "fast": { "provider": "openai-codex", "model": "gpt-5.6-luna", "thinking": "medium" },
    "balanced": { "provider": "openai-codex", "model": "gpt-5.6-terra", "thinking": "high" },
    "deep": { "provider": "openai-codex", "model": "gpt-5.6-sol", "thinking": "high" }
  }
}
```

`agentDir` is optional. Omit it, or set it to `null`, to use pi-fleet's default Pi profile. Set a non-empty path to use a dedicated fork profile. A project `agentDir: null` overrides a configured global path.

`stateDir` is optional. Omit it, or set it to `null`, to use pi-fleet's default state directory, `~/.pi-fleet`. Set a non-empty path to isolate fork state. A project `stateDir: null` overrides a configured global path.

`env` is an optional string-to-string overlay for fork Pi processes. It does not change the parent Pi process or the pi-fleet worker. A project `env` object merges by key with the global object. A project string overrides one global value, a project `null` value removes one inherited key, `env: null` clears all inherited values, and `env: {}` keeps inherited values. Omit `env`, or resolve no entries, to pass no overlay.

`PATH` and `PI_CODING_AGENT_DIR` are reserved. Names must be non-empty and cannot contain `=` or a null byte. Values must be strings without null bytes; empty strings are valid. pi-fleet persists values in agent state and backups, then applies them to Pi startup and recovery. Do not use `env` for secrets. Existing forks retain their recorded environment until destruction; changes affect only new forks. pi-async-fork does not duplicate environment data in its session ledger.

A dedicated fork profile controls child resources and extensions. When the default profile loads `pi-async-fork` inside a child, an extension-owned session marker prevents all three async-fork tools from starting or managing forks. The tools remain visible so an attempted call can return a task-focused error.

After adding or changing this configuration, run `/reload` or restart Pi. Until valid configuration exists, the extension stays inactive and its tools return the configuration error.

## Operational limits

Forks share the parent project working directory. Concurrent writes are unsafe without separate workspace isolation, so use asynchronous forks for read-only work unless the caller coordinates writes.

The child-session marker blocks `create_fork`, `steer_fork`, and `fork_status` inside async forks. It does not block direct pi-fleet CLI commands through a shell. Use a restricted profile or sandbox when workers must not have shell access to pi-fleet.

The extension retains child session files under the parent session directory after normal completion. If creation cleanup cannot destroy an unregistered pi-fleet agent, it also retains that child session and returns the agent name and cleanup error. Inspect it with `pif status <name>`, or add `--state-dir <path>` for custom state. Destroy only that named agent with `pif destroy <name>`, or add `--state-dir <path>`.

A terminal fork waits ten seconds for delayed activity replay before it classifies its remaining report as final or sends a no-result notice. This wait is a first-version heuristic. Removing or disabling the extension does not destroy active pi-fleet agents, so inspect the configured state directory before rollback.

## Progress reports

Forks remain one-off workers. A multi-phase task must report only after a completed phase produces a concrete, evidence-backed finding. Plans, intended sources, and unstarted work do not qualify. An intermediate report must state what the evidence changes, material uncertainty, remaining work, and the next action. It must not imply that the task is complete. A later report must add evidence that changes the recommendation, scope, risk, or next action, resolve a named uncertainty, or complete a distinct phase. New citations, restated findings, and repeated next actions do not qualify. Forks do not report simple one-phase work, raw activity, elapsed time, or waiting. They automatically destroy themselves after the final report or a terminal notice.

Each visible checkpoint and final report uses `## Output` and `## Learnings`. Intermediate reports stay short and focused. Source URLs can appear inline. This brevity requirement does not apply to final reports, which retain the task-adapted report contract. To continue one Pi run, an intermediate report must include the next necessary tool call in the same assistant response. A text-only report with no next tool call is final.

The extension holds each visible child message until later pi-fleet activity proves that the child continued. It sends that report as progress only while the latest monitored pi-fleet status is `working`. If terminal status remains for ten seconds, only the latest remaining message is final. It sends these model-visible envelopes:

```text
<forkId>:

This is an intermediate progress report. The fork is still working and can receive steering.

<report>
```

```text
<forkId>:

This is the final report. The fork finished and can no longer receive steering.

<report>
```

A terminal notice states that the fork can no longer receive steering. The TUI renders only clean headers: `● fork <forkId>: working` for progress, `✓ fork <forkId>: completed` for final reports, and `⚠ fork <forkId>: terminal` for notices. The model-only status sentence does not appear in expanded Markdown.

Progress and final reports use pi-fleet cursors plus the public fork ID and immutable agent ID for duplicate suppression. Each report remains scoped to its owner branch. An inactive owner branch receives no delivery. If the fork is still working when that branch becomes active, missing progress can replay. If the fork is terminal, only its latest report becomes final. Progress does not add `fork.created` or `fork.destroyed` records.

`pi.sendMessage()` has no delivery acknowledgement. This provides at-least-once replay with cursor duplicate suppression after a persisted parent custom message, not exactly-once delivery. A parent process can still lose a queued progress message before Pi consumes and persists it.

## Development

```bash
npm install
npm test
npm run typecheck
```
