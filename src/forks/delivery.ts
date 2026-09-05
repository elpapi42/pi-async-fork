import { RESULT_TYPE, isDelivered, type Destroyed } from "./ledger.js";

export function formatOutput(forkId: string, output: string): string {
  return `${forkId}:\n\n${output}`;
}

export class Delivery {
  #tail = Promise.resolve();

  deliver(pi: any, forkId: string, agentId: string, kind: Destroyed["kind"], output: string, cursor: string | undefined): Promise<void> {
    const work = this.#tail.catch(() => undefined).then(() => {
      pi.sendMessage(
        {
          customType: RESULT_TYPE,
          content: formatOutput(forkId, output),
          display: true,
          details: { forkId, agentId, kind, cursor },
        },
        { deliverAs: "steer", triggerTurn: true },
      );
    });
    this.#tail = work;
    return work;
  }

  wasDelivered(entries: readonly any[], forkId: string, agentId: string, cursor: string | undefined): boolean {
    return isDelivered(entries, forkId, agentId, cursor);
  }
}
