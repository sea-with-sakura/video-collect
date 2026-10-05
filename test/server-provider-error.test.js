import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

test("the collection API reports upstream timeouts as HTTP 504 with a readable message", async (t) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const preload = `globalThis.fetch = async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("timeout"), {code:"UND_ERR_CONNECT_TIMEOUT"}) }); };`;
  const server = spawn(
    process.execPath,
    [
      "--import",
      `data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`,
      fileURLToPath(new URL("../src/server.js", import.meta.url)),
    ],
    {
      env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill();
      await once(server, "exit");
    }
  });
  const ready = await Promise.race([
    once(server.stdout, "data"),
    once(server, "exit").then(([code]) => {
      throw new Error(`Server exited: ${code}`);
    }),
  ]);
  assert.match(String(ready[0]), /web is running/);
  const response = await fetch(`http://127.0.0.1:${port}/api/index/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providerId: "quark-share",
      shareUrl: "https://pan.quark.cn/s/example",
      confirmAuthorized: true,
      saveToLibrary: false,
    }),
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.error.code, "provider_timeout");
  assert.match(body.error.message, /连接夸克网盘超时/);
  assert.doesNotMatch(body.error.message, /Internal server error/);
});
