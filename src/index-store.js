import { Worker } from "node:worker_threads";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultDbPath = fileURLToPath(
  new URL("../data/resource-index.sqlite", import.meta.url),
);
const clients = new Map();
let nextId = 0;

// SQLite remains atomic and serial, while HTTP and provider requests can
// continue during large writes, searches, and cleanup queries.
function request(operation, args, storePath) {
  let client = clients.get(storePath);
  if (!client) {
    const worker = new Worker(
      new URL("./index-store-worker.js", import.meta.url),
    );
    client = { worker, pending: new Map() };
    clients.set(storePath, client);
    const fail = (error) => {
      if (clients.get(storePath) === client) clients.delete(storePath);
      for (const pending of client.pending.values()) pending.reject(error);
      client.pending.clear();
      worker.unref();
    };
    worker.on("message", ({ id, value, error }) => {
      const pending = client.pending.get(id);
      if (!pending) return;
      client.pending.delete(id);
      if (error) {
        pending.reject(
          Object.assign(new Error(error.message), {
            name: error.name,
            code: error.code,
          }),
        );
      } else pending.resolve(value);
      if (!client.pending.size) worker.unref();
    });
    worker.on("error", fail);
    worker.on("exit", (code) =>
      fail(new Error(`Database worker exited (${code}).`)),
    );
    worker.unref();
  }
  const id = ++nextId;
  return new Promise((resolveRequest, reject) => {
    client.pending.set(id, { resolve: resolveRequest, reject });
    client.worker.ref();
    try {
      client.worker.postMessage({ id, operation, args });
    } catch (error) {
      client.pending.delete(id);
      if (!client.pending.size) client.worker.unref();
      reject(error);
    }
  });
}

function optionsWithPath(options = {}) {
  return { ...options, storePath: resolve(options.storePath || defaultDbPath) };
}

export function saveIndexResult(result, options) {
  const normalized = optionsWithPath(options);
  return request("saveIndexResult", [result, normalized], normalized.storePath);
}

export function searchIndex(options) {
  const normalized = optionsWithPath(options);
  return request("searchIndex", [normalized], normalized.storePath);
}

export function indexStats(options) {
  const normalized = optionsWithPath(options);
  return request("indexStats", [normalized], normalized.storePath);
}

export function listIndexResources(options) {
  const normalized = optionsWithPath(options);
  return request("listIndexResources", [normalized], normalized.storePath);
}

export function listIndexChildren(options) {
  const normalized = optionsWithPath(options);
  return request("listIndexChildren", [normalized], normalized.storePath);
}

export function deleteIndexResource(id, options) {
  const normalized = optionsWithPath(options);
  return request("deleteIndexResource", [id, normalized], normalized.storePath);
}
