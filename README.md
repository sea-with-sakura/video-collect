# video-collect

Personal resource indexing tools. The current implementation reads supported cloud-share directory metadata and builds a local, searchable mapping from resource names to share-page links.

## 项目概览

Video Collect 是一个网盘分享资源索引工具，使用 Node.js 原生 HTTP 服务、原生 JavaScript 前端和 SQLite 存储，无第三方 npm 依赖。

- Web 支持夸克和阿里云盘分享链接的目录元数据采集、单链接/批量/CSV 导入、JSON/CSV 导出。
- 索引库支持关键词搜索、目录浏览，以及按数据源校验并清理失效资源。
- CLI 当前支持夸克分享链接解析及索引导出。
- 支持 Docker Compose 部署，运行数据保存在 `data/`，导出文件保存在 `exports/`；这些本地数据不提交到 Git。

主要代码：`src/server.js` 提供 HTTP API，`src/providers/` 注册数据源，`src/*-share.js` 对接网盘分享 API，`src/index-store.js` 管理 SQLite 索引，`src/invalid-cleaner.js` 清理失效条目，`public/` 提供 Web 界面。

本地启动（Node.js 需支持内置 `node:sqlite`）：

```bash
npm start
```

默认访问 `http://127.0.0.1:4173`。Linux 上可通过 `HOST=0.0.0.0 PORT=4173 npm start` 调整监听地址和端口。

## Boundary

- Only index links you own, created, or are authorized to index.
- The tool reads directory metadata only.
- It does not download files, transfer files, or resolve download URLs.
- Remote indexing requires explicit authorization confirmation.

## Web App

Start the web workspace:

```powershell
node .\src\server.js
```

Default URL:

```text
http://127.0.0.1:4173
```

Bind to all interfaces when running in Docker or on a NAS:

```powershell
$env:HOST="0.0.0.0"; $env:PORT="4173"; node .\src\server.js
```

The web app saves generated mappings to SQLite:

```text
data/resource-index.sqlite
```

If an older `data/resource-index.json` exists, it is migrated automatically on first startup/search/save. After a successful migration the original file is preserved as:

```text
data/resource-index.json.migrated
```

The saved records are searchable through the UI and through:

```text
GET /api/indexes/search?q=<keyword>&limit=50
GET /api/indexes/stats
```

The web app supports batch import. Pick a provider in the sidebar, then paste matching share links copied from Excel into the batch box; one link per line or blank-line-separated blocks both work. Batch import uses max depth `12` by default so nested folders are collected as deeply as the provider allows.

Batch and CSV imports use controlled concurrency in the browser. The default concurrency is `3`, configurable in the UI up to `8`. Each link is fetched without writing immediately, then all collected results are saved once at the end. This is faster than serial import and avoids concurrent writes to `data/resource-index.json`.

CSV import is also supported. Upload a `.csv` file and the browser scans the entire file text for links that match the selected provider, not a fixed column, so links can appear in any column or inside mixed notes. UTF-8 and common Chinese Excel CSV encoding are handled on the client side. The detected links can be filled into the batch box or imported directly.

Batch API:

```text
POST /api/index/batch-export
```

## Docker / NAS Deployment

The project has no third-party npm dependencies. Docker is the recommended deployment path for NAS systems such as fnOS/Feiniu NAS.

Build and start:

```bash
docker compose up -d --build
```

Open:

```text
http://<nas-ip>:4173
```

Persistent data lives in:

```text
./data:/app/data
./exports:/app/exports
```

When migrating an existing SQLite index, stop the local app first, then copy `data/resource-index.sqlite`. If SQLite WAL files exist and the app was running, also copy `resource-index.sqlite-wal` and `resource-index.sqlite-shm`, or checkpoint SQLite before copying.

## CLI

Parse a URL without remote access:

```powershell
node .\src\cli.js parse-url "https://pan.quark.cn/s/example#/list/share/folder-id"
```

Export JSON:

```powershell
node .\src\cli.js export "https://pan.quark.cn/s/example" --confirm-authorized --format json --out .\exports\index.json
```

Export CSV:

```powershell
node .\src\cli.js export "https://pan.quark.cn/s/example" --confirm-authorized --format csv --out .\exports\index.csv
```

Default max depth is `0`, which indexes the current directory level only. Increase it when you intentionally want nested files:

```powershell
node .\src\cli.js export "https://pan.quark.cn/s/example" --confirm-authorized --max-depth 1
```

## Saved Mapping Shape

Each saved item keeps the fields needed for later search and retrieval:

- `title`: original file or folder name
- `normalizedTitle`: normalized searchable title
- `type`: `folder` or `file`
- `path`: path inside the share
- `shareLink`: Provider share-page link to open. Folder records use their own directory id where supported; file records use the parent folder link because file routes are not reliably openable across providers.
- `linkTarget`: `self` for folders, `parent_folder` for files
- `sourceShareUrl`: original entry link used for collection
- `fid`: provider file id
- `parentFid`: parent folder id
- `providerId`: provider namespace
- `searchText`: internal normalized search text

SQLite is the default store. It keeps deployment simple while making search, updates, and larger imports much faster than the previous JSON file store. The provider output shape is unchanged, so Meilisearch or Typesense can still be added later if needed.

## Backend Extension

Providers live behind a small registry:

- `src/providers/index.js`: provider registration
- `src/providers/quark-provider.js`: Quark share provider
- `src/providers/aliyun-provider.js`: Aliyun Drive share provider
- `src/aliyun-share.js`: Aliyun Drive share API client and normalizer
- `src/server.js`: common API surface
- `src/index-store.js`: SQLite-backed local search store

To add TMDB, MusicBrainz, AList, or another API, add a `*-provider.js` that implements:

- `parse(input)`
- `collect(input)` returning `{ providerId, providerName, source, summary, items }`
- `capabilities`, `auth`, and `limits`
