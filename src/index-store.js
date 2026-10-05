import { existsSync } from "node:fs";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(__dirname, "..");
const defaultDbPath = resolve(projectRoot, "data", "resource-index.sqlite");
const legacyJsonPath = resolve(projectRoot, "data", "resource-index.json");

let db;
let initialized = false;

export async function saveIndexResult(result, { storePath = defaultDbPath } = {}) {
  await ensureStore(storePath);
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;

  const select = db.prepare("SELECT first_saved_at FROM resources WHERE id = ?");
  const upsert = db.prepare(`
    INSERT INTO resources (
      id, provider_id, provider_name, title, normalized_title, type, path,
      share_link, link_target, source_share_url, fid, parent_fid, file_type,
      size, item_updated_at, source_json, first_saved_at, saved_at, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider_id = excluded.provider_id,
      provider_name = excluded.provider_name,
      title = excluded.title,
      normalized_title = excluded.normalized_title,
      type = excluded.type,
      path = excluded.path,
      share_link = excluded.share_link,
      link_target = excluded.link_target,
      source_share_url = excluded.source_share_url,
      fid = excluded.fid,
      parent_fid = excluded.parent_fid,
      file_type = excluded.file_type,
      size = excluded.size,
      item_updated_at = excluded.item_updated_at,
      source_json = excluded.source_json,
      saved_at = excluded.saved_at,
      search_text = excluded.search_text
  `);

  runTransaction(() => {
    for (const item of result.items || []) {
      const record = toRecord(result, item, now);
      const existing = select.get(record.id);
      if (existing) {
        updated += 1;
        record.firstSavedAt = existing.first_saved_at || record.firstSavedAt;
      } else {
        inserted += 1;
      }

      upsert.run(...recordParams(record));
    }

    setMetadata("updatedAt", now);
  });

  return {
    inserted,
    updated,
    total: countResources(),
    storePath,
  };
}

export async function searchIndex({ query = "", limit = 50, storePath = defaultDbPath } = {}) {
  await ensureStore(storePath);
  const normalizedQuery = normalizeSearchText(query);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));

  if (!normalizedQuery) {
    const rows = db.prepare(`
      SELECT * FROM resources
      ORDER BY normalized_title COLLATE NOCASE ASC
      LIMIT ?
    `).all(safeLimit);

    return {
      total: countResources(),
      items: rows.map(fromRow),
      updatedAt: getMetadata("updatedAt"),
    };
  }

  const like = `%${escapeLike(normalizedQuery)}%`;
  const total = db.prepare(`
    SELECT COUNT(*) AS count FROM resources
    WHERE search_text LIKE ? ESCAPE '\\'
  `).get(like).count;
  const uniqueTotal = db.prepare(`
    SELECT COUNT(DISTINCT COALESCE(NULLIF(share_link, ''), id)) AS count
    FROM resources
    WHERE search_text LIKE ? ESCAPE '\\'
  `).get(like).count;
  const candidateLimit = Math.min(2000, Math.max(safeLimit * 20, 300));
  const rows = db.prepare(`
    SELECT * FROM resources
    WHERE search_text LIKE ? ESCAPE '\\'
    ORDER BY normalized_title COLLATE NOCASE ASC
    LIMIT ?
  `).all(like, candidateLimit);
  const collapsedRows = collapseRowsByShareLink(rows, safeLimit);

  return {
    total: uniqueTotal,
    rawTotal: total,
    collapsed: true,
    items: collapsedRows.map(fromRow),
    updatedAt: getMetadata("updatedAt"),
  };
}

