import { AgentNameTakenError, type Agent, type AgentState } from "@elpapi42/pi-fleet-sdk";
import type { Configuration, Tier } from "../configuration.js";
import { Agents, type Candidate, type ManagedAgents } from "./agent.js";
import { Delivery } from "./delivery.js";
import { createId, maxIdAttempts } from "./identity.js";
import { active, appendCreated, appendDestroyed, project, type Created, type Destroyed } from "./ledger.js";
import { assertForkToolsAvailable, createChildSession, removeChildSession } from "./session.js";
import { buildAssignedTask } from "./task-prompt.js";

type Running = Created & {
  agent: Agent;
  registered: boolean;
  candidate?: Candidate;
  state?: AgentState;
  terminalSince?: number;
  finalizing?: boolean;
};

const NO_OUTPUT_IDLE = "Fork idle without a confirmed final assistant response.";
const SETTLEMENT_GRACE_MS = 10_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Async fork operation was aborted.");
}

export class Controller {
  readonly #pi: any;
  readonly #configuration: Configuration;
  readonly #agents: ManagedAgents;
  readonly #delivery = new Delivery();
  readonly #running = new Map<string, Running>();
  readonly #unavailable = new Map<string, string>();
  #generation = 0;
  #paused = false;
  #lifecycleTail: Promise<void> = Promise.resolve();
  readonly #now: () => number;

  constructor(
    pi: any,
    configuration: Configuration,
    agents: ManagedAgents = new Agents(configuration.stateDir),
    now: () => number = Date.now,
  ) {
    this.#pi = pi;
    this.#configuration = configuration;
    this.#agents = agents;
    this.#now = now;
  }

  async start(ctx: any): Promise<void> {
    this.#generation += 1;
    this.#paused = false;
    await this.#agents.start();
    try {
      await this.reconcile(ctx);
    } catch (error) {
      await this.#agents.stop().catch(() => undefined);
      throw error;
    }
  }

  async beforeTree(): Promise<void> {
    this.#paused = true;
    await this.#lifecycleTail.catch(() => undefined);
  }

  async afterTree(ctx: any): Promise<void> {
    this.#paused = false;
    await this.reconcile(ctx);
  }

  async stop(): Promise<void> {
    this.#paused = true;
    this.#generation += 1;
    await this.#lifecycleTail.catch(() => undefined);
    this.#running.clear();
    this.#unavailable.clear();
    await this.#agents.stop();
  }

