const net = require("node:net");

const pid = Number(process.argv[2]);
const pipe = "\\\\.\\pipe\\cybersafe-protection-dev-v2";
const started = Date.now();
const pending = new Map();
const events = [];
let sequence = 0;
let buffer = "";

const log = (message) => console.log(new Date().toISOString(), message);
const socket = net.createConnection(pipe, async () => {
  try {
    log(`CONNECTED PID=${pid}`);
    const before = await request("processes.list");
    log(`BEFORE present=${before.some((process) => process.pid === pid)} count=${before.length}`);
    const result = await request("process.killTree", { pid });
    log(`KILL_RESULT ${JSON.stringify(result)}`);
    const immediate = await request("processes.list");
    log(`AFTER_IMMEDIATE present=${immediate.some((process) => process.pid === pid)} count=${immediate.length}`);
    setTimeout(async () => {
      const later = await request("processes.list");
      log(`AFTER_12S present=${later.some((process) => process.pid === pid)} count=${later.length}`);
      log(`EVENTS ${JSON.stringify(events)}`);
      log(`TOTAL_MS=${Date.now() - started}`);
      socket.end();
    }, 12_000);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    socket.end();
  }
});

function request(method, payload) {
  const id = `diag-${++sequence}`;
  socket.write(`${JSON.stringify({ id, type: "request", method, payload })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`TIMEOUT ${method}`));
    }, 20_000);
  });
}

socket.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === "event") {
      events.push({ type: message.event?.type, at: Date.now() - started, data: message.event?.data });
      log(`EVENT ${message.event?.type} +${Date.now() - started}ms`);
      continue;
    }
    const requestState = pending.get(message.id);
    if (!requestState) continue;
    pending.delete(message.id);
    if (message.ok) requestState.resolve(message.result);
    else requestState.reject(new Error(message.error));
  }
});

socket.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
