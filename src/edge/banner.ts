import { networkInterfaces } from "node:os";

export function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (name.startsWith("utun") || name.startsWith("bridge") || name.startsWith("docker")) continue;
      addresses.push(entry.address);
    }
  }
  return [...new Set(addresses)];
}

export function edgeBanner(opts: {
  port: number;
  project: string;
  joinToken: string;
  generated: boolean;
  label?: string;
}): string {
  const lan = lanAddresses();
  const lines = [
    "",
    opts.label ?? "QM Edge running",
    "",
    `HTTP:      http://localhost:${opts.port}/edge/health`,
    `Dashboard: http://localhost:${opts.port}/edge#token=${opts.joinToken}`,
    `WebSocket: ws://localhost:${opts.port}/edge/ws`,
    ...(lan.length
      ? lan.map((ip, i) => `${i === 0 ? "LAN:      " : "          "} ws://${ip}:${opts.port}/edge/ws`)
      : ["LAN:       (no LAN address found; on macOS run: ipconfig getifaddr en0)"]),
    "",
    `Project:    ${opts.project}`,
    `Join token: ${opts.joinToken}${opts.generated ? "   (generated; set EDGE_JOIN_TOKEN to pin it)" : ""}`,
    "",
    `Agent CLI:  QM_EDGE_URL=http://localhost:${opts.port} QM_EDGE_TOKEN=${opts.joinToken} npm run qm-edge -- status`,
    "",
  ];
  return lines.join("\n");
}
