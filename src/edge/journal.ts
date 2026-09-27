import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { EdgeCommittedOperation } from "./protocol.ts";

export interface EdgeJournal {
  load(): EdgeCommittedOperation[];
  append(operation: EdgeCommittedOperation): void;
}

function endsWithNewline(file: string): boolean {
  const size = statSync(file).size;
  if (size === 0) return true;
  const fd = openSync(file, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

export function createEdgeJournal(dir: string): EdgeJournal {
  mkdirSync(dir, { recursive: true });
  const fileFor = (projectId: string): string => join(dir, `${projectId}.jsonl`);
  const repaired = new Set<string>();
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
            continue;
          }
        }
      }
      return operations;
    },
    append(operation) {
      const file = fileFor(operation.projectId);
      if (!repaired.has(file)) {
        if (existsSync(file) && !endsWithNewline(file)) appendFileSync(file, "\n");
        repaired.add(file);
      }
      appendFileSync(file, `${JSON.stringify(operation)}\n`);
    },
  };
}
