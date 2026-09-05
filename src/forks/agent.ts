import { connectPiFleet, type Agent, type AgentEvent, type AgentState, type PiFleetClient } from "@elpapi42/pi-fleet-sdk";

export type Candidate = { text: string; cursor: string };

export type ObserverCallbacks = {
  onCandidate(candidate: Candidate): void;
  onStatus(state: AgentState): void;
  onError(error: unknown): void;
};

type Observer = {
  stopped: boolean;
  iterator?: AsyncIterator<AgentEvent>;
  timer?: NodeJS.Timeout;
  wake?: () => void;
};

export interface ManagedAgents {
  start(): Promise<void>;
  stop(): Promise<void>;
  create(name: string, cwd: string, agentDir: string, piArgs: string[]): Promise<Agent>;
  restore(name: string, agentId: string): Promise<Agent>;
  status(agent: Agent): Promise<AgentState>;
  steer(agent: Agent, message: string): Promise<void>;
  observe(agent: Agent, after: string | undefined, callbacks: ObserverCallbacks): void;
  stopObserving(agentId: string): void;
  destroy(agent: Agent): Promise<void>;
}

export class Agents implements ManagedAgents {
  readonly #stateDir: string;
  #client: PiFleetClient | undefined;
  readonly #observers = new Map<string, Observer>();
  readonly #sendTails = new Map<string, Promise<void>>();

  constructor(stateDir: string) {
    this.#stateDir = stateDir;
  }

  async start(): Promise<void> {
    this.#client ??= await connectPiFleet({ stateDir: this.#stateDir });
  }

  async stop(): Promise<void> {
    for (const id of [...this.#observers.keys()]) this.stopObserving(id);
    await this.#client?.close();
    this.#client = undefined;
  }

  async create(name: string, cwd: string, agentDir: string, piArgs: string[]): Promise<Agent> {
    return (await this.client()).create({ name, cwd, agentDir, piArgs });
  }

  async restore(name: string, agentId: string): Promise<Agent> {
    const agent = await (await this.client()).get(name);
    if (agent.id !== agentId) throw new Error(`pi-fleet agent ${name} has an unexpected immutable ID.`);
    return agent;
  }

  async status(agent: Agent): Promise<AgentState> {
    return (await agent.status()).state;
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
        if (next.value.type === "message.finished") callbacks.onCandidate({ text: next.value.text, cursor: next.value.cursor });
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
