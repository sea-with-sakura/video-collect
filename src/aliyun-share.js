import { fetchProviderText } from "./provider-request.js";

const DEFAULT_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "content-type": "application/json;charset=UTF-8",
  origin: "https://www.aliyundrive.com",
  referer: "https://www.aliyundrive.com/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

const API_BASE = "https://api.aliyundrive.com";
const SUPPORTED_HOSTS = new Set([
  "aliyundrive.com",
  "www.aliyundrive.com",
  "alipan.com",
  "www.alipan.com",
]);

export class AliyunShareError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AliyunShareError";
    this.details = details;
  }
}

export function parseAliyunShareUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new AliyunShareError("Invalid URL", { input });
  }

  if (!SUPPORTED_HOSTS.has(url.hostname)) {
    throw new AliyunShareError("Only Aliyun Drive share links are supported", {
      hostname: url.hostname,
    });
  }

  const shareId = url.pathname.match(/\/s\/([^/?#]+)/)?.[1];
  if (!shareId) {
    throw new AliyunShareError("Share id was not found in the URL", { input });
  }

  const folderId =
    url.pathname.match(/\/folder\/([^/?#]+)/)?.[1] ||
    decodeURIComponent(url.hash || "").match(/\/folder\/([^/?#]+)/)?.[1] ||
    "";

  return {
    originalUrl: input,
    shareId,
    rootFileId: folderId || "root",
    baseShareUrl: `${url.protocol}//${url.hostname}/s/${shareId}`,
    shareHost: url.hostname,
  };
}

export function buildAliyunFolderLink(baseShareUrl, fileId) {
  if (!fileId || fileId === "root") {
    return baseShareUrl;
  }

  return `${baseShareUrl}/folder/${encodeURIComponent(fileId)}`;
}

function buildAliyunRecordLink({ baseShareUrl, isFolder, fileId, parentFileId }) {
  if (isFolder) {
    return {
      shareLink: buildAliyunFolderLink(baseShareUrl, fileId),
      linkTarget: "self",
    };
  }

  return {
    shareLink: buildAliyunFolderLink(baseShareUrl, parentFileId),
    linkTarget: "parent_folder",
  };
}

export function normalizeResourceTitle(fileName) {
  return String(fileName)
    .trim()
    .replace(/\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mp3|flac|wav|ape|aac|m4a)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class AliyunShareClient {
  constructor({ fetchImpl = globalThis.fetch, headers = {}, requestDelayMs = 160 } = {}) {
    if (!fetchImpl) {
      throw new AliyunShareError("Current Node runtime does not provide fetch. Use Node 20+.");
    }

    this.fetchImpl = fetchImpl;
    this.requestDelayMs = requestDelayMs;
    this.headers = {
      ...DEFAULT_HEADERS,
      ...headers,
    };
  }

  async getShareToken(shareId, passcode = "") {
    const response = await this.fetchJson(`${API_BASE}/v2/share_link/get_share_token`, {
      method: "POST",
      body: JSON.stringify({
        share_id: shareId,
        share_pwd: passcode,
        expire_sec: 7200,
      }),
    });

    if (!response.share_token) {
      throw new AliyunShareError(response.message || "Failed to get Aliyun share token", {
        code: response.code,
        response,
      });
    }

    return response.share_token;
  }

  async getFile({ shareId, shareToken, fileId }) {
    return this.fetchJson(`${API_BASE}/v2/file/get`, {
      method: "POST",
      headers: {
        "x-share-token": shareToken,
      },
      body: JSON.stringify({
        share_id: shareId,
        file_id: fileId,
      }),
    });
  }

  async listDirectory({ shareId, shareToken, parentFileId = "root", pageSize = 100 }) {
    const items = [];
    let marker = "";

    do {
      const response = await this.fetchJson(`${API_BASE}/adrive/v2/file/list_by_share`, {
        method: "POST",
        headers: {
          "x-share-token": shareToken,
        },
        body: JSON.stringify({
          share_id: shareId,
          parent_file_id: parentFileId || "root",
          limit: pageSize,
          marker,
          order_by: "name",
          order_direction: "ASC",
        }),
      });

      if (!Array.isArray(response.items)) {
        throw new AliyunShareError(response.message || "Failed to read Aliyun share directory", {
          code: response.code,
          response,
        });
      }

      items.push(...response.items);
      marker = response.next_marker || "";
    } while (marker);

    return items;
  }

  async fetchJson(url, options = {}) {
    let lastError;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) {
        await sleep(450 * 2 ** (attempt - 1) + randomInt(80, 260));
      } else if (this.requestDelayMs > 0) {
        await sleep(this.requestDelayMs);
      }

      try {
        const { response, text } = await fetchProviderText(this.fetchImpl, url, {
          ...options,
          headers: {
            ...this.headers,
            ...(options.headers || {}),
          },
        }, { providerName: "阿里云盘", ErrorClass: AliyunShareError });
        let json;

        try {
          json = JSON.parse(text);
        } catch {
          throw new AliyunShareError("Provider response was not JSON", {
            status: response.status,
            bodyPreview: text.slice(0, 200),
          });
        }

        if (response.ok) {
          return json;
        }

        lastError = new AliyunShareError(json.message || `HTTP request failed: ${response.status}`, {
          status: response.status,
          response: json,
          attempt: attempt + 1,
        });

        if (!isRetryableProviderError(response.status, json)) {
          throw lastError;
        }
      } catch (error) {
        lastError = error;
        if (error instanceof AliyunShareError && !error.details?.retryable && !isRetryableProviderError(error.details?.status, error.details?.response)) {
          throw error;
        }
      }
    }

    throw lastError;
  }
}

function isRetryableProviderError(status, response = {}) {
  if ([408, 429, 500, 502, 503, 504].includes(Number(status))) {
    return true;
  }

  const code = String(response?.code || response?.error || "").toLowerCase();
  const message = String(response?.message || "").toLowerCase();
  return /limit|too.?many|thrott|频繁|限流|繁忙|timeout/.test(`${code} ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function exportAliyunShareIndex({
  shareUrl,
  passcode = "",
  maxDepth = 0,
  recursive = true,
  client = new AliyunShareClient(),
}) {
  const parsed = parseAliyunShareUrl(shareUrl);
  const shareToken = await client.getShareToken(parsed.shareId, passcode);
  const rows = [];
  const pathParts = [];

  if (parsed.rootFileId !== "root") {
    try {
      const rootFile = await client.getFile({
        shareId: parsed.shareId,
        shareToken,
        fileId: parsed.rootFileId,
      });
      if (rootFile?.name) {
        pathParts.push(rootFile.name);
      }
    } catch {
      // Folder links still remain indexable even if breadcrumb metadata is unavailable.
    }
  }

  await walkDirectory({
    client,
    shareId: parsed.shareId,
    shareToken,
    baseShareUrl: parsed.baseShareUrl,
    parentFileId: parsed.rootFileId,
    maxDepth,
    recursive,
    depth: 0,
    pathParts,
    sourceShareUrl: parsed.originalUrl,
    rows,
  });

  return {
    source: {
      shareId: parsed.shareId,
      rootFileId: parsed.rootFileId,
      shareUrl: parsed.originalUrl,
      exportedAt: new Date().toISOString(),
    },
    items: rows,
  };
}

async function walkDirectory({
  client,
  shareId,
  shareToken,
  baseShareUrl,
  parentFileId,
  maxDepth,
  recursive,
  depth,
  pathParts,
  sourceShareUrl,
  rows,
}) {
  if (depth > maxDepth) {
    return;
  }

  const items = await client.listDirectory({ shareId, shareToken, parentFileId });

  for (const item of items) {
    const title = item.name || item.file_name || "";
    const isFolder = item.type === "folder";
    const fileId = item.file_id;
    const currentParentId = item.parent_file_id ?? parentFileId;
    const nextPathParts = [...pathParts, title].filter(Boolean);
    const recordLink = buildAliyunRecordLink({
      baseShareUrl,
      isFolder,
      fileId,
      parentFileId: currentParentId,
    });

    rows.push({
      title,
      normalizedTitle: normalizeResourceTitle(title),
      type: isFolder ? "folder" : "file",
      path: nextPathParts.join("/"),
      shareLink: recordLink.shareLink,
      linkTarget: recordLink.linkTarget,
      sourceShareUrl,
      fid: fileId,
      parentFid: currentParentId,
      fileType: item.file_extension || item.category || item.mime_type || null,
      size: item.size ?? null,
      updatedAt: item.updated_at ?? null,
    });

    if (recursive && isFolder && depth < maxDepth) {
      await walkDirectory({
        client,
        shareId,
        shareToken,
        baseShareUrl,
        parentFileId: fileId,
        maxDepth,
        recursive,
        depth: depth + 1,
        pathParts: nextPathParts,
        sourceShareUrl,
        rows,
      });
    }
  }
}
