# pi-async-fork specification

## Purpose

`pi-async-fork` makes forks durable, asynchronous context branches.

A main Pi agent creates bounded work and immediately continues. A pi-fleet agent runs the work independently. When the fork produces its final assistant response, the extension sends that response back to the parent as a steering message.

The parent remains the orchestrator. Async forks are temporary work branches. They are not user-facing agents, long-lived specialists, or workflow owners.

## Behavior change

Synchronous `pi-fork` behavior is:

```text
fork → wait → result → continue
```

`pi-async-fork` behavior is:

```text
create fork → receive fork ID → continue → receive final response later
```

The first-order outcome is that bounded research or other safe background work does not block the parent agent's current reasoning.

## Runtime boundary

pi-fleet is the durable runtime for fork agents. It owns agent processes, worker recovery, and activity persistence.

`pi-async-fork` uses only the public `@elpapi42/pi-fleet-sdk`. It must not inspect, write, or depend on pi-fleet's internal state or LMDB implementation.

`pi-async-fork` owns:

- parent-session fork records;
- retained child Pi session files;
- active in-memory handles and receivers for the current parent session.

## Tool surface

### `create_fork`

```text
create_fork(name, task, tier?) → fork ID
```

The agent supplies a short semantic name for the work. The name does not need to be unique. It must contain one or two lowercase words, with one hyphen between two words. Each word contains letters only. The agent must not add a number because the tool appends the generated seven-digit suffix.

The tool creates a retained child session, creates a durable pi-fleet agent, starts its receiver, and sends the assigned task. It appends `fork.created` only after `agent.send()` accepts that task, then returns the canonical fork ID without waiting for completion.

Successful send acceptance is the registration boundary. The public pi-fleet SDK cannot reliably expose a separately observed `working` transition for fast tasks because a task can settle before status observation.

If child-session creation, fleet creation, or initial task delivery fails, the tool destroys any created fleet agent, deletes the unregistered child session file, writes no lifecycle entry, and returns a clear error. An uncertain send is a delivery failure and must not be retried automatically. If cleanup also fails, the error reports both the original failure and cleanup failure.

The `create_fork` tool description and its `name` parameter description must state all naming rules. They must include the one-or-two-word limit, lowercase letters-only rule, optional single separator, prohibition against agent-supplied numbers, generated suffix behavior, and requirement to use the returned fork ID for later calls.

`tier` accepts `fast`, `balanced`, or `deep`. The fixed default is `balanced`.

### `steer_fork`

```text
steer_fork(fork ID, message) → acceptance or error
```

The tool uses pi-fleet's existing adaptive steering delivery. If the fork is working, Pi queues the message as steering before the next LLM call. If the fork is idle, Pi treats it as a normal prompt and starts a turn. The tool does not wait for the work to finish.

### `fork_status`

```text
fork_status(fork ID) → current fork state
```

The tool resolves the fork ID against the current active-branch ledger.

- An active fork returns its current raw pi-fleet state without extension remapping.
- A fork with matching `fork.created` and `fork.destroyed` entries returns the terminal public state `completed` without contacting pi-fleet.
- An ID with no `fork.created` entry on the active branch returns a not-found error.

`idle` means that pi-fleet reports settlement. It is not steerable. Automatic pi-fleet destruction is an internal cleanup detail, so the public terminal state is `completed`, not `destroyed`.

Tool output must not expose the retained child session path or other internal storage paths.

The `fork ID` parameter descriptions for `steer_fork` and `fork_status` must tell the caller to use the complete ID returned by `create_fork`. The caller must not shorten, modify, or reconstruct it.

There is no `destroy_fork` tool.

## Fork ID

Fork IDs use this format:

```text
<name>-<seven-digit suffix>
```

Examples:

```text
research-1234567
review-0429183
tests-8301742
```

The supplied name must match:

```text
^[a-z]{1,20}(?:-[a-z]{1,20})?$
```

The complete supplied name must not exceed 30 characters. The extension rejects invalid names instead of rewriting them.

A valid name contains one or two lowercase words. Each word contains letters only and has at most 20 characters. One hyphen separates two words. Numbers, underscores, leading or trailing hyphens, repeated hyphens, and three-word names are invalid.

