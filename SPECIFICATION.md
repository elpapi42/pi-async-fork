# pi-async-fork specification

## Purpose

`pi-async-fork` makes forks durable, asynchronous context branches.

A main Pi agent creates bounded work and immediately continues. A pi-fleet agent runs the work independently. The extension sends meaningful intermediate reports and the final assistant response back to the parent as steering messages.

The parent remains the orchestrator. Async forks are temporary work branches. They are not user-facing agents, long-lived specialists, or workflow owners.

## Behavior change

Synchronous `pi-fork` behavior is:

```text
fork → wait → result → continue
```

`pi-async-fork` behavior is:

```text
create fork → receive fork ID → continue → receive progress and final reports later
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
create_fork(name, task, effort?) → fork ID
```

The agent supplies a short semantic name for the work. The name does not need to be unique. It must contain one or two lowercase words, with one hyphen between two words. Each word contains letters only. The agent must not add a number because the tool appends the generated seven-digit suffix.

The tool creates a retained child session, creates a durable pi-fleet agent, starts its receiver, and sends the assigned task followed by a concise report-format requirement. It appends `fork.created` only after `agent.send()` accepts that message, then returns the canonical fork ID without waiting for completion.

Successful send acceptance is the registration boundary. The public pi-fleet SDK cannot reliably expose a separately observed `working` transition for fast tasks because a task can settle before status observation.

If child-session creation, fleet creation, or initial task delivery fails, the tool destroys any created fleet agent, deletes the unregistered child session file, writes no lifecycle entry, and returns a clear error. An uncertain send is a delivery failure and must not be retried automatically. If cleanup also fails, the error reports both the original failure and cleanup failure.

The `create_fork` tool description and its `name` parameter description must state all naming rules. They must include the one-or-two-word limit, lowercase letters-only rule, optional single separator, prohibition against agent-supplied numbers, generated suffix behavior, and requirement to use the returned fork ID for later calls.

`effort` accepts `fast`, `balanced`, or `deep`. Choose it from the primary cognitive job and required reasoning depth. Use the lowest effort that can reliably complete the task. Effort changes reasoning depth, not task scope. `fast` is bounded read-only evidence gathering for lookups, codebase exploration, documentation or web research, exact checks, inventories, and source or relationship tracing. It returns facts and does not make final judgments, recommendations, diagnoses, approval or gate decisions, or changes. `balanced` applies bounded judgment or settled execution for review, plan validation, test interpretation, bounded diagnosis, research synthesis, implementation planning, and scoped changes. `deep` applies frontier uncertainty or the hardest reasoning for novel architecture, unclear root causes, conflicting evidence, difficult security or data analysis, complex system behavior, major product decisions, broad blast radius, and hard-to-reverse choices. If fast evidence needs judgment, use `balanced`; if it exposes complex uncertainty, use `deep`. The fixed default is `balanced`.

In the Pi TUI, `create_fork` uses one content line: `create_fork [<effort>] <fork ID>`. Before creation returns the generated ID, it shows `<name>-…`. The expanded view adds the full task under `─── Task ───`. `steer_fork` uses `steer_fork <fork ID>` and adds the full steering message under `─── Message ───` only when expanded. `fork_status` uses `fork_status <fork ID>: <state>` after its result returns and has no expanded content. Brackets apply only to the `create_fork` effort. Normal successful result output, activity, usage, cost, and expansion hints remain hidden. Tool errors remain visible. The displayed ID is the public fork ID, not pi-fleet's internal agent UUID.

Fork result custom messages retain the model-visible fork-ID prefix `<forkId>:\n\n` followed by a progress, final, or notice sentence and then the report. Progress says `This is an intermediate progress report. The fork is still working and can receive steering.` Final output says `This is the final report. The fork finished and can no longer receive steering.` A notice says `This is a terminal notice. The fork can no longer receive steering.`

