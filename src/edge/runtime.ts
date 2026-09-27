import type { EdgeConfig } from "./config.ts";
import { EdgeHub } from "./hub.ts";
import { createEdgeJournal } from "./journal.ts";

export function createConfiguredEdgeHub(config: EdgeConfig): EdgeHub {
  const journal = config.journalDir ? createEdgeJournal(config.journalDir) : null;
  const hub = new EdgeHub({
    joinToken: config.joinToken,
    historyLimit: config.historyLimit,
    ...(journal ? { onCommit: (op) => journal.append(op) } : {}),
  });
  if (journal) hub.restore(journal.load());
  hub.ensureProject(config.defaultProject);
  return hub;
}