Examples:

```text
allowed: research
allowed: window-researcher
allowed: api-review

rejected: researcher-1
rejected: researcher1
rejected: window-api-review
rejected: window_researcher
```

The suffix comes directly from Node's `crypto.randomInt(0, 10_000_000)`, converted to decimal and left-padded with zeroes to seven digits. UUID generation and hashing are not used because they add no entropy after truncation to seven decimal digits.

Before creation, the extension checks the current active-branch ledger for the candidate ID. It uses the complete fork ID as the pi-fleet agent name. If pi-fleet returns `AgentNameTakenError`, the extension generates another suffix and retries. It makes at most ten generation attempts, then returns a clear creation error.

The readable fork ID is a session-branch-scoped handle. The separate immutable pi-fleet agent ID remains the internal identity used for recovery checks.

## Fork completion and delivery

The extension receives pi-fleet activity in the background. For the first version, it forwards only the final visible assistant response to the parent.

Each active-fork receiver retains the latest pi-fleet `message.finished` text and cursor as its candidate response. It monitors that fork through the public `agent.status()` API, which already attempts pi-fleet worker recovery before returning. The extension continues monitoring `starting` and `working`. Only `idle` confirms settlement. If an idle fork has a candidate response, that response is final.

If an idle fork has no candidate response, or status returns `interrupted` or `failed`, the extension waits ten seconds from the first terminal-state observation. This simple grace period lets delayed replay deliver a candidate after restart. If no confirmed final response is available after the grace period, the extension does not attempt its own recovery. It creates a plain situation notice that states the raw pi-fleet status and that no confirmed final response is available.

Before finalization or notice handling, the extension confirms that the current active-branch ledger owns the exact fork ID and immutable pi-fleet agent ID. If the owning branch is inactive, the extension does not deliver a result or notice, destroy the fleet agent, or append an entry. It leaves the fleet agent and its replayable activity intact. When that branch becomes active again, the extension reconnects, restores the latest candidate, checks status, and then handles the settled or no-result condition. A fork result or notice must never enter a sibling branch.

For an active owning branch, finalization or no-result handling occurs in this order:

```text
capture output or create notice → destroy pi-fleet agent → append fork.destroyed → deliver to parent
```

Parent delivery does not keep the finished fleet agent alive.

The visible parent message envelope is exactly:

```text
<forkId>:

<output>
```

For example:

```text
research-1234567:

<output>
```

`<output>` is either the final fork response or the plain situation notice. The extension must not add a prefix such as `Async fork completed`. Its custom-message metadata separately includes the fork ID, immutable agent ID, and pi-fleet cursor when available. A parent custom message with the same metadata marks that output as delivered.

Parent delivery uses Pi's adaptive immediate delivery:

```ts
pi.sendMessage(message, {
  deliverAs: "steer",
  triggerTurn: true,
})
```

If the parent is working, Pi queues the result as steering before the next LLM call. If the parent is idle, Pi stores the custom message and starts a turn. The extension serializes these calls so simultaneous completed forks cannot start competing parent turns.

A completed `fork.destroyed` record retains the delivered output, its kind (`response` or `notice`), and the pi-fleet cursor when available. After restart, the extension resends that output when the active branch has no matching parent custom message. This adds no lifecycle entry.

Final-response delivery must serialize. Several finished forks can arrive while the parent is idle, and concurrent parent turn triggers can race.

## Session and context model

Each fork receives a retained child Pi session derived from the parent session's active branch.

The child session file must:

- have a fresh session ID;
- reference the parent session path;
- contain the parent header and active branch context needed by the child;
- remain available after the fleet agent is destroyed so completed fork work can be inspected later.

The session cut is the assistant entry that contains the current `create_fork` tool call. The extension finds that entry by the current `toolCallId`. It copies all earlier active-branch entries unchanged and excludes every later parent entry.

The extension clones the invoking assistant entry and removes every `toolCall` content block, including sibling tool calls from the same assistant batch. It preserves `thinking` and `text` blocks in their original order and changes `stopReason` from `toolUse` to `stop`.