A dedicated TUI renderer shows `● fork <forkId>: working` for progress, `✓ fork <forkId>: completed` for a response, or `⚠ fork <forkId>: terminal` for a notice. In Pi's global collapsed mode, it shows only that header. In expanded mode, it adds a blank line and Markdown report output. It uses the active theme's `customMessageBg` panel and `customMessageText` body color so the result remains distinct from user and assistant messages. Delivery metadata carries `kind: "progress" | "response" | "notice"` for this display only. The renderer removes the model-only classification sentence from Markdown. Legacy result messages without `kind` use a neutral marker. The renderer does not expose pi-fleet agent IDs or cursors.

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

The extension receives pi-fleet activity in the background. Forks remain one-off workers: multi-phase tasks report meaningful checkpoints while working, then send one final report or terminal notice before automatic destruction.

A multi-phase task must send one intermediate report only after a completed phase produces a concrete, task-relevant finding supported by evidence already obtained. Plans, intended sources, and unstarted work do not qualify. An intermediate report states what the evidence changes, material uncertainty, remaining work, and the next action. It must not use completion language. A later report must add evidence that changes the recommendation, scope, risk, or next action, resolve a named uncertainty, or complete a distinct phase. New citations, restated findings, and repeated next actions do not qualify. Workers do not report simple one-phase work, raw thinking, each tool action, elapsed time, or waiting. Every visible checkpoint and final worker report must use `## Output` and `## Learnings`. An intermediate report stays short and focused, with source URLs inline when needed. This brevity requirement does not apply to final reports, which retain the task-adapted report contract. An intermediate report must include the next necessary tool call in the same assistant response so the current Pi run continues. A text-only response with no next tool call is final.

Each active-fork receiver holds visible pi-fleet `message.finished` text and its cursor in arrival order. It reports raw later activity only to the controller, never to the parent. Later activity, including a newer visible message, proves that the previous held report continued. The controller delivers that report as progress only when the latest monitored pi-fleet status is `working`, the owning branch is active, and no persisted parent custom message has the same public fork ID, immutable agent ID, and cursor. It does not remove a held report before branch-safe delivery succeeds.

The controller keeps held reports pending when pi-fleet status becomes `idle`. It waits ten seconds from the first terminal-state observation because status polling and activity delivery are separate paths. Delayed activity marks earlier reports as continued but does not replace an authoritative terminal status. If status returns to `working`, those reports can be delivered as progress. If terminal status remains through the grace period, only the latest held report becomes the idle final response. If no report remains, or status returns `interrupted` or `failed`, the extension creates a plain terminal notice. It does not attempt its own worker recovery.

Before progress delivery, finalization, or notice handling, the extension confirms that the current active-branch ledger owns the exact fork ID and immutable pi-fleet agent ID. If the owning branch is inactive, the extension does not deliver a report or notice, destroy the fleet agent, or append an entry. It leaves the fleet agent and its replayable activity intact. When that branch becomes active again, the extension reconnects, replays held reports, checks current status, and then handles progress, settlement, or a no-result condition. A fork report or notice must never enter a sibling branch.

For an active owning branch, finalization or no-result handling occurs in this order:

```text
capture output or create notice → destroy pi-fleet agent → append fork.destroyed → deliver to parent
```

Parent delivery does not keep the finished fleet agent alive.

Each parent report retains this visible fork-ID prefix:

```text
<forkId>:

<classification sentence>

<report>
```

A progress report uses the explicit progress sentence and says that steering remains possible. A final report uses the explicit final sentence and says that steering is no longer possible. A terminal notice uses the explicit notice sentence. Its custom-message metadata separately includes the fork ID, immutable agent ID, report kind, and pi-fleet cursor when available. A parent custom message with the same identity marks that report as delivered.

Parent delivery uses Pi's adaptive immediate delivery:

```ts
pi.sendMessage(message, {
  deliverAs: "steer",
  triggerTurn: true,
})
```

If the parent is working, Pi queues the result as steering before the next LLM call. If the parent is idle, Pi stores the custom message and starts a turn. The extension serializes these calls so simultaneous completed forks cannot start competing parent turns.

