import { parentPort } from "node:worker_threads";
import * as store from "./index-store-core.js";

let queue = Promise.resolve();
parentPort.on("message", ({ id, operation, args }) => {
  // Initial schema/migration and transactions must never overlap.
  queue = queue.then(async () => {
    try {
      const value = await store[operation](...args);
      parentPort.postMessage({ id, value });
    } catch (error) {
      parentPort.postMessage({
        id,
        error: { name: error.name, message: error.message, code: error.code },
      });
    }
  });
});
