import { RESULT_TYPE, isDelivered } from "./ledger.js";

export type ReportKind = "progress" | "response" | "notice";

function statusSentence(kind: ReportKind): string {
  if (kind === "progress") return "This is an intermediate progress report. The fork is still working and can receive steering.";
  if (kind === "response") return "This is the final report. The fork finished and can no longer receive steering. Treat this report as an internal work event. Do not write user-visible text only because it arrived.";
  return "This is a terminal notice. The fork finished and can no longer receive steering. Treat this notice as an internal work event. Do not write user-visible text only because it arrived.";
}

export function formatOutput(forkId: string, output: string, kind: ReportKind): string {
  return `${forkId}:\n\n${statusSentence(kind)}\n\n${output}`;
}

export class Delivery {
  #tail = Promise.resolve();

  deliver(pi: any, forkId: string, agentId: string, kind: ReportKind, output: string, cursor: string | undefined, description?: string): Promise<void> {
    const work = this.#tail.catch(() => undefined).then(() => {
      pi.sendMessage(
        {
          customType: RESULT_TYPE,
          content: formatOutput(forkId, output, kind),
          display: true,
          details: { forkId, agentId, kind, cursor, ...(description === undefined ? {} : { description }) },
        },
        { deliverAs: "steer", triggerTurn: kind !== "progress" },
      );
    });
    this.#tail = work;
    return work;
  }

  wasDelivered(entries: readonly any[], forkId: string, agentId: string, cursor: string | undefined): boolean {
    return isDelivered(entries, forkId, agentId, cursor);
  }
}
