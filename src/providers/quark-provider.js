import {
  exportQuarkShareIndex,
  parseQuarkShareUrl,
  QuarkShareClient,
} from "../quark-share.js";

const tokenCache = new Map();

export const quarkProvider = {
  id: "quark-share",
  name: "Quark Share",
  displayName: "Quark Share",
  category: "cloud_drive",
  status: "ready",
  capabilities: ["url_parse", "directory_index", "json_export", "csv_export"],
  auth: {
    type: "share_token",
    fields: ["shareUrl", "passcode"],
    requiresAuthorizationConfirmation: true,
  },
  limits: {
    defaultMaxDepth: 0,
    maxDepth: 12,
    batchMaxDepth: 12,
    defaultBatchConcurrency: 3,
    maxConcurrency: 8,
    cleanupConcurrency: 10,
    cleanupDelayMs: 0,
  },

  parse(input) {
    return parseQuarkShareUrl(input.shareUrl);
  },

  async collect(input) {
    const maxDepth = clampDepth(input.maxDepth, this.limits.defaultMaxDepth, this.limits.maxDepth);
    const result = await exportQuarkShareIndex({
      shareUrl: input.shareUrl,
      passcode: input.passcode || "",
      maxDepth,
      recursive: input.recursive !== false,
    });

    return {
      providerId: this.id,
      providerName: this.displayName,
      source: result.source,
      summary: summarize(result.items),
      items: result.items,
    };
  },

  async validateItem(item) {
    return validateQuarkItem(item);
  },
};

async function validateQuarkItem(item) {
  if (!item.sourceShareUrl || !item.fid) {
    return {
      valid: true,
      delete: false,
      skipped: true,
      reason: "缺少原始分享链接或 fid，跳过",
    };
  }

  const parsed = parseQuarkShareUrl(item.sourceShareUrl);
  const client = new QuarkShareClient();
  const stoken = await getCachedStoken(client, parsed.pwdId);

  if (item.type === "folder") {
    const children = await client.listDirectory({
      pwdId: parsed.pwdId,
      stoken,
      pdirFid: item.fid,
      pageSize: 10,
    });

    if (!children.length) {
      return {
        valid: false,
        delete: true,
        reason: "目录为空或已不可访问",
      };
    }

    return {
      valid: true,
      delete: false,
      reason: "目录可访问且存在内容",
    };
  }

  const parentFid = item.parentFid || "0";
  const siblings = await client.listDirectory({
    pwdId: parsed.pwdId,
    stoken,
    pdirFid: parentFid,
    pageSize: 100,
  });
  const exists = siblings.some((entry) => entry.fid === item.fid);

  return {
    valid: exists,
    delete: !exists,
    reason: exists ? "文件仍存在" : "父目录中未找到该文件",
  };
}

async function getCachedStoken(client, pwdId) {
  const cacheKey = `${pwdId}:`;
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const stoken = await client.getStoken(pwdId, "");
  tokenCache.set(cacheKey, stoken);
  return stoken;
}

function summarize(items) {
  return {
    total: items.length,
    folders: items.filter((item) => item.type === "folder").length,
    files: items.filter((item) => item.type === "file").length,
    generatedAt: new Date().toISOString(),
  };
}

function clampDepth(value, fallback, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}