Progress remains delivery history only. It never adds `fork.created` or `fork.destroyed` entries. A completed `fork.destroyed` record retains only the final output or notice, its kind (`response` or `notice`), and the pi-fleet cursor when available. After restart, an active working fork can resend missing progress when the active branch has no matching parent custom message. A completed fork can resend its missing final report from `fork.destroyed`. This adds no lifecycle entry.

All report delivery must serialize. Several progress or final reports can arrive while the parent is idle, and concurrent parent turn triggers can race. `pi.sendMessage()` has no delivery acknowledgement. The extension provides at-least-once replay with cursor duplicate suppression after a parent custom message persists. It does not provide exactly-once delivery, and a parent process can lose a queued progress report before Pi consumes and persists it.

## Session and context model

Each fork receives a retained child Pi session derived from the parent session's active branch.

The child session file must:

- have a fresh session ID;
- reference the parent session path;
- contain the parent header and active branch context needed by the child;
- remain available after the fleet agent is destroyed so completed fork work can be inspected later.

The session cut is the assistant entry that contains the current `create_fork` tool call. The extension finds that entry by the current `toolCallId`. It copies all earlier active-branch entries unchanged and excludes every later parent entry.

The extension clones the invoking assistant entry and removes every `toolCall` content block, including sibling tool calls from the same assistant batch. It preserves remaining `thinking` and `text` blocks in their original order and changes `stopReason` from `toolUse` to `stop`. It keeps a thinking-only cleaned entry and omits the cleaned entry only when no content remains.

After that cleaned entry, the extension adds a `pi-async-fork-child` custom entry containing version `1`, the fresh child session ID, and the public fork ID. The marker links to the cleaned entry, or to the invoking entry's parent when cleaning removed all content. The marker is extension state and does not enter model context. A matching marker and session-header ID identify an async child across restart and branch navigation. Copied markers for other session IDs do not identify the current session.

The extension always adds a synthetic assistant boundary with a new entry ID after the marker. The boundary links to the marker. It reuses only the source provider, API, and model metadata, has zero usage, has no `responseId` or reasoning signature, and uses `stopReason: "stop"`. Its static text starts with the assistant-role runtime declaration `I am a fork.`, frames earlier messages as main-agent context, commits the worker to the next user task, requires it to stay within scope and report out-of-scope findings without acting on them, explicitly prohibits `create_fork`, `fork_status`, `steer_fork`, and other delegation tools even when available, and contains the two-section report contract. It also prohibits any tool or action that defers work to a later run, future wake-up, passive wait, or background continuation. This rule is capability-based and does not depend on tool names. Normal tools that return during the current run remain allowed. The fork ID appears at the end of the boundary so sibling forks can share the longest input prefix.

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
6. Restarts report receivers for active forks.
7. Resends missing progress or completed `fork.destroyed` reports only when parent custom-message metadata has no match.

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
    "env": { "PI_OBSERVATIONAL_MEMORY_PASSIVE": "1" },
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

The configuration has five concepts only:

- `agentDir`: optional complete global Pi profile for every fork. Omit it, or set it to `null`, to let pi-fleet use Pi's default profile. A project `null` overrides a configured global path;
- `stateDir`: optional pi-fleet state-directory selector. Omit it, or set it to `null`, to use pi-fleet's default `~/.pi-fleet` state directory. A project `null` overrides a configured global path;
- `env`: optional string-to-string overlay for fork Pi processes. It is not applied to the parent Pi process or pi-fleet worker;
- `fast`, `balanced`, and `deep`: model and thinking profiles.

`PATH` and `PI_CODING_AGENT_DIR` are reserved. Environment names must be non-empty and cannot contain `=` or a null byte. Values must be strings without null bytes. Empty string values are valid. Do not use `env` for secrets: pi-fleet persists values in agent state and backups, and child processes can expose them in logs or activity.