export async function indexStats({ storePath = defaultDbPath } = {}) {
  await ensureStore(storePath);
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN type = 'folder' THEN 1 ELSE 0 END) AS folders,
      SUM(CASE WHEN type = 'file' THEN 1 ELSE 0 END) AS files
    FROM resources
  `).get();

  return {
    total: row.total || 0,
    folders: row.folders || 0,
    files: row.files || 0,
    updatedAt: getMetadata("updatedAt"),
    storePath,
  };
}

export async function listIndexResources({ query = "", limit = 100000, storePath = defaultDbPath } = {}) {
  await ensureStore(storePath);
  const normalizedQuery = normalizeSearchText(query);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100000, 200000));

  if (!normalizedQuery) {
    const rows = db.prepare(`
      SELECT * FROM resources
      ORDER BY saved_at ASC, id ASC
      LIMIT ?
    `).all(safeLimit);
    return rows.map(fromRow);
  }

  const like = `%${escapeLike(normalizedQuery)}%`;
  const rows = db.prepare(`
    SELECT * FROM resources
    WHERE search_text LIKE ? ESCAPE '\\'
    ORDER BY saved_at ASC, id ASC
    LIMIT ?
  `).all(like, safeLimit);

  return rows.map(fromRow);
}

export async function listIndexChildren({
  shareLink = "",
  query = "",
  limit = 300,
  matchedOnly = false,
  storePath = defaultDbPath,
} = {}) {
  await ensureStore(storePath);
  const normalizedShareLink = normalizeShareLinkKey(shareLink);
  const safeLimit = Math.max(1, Math.min(Number(limit) || 300, 1000));

  if (!normalizedShareLink) {
    return {
      total: 0,
      items: [],
    };
  }

  const normalizedQuery = normalizeSearchText(query);
  const like = normalizedQuery ? `%${escapeLike(normalizedQuery)}%` : "";
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM resources
    WHERE RTRIM(share_link, '/') = ?
  `).get(normalizedShareLink).count;
  const matchedFilter = matchedOnly && normalizedQuery
    ? "AND (LOWER(COALESCE(title, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(normalized_title, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(fid, '')) LIKE ? ESCAPE '\\')"
    : "";
  const matchedTotal = normalizedQuery
    ? db.prepare(`
      SELECT COUNT(*) AS count
      FROM resources
      WHERE RTRIM(share_link, '/') = ?
        AND (LOWER(COALESCE(title, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(normalized_title, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(fid, '')) LIKE ? ESCAPE '\\')
    `).get(normalizedShareLink, like, like, like).count
    : total;

  const rows = db.prepare(`
    SELECT *,
      CASE
        WHEN ? = '' THEN 0
        WHEN LOWER(COALESCE(title, '')) LIKE ? ESCAPE '\\' THEN 1
        WHEN LOWER(COALESCE(normalized_title, '')) LIKE ? ESCAPE '\\' THEN 1
        WHEN LOWER(COALESCE(fid, '')) LIKE ? ESCAPE '\\' THEN 1
        ELSE 0
      END AS query_matched
    FROM resources
    WHERE RTRIM(share_link, '/') = ?
      ${matchedFilter}
    ORDER BY query_matched DESC, type = 'folder' DESC, LENGTH(path) ASC, normalized_title COLLATE NOCASE ASC
    LIMIT ?
  `).all(...[
    normalizedQuery,
    like,
    like,
    like,
    normalizedShareLink,
    ...(matchedFilter ? [like, like, like] : []),
    safeLimit,
  ]);

  return {
    total,
    matchedTotal,
    items: rows.map(fromChildRow),
  };
}

export async function deleteIndexResource(id, { storePath = defaultDbPath } = {}) {
  await ensureStore(storePath);
  const result = db.prepare("DELETE FROM resources WHERE id = ?").run(id);
  if (result.changes > 0) {
    setMetadata("updatedAt", new Date().toISOString());
  }
  return result.changes;
}

