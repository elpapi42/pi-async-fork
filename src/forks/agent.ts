import { connectPiFleet, type Agent, type AgentEvent, type AgentState, type PiFleetClient } from "@elpapi42/pi-fleet-sdk";

export type Candidate = { text: string; cursor: string };

export type ActivityEntry = {
  timestamp: number | null;
  kind: "thinking" | "tool" | "message";
  toolName?: string;
  args?: unknown;
  argsTruncated?: boolean;
  redacted?: boolean;
  truncated?: boolean;
};

export type ActivityStopReason = "idle" | "deadline" | "stream-ended" | "error" | "aborted";

export type ActivityCollection = {
  entries: ActivityEntry[];
  stopReason: ActivityStopReason;
  outputTruncated: boolean;
  incomplete: boolean;
};

export type ObserverCallbacks = {
  onCandidate(candidate: Candidate): void;
  onActivity(): void;
  onStatus(state: AgentState): void;
  onError(error: unknown): void;
};

type Observer = {
  stopped: boolean;
  iterator?: AsyncIterator<AgentEvent>;
  timer?: NodeJS.Timeout;
  wake?: () => void;
};

type ActivityTimers = {
  set(delay: number, callback: () => void): unknown;
  clear(handle: unknown): void;
};

type AgentOptions = { timers?: ActivityTimers };

const ACTIVITY_IDLE_MS = 1_000;
const ACTIVITY_DEADLINE_MS = 3_000;
const MAX_TOOL_ARGS_BYTES = 512;
const MAX_ACTIVITY_BYTES = 16 * 1_024;
const SECRET_KEY = /(?:password|passphrase|secret|token|authorization|api[_-]?key|cookie|credential)/i;

function defaultActivityTimers(): ActivityTimers {
  return {
    set(delay, callback) { return setTimeout(callback, delay); },
    clear(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
  };
}

function activityBytes(entries: readonly ActivityEntry[]): number {
  return Buffer.byteLength(JSON.stringify(entries));
}

function compactActivity(event: AgentEvent): ActivityEntry | undefined {
  const timestamp = Number.isFinite(event.timestamp) ? event.timestamp : null;
  if (event.type === "thinking.started") return { timestamp, kind: "thinking" };
  if (event.type === "message.finished") return { timestamp, kind: "message" };
  if (event.type !== "tool.started") return undefined;
  const args = compactArgs(event.args);
  return {
    timestamp,
    kind: "tool",
    toolName: event.toolName,
    args: args.value,
    argsTruncated: event.argsTruncated,
    redacted: args.redacted,
    truncated: args.truncated,
  };
}

function compactArgs(value: unknown): { value: unknown; redacted: boolean; truncated: boolean } {
  const sanitized = sanitize(value);
  if (jsonBytes(sanitized.value) <= MAX_TOOL_ARGS_BYTES) return { ...sanitized, truncated: false };
  return { value: "[TRUNCATED]", redacted: sanitized.redacted, truncated: true };
}

function sanitize(value: unknown): { value: unknown; redacted: boolean } {
  if (typeof value === "string") {
    const text = redactText(value);
    return { value: text.value, redacted: text.redacted };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    const items = value.map((item) => {
      const sanitized = sanitize(item);
      redacted ||= sanitized.redacted;
      return sanitized.value;
    });
    return { value: items, redacted };
  }
  if (value && typeof value === "object") {
    let redacted = false;
    const object: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const next = SECRET_KEY.test(key) ? { value: "[REDACTED]", redacted: true } : sanitize(item);
      Object.defineProperty(object, key, { value: next.value, enumerable: true, configurable: true, writable: true });
      redacted ||= next.redacted;
    }
    return { value: object, redacted };
  }
  return { value, redacted: false };
}

