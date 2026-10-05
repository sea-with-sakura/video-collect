import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  saveIndexResult,
  searchIndex,
  indexStats,
  listIndexResources,
  listIndexChildren,
  deleteIndexResource,
} from "../src/index-store.js";

const fixture = (fid, shareUrl = "https://pan.quark.cn/s/one") => ({
  title: `Resource ${fid}`,
  normalizedTitle: `Resource ${fid}`,
  type: "folder",
  fid,
  parentFid: "0",
  path: `/Resource ${fid}`,
  shareLink: `${shareUrl}#/list/share/${fid}`,
  sourceShareUrl: shareUrl,
});
const result = (
  items,
  source = { shareUrl: "https://pan.quark.cn/s/one" },
) => ({ providerId: "quark-share", providerName: "Quark", source, items });
async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), "video-collect-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { storePath: join(directory, "index.sqlite") };
}

test("old batch payloads retain per-resource origin without replicating thousands of links", async (t) => {
  const options = await temporaryStore(t);
  const links = Array.from(
    { length: 4296 },
    (_, i) => `https://pan.quark.cn/s/${i}`,
  );
  const saved = await saveIndexResult(
    result(
      [fixture("first"), fixture("second", "https://pan.quark.cn/s/two")],
      { shareUrls: links, exportedAt: "2026-10-05" },
    ),
    options,
  );
  assert.equal(saved.inserted, 2);
  const db = new DatabaseSync(options.storePath);
  t.after(() => db.close());
  const rows = db
    .prepare("SELECT source_json, source_share_url FROM resources ORDER BY id")
    .all();
  for (const row of rows) {
    const source = JSON.parse(row.source_json);
    assert.equal(source.shareUrls, undefined);
    assert.equal(source.shareUrl, row.source_share_url);
    assert.equal(source.exportedAt, "2026-10-05");
    assert.ok(row.source_json.length < 150);
  }
  const resources = await listIndexResources({
    ...options,
    includeSource: false,
  });
  assert.equal(resources.length, 2);
  assert.equal(resources[0].source, null);
  assert.ok(
    resources.every(
      (item) => item.fid && item.sourceShareUrl && item.parentFid,
    ),
  );
});

test("queued saves preserve update counts, first-save dates, search, children and deletion", async (t) => {
  const options = await temporaryStore(t);
  const [first, second] = await Promise.all([
    saveIndexResult(result([fixture("folder")]), options),
    saveIndexResult(
      result([
        fixture("folder"),
        {
          ...fixture("child"),
          type: "file",
          parentFid: "folder",
          shareLink: fixture("folder").shareLink,
        },
      ]),
      options,
    ),
  ]);
  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 1);
  assert.equal(second.updated, 1);
  assert.deepEqual((await indexStats(options)).total, 2);
  const search = await searchIndex({ ...options, query: "folder" });
  assert.equal(search.items.length, 1);
  const firstSavedAt = search.items[0].firstSavedAt;
  await saveIndexResult(result([fixture("folder")]), options);
  assert.equal(
    (await searchIndex({ ...options, query: "folder" })).items[0].firstSavedAt,
    firstSavedAt,
  );
  const children = await listIndexChildren({
    ...options,
    shareLink: fixture("folder").shareLink,
  });
  assert.ok(children.items.some((item) => item.fid === "child"));
  assert.equal(await deleteIndexResource("quark-share:child", options), 1);
  assert.equal((await indexStats(options)).total, 1);
});

test("failed saves roll back the entire transaction and leave the worker usable", async (t) => {
  const options = await temporaryStore(t);
  await saveIndexResult(result([fixture("existing")]), options);
  await assert.rejects(
    saveIndexResult(result([fixture("should-rollback"), null]), options),
  );
  assert.equal((await indexStats(options)).total, 1);
  assert.equal(
    (await saveIndexResult(result([fixture("after-error")]), options)).inserted,
    1,
  );
});

test("different store paths stay isolated even when requests arrive concurrently", async (t) => {
  const first = await temporaryStore(t);
  const second = await temporaryStore(t);
  await Promise.all([
    saveIndexResult(result([fixture("a")]), first),
    saveIndexResult(result([fixture("b"), fixture("c")]), second),
  ]);
  assert.equal((await indexStats(first)).total, 1);
  assert.equal((await indexStats(second)).total, 2);
});

test("HTTP health and cleanup status remain responsive while SQLite waits for a write lock", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "video-collect-server-store-"),
  );
  await cp(
    fileURLToPath(new URL("../src", import.meta.url)),
    join(directory, "src"),
    { recursive: true },
  );
  await cp(
    fileURLToPath(new URL("../package.json", import.meta.url)),
    join(directory, "package.json"),
  );
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const server = spawn(process.execPath, ["src/server.js"], {
    cwd: directory,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let lock;
  t.after(async () => {
    if (lock?.exitCode === null) {
      lock.kill();
      await once(lock, "exit");
    }
    if (server.exitCode === null) {
      server.kill();
      await once(server, "exit");
    }
    await rm(directory, { recursive: true, force: true });
  });
  await once(server.stdout, "data");
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/indexes/stats`)).status, 200);
  const script = `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('locked'); process.stdin.once('data',()=>{db.exec('COMMIT');db.close();process.exit(0);});`;
  lock = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      join(directory, "data/resource-index.sqlite"),
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await once(lock.stdout, "data");
  let saveComplete = false;
  const saving = fetch(`${base}/api/indexes/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(result([fixture("locked-write")])),
    signal: AbortSignal.timeout(10000),
  }).then(async (response) => {
    saveComplete = true;
    return { status: response.status, body: await response.json() };
  });
  // Ensure the worker has entered SQLite's synchronous lock wait.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(saveComplete, false);
  for (const path of ["/api/health", "/api/indexes/cleanup-invalid/status"]) {
    const started = performance.now();
    const response = await fetch(`${base}${path}`, {
      signal: AbortSignal.timeout(1500),
    });
    assert.equal(response.status, 200);
    assert.ok(performance.now() - started < 1000);
  }
  assert.equal(saveComplete, false);
  lock.stdin.write("release\n");
  const saved = await saving;
  assert.equal(saved.status, 200);
  assert.equal(saved.body.inserted, 1);
  assert.equal(
    (
      await fetch(`${base}/api/indexes/stats`).then((response) =>
        response.json(),
      )
    ).total,
    1,
  );
  // Concurrent starts must share the asynchronous resource-listing phase.
  await fetch(`${base}/api/indexes/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...result([
        fixture("startup-a"),
        fixture("startup-b"),
        fixture("startup-c"),
      ]),
      providerId: "test-unsupported",
    }),
  });
  const starts = await Promise.all(
    Array.from({ length: 5 }, async () => {
      const response = await fetch(`${base}/api/indexes/cleanup-invalid`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "startup", delayMs: 5000 }),
      });
      assert.equal(response.status, 202);
      return response.json();
    }),
  );
  assert.equal(new Set(starts.map((status) => status.startedAt)).size, 1);
  const cleanup = await fetch(
    `${base}/api/indexes/cleanup-invalid/status`,
  ).then((response) => response.json());
  assert.equal(cleanup.total, 3);
  assert.equal(cleanup.completed, 1);
});