async function ensureStore(storePath = defaultDbPath) {
  if (initialized && db) {
    return;
  }

  await mkdir(dirname(storePath), { recursive: true });
  db = new DatabaseSync(storePath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  createSchema();
  initialized = true;
  await migrateLegacyJsonIfNeeded(storePath);
}

function createSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      provider_name TEXT,
      title TEXT,
      normalized_title TEXT,
      type TEXT,
      path TEXT,
      share_link TEXT,
      link_target TEXT,
      source_share_url TEXT,
      fid TEXT,
      parent_fid TEXT,
      file_type INTEGER,
      size INTEGER,
      item_updated_at INTEGER,
      source_json TEXT,
      first_saved_at TEXT,
      saved_at TEXT,
      search_text TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_resources_normalized_title ON resources(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
    CREATE INDEX IF NOT EXISTS idx_resources_fid ON resources(fid);
    CREATE INDEX IF NOT EXISTS idx_resources_parent_fid ON resources(parent_fid);
    CREATE INDEX IF NOT EXISTS idx_resources_saved_at ON resources(saved_at);

    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

async function migrateLegacyJsonIfNeeded(storePath) {
  if (!existsSync(legacyJsonPath)) {
    return;
  }

  if (getMetadata("legacyJsonMigrated") === "true") {
    return;
  }

  const raw = await readFile(legacyJsonPath, "utf8");
  const legacy = JSON.parse(raw);
  const items = Array.isArray(legacy.items) ? legacy.items : [];
  if (!items.length) {
    setMetadata("legacyJsonMigrated", "true");
    return;
  }

  const now = legacy.updatedAt || new Date().toISOString();
  const source = {
    providerId: "legacy-json",
    providerName: "Legacy JSON",
    source: null,
    items,
  };

  const upsert = db.prepare(`
    INSERT INTO resources (
      id, provider_id, provider_name, title, normalized_title, type, path,
      share_link, link_target, source_share_url, fid, parent_fid, file_type,
      size, item_updated_at, source_json, first_saved_at, saved_at, search_text
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `);

  runTransaction(() => {
    for (const item of items) {
      const record = normalizeLegacyRecord(source, item, now);
      upsert.run(...recordParams(record));
    }
    setMetadata("updatedAt", now);
    setMetadata("legacyJsonMigrated", "true");
  });

  const migratedPath = `${legacyJsonPath}.migrated`;
  if (!existsSync(migratedPath)) {
    await rename(legacyJsonPath, migratedPath);
  }
}

function normalizeLegacyRecord(result, item, savedAt) {
  if (item.id && item.providerId) {
    const record = {
      id: item.id,
      providerId: item.providerId,
      providerName: item.providerName || item.providerId,
      title: item.title || "",
      normalizedTitle: item.normalizedTitle || item.title || "",
      type: item.type || "unknown",
      path: item.path || item.title || "",
      shareLink: item.shareLink || "",
      linkTarget: item.linkTarget || "self",
      sourceShareUrl: item.sourceShareUrl || "",
      fid: item.fid || "",
      parentFid: item.parentFid || "",
      fileType: item.fileType ?? null,
      size: item.size ?? null,
      itemUpdatedAt: item.itemUpdatedAt ?? item.updatedAt ?? null,
      source: item.source || null,
      firstSavedAt: item.firstSavedAt || item.savedAt || savedAt,
      savedAt: item.savedAt || savedAt,
      searchText: item.searchText || normalizeSearchText([
        item.title,
        item.normalizedTitle,
        item.path,
        item.fid,
        item.shareLink,
      ].join(" ")),
    };
    return record;
  }

  return toRecord(result, item, savedAt);
}

function toRecord(result, item, savedAt) {
  const providerId = result.providerId || "unknown";
  const id = `${providerId}:${item.fid || item.shareLink}`;
  const title = item.title || "";
  const normalizedTitle = item.normalizedTitle || title;

  return {
    id,
    providerId,
    providerName: result.providerName || providerId,
    title,
    normalizedTitle,
    type: item.type || "unknown",
    path: item.path || title,
    shareLink: item.shareLink || "",
    linkTarget: item.linkTarget || "self",
    sourceShareUrl: item.sourceShareUrl || result.source?.shareUrl || "",
    fid: item.fid || "",
    parentFid: item.parentFid || "",
    fileType: item.fileType ?? null,
    size: item.size ?? null,
    itemUpdatedAt: item.updatedAt ?? item.itemUpdatedAt ?? null,
    source: result.source || item.source || null,
    firstSavedAt: savedAt,
    savedAt,
    searchText: normalizeSearchText([
      title,
      normalizedTitle,
      item.path,
      item.fid,
      item.shareLink,
    ].join(" ")),
  };
}

function recordParams(record) {
  return [
    record.id,
    record.providerId,
    record.providerName,
    record.title,
    record.normalizedTitle,
    record.type,
    record.path,
    record.shareLink,
    record.linkTarget,
    record.sourceShareUrl,
    record.fid,
    record.parentFid,
    record.fileType,
    record.size,
    record.itemUpdatedAt,
    record.source ? JSON.stringify(record.source) : null,
    record.firstSavedAt,
    record.savedAt,
    record.searchText,
  ];
}

function fromRow(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    title: row.title,
    normalizedTitle: row.normalized_title,
    type: row.type,
    path: row.path,
    shareLink: row.share_link,
    linkTarget: row.link_target,
    sourceShareUrl: row.source_share_url,
    fid: row.fid,
    parentFid: row.parent_fid,
    fileType: row.file_type,
    size: row.size,
    itemUpdatedAt: row.item_updated_at,
    source: row.source_json ? JSON.parse(row.source_json) : null,
    firstSavedAt: row.first_saved_at,
    savedAt: row.saved_at,
  };
}

function fromChildRow(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    title: row.title,
    normalizedTitle: row.normalized_title,
    type: row.type,
    path: row.path,
    shareLink: row.share_link,
    linkTarget: row.link_target,
    sourceShareUrl: row.source_share_url,
    fid: row.fid,
    parentFid: row.parent_fid,
    matched: Boolean(row.query_matched),
  };
}

function collapseRowsByShareLink(rows, limit) {
  const groups = new Map();

  for (const row of rows) {
    const key = normalizeShareLinkKey(row.share_link) || row.id;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(row);
  }

  const findFolderByLink = db.prepare(`
    SELECT * FROM resources
    WHERE share_link = ? AND type = 'folder'
    ORDER BY LENGTH(path) ASC, normalized_title COLLATE NOCASE ASC
    LIMIT 1
  `);

  const collapsed = [];
  for (const group of groups.values()) {
    collapsed.push(bestSearchRepresentative(group, findFolderByLink));
    if (collapsed.length >= limit) {
      break;
    }
  }

  return collapsed;
}

function bestSearchRepresentative(group, findFolderByLink) {
  const matchingFolder = group.find((row) => row.type === "folder");
  if (matchingFolder) {
    return matchingFolder;
  }

  const link = group[0]?.share_link || "";
  if (link) {
    const folder = findFolderByLink.get(link);
    if (folder) {
      return folder;
    }
  }

  return [...group].sort(compareRepresentativeRows)[0];
}

function compareRepresentativeRows(left, right) {
  if (left.type === "folder" && right.type !== "folder") return -1;
  if (left.type !== "folder" && right.type === "folder") return 1;
  return pathDepth(left.path) - pathDepth(right.path);
}

function pathDepth(path) {
  return String(path || "").split("/").filter(Boolean).length;
}

function normalizeShareLinkKey(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function countResources() {
  return db.prepare("SELECT COUNT(*) AS count FROM resources").get().count;
}

function getMetadata(key) {
  return db.prepare("SELECT value FROM metadata WHERE key = ?").get(key)?.value || null;
}

function setMetadata(key, value) {
  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function runTransaction(fn) {
  db.exec("BEGIN");
  try {
    fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}