function redactText(value: string): { value: string; redacted: boolean } {
  let redacted = false;
  const replace = (pattern: RegExp, replacement: string) => {
    const next = value.replace(pattern, replacement);
    if (next !== value) redacted = true;
    value = next;
  };
  replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, "$1 [REDACTED]");
  replace(/\b(Authorization)\s*:\s*([A-Za-z][A-Za-z0-9_-]*)\s+[^'"\s,;]+/gi, "$1: $2 [REDACTED]");
  replace(/\bX-Api-Key\s*:\s*[^'"\s,;]+/gi, "X-Api-Key: [REDACTED]");
  replace(/\bCookie\s*:\s*[^'"\r\n]*(?=['"]|$)/gi, "Cookie: [REDACTED]");
  replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSPHRASE|CREDENTIALS?))=([^\s'";]+)/gi, "$1=[REDACTED]");
  replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
  replace(/([?&](?:(?:access|api)(?:_|%5f|-)?(?:token|key)|token|password|secret)=)[^&#\s]+/gi, "$1[REDACTED]");
  return { value, redacted };
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export interface ManagedAgents {
  start(): Promise<void>;
  stop(): Promise<void>;
  create(name: string, cwd: string, agentDir: string | undefined, piArgs: string[], env?: Record<string, string>): Promise<Agent>;
  restore(name: string, agentId: string): Promise<Agent>;
  status(agent: Agent): Promise<AgentState>;
  collectActivity?(agent: Agent, limit: number | undefined, signal?: AbortSignal): Promise<ActivityCollection>;
  steer(agent: Agent, message: string): Promise<void>;
  observe(agent: Agent, after: string | undefined, callbacks: ObserverCallbacks): void;
  stopObserving(agentId: string): void;
  destroy(agent: Agent): Promise<void>;
}

export class Agents implements ManagedAgents {
  readonly #stateDir: string | undefined;
  readonly #connect: typeof connectPiFleet;
  readonly #timers: ActivityTimers;
  #client: PiFleetClient | undefined;
  readonly #observers = new Map<string, Observer>();
  readonly #sendTails = new Map<string, Promise<void>>();

  constructor(stateDir: string | undefined, connect: typeof connectPiFleet = connectPiFleet, options: AgentOptions = {}) {
    this.#stateDir = stateDir;
    this.#connect = connect;
    this.#timers = options.timers ?? defaultActivityTimers();
  }

  async start(): Promise<void> {
    this.#client ??= await this.#connect(this.#stateDir ? { stateDir: this.#stateDir } : {});
  }

  async stop(): Promise<void> {
    for (const id of [...this.#observers.keys()]) this.stopObserving(id);
    await this.#client?.close();
    this.#client = undefined;
  }

  async create(name: string, cwd: string, agentDir: string | undefined, piArgs: string[], env?: Record<string, string>): Promise<Agent> {
    return (await this.client()).create({ name, cwd, ...(agentDir ? { agentDir } : {}), ...(env ? { env } : {}), piArgs });
  }

  async restore(name: string, agentId: string): Promise<Agent> {
    const agent = await (await this.client()).get(name);
    if (agent.id !== agentId) throw new Error(`pi-fleet agent ${name} has an unexpected immutable ID.`);
    return agent;
  }

  async status(agent: Agent): Promise<AgentState> {
    return (await agent.status()).state;
  }

  async collectActivity(agent: Agent, limit: number | undefined, signal?: AbortSignal): Promise<ActivityCollection> {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
      throw new TypeError("Activity limit must be a positive integer.");
    }

    const entries: ActivityEntry[] = [];
    let outputTruncated = false;
    let stopReason: ActivityStopReason = "stream-ended";
    let iterator: AsyncIterator<AgentEvent> | undefined;
    let closePromise: Promise<void> | undefined;
    let idleTimer: unknown;
    let deadlineTimer: unknown;
    let resolveStop!: () => void;
    const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });

    const close = (): Promise<void> => {
      closePromise ??= Promise.resolve(iterator?.return?.()).then(() => undefined, () => undefined);
      return closePromise;
    };
    const stop = (reason: ActivityStopReason) => {
      if (stopReason !== "stream-ended") return;
      stopReason = reason;
      resolveStop();
      void close();
    };
    const resetIdle = () => {
      if (idleTimer !== undefined) this.#timers.clear(idleTimer);
      idleTimer = this.#timers.set(ACTIVITY_IDLE_MS, () => stop("idle"));
    };
    const append = (entry: ActivityEntry) => {
      if (limit !== undefined) {
        entries.push(entry);
        while (entries.length > limit) entries.shift();
        while (entries.length > 0 && activityBytes(entries) > MAX_ACTIVITY_BYTES) {
          entries.shift();
          outputTruncated = true;
        }
        return;
      }
      if (activityBytes([...entries, entry]) > MAX_ACTIVITY_BYTES) {
        outputTruncated = true;
        return;
      }
      entries.push(entry);
    };

    try {
      const stream = agent.receive({ fromStart: true });
      iterator = stream[Symbol.asyncIterator]();
      resetIdle();
      deadlineTimer = this.#timers.set(ACTIVITY_DEADLINE_MS, () => stop("deadline"));
      const abort = () => stop("aborted");
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      try {
        while (stopReason === "stream-ended") {
          const result = await Promise.race([
            iterator.next().then((value) => ({ type: "next" as const, value }), (error) => ({ type: "error" as const, error })),
            stopped.then(() => ({ type: "stopped" as const })),
          ]);
          if (result.type === "stopped") break;
          if (result.type === "error") {
            stop("error");
            break;
          }
          if (result.value.done) break;
          resetIdle();
          const entry = compactActivity(result.value.value);
          if (entry) append(entry);
        }
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    } catch {
      stopReason = "error";
    } finally {
      if (idleTimer !== undefined) this.#timers.clear(idleTimer);
      if (deadlineTimer !== undefined) this.#timers.clear(deadlineTimer);
      await close();
    }

    return {
      entries,
      stopReason,
      outputTruncated,
      incomplete: stopReason !== "stream-ended",
    };
  }

  async steer(agent: Agent, message: string): Promise<void> {
    const previous = this.#sendTails.get(agent.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => { await agent.send(message, { delivery: "steer" }); });
    this.#sendTails.set(agent.id, next);
    try {
      await next;
    } finally {
      if (this.#sendTails.get(agent.id) === next) this.#sendTails.delete(agent.id);
    }
  }

  observe(agent: Agent, after: string | undefined, callbacks: ObserverCallbacks): void {
    this.stopObserving(agent.id);
    const observer: Observer = { stopped: false };
    this.#observers.set(agent.id, observer);
    void this.receive(agent, after, observer, callbacks);
    void this.poll(agent, observer, callbacks);
  }

  stopObserving(agentId: string): void {
    const observer = this.#observers.get(agentId);
    if (!observer) return;
    observer.stopped = true;
    if (observer.timer) clearTimeout(observer.timer);
    observer.wake?.();
    void observer.iterator?.return?.().catch(() => undefined);
    this.#observers.delete(agentId);
  }

  async destroy(agent: Agent): Promise<void> {
    await agent.destroy();
    this.stopObserving(agent.id);
  }

  private async poll(agent: Agent, observer: Observer, callbacks: ObserverCallbacks): Promise<void> {
    while (!observer.stopped) {
      try {
        const status = await agent.status();
        if (observer.stopped) return;
        callbacks.onStatus(status.state);
      } catch (error) {
        if (observer.stopped) return;
        callbacks.onError(error);
      }
      await new Promise<void>((resolve) => {
        observer.wake = resolve;
        observer.timer = setTimeout(resolve, 1_000);
      });
      observer.timer = undefined;
      observer.wake = undefined;
    }
  }

  private async receive(agent: Agent, after: string | undefined, observer: Observer, callbacks: ObserverCallbacks): Promise<void> {
    try {
      const stream = agent.receive(after ? { after } : { fromStart: true });
      const iterator = stream[Symbol.asyncIterator]();
      observer.iterator = iterator;
      while (!observer.stopped) {
        const next = await iterator.next();
        if (next.done) return;
        if (next.value.type === "message.finished") {
          callbacks.onCandidate({ text: next.value.text, cursor: next.value.cursor });
        } else if (next.value.type !== "agent.destroyed") {
          callbacks.onActivity();
        }
      }
    } catch (error) {
      if (!observer.stopped) callbacks.onError(error);
    }
  }

  private async client(): Promise<PiFleetClient> {
    await this.start();
    if (!this.#client) throw new Error("pi-fleet client did not start.");
    return this.#client;
  }
}