The selected profile maps to Pi model flags when the agent is created. The resolved `env` map passes only to that Pi child. Pi-fleet persists it through Pi and worker recovery. Existing forks retain their immutable recorded map until destruction, so configuration changes affect only new forks. pi-async-fork does not duplicate this map in its session ledger. A missing or invalid selected profile leaves the auto-discovered extension inactive and makes all three tools return the same configuration error. It must not fail Pi session startup. Reload or restart Pi after adding valid configuration.

Global and project settings both apply. Project scalar settings replace global values. A project `null` for `agentDir` or `stateDir` explicitly selects the corresponding Pi or pi-fleet default. A project effort profile replaces the matching global profile as one complete profile. Project `env` objects merge by key with global values: a project string overrides one value, a project key set to `null` removes one inherited value, `env: null` clears all inherited values, and `env: {}` retains inherited values. Omitted or empty resolved maps pass no SDK overlay.

## Fork Pi profile

Pi's default agent directory is `~/.pi/agent`. `PI_CODING_AGENT_DIR` selects another global Pi profile before Pi starts.

When configured, the fork `agentDir` is the complete worker-profile boundary. It can contain its own `settings.json`, `SYSTEM.md`, `AGENTS.md`, extensions, skills, prompts, themes, model definitions, package resources, and credentials policy. When it is omitted or `null`, pi-fleet starts the worker with Pi's default agent directory instead. When `stateDir` is omitted or `null`, the extension omits the SDK option and pi-fleet uses `~/.pi-fleet`.

The profile controls stable resources and extensions. It does not contain fork-specific identity, bounded-worker instructions, task text, or report instructions. The extension adds identity, context framing, and the full report contract in a synthetic assistant boundary at the child-session tail. The next user message contains the unchanged assigned task followed by a concise requirement for the exact `Output` and `Learnings` headings. This dynamic message does not change the stable system and inherited-history prefix.

`pi-async-fork` does not maintain an extension allowlist or pass individual extension flags to child Pi processes. The selected profile determines the fork's extension set. If the profile loads `pi-async-fork` inside a marked child session, the extension does not start its controller and all three async-fork tools return a task-focused child-session error. `Controller.create()` repeats the guard for future internal call paths.

Project-local `<cwd>/.pi` resources remain separate from the selected global agent directory. The fork profile's trust policy decides whether non-interactive Pi loads those project resources. Root and ancestor `AGENTS.md` context remains a Pi concern.

## pi-fleet dependency

`pi-async-fork` requires `@elpapi42/pi-fleet-sdk` version `0.14.0` or later. This version provides public per-agent `agentDir` and child-Pi `env` creation options:

```ts
client.create({
  name,
  cwd,
  agentDir,
  env,
  piArgs,
})
```

pi-fleet persists both values in its agent record. It sets `PI_CODING_AGENT_DIR` from `agentDir` and applies `env` only when it starts or recovers that agent's Pi process. It does not apply `env` to the pi-fleet worker or SDK process.

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
- `configuration.ts` loads and validates `agentDir`, `stateDir`, `env`, and the three effort profiles. Configuration types remain with this module.
- `forks/controller.ts` coordinates accepted creation, steer, status, restoration, branch protection, ordered report classification, settlement, situation notices, and finalization. It owns current in-memory fork state and the session generation guard, but no low-level storage, SDK, or message-formatting logic.
- `forks/identity.ts` owns name validation, seven-digit suffix generation, ID formatting, and collision attempts.
- `forks/ledger.ts` owns `fork.created` and `fork.destroyed` entry shapes, active-branch projection, historical lookup, lifecycle writes, and replayable output records.
- `forks/session.ts` owns the current tool-call cut, invoking-assistant projection, durable child-session marker and detection, linked synthetic assistant boundary entry, retained child JSONL creation, and unregistered-session cleanup after creation failure.
- `forks/agent.ts` is the only module that imports the public pi-fleet SDK. It owns client lifetime, agent creation and restoration, status monitoring, ordered activity receivers, serialized steering, and destruction.
- `forks/delivery.ts` is the only module that calls `pi.sendMessage()`. It owns serialized parent progress, final, and notice delivery, model-visible envelopes, display metadata, and replay detection.
- `forks/render.ts` owns the async-fork TUI rendering. It transfers returned fork IDs and states through Pi's row-local renderer state, updates its retained call components directly without reentrant invalidation, and never renders normal successful fork output or activity.
- `forks/task-prompt.ts` owns the synthetic assistant boundary text, including identity, inherited-context framing, bounded-worker instructions, milestone-report protocol, and the full `Output` and `Learnings` report contract. It also owns the assigned-task user message, its evidence-, state-, novelty-, and brevity-gated progress-report requirement, and its concise final-response format requirement.

