import { parentPort, workerData } from "node:worker_threads";
import { Client, types } from "pg";

const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const client = new Client({
  connectionString: workerData.connectionString,
  ssl: workerData.ssl ? { rejectUnauthorized: true } : undefined,
  statement_timeout: 30_000,
  query_timeout: 35_000,
});

types.setTypeParser(20, (value) => Number(value));

function signal(buffer, status, result) {
  const state = new Int32Array(buffer, 0, 2);
  const serialized = Buffer.from(JSON.stringify(result));

  if (serialized.byteLength > MAX_RESULT_BYTES) {
    signalError(buffer, "PostgreSQL response exceeded the configured size limit.");
    return;
  }

  new Uint8Array(buffer, 8, serialized.byteLength).set(serialized);
  Atomics.store(state, 1, serialized.byteLength);
  Atomics.store(state, 0, status);
  Atomics.notify(state, 0);
}

function signalError(buffer, message) {
  signal(buffer, 2, { error: message });
}

async function connect() {
  try {
    await client.connect();
    signal(workerData.readyBuffer, 1, { ready: true });
  } catch (error) {
    signalError(workerData.readyBuffer, error.message);
  }
}

async function handleMessage(message) {
  try {
    if (message.action === "close") {
      await client.end();
      signal(message.buffer, 1, { closed: true });
      return;
    }

    if (message.action === "exec") {
      const result = await client.query(message.sql);
      const lastResult = Array.isArray(result) ? result.at(-1) : result;
      signal(message.buffer, 1, {
        rowCount: lastResult?.rowCount ?? 0,
        rows: lastResult?.rows ?? [],
      });
      return;
    }

    const result = await client.query(message.sql, message.parameters);
    signal(message.buffer, 1, {
      rowCount: result.rowCount ?? 0,
      rows: result.rows ?? [],
    });
  } catch (error) {
    signalError(message.buffer, error.message);
  }
}

await connect();
parentPort.on("message", handleMessage);
