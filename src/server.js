#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getProvider, listProviders } from "./providers/index.js";
import { indexStats, listIndexChildren, saveIndexResult, searchIndex } from "./index-store.js";
import { cleanupStatus, startInvalidCleanup } from "./invalid-cleaner.js";
import { AliyunShareError } from "./aliyun-share.js";
import { QuarkShareError } from "./quark-share.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");
const publicRoot = resolve(projectRoot, "public");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    handleError(response, error);
  }
});

server.listen(port, host, () => {
  console.log(`video-collect web is running at http://${host}:${port}`);
});

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      name: "video-collect",
      time: new Date().toISOString(),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/providers") {
    sendJson(response, 200, {
      providers: listProviders(),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/indexes/stats") {
    sendJson(response, 200, await indexStats());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/indexes/search") {
    sendJson(response, 200, await searchIndex({
      query: url.searchParams.get("q") || "",
      limit: url.searchParams.get("limit") || 50,
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/indexes/children") {
    sendJson(response, 200, await listIndexChildren({
      shareLink: url.searchParams.get("shareLink") || "",
      query: url.searchParams.get("q") || "",
      limit: url.searchParams.get("limit") || 300,
      matchedOnly: url.searchParams.get("matchedOnly") === "1",
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/indexes/cleanup-invalid/status") {
    sendJson(response, 200, cleanupStatus());
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/indexes/cleanup-invalid") {
    const body = await readJson(request);
    const status = await startInvalidCleanup({
      query: String(body.query || "").trim(),
      delayMs: body.delayMs,
    });
    sendJson(response, status.status === "running" ? 202 : 200, status);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/parse-url") {
    const body = await readJson(request);
    const provider = requireProvider(body.providerId || "quark-share");
    sendJson(response, 200, {
      providerId: provider.id,
      parsed: provider.parse(body),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/index/export") {
    const body = await readJson(request);

    if (!body.confirmAuthorized) {
      sendJson(response, 400, {
        error: {
          code: "authorization_confirmation_required",
          message: "Authorization confirmation is required before indexing this share link.",
        },
      });
      return;
    }

    const provider = requireProvider(body.providerId || "quark-share");
    const result = await provider.collect(body);

    if (body.saveToLibrary !== false) {
      result.saved = await saveIndexResult(result);
    }

    sendJson(response, 200, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/index/batch-export") {
    const body = await readJson(request);

    if (!body.confirmAuthorized) {
      sendJson(response, 400, {
        error: {
          code: "authorization_confirmation_required",
          message: "Authorization confirmation is required before indexing share links.",
        },
      });
      return;
    }

    const provider = requireProvider(body.providerId || "quark-share");
    const shareUrls = normalizeShareUrls(body.shareUrls || body.batchText || "", provider.id);

    if (!shareUrls.length) {
      sendJson(response, 400, {
        error: {
          code: "missing_share_urls",
          message: "At least one share URL is required.",
        },
      });
      return;
    }

    const maxDepth = body.maxDepth ?? provider.limits?.batchMaxDepth ?? provider.limits?.maxDepth ?? 12;
    const results = [];
    const failed = [];
    const items = [];

    for (const shareUrl of shareUrls) {
      try {
        const result = await provider.collect({
          ...body,
          shareUrl,
          maxDepth,
          recursive: body.recursive !== false,
        });
        results.push({
          shareUrl,
          ok: true,
          total: result.summary.total,
          folders: result.summary.folders,
          files: result.summary.files,
        });
        for (const item of result.items) items.push(item);
      } catch (error) {
        failed.push({
          shareUrl,
          ok: false,
          message: error.message,
        });
      }
    }

    const batchResult = {
      providerId: provider.id,
      providerName: provider.displayName,
      source: {
        shareUrls,
        exportedAt: new Date().toISOString(),
      },
      summary: summarizeItems(items),
      batch: {
        totalLinks: shareUrls.length,
        succeeded: results.length,
        failed: failed.length,
        results,
        failedItems: failed,
      },
      items,
    };

    if (body.saveToLibrary !== false && items.length) {
      batchResult.saved = await saveIndexResult(batchResult);
    }

    sendJson(response, 200, batchResult);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/indexes/save") {
    const body = await readJson(request);
    const saved = await saveIndexResult(body);
    sendJson(response, 200, saved);
    return;
  }

  sendJson(response, 404, {
    error: {
      code: "not_found",
      message: "API route was not found.",
    },
  });
}

function requireProvider(providerId) {
  const provider = getProvider(providerId);
  if (!provider) {
    throw new HttpError(404, `Provider not found: ${providerId}`, "provider_not_found");
  }

  return provider;
}

function normalizeShareUrls(input, providerId = "quark-share") {
  const rawItems = Array.isArray(input) ? input : String(input).split(/\r?\n\s*\r?\n|\r?\n/);
  const matcher = shareUrlMatcher(providerId);
  const urls = [];
  const seen = new Set();

  for (const rawItem of rawItems) {
    const text = String(rawItem || "").trim();
    if (!text) {
      continue;
    }

    const matches = text.match(matcher) || [text];
    for (const match of matches) {
      const url = cleanShareUrl(match);
      if (!url || seen.has(url)) {
        continue;
      }
      seen.add(url);
      urls.push(url);
    }
  }

  return urls;
}

function shareUrlMatcher(providerId) {
  if (providerId === "aliyun-share") {
    return /https?:\/\/(?:www\.)?(?:aliyundrive\.com|alipan\.com)\/s\/[^\s"'<>，,；;]+/g;
  }

  return /https?:\/\/pan\.quark\.cn\/s\/[^\s"'<>，,；;]+/g;
}

function cleanShareUrl(url) {
  return String(url || "")
    .trim()
    .replace(/[)\]}。.!！？、，,；;]+$/g, "");
}

function summarizeItems(items) {
  return {
    total: items.length,
    folders: items.filter((item) => item.type === "folder").length,
    files: items.filter((item) => item.type === "file").length,
    generatedAt: new Date().toISOString(),
  };
}

async function serveStatic(response, pathname) {
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(join(publicRoot, safePath === "/" ? "index.html" : safePath));

  if (!filePath.startsWith(publicRoot)) {
    throw new HttpError(403, "Forbidden path.", "forbidden");
  }

  let targetPath = filePath;
  const fileStat = await stat(targetPath).catch(() => null);

  if (fileStat?.isDirectory()) {
    targetPath = join(targetPath, "index.html");
  }

  const content = await readFile(targetPath);
  response.writeHead(200, {
    "content-type": contentType(targetPath),
    "cache-control": "no-store",
  });
  response.end(content);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.", "invalid_json");
  }
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data, null, 2));
}

function handleError(response, error) {
  if (error instanceof HttpError) {
    sendJson(response, error.statusCode, {
      error: {
        code: error.code,
        message: error.message,
      },
    });
    return;
  }

  if (error instanceof QuarkShareError || error instanceof AliyunShareError) {
    sendJson(response, error.details?.code === "provider_timeout" ? 504 : 502, {
      error: {
        code: error.details?.code || "provider_error",
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  console.error(error);
  sendJson(response, 500, {
    error: {
      code: "internal_error",
      message: "Internal server error.",
    },
  });
}

function contentType(filePath) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  };

  return types[extname(filePath).toLowerCase()] || "application/octet-stream";
}

class HttpError extends Error {
  constructor(statusCode, message, code = "http_error") {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}