Types remain with the module that owns their meaning. The first version has no generic `utils`, `helpers`, `models`, `constants`, shared-code directory, repository abstraction, generic pi-fleet wrapper, custom database, cost footer, subprocess runner, JSONL event parser, or copied `pi-fork` architecture.

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
- exactly-once parent-result delivery guarantees.

Synchronous `pi-fork` remains separate and active.

## Validation required

Before daily use, prove:

1. A child receives a distinct retained session containing the intended parent active-branch context.
2. The child projection removes all tool calls from the invoking assistant entry, preserves ordered text and thinking, changes `toolUse` to `stop`, and includes no synthetic missing-tool results.
3. A thinking-only cleaned invoking assistant is retained. An empty cleaned entry is omitted. Both paths add a `pi-async-fork-child` custom marker linked before the synthetic assistant boundary, while a missing current `toolCallId` returns a creation error.
4. The marker contains version `1`, the current child session ID, and the public fork ID. Detection uses all session entries but accepts only a marker matching the current session-header ID. The boundary links to the marker and has a distinct ID, zero usage, no source response ID or reasoning signature, stable context framing and report text, and the fork ID at its end.
5. Multiple `create_fork` calls from one assistant batch produce sibling sessions from the same cut point.
6. `create_fork` creates the child session and fleet agent, starts reception, sends the assigned task followed by the evidence-, state-, novelty-, and brevity-gated progress-report requirement and concise final-response format requirement as user content, receives initial-task acceptance, appends `fork.created`, and returns before the child completes.
7. Initial creation or task-send failures destroy any created agent, remove the unregistered child session, write no ledger entry, return a clear error, and report cleanup failure when it occurs. Uncertain sends are not retried.
8. Each receiver preserves visible `message.finished` reports and ordered later activity. A later activity marks the previous held report as continued. Current `working` status permits its progress delivery, while terminal status remains authoritative.
9. An idle fork waits ten seconds from its first terminal-state observation before classifying only its latest held report as final. Delayed activity can release progress only after current status returns to `working`. An idle fork with no held report, or an interrupted or failed fork, produces a plain situation notice without extension-level recovery and then follows the normal destruction and replay path.
10. `fork_status` forwards raw pi-fleet states for active forks, treats idle forks as not steerable, and returns `completed` only for historical destroyed forks.
11. A progress, response, or notice reaches the parent in report order with the fork-ID prefix and its explicit model-visible classification sentence. Progress says steering remains possible; response and notice say it is not.
12. Progress reports remain active-fork delivery history only. They do not add lifecycle records. Cursor metadata deduplicates already persisted progress and final reports across active-branch replay.
13. Several progress or final reports cannot race parent delivery while the parent is idle.
14. Automatic destruction occurs only when the owning branch is active, follows the required finalization order, writes replayable final output to `fork.destroyed`, and does not delete the child session file.
15. A progress, response, or notice is not delivered, destroyed, or recorded while its owning branch is inactive. Progress and final handling resume only when that branch becomes active.
16. Session restart rebuilds active fork inventory and reconnects receivers. An active working fork resends missing progress only when custom-message metadata has no match. A destroyed fork resends missing completed output from `fork.destroyed` under the same rule.
17. Machine or worker recovery preserves the configured `agentDir` profile, or continues with the default profile when no `agentDir` is configured.
18. Name reuse with a different immutable pi-fleet agent ID is detected and never adopted.
19. Parent session replacement or branch change prevents stale receiver delivery.
20. The synthetic assistant boundary starts with the exact assistant-role runtime declaration `I am a fork.`, identifies the worker as a fork rather than the main agent, assigns inherited assistant messages to the main agent, marks inherited requests inactive, requires the worker to stay within scope and report out-of-scope findings without acting on them, explicitly prohibits `create_fork`, `fork_status`, `steer_fork`, and other delegation tools even when available, prohibits capability-equivalent deferred completion or later-run tooling without relying on names, defines the two-section checkpoint contract and same-response next-tool-call rule, and contains the two-section report contract. The next user message contains the assigned task followed by an evidence-, state-, novelty-, and brevity-gated progress-report requirement and a concise requirement to use both exact final-report headings, including for one-line tasks.
21. A marked child does not start an async-fork controller. All three public async-fork tools reject calls with the same task-focused error, and direct `Controller.create()` calls reject before child-session or agent creation.
22. Fork names enforce the one-or-two-word rule in the tool and parameter descriptions, reject agent-supplied numbers, and produce IDs with exactly seven generated digits.
23. Fork IDs avoid current-branch history collisions and retry pi-fleet name collisions.
24. The collapsed `create_fork` TUI call is one content line with its effort and public fork ID, the pending state uses `<name>-…`, and the expanded view adds only the full task. `steer_fork` and `fork_status` use their exact tool names as headers, the steering message appears only when expanded, and status appends its state after a result. Normal successful result output, activity, usage, cost, and expansion hints remain hidden, while tool errors remain visible.
25. Result custom-message content includes the fork-ID prefix and an explicit progress, final, or notice sentence for model context. The TUI renderer shows `working` for progress, `completed` for final output, and `terminal` with a warning for notices. It shows Markdown output only in Pi's global expanded mode and never shows internal agent IDs, cursors, or the model-only sentence.
26. The extension does not imply workspace isolation or safe concurrent writes.
27. Environment configuration merges global and project values by the documented key rules, rejects reserved or invalid entries, reaches only new child Pi processes, and preserves empty strings. It is absent from the async-fork ledger, while pi-fleet persists and recovers it.