  async reconcile(ctx: any): Promise<void> {
    const generation = ++this.#generation;
    for (const running of this.#running.values()) this.#agents.stopObserving(running.agentId);
    this.#running.clear();
    this.#unavailable.clear();
    const entries = ctx.sessionManager.getBranch();
    const records = project(entries);
    for (const record of records.values()) {
      if (!this.isGeneration(generation)) return;
      if (record.destroyed) {
        if (!this.#delivery.wasDelivered(ctx.sessionManager.getBranch(), record.forkId, record.agentId, record.destroyed.cursor)) {
          await this.#delivery.deliver(this.#pi, record.forkId, record.agentId, record.destroyed.kind, record.destroyed.output, record.destroyed.cursor);
        }
        continue;
      }
      if (record.stateDir !== this.#configuration.stateDir) {
        this.#unavailable.set(record.forkId, `Fork ${record.forkId} uses a different pi-fleet state directory.`);
        continue;
      }
      try {
        const agent = await this.#agents.restore(record.agentName, record.agentId);
        if (!this.isGeneration(generation)) return;
        const running: Running = { ...record, agent, registered: true };
        this.#running.set(record.forkId, running);
        this.observe(ctx, running, generation);
      } catch (error) {
        if (this.isGeneration(generation)) this.#unavailable.set(record.forkId, `Fork ${record.forkId} is unavailable: ${errorText(error)}`);
      }
    }
  }

  async create(ctx: any, toolCallId: string, name: string, task: string, tier: Tier = "balanced", signal?: AbortSignal): Promise<string> {
    this.resume();
    assertForkToolsAvailable(ctx.sessionManager);
    const existingIds = new Set(project(ctx.sessionManager.getBranch()).keys());
    for (let attempt = 0; attempt < maxIdAttempts; attempt += 1) {
      throwIfAborted(signal);
      const forkId = createId(name);
      if (existingIds.has(forkId)) continue;
      existingIds.add(forkId);
      const child = await createChildSession(ctx.sessionManager, toolCallId, forkId);
      let agent: Agent | undefined;
      try {
        const profile = this.#configuration.profiles[tier];
        agent = await this.#agents.create(forkId, ctx.cwd, this.#configuration.agentDir, [
          "--session", child.path,
          "--provider", profile.provider,
          "--model", profile.model,
          "--thinking", profile.thinking,
        ]);
        throwIfAborted(signal);
        const created: Created = {
          type: "fork.created",
          forkId,
          agentId: agent.id,
          agentName: agent.name,
          ...(this.#configuration.stateDir ? { stateDir: this.#configuration.stateDir } : {}),
          sessionPath: child.path,
          tier,
        };
        const running: Running = { ...created, agent, registered: false };
        this.#running.set(forkId, running);
        this.observe(ctx, running, this.#generation);
        await this.#agents.steer(agent, buildAssignedTask(task));
        appendCreated(this.#pi, created);
        running.registered = true;
        this.schedule(ctx, running, this.#generation);
        return forkId;
      } catch (error) {
        this.#running.delete(forkId);
        const cleanupFailures: string[] = [];
        let agentStopped = agent === undefined;
        if (agent) {
          try {
            await this.#agents.destroy(agent);
            agentStopped = true;
          } catch (cleanup) {
            this.#agents.stopObserving(agent.id);
            cleanupFailures.push(`Agent cleanup failed: ${errorText(cleanup)}. Child session retained at ${child.path}`);
          }
        }
        if (agentStopped) {
          try { await removeChildSession(child.path); } catch (cleanup) {
            cleanupFailures.push(`Child-session cleanup failed: ${errorText(cleanup)}`);
          }
        }
        if (error instanceof AgentNameTakenError && cleanupFailures.length === 0) continue;
        const suffix = cleanupFailures.length > 0 ? `. ${cleanupFailures.join(". ")}` : "";
        throw new Error(`Could not create fork ${forkId}: ${errorText(error)}${suffix}`);
      }
    }
    throw new Error(`Could not create a pi-fleet agent for ${name} after ${maxIdAttempts} name attempts.`);
  }

  async steer(ctx: any, forkId: string, message: string, signal?: AbortSignal): Promise<void> {
    this.resume();
    await this.enqueue(async () => {
      throwIfAborted(signal);
      const record = this.activeRecord(ctx, forkId);
      const running = this.#running.get(forkId);
      if (!running || running.agentId !== record.agentId) throw new Error(this.#unavailable.get(forkId) ?? `Fork ${forkId} is unavailable in this session.`);
      const state = await this.#agents.status(running.agent);
      throwIfAborted(signal);
      running.state = state;
      if (state === "idle") throw new Error(`Fork ${forkId} is idle and cannot be steered.`);
      if (state === "interrupted" || state === "failed") throw new Error(`Fork ${forkId} is ${state} and cannot be steered.`);
      const previousCandidate = running.candidate;
      running.candidate = undefined;
      running.terminalSince = undefined;
      try {
        await this.#agents.steer(running.agent, message);
      } catch (error) {
        running.candidate ??= previousCandidate;
        throw error;
      }
    });
  }

  async status(ctx: any, forkId: string): Promise<{ state: AgentState | "completed" }> {
    this.resume();
    const record = project(ctx.sessionManager.getBranch()).get(forkId);
    if (!record) throw new Error(`Fork ${forkId} was not found on this session branch.`);
    if (record.destroyed) return { state: "completed" };
    const running = this.#running.get(forkId);
    if (!running || running.agentId !== record.agentId) throw new Error(this.#unavailable.get(forkId) ?? `Fork ${forkId} is unavailable in this session.`);
    const state = await this.#agents.status(running.agent);
    running.state = state;
    this.schedule(ctx, running, this.#generation);
    return { state };
  }

  private observe(ctx: any, running: Running, generation: number): void {
    this.#agents.observe(running.agent, undefined, {
      onCandidate: (candidate: Candidate) => {
        if (!this.current(generation, running)) return;
        running.candidate = candidate;
        this.schedule(ctx, running, generation);
      },
      onStatus: (state: AgentState) => {
        if (!this.current(generation, running)) return;
        running.state = state;
        if (state === "starting" || state === "working") running.terminalSince = undefined;
        this.schedule(ctx, running, generation);
      },
      onError: (error: unknown) => {
        if (this.current(generation, running)) this.#unavailable.set(running.forkId, `Fork ${running.forkId} monitor error: ${errorText(error)}`);
      },
    });
  }

  private schedule(ctx: any, running: Running, generation: number): void {
    void this.enqueue(async () => this.process(ctx, running, generation)).catch((error) => {
      if (this.current(generation, running)) this.#unavailable.set(running.forkId, `Fork ${running.forkId} lifecycle error: ${errorText(error)}`);
    });
  }

  private async process(ctx: any, running: Running, generation: number): Promise<void> {
    if (this.#paused || !this.current(generation, running) || !running.registered || running.finalizing || !this.ownsCurrentBranch(ctx, running)) return;
    if (running.state === "idle" && running.candidate) {
      await this.finalize(ctx, running, "response", running.candidate.text, running.candidate.cursor, generation);
      return;
    }
    if (running.state === "idle" || running.state === "interrupted" || running.state === "failed") {
      running.terminalSince ??= this.#now();
      if (this.#now() - running.terminalSince < SETTLEMENT_GRACE_MS) return;
      const notice = running.state === "idle"
        ? NO_OUTPUT_IDLE
        : `Fork ${running.state} without a confirmed final assistant response.`;
      await this.finalize(ctx, running, "notice", notice, undefined, generation);
    }
  }

  private async finalize(ctx: any, running: Running, kind: Destroyed["kind"], output: string, cursor: string | undefined, generation: number): Promise<void> {
    if (this.#paused || !this.current(generation, running) || running.finalizing || !this.ownsCurrentBranch(ctx, running)) return;
    running.finalizing = true;
    try {
      await this.#agents.destroy(running.agent);
      // session_before_tree waits for work already in the lifecycle queue. Once this
      // finalization starts on its owning branch, it must record the outcome before
      // that branch can change.
      const destroyed: Destroyed = { type: "fork.destroyed", forkId: running.forkId, agentId: running.agentId, kind, output, cursor };
      appendDestroyed(this.#pi, destroyed);
      this.#running.delete(running.forkId);
      await this.#delivery.deliver(this.#pi, running.forkId, running.agentId, kind, output, cursor);
    } finally {
      running.finalizing = false;
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.#lifecycleTail.catch(() => undefined).then(work);
    this.#lifecycleTail = next.catch(() => undefined);
    return next;
  }

  private activeRecord(ctx: any, forkId: string): Created {
    const record = project(ctx.sessionManager.getBranch()).get(forkId);
    if (!record) throw new Error(`Fork ${forkId} was not found on this session branch.`);
    if (record.destroyed) throw new Error(`Fork ${forkId} is completed.`);
    return record;
  }

  private ownsCurrentBranch(ctx: any, running: Running): boolean {
    const record = active(ctx.sessionManager.getBranch()).get(running.forkId);
    return record?.agentId === running.agentId;
  }

  private current(generation: number, running: Running): boolean {
    return generation === this.#generation && this.#running.get(running.forkId) === running;
  }

  private isGeneration(generation: number): boolean {
    return generation === this.#generation;
  }

  private resume(): void {
    this.#paused = false;
  }
}