If text remains, the extension keeps the projected assistant entry with its text and thinking. If no content remains, it omits the entry. If only thinking remains, it also omits the entry because some providers reject an isolated reasoning item without assistant text or a function call.

The extension must return a clear creation error if it cannot find the current `toolCallId`. It must not fall back to copying the active leaf because that leaf can contain an unresolved tool batch.

The child must never share the writable parent JSONL session file. Parent and child Pi processes must not append to the same session. Destroying a fleet agent must not delete its retained Pi session file.

## Parent-session ledger

The parent Pi session is the source of truth for fork ownership in that session branch.

The extension appends only these lifecycle custom entries:

```text
fork.created
fork.destroyed
```

`fork.created` is appended only after pi-fleet creates the agent and `agent.send()` accepts the initial task. It records the fork ID, pi-fleet name, immutable pi-fleet agent ID, selected state directory, and child session path.

`fork.destroyed` is appended only after pi-fleet destruction succeeds. It identifies the same fork and immutable agent ID, and stores the final output or situation notice, its kind, and the pi-fleet cursor when available for parent-delivery replay.

The extension rebuilds the fork ledger by reading relevant custom entries from root to tip of the active session branch. The projection retains every fork created on that branch. A create without a matching destroy is active, while a fork with both entries is historically completed.

Fork records on inactive or sibling session branches are not part of the current projection. Historical completed records remain available to `fork_status`, but their internal child session paths are not returned through tool output.

Normal tool failures return errors directly. The first version does not add intent/outcome records, a transactional workflow engine, or a second state database. A crash between an external pi-fleet action and its session entry can leave an orphan or stale record. Recovery handles that case through status and identity checks.

## Restart and lifecycle behavior

On `session_start`, the extension:

1. Reads the current active branch and rebuilds the fork inventory.
2. Connects to the configured pi-fleet state directory.
3. Restores each active fork by its pi-fleet name.
4. Verifies the returned immutable agent ID against the ledger.
5. Checks status so pi-fleet can recover a missing worker and determine settlement or a no-result condition.
6. Restarts final-response receivers.
7. Resends output from completed `fork.destroyed` records that has no matching parent custom message.

On `session_shutdown`, the extension stops receivers and closes its SDK client. It does not destroy active pi-fleet agents.

A restored fork with a missing name or mismatched immutable ID is not adopted or destroyed automatically. The extension reports the inconsistency through status.

Receiver and delivery callbacks must use a session generation guard. An old callback must not deliver into a replaced session or a different active branch. Completion processing must also recheck active-branch ownership before destruction, ledger writes, or parent delivery.

## Configuration

Configuration lives under `pi-async-fork` in normal Pi settings.

```json
{
  "pi-async-fork": {
    "agentDir": "/home/elpapi/.pi/profiles/async-fork",
    "stateDir": "~/.pi-fleet",
    "fast": {
      "provider": "openai-codex",
      "model": "gpt-5.6-luna",
      "thinking": "medium"
    },
    "balanced": {
      "provider": "openai-codex",
      "model": "gpt-5.6-terra",
      "thinking": "high"
    },
    "deep": {
      "provider": "openai-codex",
      "model": "gpt-5.6-sol",
      "thinking": "high"
    }
  }
}
```

The configuration has four concepts only:

- `agentDir`: optional complete global Pi profile for every fork. Omit it, or set it to `null`, to let pi-fleet use Pi's default profile. A project `null` overrides a configured global path;
- `stateDir`: optional pi-fleet state-directory selector. Omit it, or set it to `null`, to use pi-fleet's default `~/.pi-fleet` state directory. A project `null` overrides a configured global path;
- `fast`, `balanced`, and `deep`: model and thinking profiles.

The selected profile maps to Pi model flags when the agent is created. A missing or invalid selected profile leaves the auto-discovered extension inactive and makes all three tools return the same configuration error. It must not fail Pi session startup. Reload or restart Pi after adding valid configuration.

Global and project settings both apply. Project scalar settings replace global values. A project `null` for `agentDir` or `stateDir` explicitly selects the corresponding Pi or pi-fleet default. A project tier replaces the matching global tier as one complete profile.

## Fork Pi profile

Pi's default agent directory is `~/.pi/agent`. `PI_CODING_AGENT_DIR` selects another global Pi profile before Pi starts.

