import { deleteIndexResource, listIndexResources } from "./index-store.js";
import { getProvider } from "./providers/index.js";

const DEFAULT_DELAY_MS = 1000;
const DEFAULT_CLEANUP_CONCURRENCY = 1;

let cleanupState = idleState();

export function cleanupStatus() {
  return cleanupState;
}

export async function startInvalidCleanup({ query = "", delayMs = DEFAULT_DELAY_MS } = {}) {
  if (cleanupState.status === "running") {
    return cleanupState;
  }

  const resources = await listIndexResources({ query });
  cleanupState = {
    status: "running",
    query,
    delayMs: clampDelay(delayMs),
    total: resources.length,
    completed: 0,
    valid: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    active: 0,
    providerPlan: providerPlan(resources),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    current: [],
    lastResult: null,
    recent: [],
  };

  runCleanup(resources).catch((error) => {
    cleanupState.status = "failed";
    cleanupState.finishedAt = new Date().toISOString();
    cleanupState.lastResult = {
      ok: false,
      reason: error.message,
    };
  });

  return cleanupState;
}

async function runCleanup(resources) {
  const groups = groupResourcesByProvider(resources);
  await Promise.all([...groups.entries()].map(([providerId, group]) => processProviderGroup(providerId, group)));

  cleanupState.status = "completed";
  cleanupState.finishedAt = new Date().toISOString();
}

async function processProviderGroup(providerId, resources) {
  const provider = getProvider(providerId);
  const concurrency = Math.max(
    1,
    Math.min(Number(provider?.limits?.cleanupConcurrency) || DEFAULT_CLEANUP_CONCURRENCY, 20)
  );
  const delayMs = clampProviderDelay(provider?.limits?.cleanupDelayMs ?? cleanupState.delayMs);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, resources.length) }, async () => {
    while (nextIndex < resources.length) {
      const resource = resources[nextIndex];
      nextIndex += 1;

      markCurrent(resource, true);
      const result = await validateAndMaybeDelete(resource);
      cleanupState.completed += 1;
      cleanupState.lastResult = result;
      pushRecent(result);
      markCurrent(resource, false);

      if (delayMs > 0 && nextIndex < resources.length) {
        await sleep(delayMs);
      }
    }
  }));
}

async function validateAndMaybeDelete(resource) {
  const provider = getProvider(resource.providerId);
  if (!provider?.validateItem) {
    cleanupState.skipped += 1;
    return resultFor(resource, {
      ok: true,
      action: "skipped",
      reason: "Provider 不支持有效性校验",
    });
  }

  try {
    const validation = await provider.validateItem(resource);
    if (validation.skipped) {
      cleanupState.skipped += 1;
      return resultFor(resource, {
        ok: true,
        action: "skipped",
        reason: validation.reason || "跳过",
      });
    }

    if (validation.delete) {
      const deleted = await deleteIndexResource(resource.id);
      cleanupState.deleted += deleted ? 1 : 0;
      return resultFor(resource, {
        ok: true,
        action: deleted ? "deleted" : "not_found",
        reason: validation.reason || "已判定无效",
      });
    }

    cleanupState.valid += 1;
    return resultFor(resource, {
      ok: true,
      action: "kept",
      reason: validation.reason || "有效",
    });
  } catch (error) {
    cleanupState.failed += 1;
    return resultFor(resource, {
      ok: false,
      action: "failed",
      reason: error.message,
    });
  }
}

function resultFor(resource, extra) {
  return {
    id: resource.id,
    providerId: resource.providerId,
    title: resource.title,
    type: resource.type,
    shareLink: resource.shareLink,
    ...extra,
    checkedAt: new Date().toISOString(),
  };
}

function pushRecent(result) {
  cleanupState.recent = [result, ...cleanupState.recent].slice(0, 10);
}

function markCurrent(resource, active) {
  if (active) {
    cleanupState.active += 1;
    cleanupState.current = [
      ...cleanupState.current,
      {
        id: resource.id,
        providerId: resource.providerId,
        title: resource.title,
        type: resource.type,
        path: resource.path,
      },
    ].slice(-20);
    return;
  }

  cleanupState.active = Math.max(0, cleanupState.active - 1);
  cleanupState.current = cleanupState.current.filter((item) => item.id !== resource.id);
}

function groupResourcesByProvider(resources) {
  const groups = new Map();
  for (const resource of resources) {
    if (!groups.has(resource.providerId)) {
      groups.set(resource.providerId, []);
    }
    groups.get(resource.providerId).push(resource);
  }
  return groups;
}

function providerPlan(resources) {
  return [...groupResourcesByProvider(resources).entries()].map(([providerId, group]) => {
    const provider = getProvider(providerId);
    return {
      providerId,
      total: group.length,
      concurrency: provider?.limits?.cleanupConcurrency || DEFAULT_CLEANUP_CONCURRENCY,
      delayMs: provider?.limits?.cleanupDelayMs ?? DEFAULT_DELAY_MS,
    };
  });
}

function idleState() {
  return {
    status: "idle",
    query: "",
    delayMs: DEFAULT_DELAY_MS,
    total: 0,
    completed: 0,
    valid: 0,
    deleted: 0,
    skipped: 0,
    failed: 0,
    active: 0,
    providerPlan: [],
    startedAt: null,
    finishedAt: null,
    current: [],
    lastResult: null,
    recent: [],
  };
}

function clampDelay(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DELAY_MS;
  }

  return Math.max(500, Math.min(Math.trunc(parsed), 5000));
}

function clampProviderDelay(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DELAY_MS;
  }

  return Math.max(0, Math.min(Math.trunc(parsed), 5000));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
