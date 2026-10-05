const DEFAULT_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
  "content-type": "application/json;charset=UTF-8",
  origin: "https://pan.quark.cn",
  referer: "https://pan.quark.cn/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

const API_BASE = "https://drive-pc.quark.cn/1/clouddrive/share/sharepage";

export class QuarkShareError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "QuarkShareError";
    this.details = details;
  }
}

export function parseQuarkShareUrl(input) {
  let url;

  try {
    url = new URL(input);
  } catch {
    throw new QuarkShareError("Invalid URL", { input });
  }

  if (url.hostname !== "pan.quark.cn") {
    throw new QuarkShareError("Only pan.quark.cn share links are supported", {
      hostname: url.hostname,
    });
  }

  const pwdId = url.pathname.match(/\/s\/([^/?#]+)/)?.[1];
  if (!pwdId) {
    throw new QuarkShareError("Share id was not found in the URL", { input });
  }

  const hashPath = decodeURIComponent(url.hash || "");
  const sharePath = hashPath.match(/^#\/list\/share\/?(.*)$/)?.[1] || "";
  const pathSegments = sharePath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map(parseHashSegment);

  return {
    originalUrl: input,
    pwdId,
    pdirFid: pathSegments.at(-1)?.fid || "0",
    pathSegments,
    navigationSegments: pathSegments,
    baseShareUrl: `https://pan.quark.cn/s/${pwdId}`,
  };
}

function parseHashSegment(segment) {
  const [fid, ...nameParts] = segment.split("-");
  return {
    fid,
    name: nameParts.join("-") || "",
  };
}

export function buildQuarkItemLink(pwdId, pathSegments = []) {
  const targetSegment = [...pathSegments].reverse().find((segment) => segment.fid);

  if (!targetSegment || targetSegment.fid === "0") {
    return `https://pan.quark.cn/s/${pwdId}#/list/share`;
  }

  return `https://pan.quark.cn/s/${pwdId}#/list/share/${encodeHashPart(targetSegment.fid)}`;
}

function buildQuarkRecordLink({ pwdId, isDir, parentSegments, pdirFid, nextSegments }) {
  if (isDir) {
    return {
      shareLink: buildQuarkItemLink(pwdId, nextSegments),
      linkTarget: "self",
    };
  }

  const fallbackParentSegments =
    pdirFid && pdirFid !== "0" ? [{ fid: pdirFid, name: "" }] : [];
  return {
    shareLink: buildQuarkItemLink(
      pwdId,
      parentSegments.length ? parentSegments : fallbackParentSegments
    ),
    linkTarget: "parent_folder",
  };
}

function encodeHashPart(value) {
  return encodeURIComponent(String(value)).replace(/%2F/gi, "/");
}

export function normalizeResourceTitle(fileName) {
  return String(fileName)
    .trim()
    .replace(/\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mp3|flac|wav|ape|aac|m4a)$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class QuarkShareClient {
  constructor({ fetchImpl = globalThis.fetch, headers = {} } = {}) {
    if (!fetchImpl) {
      throw new QuarkShareError("Current Node runtime does not provide fetch. Use Node 20+.");
    }

    this.fetchImpl = fetchImpl;
    this.headers = {
      ...DEFAULT_HEADERS,
      ...headers,
    };
  }

  async getStoken(pwdId, passcode = "") {
    const url = new URL(`${API_BASE}/token`);
    url.searchParams.set("pr", "ucpro");
    url.searchParams.set("fr", "pc");
    url.searchParams.set("uc_param_str", "");
    url.searchParams.set("__dt", String(randomInt(100, 9999)));
    url.searchParams.set("__t", String(Date.now()));

    const response = await this.fetchJson(url, {
      method: "POST",
      body: JSON.stringify({
        pwd_id: pwdId,
        passcode,
      }),
    });

    if (response.status !== 200 || !response.data?.stoken) {
      throw new QuarkShareError(response.message || "Failed to get share stoken", {
        code: response.code,
        status: response.status,
      });
    }

    return response.data.stoken;
  }

  async listDirectory({ pwdId, stoken, pdirFid = "0", pageSize = 50 }) {
    const items = [];
    let page = 1;
    let total = Infinity;

    while (items.length < total) {
      const response = await this.fetchDirectoryPage({
        pwdId,
        stoken,
        pdirFid,
        page,
        pageSize,
      });

      if (response.code !== 0) {
        throw new QuarkShareError(response.message || "Failed to read share directory", {
          code: response.code,
          status: response.status,
        });
      }

      const list = response.data?.list || [];
      items.push(...list);
      total = Number(response.metadata?._total ?? items.length);

      if (!list.length || list.length < pageSize) {
        break;
      }

      page += 1;
    }

    return items;
  }

  async fetchDirectoryPage({ pwdId, stoken, pdirFid, page, pageSize }) {
    const url = new URL(`${API_BASE}/detail`);
    const params = {
      pr: "ucpro",
      fr: "pc",
      uc_param_str: "",
      pwd_id: pwdId,
      stoken,
      pdir_fid: pdirFid || "0",
      force: "0",
      _page: String(page),
      _size: String(pageSize),
      _fetch_banner: "0",
      _fetch_share: "0",
      _fetch_total: "1",
      _sort: "file_type:asc,updated_at:desc",
      ver: "2",
      fetch_share_full_path: "0",
      __dt: String(randomInt(200, 9999)),
      __t: String(Date.now()),
    };

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return this.fetchJson(url, { method: "GET" });
  }

  async fetchJson(url, options = {}) {
    const response = await this.fetchImpl(url, {
      ...options,
      headers: {
        ...this.headers,
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let json;

    try {
      json = JSON.parse(text);
    } catch {
      throw new QuarkShareError("Provider response was not JSON", {
        status: response.status,
        bodyPreview: text.slice(0, 200),
      });
    }

    if (!response.ok) {
      throw new QuarkShareError(`HTTP request failed: ${response.status}`, {
        status: response.status,
        response: json,
      });
    }

    return json;
  }
}

export async function exportQuarkShareIndex({
  shareUrl,
  passcode = "",
  maxDepth = 0,
  recursive = true,
  client = new QuarkShareClient(),
}) {
  const parsed = parseQuarkShareUrl(shareUrl);
  const stoken = await client.getStoken(parsed.pwdId, passcode);
  const rows = [];

  await walkDirectory({
    client,
    pwdId: parsed.pwdId,
    stoken,
    pdirFid: parsed.pdirFid,
    maxDepth,
    recursive,
    depth: 0,
    parentSegments: parsed.navigationSegments,
    pathParts: parsed.pathSegments.map((segment) => segment.name).filter(Boolean),
    sourceShareUrl: parsed.originalUrl,
    rows,
  });

  return {
    source: {
      pwdId: parsed.pwdId,
      pdirFid: parsed.pdirFid,
      shareUrl: parsed.originalUrl,
      exportedAt: new Date().toISOString(),
    },
    items: rows,
  };
}

async function walkDirectory({
  client,
  pwdId,
  stoken,
  pdirFid,
  maxDepth,
  recursive,
  depth,
  parentSegments,
  pathParts,
  sourceShareUrl,
  rows,
}) {
  if (depth > maxDepth) {
    return;
  }

  const items = await client.listDirectory({ pwdId, stoken, pdirFid });

  for (const item of items) {
    const title = item.file_name || item.name || "";
    const isDir = Boolean(item.dir);
    const nextSegments = [
      ...parentSegments,
      {
        fid: item.fid,
        name: title,
      },
    ];
    const nextPathParts = [...pathParts, title].filter(Boolean);
    const recordLink = buildQuarkRecordLink({
      pwdId,
      isDir,
      parentSegments,
      pdirFid,
      nextSegments,
    });

    rows.push({
      title,
      normalizedTitle: normalizeResourceTitle(title),
      type: isDir ? "folder" : "file",
      path: nextPathParts.join("/"),
      shareLink: recordLink.shareLink,
      linkTarget: recordLink.linkTarget,
      sourceShareUrl,
      fid: item.fid,
      parentFid: item.pdir_fid ?? pdirFid,
      fileType: item.file_type ?? null,
      size: item.size ?? item.file_size ?? null,
      updatedAt: item.updated_at ?? item.last_update_at ?? null,
    });

    if (recursive && isDir && depth < maxDepth) {
      await walkDirectory({
        client,
        pwdId,
        stoken,
        pdirFid: item.fid,
        maxDepth,
        recursive,
        depth: depth + 1,
        parentSegments: nextSegments,
        pathParts: nextPathParts,
        sourceShareUrl,
        rows,
      });
    }
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