When configured, the fork `agentDir` is the complete worker-profile boundary. It can contain its own `settings.json`, `SYSTEM.md`, `AGENTS.md`, extensions, skills, prompts, themes, model definitions, package resources, and credentials policy. When it is omitted or `null`, pi-fleet starts the worker with Pi's default agent directory instead. When `stateDir` is omitted or `null`, the extension omits the SDK option and pi-fleet uses `~/.pi-fleet`.

The profile controls stable resources and extensions. It must not contain fork-specific identity, bounded-worker instructions, task text, or report instructions. These change per fork and belong in the final user prompt, so the stable system and history prefix remains cacheable.

`pi-async-fork` does not maintain an extension allowlist or pass individual extension flags to child Pi processes. The selected profile determines the fork's extension set. The profile must not load `pi-async-fork` unless recursive async forks become an explicit future feature.

Project-local `<cwd>/.pi` resources remain separate from the selected global agent directory. The fork profile's trust policy decides whether non-interactive Pi loads those project resources. Root and ancestor `AGENTS.md` context remains a Pi concern.

## pi-fleet dependency

`pi-async-fork` requires `@elpapi42/pi-fleet-sdk` version `0.13.0` or later. This version provides the public per-agent `agentDir` creation option:

```ts
client.create({
  name,
  cwd,
  agentDir,
  piArgs,
})
```

pi-fleet persists this value in its durable agent record and sets `PI_CODING_AGENT_DIR` whenever it starts or recovers that agent's Pi process. The field is intentionally narrow. It is not generic per-agent environment injection.

## Proposed module structure

```text
src/
  index.ts
  configuration.ts
  forks/
    controller.ts
    identity.ts
    ledger.ts
    session.ts
    agent.ts
    delivery.ts
    task-prompt.ts

test/
  configuration.test.mjs
  forks/
    controller.test.mjs
    identity.test.mjs
    ledger.test.mjs
    session.test.mjs
    agent.test.mjs
    delivery.test.mjs
    task-prompt.test.mjs
```

The `forks/` directory is one cohesive feature boundary. Its files use that directory context instead of repeating a `fork-` prefix.

- `index.ts` registers Pi tools and lifecycle hooks. It creates and stops the session-scoped controller and contains no fork behavior.
- `configuration.ts` loads and validates `agentDir`, `stateDir`, and the three tier profiles. Configuration types remain with this module.
- `forks/controller.ts` coordinates accepted creation, steer, status, restoration, branch protection, settlement, situation notices, and finalization. It owns current in-memory fork state and the session generation guard, but no low-level storage, SDK, or message-formatting logic.
- `forks/identity.ts` owns name validation, seven-digit suffix generation, ID formatting, and collision attempts.
- `forks/ledger.ts` owns `fork.created` and `fork.destroyed` entry shapes, active-branch projection, historical lookup, lifecycle writes, and replayable output records.
- `forks/session.ts` owns the current tool-call cut, invoking-assistant projection, retained child JSONL creation, and unregistered-session cleanup after creation failure.
- `forks/agent.ts` is the only module that imports the public pi-fleet SDK. It owns client lifetime, agent creation and restoration, status monitoring, activity receivers, serialized steering, and destruction.
- `forks/delivery.ts` is the only module that calls `pi.sendMessage()`. It owns serialized parent delivery, the exact visible envelope, internal metadata, and replay detection.
- `forks/task-prompt.ts` appends each fork's identity, inherited-context boundary, bounded-worker instructions, required `Output` and `Learnings` report contract, and the assigned task as the final section of the final user prompt.

Types remain with the module that owns their meaning. The first version has no generic `utils`, `helpers`, `models`, `constants`, shared-code directory, repository abstraction, generic pi-fleet wrapper, custom database, cost footer, subprocess runner, JSONL event parser, generic environment configuration, or copied `pi-fork` architecture.

## Scope and non-goals

The extension does not provide workspace isolation. Fork agents share the project working directory, so the extension does not claim that concurrent writes are safe. The caller and harness policy remain responsible for write coordination.

It does not include:

