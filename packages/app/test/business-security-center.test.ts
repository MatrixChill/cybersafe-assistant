import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConnectionSnapshot, ProcessSnapshot } from "@cybersafe/shared-types";
import {
  buildProcessMap,
  enrichConnections,
  isTCP,
  isUDP,
  countUniqueDestinations,
  UDP_COLLECTION_AVAILABLE,
} from "../src/lib/business-network-utils";

const mockProcess: ProcessSnapshot = {
  pid: 1234,
  ppid: 1,
  name: "chrome.exe",
  path: "C:\\Program Files\\Chrome\\chrome.exe",
  commandLine: "chrome.exe --flag",
  user: "USER",
  cpu: 5.2,
  memoryMb: 150,
  startedAt: new Date().toISOString(),
  signer: "Google LLC",
  hash: "abc123",
  trusted: "trusted",
};

const mockConnectionTCP: ConnectionSnapshot = {
  processPid: 1234,
  processName: "chrome.exe",
  remoteAddress: "142.250.185.206",
  remotePort: 443,
  protocol: "tcp",
  state: "Established",
  domain: "google.com",
  direction: "outbound",
  observedAt: new Date().toISOString(),
};

const mockConnectionUDP: ConnectionSnapshot = {
  processPid: 5678,
  processName: "discord.exe",
  remoteAddress: "162.159.128.233",
  remotePort: 443,
  protocol: "udp",
  state: "Established",
  domain: "discord.com",
  direction: "outbound",
  observedAt: new Date().toISOString(),
};

const mockConnectionNoPID: ConnectionSnapshot = {
  processPid: undefined,
  processName: undefined,
  remoteAddress: "192.168.1.50",
  remotePort: 80,
  protocol: "tcp",
  state: "Listen",
  domain: undefined,
  direction: "inbound",
  observedAt: new Date().toISOString(),
};

test("buildProcessMap creates map keyed by PID", () => {
  const map = buildProcessMap([mockProcess]);
  assert.ok(map.has(1234));
  assert.equal(map.get(1234)?.name, "chrome.exe");
  assert.equal(map.size, 1);
});

test("enrichConnections maps PID to process name", () => {
  const map = buildProcessMap([mockProcess]);
  const enriched = enrichConnections([mockConnectionTCP], map);
  assert.equal(enriched[0].processName, "chrome.exe");
  assert.equal(enriched[0].processPid, 1234);
  assert.equal(enriched[0].processPath, mockProcess.path);
});

test("enrichConnections falls back to connection.processName if PID not found", () => {
  const map = buildProcessMap([]);
  const enriched = enrichConnections([mockConnectionTCP], map);
  assert.equal(enriched[0].processName, "chrome.exe");
});

test("enrichConnections shows 'Processo desconhecido' when no PID and no processName", () => {
  const map = buildProcessMap([]);
  const enriched = enrichConnections([mockConnectionNoPID], map);
  assert.equal(enriched[0].processName, "Processo desconhecido");
});

test("isTCP returns true for tcp protocol", () => {
  assert.ok(isTCP({ ...mockConnectionTCP, protocol: "tcp" }));
  assert.ok(isTCP({ ...mockConnectionTCP, protocol: "tcp4" }));
  assert.ok(isTCP({ ...mockConnectionTCP, protocol: "tcp6" }));
  assert.ok(isTCP({ ...mockConnectionTCP, protocol: "TCP" }));
});

test("isTCP returns true when protocol missing but state is Established", () => {
  assert.ok(isTCP({ ...mockConnectionTCP, protocol: undefined }));
});

test("isTCP returns false for udp protocol", () => {
  assert.ok(!isTCP({ ...mockConnectionUDP, protocol: "udp" }));
});

test("isUDP returns true for udp protocol", () => {
  assert.ok(isUDP({ ...mockConnectionUDP, protocol: "udp" }));
  assert.ok(isUDP({ ...mockConnectionUDP, protocol: "udp4" }));
  assert.ok(isUDP({ ...mockConnectionUDP, protocol: "udp6" }));
});

test("isUDP returns false for tcp protocol", () => {
  assert.ok(!isUDP({ ...mockConnectionTCP, protocol: "tcp" }));
});

test("UDP collection is explicitly unavailable (not shown as a real zero)", () => {
  // Truthfulness: the Windows bridge only collects TCP (Get-NetTCPConnection).
  // The UI must render "Indisponível" instead of a fabricated zero count.
  assert.equal(UDP_COLLECTION_AVAILABLE, false);
});

test("countUniqueDestinations counts distinct remoteAddress values (truthful naming)", () => {
  const list: ConnectionSnapshot[] = [
    { ...mockConnectionTCP, remoteAddress: "142.250.185.206" },
    { ...mockConnectionTCP, remoteAddress: "142.250.185.206", remotePort: 444 },
    { ...mockConnectionTCP, remoteAddress: "192.168.1.50", direction: "inbound" },
    { ...mockConnectionTCP, remoteAddress: "" },
    { ...mockConnectionTCP, remoteAddress: undefined as unknown as string },
  ];
  // Two distinct real values. Loopback/private IPs are NOT excluded because no
  // external-vs-local classification exists — the card name reflects this.
  assert.equal(countUniqueDestinations(list), 2);
});

test("countUniqueDestinations is zero when remoteAddress is missing everywhere", () => {
  const list: ConnectionSnapshot[] = [
    { ...mockConnectionTCP, remoteAddress: "" },
    { ...mockConnectionTCP, remoteAddress: "" },
  ];
  assert.equal(countUniqueDestinations(list), 0);
});

test("missing optional fields are preserved as absent (no fabricated values)", () => {
  const map = buildProcessMap([]);
  const enriched = enrichConnections(
    [{ ...mockConnectionTCP, processName: undefined, domain: undefined, remotePort: undefined }],
    map,
  );
  assert.equal(enriched[0].processName, "Processo desconhecido");
  assert.equal(enriched[0].connection.remotePort, undefined);
  assert.equal(enriched[0].connection.domain, undefined);
});