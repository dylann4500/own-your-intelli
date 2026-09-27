import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EdgeCommittedOperation } from "./protocol.ts";

export interface EdgeJournal {
  load(): EdgeCommittedOperation[];
  append(operation: EdgeCommittedOperation): void;
}

export function createEdgeJournal(dir: string): EdgeJournal {
  mkdirSync(dir, { recursive: true });
  const fileFor = (projectId: string): string => join(dir, `${projectId}.jsonl`);
  return {
    load() {
      if (!existsSync(dir)) return [];
      const operations: EdgeCommittedOperation[] = [];
      for (const name of readdirSync(dir).filter((n) => n.endsWith(".jsonl"))) {
        for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            operations.push(JSON.parse(line) as EdgeCommittedOperation);
          } catch {
            break;
          }
        }
      }
      return operations;
    },
    append(operation) {
      appendFileSync(fileFor(operation.projectId), `${JSON.stringify(operation)}\n`);
    },
  };
}