- long-lived specialized agents;
- user-facing agent management;
- recursive async forks;
- fork destruction tools;
- a custom database or job engine;
- cost footer or cost aggregation;
- direct imports from `pi-fork` internals;
- generic pi-fleet environment injection;
- exactly-once parent-result delivery guarantees.

Synchronous `pi-fork` remains separate and active.

## Validation required

Before daily use, prove:

1. A child receives a distinct retained session containing the intended parent active-branch context.
2. The child projection removes all tool calls from the invoking assistant entry, preserves ordered text and attached thinking, changes `toolUse` to `stop`, and includes no synthetic missing-tool results.
3. Empty and thinking-only invoking assistant projections are omitted, while a missing current `toolCallId` returns a creation error.
4. Multiple `create_fork` calls from one assistant batch produce sibling sessions from the same cut point.
5. `create_fork` creates the child session and fleet agent, starts reception, receives initial-task acceptance, appends `fork.created`, and returns before the child completes.
6. Initial creation or task-send failures destroy any created agent, remove the unregistered child session, write no ledger entry, return a clear error, and report cleanup failure when it occurs. Uncertain sends are not retried.
7. Each receiver retains the latest `message.finished` candidate, while `agent.status()` recovery behavior and `idle` settlement determine finalization.
8. An idle fork with no candidate, or an interrupted or failed fork, waits ten seconds from its first terminal-state observation, produces a plain situation notice without extension-level recovery, and then follows the normal destruction and replay path.
9. `fork_status` forwards raw pi-fleet states for active forks, treats idle forks as not steerable, and returns `completed` only for historical destroyed forks.
10. A response or notice reaches the parent once in normal operation with exactly `<forkId>:\n\n<output>` as visible content.
11. Two completed forks cannot race parent delivery while the parent is idle.
12. Automatic destruction occurs only when the owning branch is active, follows the required finalization order, writes replayable output to `fork.destroyed`, and does not delete the child session file.
13. A response or notice is not delivered, destroyed, or recorded while its owning branch is inactive, and later finalizes when that branch becomes active.
14. Session restart rebuilds active fork inventory, reconnects receivers, and resends undelivered output from `fork.destroyed` only when custom-message metadata has no match.
15. Machine or worker recovery preserves the configured `agentDir` profile, or continues with the default profile when no `agentDir` is configured.
16. Name reuse with a different immutable pi-fleet agent ID is detected and never adopted.
17. Parent session replacement or branch change prevents stale receiver delivery.
18. The final worker prompt identifies the worker as a fork, treats inherited requests as background context, keeps the profile system prompt stable, and places the assigned task after the two-section report contract as the last substantive instruction.
19. Fork names enforce the one-or-two-word rule in the tool and parameter descriptions, reject agent-supplied numbers, and produce IDs with exactly seven generated digits.
20. Fork IDs avoid current-branch history collisions and retry pi-fleet name collisions.
21. The extension does not imply workspace isolation or safe concurrent writes.

Use unit tests with a fake pi-fleet SDK and isolated real Pi plus pi-fleet integration tests. Unit tests alone cannot prove RPC startup, agent-directory selection, session loading, steering delivery, or recovery.

## Known limits and open details

- `message.finished` is only a candidate response. Finalization depends on observing `idle` through pi-fleet status monitoring and requires real integration evidence.
- The ten-second terminal-state grace period is a deliberate first-version heuristic, not proof that pi-fleet replay has caught up. A replay delayed beyond ten seconds can produce a no-result notice instead of the valid response.
- `steer_fork` checks status before adaptive delivery, but pi-fleet does not make that check and send atomic. A fork can become idle within that small interval.
- pi-fleet currently defines `failed` publicly but may not assign it in all failure paths. The extension forwards raw returned states and handles any returned `failed` as a no-result condition.
- Pi and pi-fleet do not share an atomic transaction. The first version accepts rare stale or orphan records and reconciles them conservatively. A failed initial cleanup can still leave an unregistered external agent or child session.
- Pi branch navigation has restart semantics that need integration testing for a branch-scoped fork inventory.
- The child-session file location, custom-entry renderer, and exact status response schema remain implementation details.
- The fork profile's `defaultProjectTrust` and credential strategy remain explicit profile decisions.