Use unit tests with a fake pi-fleet SDK and isolated real Pi plus pi-fleet integration tests. Unit tests alone cannot prove RPC startup, agent-directory selection, session loading, steering delivery, or recovery.

## Known limits and open details

- `message.finished` has no task or tool-call correlation. The extension classifies a held report from later ordered activity or terminal grace. This requires real integration evidence.
- The ten-second terminal-state grace period is a deliberate first-version heuristic, not proof that pi-fleet activity replay has caught up. Delayed continuation beyond ten seconds can classify an intermediate report as final, while delayed final activity can still produce a no-result notice.
- `pi.sendMessage()` has no delivery acknowledgement. A queued progress report can be lost if the parent exits before Pi consumes and persists it. Cursor duplicate suppression applies only after the parent custom message exists.
- `steer_fork` checks status before adaptive delivery, but pi-fleet does not make that check and send atomic. A fork can become idle within that small interval.
- pi-fleet currently defines `failed` publicly but may not assign it in all failure paths. The extension forwards raw returned states and handles any returned `failed` as a no-result condition.
- Pi and pi-fleet do not share an atomic transaction. The first version accepts rare stale or orphan records and reconciles them conservatively. A failed initial cleanup can still leave an unregistered external agent or child session.
- Pi branch navigation has restart semantics that need integration testing for a branch-scoped fork inventory.
- The child-session file location, custom-entry renderer, and exact status response schema remain implementation details.
- The child-session marker blocks this extension's tools. It does not block direct pi-fleet CLI commands through a shell; stronger command isolation requires a restricted profile or sandbox.
- The fork profile's `defaultProjectTrust` and credential strategy remain explicit profile decisions.
