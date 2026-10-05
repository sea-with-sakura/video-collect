import {
  AliyunShareClient,
  exportAliyunShareIndex,
  parseAliyunShareUrl,
} from "../aliyun-share.js";

const tokenCache = new Map();

export const aliyunProvider = {
  id: "aliyun-share",
  name: "Aliyun Drive Share",
  displayName: "Aliyun Drive",
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
    defaultBatchConcurrency: 1,
    maxConcurrency: 1,
    cleanupConcurrency: 1,
    cleanupDelayMs: 1000,
  },

  parse(input) {
    return parseAliyunShareUrl(input.shareUrl);
  },

  async collect(input) {
    const maxDepth = clampDepth(input.maxDepth, this.limits.defaultMaxDepth, this.limits.maxDepth);
    const result = await exportAliyunShareIndex({
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
    return validateAliyunItem(item);
  },
};

async function validateAliyunItem(item) {
  if (!item.sourceShareUrl || !item.fid) {
    return {
      valid: true,
      delete: false,
      skipped: true,
      reason: "缺少原始分享链接或 file_id，跳过",
    };
  }

  const parsed = parseAliyunShareUrl(item.sourceShareUrl);
  const client = new AliyunShareClient({ requestDelayMs: 220 });
  const shareToken = await getCachedShareToken(client, parsed.shareId);

  if (item.type === "folder") {
    const children = await client.listDirectory({
      shareId: parsed.shareId,
      shareToken,
      parentFileId: item.fid,
      pageSize: 100,
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

  const parentFileId = item.parentFid || "root";
  const siblings = await client.listDirectory({
    shareId: parsed.shareId,
    shareToken,
    parentFileId,
    pageSize: 100,
  });
  const exists = siblings.some((entry) => entry.file_id === item.fid);

  return {
    valid: exists,
    delete: !exists,
    reason: exists ? "文件仍存在" : "父目录中未找到该文件",
  };
}

async function getCachedShareToken(client, shareId) {
  const cacheKey = `${shareId}:`;
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const shareToken = await client.getShareToken(shareId, "");
  tokenCache.set(cacheKey, shareToken);
  return shareToken;
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
