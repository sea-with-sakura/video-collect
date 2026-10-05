const PROVIDER_URL_REGEX = {
  "quark-share": /https?:\/\/pan\.quark\.cn\/s\/[^\s"'<>，,；;]+/g,
  "aliyun-share": /https?:\/\/(?:www\.)?(?:aliyundrive\.com|alipan\.com)\/s\/[^\s"'<>，,；;]+/g,
};

const PROVIDER_COPY = {
  "quark-share": {
    example: "https://pan.quark.cn/s/xxxx",
    label: "夸克分享链接",
  },
  "aliyun-share": {
    example: "https://www.aliyundrive.com/s/xxxx",
    label: "阿里云盘分享链接",
  },
};

const state = {
  providerId: "quark-share",
  providers: [],
  activeView: "index",
  activeTab: "single",
  lastResult: null,
  progressTimer: null,
  cleanupTimer: null,
  lastSearchQuery: "",
  csvLinks: [],
  failedLinks: [],
  isCancelled: false,
  activeControllers: new Set(),
  resultFilters: {
    query: "",
    type: "all",
    status: "all",
  },
};

const elements = {
  apiStatus: document.querySelector("#apiStatus"),
  providerList: document.querySelector("#providerList"),
  viewButtons: document.querySelectorAll("[data-view-button]"),
  indexOnlySections: document.querySelectorAll("[data-index-only]"),
  searchPanel: document.querySelector("[data-view-panel='search']"),
  collectorForm: document.querySelector("#collectorForm"),
  shareUrl: document.querySelector("#shareUrl"),
  passcode: document.querySelector("#passcode"),
  parseButton: document.querySelector("#parseButton"),
  collectButton: document.querySelector("#collectButton"),
  batchCollectButton: document.querySelector("#batchCollectButton"),
  csvCollectButton: document.querySelector("#csvCollectButton"),
  batchLinks: document.querySelector("#batchLinks"),
  batchConcurrency: document.querySelector("#batchConcurrency"),
  csvFileInput: document.querySelector("#csvFileInput"),
  csvDropZone: document.querySelector("#csvDropZone"),
  csvScanButton: document.querySelector("#csvScanButton"),
  csvFileStatus: document.querySelector("#csvFileStatus"),
  confirmAuthorized: document.querySelector("#confirmAuthorized"),
  stopTaskButton: document.querySelector("#stopTaskButton"),
  stopBatchButton: document.querySelector("#stopBatchButton"),
  stopCsvButton: document.querySelector("#stopCsvButton"),
  permissionHint: document.querySelector("#permissionHint"),
  batchPermissionHint: document.querySelector("#batchPermissionHint"),
  progressPanel: document.querySelector("#progressPanel"),
  progressText: document.querySelector("#progressText"),
  progressMeta: document.querySelector("#progressMeta"),
  message: document.querySelector("#message"),
  resultRows: document.querySelector("#resultRows"),
  metricTotal: document.querySelector("#metricTotal"),
  metricFolders: document.querySelector("#metricFolders"),
  metricFiles: document.querySelector("#metricFiles"),
  metricFailed: document.querySelector("#metricFailed"),
  metricStored: document.querySelector("#metricStored"),
  downloadJson: document.querySelector("#downloadJson"),
  downloadCsv: document.querySelector("#downloadCsv"),
  retryFailedButton: document.querySelector("#retryFailedButton"),
  refreshLibrary: document.querySelector("#refreshLibrary"),
  cleanupInvalidButton: document.querySelector("#cleanupInvalidButton"),
  cleanupStatusPanel: document.querySelector("#cleanupStatusPanel"),
  cleanupProgressText: document.querySelector("#cleanupProgressText"),
  cleanupProgressMeta: document.querySelector("#cleanupProgressMeta"),
  cleanupProgressBar: document.querySelector("#cleanupProgressBar"),
  cleanupRecent: document.querySelector("#cleanupRecent"),
  searchInput: document.querySelector("#searchInput"),
  searchButton: document.querySelector("#searchButton"),
  savedRows: document.querySelector("#savedRows"),
  resultSearchInput: document.querySelector("#resultSearchInput"),
  batchPreview: document.querySelector("#batchPreview"),
  batchPreviewRows: document.querySelector("#batchPreviewRows"),
  csvPreview: document.querySelector("#csvPreview"),
  csvPreviewRows: document.querySelector("#csvPreviewRows"),
};

boot();

async function boot() {
  bindEvents();
  setActiveView(state.activeView);
  setDownloadsEnabled(false);
  updatePermissionState();
  renderEmptyResult();

  try {
    await api("/api/health");
    elements.apiStatus.textContent = "Online";
    elements.apiStatus.classList.add("ok");

    const { providers } = await api("/api/providers");
    state.providers = providers;
    renderProviders();
    syncProviderUi();
    await refreshLibrary();
  } catch (error) {
    elements.apiStatus.textContent = "Offline";
    elements.apiStatus.classList.add("error");
    setMessage(error.message, "error");
  }
}

function bindEvents() {
  elements.viewButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveView(button.dataset.viewButton));
  });

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });

  elements.collectorForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await collectIndex();
  });

  elements.parseButton.addEventListener("click", parseCurrentUrl);
  elements.batchCollectButton.addEventListener("click", collectBatchIndex);
  elements.csvScanButton.addEventListener("click", scanCsvIntoPreview);
  elements.csvCollectButton.addEventListener("click", collectCsvIndex);
  elements.csvFileInput.addEventListener("change", scanCsvIntoPreview);
  elements.downloadJson.addEventListener("click", () => downloadResult("json"));
  elements.downloadCsv.addEventListener("click", () => downloadResult("csv"));
  elements.retryFailedButton.addEventListener("click", retryFailedLinks);
  elements.refreshLibrary.addEventListener("click", refreshLibrary);
  elements.cleanupInvalidButton.addEventListener("click", startInvalidCleanup);
  elements.searchButton.addEventListener("click", searchLibrary);
  elements.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchLibrary();
    }
  });

  elements.confirmAuthorized.addEventListener("change", updatePermissionState);

  [elements.stopTaskButton, elements.stopBatchButton, elements.stopCsvButton].forEach((button) => {
    button.addEventListener("click", stopTask);
  });

  elements.batchLinks.addEventListener("input", () => {
    renderPreviewRows(elements.batchPreview, elements.batchPreviewRows, extractShareUrls(elements.batchLinks.value));
  });

  elements.resultSearchInput.addEventListener("input", () => {
    state.resultFilters.query = elements.resultSearchInput.value.trim().toLowerCase();
    renderResultRows();
  });

  document.querySelectorAll("[data-type-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      setSegment("[data-type-filter]", button);
      state.resultFilters.type = button.dataset.typeFilter;
      renderResultRows();
    });
  });

  document.querySelectorAll("[data-status-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      setSegment("[data-status-filter]", button);
      state.resultFilters.status = button.dataset.statusFilter;
      renderResultRows();
    });
  });

  elements.csvDropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.csvDropZone.classList.add("drag-over");
  });
  elements.csvDropZone.addEventListener("dragleave", () => {
    elements.csvDropZone.classList.remove("drag-over");
  });
  elements.csvDropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.csvDropZone.classList.remove("drag-over");
    if (event.dataTransfer.files?.length) {
      elements.csvFileInput.files = event.dataTransfer.files;
      scanCsvIntoPreview();
    }
  });
}

function setActiveView(view) {
  state.activeView = view === "search" ? "search" : "index";

  elements.viewButtons.forEach((button) => {
    const active = button.dataset.viewButton === state.activeView;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });

  elements.indexOnlySections.forEach((section) => {
    section.hidden = state.activeView !== "index";
  });

  if (elements.searchPanel) {
    elements.searchPanel.hidden = state.activeView !== "search";
  }

  if (state.activeView === "search") {
    searchLibrary().catch((error) => {
      elements.savedRows.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    });
    window.setTimeout(() => elements.searchInput?.focus(), 0);
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tab);
  });
  updatePermissionState();
}

function renderProviders() {
  elements.providerList.innerHTML = "";

  for (const provider of state.providers) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `provider-button ${provider.id === state.providerId ? "active" : ""}`;
    button.innerHTML = `
      <span class="dot" aria-hidden="true"></span>
      <span class="provider-name">${escapeHtml(provider.displayName)}</span>
      <span class="provider-tag">${escapeHtml(provider.category)}</span>
    `;
    button.addEventListener("click", () => {
      state.providerId = provider.id;
      state.csvLinks = [];
      renderProviders();
      syncProviderUi();
    });
    elements.providerList.append(button);
  }
}

function syncProviderUi() {
  const copy = currentProviderCopy();
  const limits = currentProviderLimits();
  const maxConcurrency = limits.maxConcurrency || 8;
  elements.shareUrl.placeholder = `请输入分享链接，例如：${copy.example}`;
  elements.batchLinks.placeholder = `每行输入一个${copy.label}，也支持用空格、逗号或换行分隔。`;
  elements.batchConcurrency.max = String(maxConcurrency);
  if (Number(elements.batchConcurrency.value || 1) > maxConcurrency) {
    elements.batchConcurrency.value = String(maxConcurrency);
  }
  if (!elements.batchConcurrency.value && limits.defaultBatchConcurrency) {
    elements.batchConcurrency.value = String(limits.defaultBatchConcurrency);
  }
  elements.csvFileStatus.textContent = "";
  renderPreviewRows(elements.batchPreview, elements.batchPreviewRows, extractShareUrls(elements.batchLinks.value));
  renderPreviewRows(elements.csvPreview, elements.csvPreviewRows, state.csvLinks);
  updatePermissionState();
}

async function parseCurrentUrl() {
  const payload = formPayload();
  if (!payload.shareUrl) {
    setMessage("请输入有效的分享链接。", "error");
    return;
  }

  setBusy(elements.parseButton, true);
  setMessage("正在解析链接。");

  try {
    const response = await api("/api/parse-url", {
      method: "POST",
      body: payload,
    });
    const parsed = response.parsed;
    const shareId = parsed.shareId || parsed.pwdId || "-";
    const folderId = parsed.rootFileId || parsed.pdirFid || "root";
    setMessage(`分享 ID: ${shareId}，当前目录: ${folderId}`, "ok");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    setBusy(elements.parseButton, false);
  }
}

async function collectIndex() {
  const payload = formPayload();

  if (!payload.shareUrl) {
    setMessage("请输入有效的分享链接。", "error");
    return;
  }

  if (!payload.confirmAuthorized) {
    setMessage("请先确认你拥有索引该资源的权限。", "error");
    return;
  }

  beginTask("single");
  startProgress(["解析分享入口", "获取目录授权", "读取目录元数据", "生成名称与链接映射", "写入本地索引库"]);
  setMessage("正在解析…");

  try {
    const result = await api("/api/index/export", {
      method: "POST",
      body: payload,
    });
    await handleIndexResult(result);
  } catch (error) {
    if (!state.isCancelled) {
      setMessage(error.message, "error");
    }
  } finally {
    endTask();
  }
}

async function collectBatchIndex() {
  const payload = formPayload();
  const shareUrls = extractShareUrls(elements.batchLinks.value);
  await collectLinks(payload, shareUrls, "批量链接");
}

async function collectCsvIndex() {
  const payload = formPayload();
  const shareUrls = state.csvLinks.length ? state.csvLinks : await readCsvLinks();
  await collectLinks(payload, shareUrls, "CSV 文件");
}

async function collectLinks(payload, shareUrls, sourceLabel) {
  if (!shareUrls.length) {
    setMessage(`${sourceLabel}中没有识别到${currentProviderCopy().label}。`, "error");
    return;
  }

  if (!payload.confirmAuthorized) {
    setMessage("请先确认你拥有索引该资源的权限。", "error");
    return;
  }

  beginTask(state.activeTab);
  startProgress(["解析批量链接"]);
  const concurrency = getBatchConcurrency();
  setMessage(`已识别 ${shareUrls.length} 个链接，并发数 ${concurrency}，正在解析…`);

  try {
    const result = await collectBatchConcurrently(payload, shareUrls, concurrency);
    await handleIndexResult(result);
  } catch (error) {
    if (!state.isCancelled) {
      setMessage(error.message, "error");
    }
  } finally {
    endTask();
  }
}

async function collectBatchConcurrently(payload, shareUrls, concurrency) {
  const items = [];
  const results = [];
  const failedItems = [];
  const batchMaxDepth = currentProviderLimits().batchMaxDepth ?? 12;
  let nextIndex = 0;
  let completed = 0;
  let active = 0;

  const workerCount = Math.min(concurrency, shareUrls.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < shareUrls.length && !state.isCancelled) {
      const index = nextIndex;
      nextIndex += 1;
      active += 1;
      await collectOneBatchLink({
        payload,
        shareUrls,
        index,
        items,
        results,
        failedItems,
        batchMaxDepth,
        getActive: () => active,
        setCompleted: (value) => {
          completed = value;
        },
        getCompleted: () => completed,
      });
      active -= 1;
    }
  }));

  const batchResult = {
    providerId: payload.providerId,
    providerName: currentProviderName(),
    source: {
      shareUrls,
      exportedAt: new Date().toISOString(),
    },
    summary: summarizeItems(items),
    batch: {
      totalLinks: shareUrls.length,
      succeeded: results.length,
      failed: failedItems.length,
      results,
      failedItems,
      concurrency,
      maxDepth: batchMaxDepth,
    },
    items,
  };

  if (payload.saveToLibrary && items.length && !state.isCancelled) {
    elements.progressText.textContent = "正在统一写入索引库";
    setMessage(`采集完成，正在统一保存 ${items.length} 条索引。`);
    batchResult.saved = await api("/api/indexes/save", {
      method: "POST",
      body: batchResult,
    });
  }

  return batchResult;
}

async function collectOneBatchLink({
  payload,
  shareUrls,
  index,
  items,
  results,
  failedItems,
  batchMaxDepth,
  getActive,
  setCompleted,
  getCompleted,
}) {
  const current = index + 1;
  const shareUrl = shareUrls[index];
  updateBatchProgress({
    completed: getCompleted(),
    total: shareUrls.length,
    succeeded: results.length,
    failed: failedItems.length,
    active: getActive(),
    current,
    maxDepth: batchMaxDepth,
  });

  try {
    const result = await api("/api/index/export", {
      method: "POST",
      body: {
        ...payload,
        shareUrl,
        maxDepth: batchMaxDepth,
        recursive: true,
        saveToLibrary: false,
      },
    });

    items.push(...result.items);
    results.push({
      shareUrl,
      ok: true,
      total: result.summary.total,
      folders: result.summary.folders,
      files: result.summary.files,
    });
  } catch (error) {
    failedItems.push({
      shareUrl,
      ok: false,
      message: state.isCancelled ? "任务已停止" : error.message,
    });
  } finally {
    const completed = getCompleted() + 1;
    setCompleted(completed);
    updateBatchProgress({
      completed,
      total: shareUrls.length,
      succeeded: results.length,
      failed: failedItems.length,
      active: Math.max(0, getActive() - 1),
      current,
      maxDepth: batchMaxDepth,
    });
  }
}

function updateBatchProgress({ completed, total, succeeded, failed, active, current, maxDepth = 12 }) {
  const text = `已完成 ${completed} / ${total}，成功 ${succeeded}，失败 ${failed}，运行中 ${active}`;
  elements.progressText.textContent = text;
  elements.progressMeta.textContent = `当前处理链接：${current} / ${total} · 已发现目录 ${elements.metricFolders.textContent} · 已发现文件 ${elements.metricFiles.textContent} · 当前递归深度 ${maxDepth}`;
  setMessage(`${text}。当前批次位置：${current} / ${total}`);
}

async function scanCsvIntoPreview() {
  try {
    const links = await readCsvLinks();
    state.csvLinks = links;
    elements.batchLinks.value = links.join("\n\n");
    renderPreviewRows(elements.csvPreview, elements.csvPreviewRows, links);
    renderPreviewRows(elements.batchPreview, elements.batchPreviewRows, links);
    elements.csvCollectButton.disabled = !elements.confirmAuthorized.checked;
    setCsvStatus(`已从 CSV 识别 ${links.length} 个唯一${currentProviderCopy().label}。`, "ok");
  } catch (error) {
    state.csvLinks = [];
    renderPreviewRows(elements.csvPreview, elements.csvPreviewRows, []);
    setCsvStatus(error.message, "error");
  }
}

async function readCsvLinks() {
  const file = elements.csvFileInput.files?.[0];
  if (!file) {
    throw new Error("请先选择 CSV 文件。");
  }

  const text = await readTextFile(file);
  const links = extractShareUrls(text);
  if (!links.length) {
    throw new Error(`CSV 文件中没有识别到${currentProviderCopy().label}。`);
  }

  return links;
}

async function readTextFile(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("gb18030").decode(bytes).replace(/^\uFEFF/, "");
  }
}

async function handleIndexResult(result) {
  if (state.isCancelled) {
    setMessage("任务已停止。", "error");
    return;
  }

  state.lastResult = result;
  state.failedLinks = result.batch?.failedItems || [];
  renderResult(result);
  setDownloadsEnabled(true);
  await refreshLibrary();

  const savedText = result.saved
    ? `已保存到索引库：新增 ${result.saved.inserted}，更新 ${result.saved.updated}。`
    : "本次未保存到索引库。";
  const batchText = result.batch
    ? `链接成功 ${result.batch.succeeded}/${result.batch.totalLinks}，失败 ${result.batch.failed}。`
    : "";
  const failureText = result.batch?.failedItems?.length
    ? `首个失败原因：${result.batch.failedItems[0].message}。`
    : "";
  setMessage(`索引生成完成。${batchText}${failureText}${savedText}`, "ok");
}

function formPayload(overrides = {}) {
  const form = new FormData(elements.collectorForm);
  const saveMode = form.get("saveMode") || "save";
  return {
    providerId: state.providerId,
    shareUrl: String(form.get("shareUrl") || "").trim(),
    passcode: String(form.get("passcode") || "").trim(),
    maxDepth: Number(form.get("maxDepth") || 0),
    recursive: form.get("recursive") === "on",
    confirmAuthorized: form.get("confirmAuthorized") === "on",
    saveToLibrary: saveMode === "save",
    ...overrides,
  };
}

function extractShareUrls(text) {
  const matcher = PROVIDER_URL_REGEX[state.providerId] || PROVIDER_URL_REGEX["quark-share"];
  const matches = String(text || "").match(matcher) || [];
  const seen = new Set();
  const links = [];

  for (const match of matches) {
    const cleaned = cleanShareUrl(match);
    if (!cleaned || seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    links.push(cleaned);
  }

  return links;
}

function cleanShareUrl(url) {
  return String(url || "")
    .trim()
    .replace(/[)\]}。.!！?？、，,；;]+$/g, "");
}

function renderResult(result) {
  elements.metricTotal.textContent = result.summary.total;
  elements.metricFolders.textContent = result.summary.folders;
  elements.metricFiles.textContent = result.summary.files;
  elements.metricFailed.textContent = result.batch?.failed || 0;
  elements.retryFailedButton.hidden = !(result.batch?.failedItems?.length);
  renderResultRows();
}

function renderResultRows() {
  const result = state.lastResult;
  if (!result || !result.items.length) {
    renderEmptyResult();
    return;
  }

  const filtered = result.items.filter((item) => {
    const query = state.resultFilters.query;
    const matchesQuery = !query || `${item.title} ${item.path}`.toLowerCase().includes(query);
    const matchesType = state.resultFilters.type === "all" || item.type === state.resultFilters.type;
    const matchesStatus = state.resultFilters.status === "all" || state.resultFilters.status === "success";
    return matchesQuery && matchesType && matchesStatus;
  });

  if (!filtered.length) {
    elements.resultRows.innerHTML = `
      <tr class="empty-row">
        <td colspan="5">
          <strong>没有匹配结果</strong>
          <span>请调整搜索关键词或筛选条件。</span>
        </td>
      </tr>
    `;
    return;
  }

  elements.resultRows.innerHTML = filtered.slice(0, 500).map((item) => `
    <tr>
      <td title="${escapeHtml(item.title)}">
        <span class="item-name">${item.type === "folder" ? "📁" : "📄"} ${escapeHtml(item.title)}</span>
      </td>
      <td><span class="type-badge ${item.type}">${item.type === "folder" ? "目录" : "文件"}</span></td>
      <td title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</td>
      <td>
        <button class="link-copy" type="button" data-copy="${escapeAttribute(item.shareLink)}" title="${escapeAttribute(item.shareLink)}">
          复制链接
        </button>
        <a class="link-cell" href="${escapeAttribute(item.shareLink)}" target="_blank" rel="noreferrer">打开</a>
      </td>
      <td class="fid-cell" title="${escapeHtml(item.fid)}">${escapeHtml(item.fid)}</td>
    </tr>
  `).join("");

  elements.resultRows.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = "复制链接";
      }, 1200);
    });
  });
}

function renderEmptyResult() {
  elements.resultRows.innerHTML = `
    <tr class="empty-row">
      <td colspan="5">
        <strong>暂无索引结果</strong>
        <span>请输入分享链接或导入 CSV 文件后开始生成索引。</span>
      </td>
    </tr>
  `;
}

function renderPreviewRows(wrapper, container, links) {
  wrapper.hidden = !links.length;
  if (!links.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = links.slice(0, 20).map((link, index) => `
    <div class="preview-row">
      <span>${index + 1}</span>
      <strong title="${escapeAttribute(link)}">${escapeHtml(link)}</strong>
      <em>待处理</em>
    </div>
  `).join("");
}

async function retryFailedLinks() {
  const payload = formPayload({ confirmAuthorized: true });
  const links = state.failedLinks.map((item) => item.shareUrl).filter(Boolean);
  await collectLinks(payload, links, "失败项");
}

async function refreshLibrary() {
  const stats = await api("/api/indexes/stats");
  elements.metricStored.textContent = stats.total;
  await searchLibrary();
}

async function searchLibrary() {
  const query = elements.searchInput.value.trim();
  state.lastSearchQuery = query;
  const params = new URLSearchParams({
    q: query,
    limit: "20",
  });
  const result = await api(`/api/indexes/search?${params.toString()}`);
  renderSavedRows(result.items, result.total, result);
}

async function startInvalidCleanup() {
  const query = elements.searchInput.value.trim();
  if (!query && !window.confirm("将校验整个索引库：夸克使用 10 并发，阿里保持低速；空目录或失效文件索引会被删除。确认开始吗？")) {
    return;
  }

  elements.cleanupInvalidButton.disabled = true;
  elements.cleanupStatusPanel.hidden = false;
  elements.cleanupProgressText.textContent = "正在启动清理任务";
  elements.cleanupProgressMeta.textContent = query
    ? `清理范围：当前关键词「${query}」`
    : "清理范围：全部索引";
  elements.cleanupProgressBar.style.width = "0%";

  try {
    const status = await api("/api/indexes/cleanup-invalid", {
      method: "POST",
      body: {
        query,
        delayMs: 1000,
      },
    });
    renderCleanupStatus(status);
    startCleanupPolling();
  } catch (error) {
    elements.cleanupProgressText.textContent = "清理任务启动失败";
    elements.cleanupProgressMeta.textContent = error.message;
    elements.cleanupInvalidButton.disabled = false;
  }
}

function startCleanupPolling() {
  stopCleanupPolling();
  state.cleanupTimer = window.setInterval(async () => {
    try {
      const status = await api("/api/indexes/cleanup-invalid/status");
      renderCleanupStatus(status);
      if (status.status !== "running") {
        stopCleanupPolling();
        elements.cleanupInvalidButton.disabled = false;
        await refreshLibrary();
      }
    } catch (error) {
      stopCleanupPolling();
      elements.cleanupProgressText.textContent = "状态刷新失败";
      elements.cleanupProgressMeta.textContent = error.message;
      elements.cleanupInvalidButton.disabled = false;
    }
  }, 1200);
}

function stopCleanupPolling() {
  if (state.cleanupTimer) {
    window.clearInterval(state.cleanupTimer);
    state.cleanupTimer = null;
  }
}

function renderCleanupStatus(status) {
  elements.cleanupStatusPanel.hidden = status.status === "idle";
  if (status.status === "idle") {
    return;
  }

  const percent = status.total ? Math.round((status.completed / status.total) * 100) : 0;
  const statusText = {
    running: "正在清理无效索引",
    completed: "无效索引清理完成",
    failed: "无效索引清理失败",
  }[status.status] || "清理状态";

  elements.cleanupProgressText.textContent = statusText;
  elements.cleanupProgressMeta.textContent =
    `已完成 ${status.completed} / ${status.total}，运行中 ${status.active || 0}，保留 ${status.valid}，删除 ${status.deleted}，跳过 ${status.skipped}，失败 ${status.failed}`;
  elements.cleanupProgressBar.style.width = `${Math.max(0, Math.min(percent, 100))}%`;
  elements.cleanupRecent.innerHTML = renderCleanupRecent(status);
}

function renderCleanupRecent(status) {
  const currentItems = Array.isArray(status.current) ? status.current : (status.current ? [status.current] : []);
  const current = currentItems.map((item) => `
    <div class="cleanup-row active">
      <strong>处理中</strong>
      <span>${escapeHtml(item.title || item.path || item.id)}</span>
      <em>${escapeHtml(item.providerId || "")}</em>
    </div>
  `).join("");
  const recent = (status.recent || []).map((item) => `
    <div class="cleanup-row ${item.action}">
      <strong>${cleanupActionLabel(item.action)}</strong>
      <span title="${escapeAttribute(item.reason || "")}">${escapeHtml(item.title || item.shareLink || item.id)}</span>
      <em>${escapeHtml(item.reason || "")}</em>
    </div>
  `).join("");

  return current || recent ? `${current}${recent}` : "";
}

function cleanupActionLabel(action) {
  return {
    kept: "保留",
    deleted: "删除",
    skipped: "跳过",
    failed: "失败",
    not_found: "未找到",
  }[action] || action || "-";
}

function renderSavedRows(items, total, meta = {}) {
  if (!items.length) {
    elements.savedRows.innerHTML = `<div class="empty-state">暂无匹配索引</div>`;
    return;
  }

  const summary = meta.collapsed && meta.rawTotal > total
    ? `匹配 ${meta.rawTotal} 条明细，折叠为 ${total} 个入口，显示前 ${items.length} 个`
    : `匹配 ${total} 条，显示前 ${items.length} 条`;

  elements.savedRows.innerHTML = `
    <div class="mini-summary">${summary}</div>
    ${items.map((item) => `
      <div class="mini-entry">
        <button class="mini-item" type="button" data-entry-link="${escapeAttribute(item.shareLink)}" aria-expanded="false">
          <strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
          <span>${escapeHtml(item.type)} · ${escapeHtml(item.path)}</span>
        </button>
        <div class="mini-entry-actions">
          <a class="ghost-link" href="${escapeAttribute(item.shareLink)}" target="_blank" rel="noreferrer">打开入口</a>
          <button class="text-button" type="button" data-copy="${escapeAttribute(item.shareLink)}">复制链接</button>
        </div>
        <div class="mini-children" hidden></div>
      </div>
    `).join("")}
  `;

  elements.savedRows.querySelectorAll("[data-entry-link]").forEach((button) => {
    button.addEventListener("click", () => toggleSavedEntry(button));
  });
  elements.savedRows.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "已复制";
      setTimeout(() => {
        button.textContent = "复制链接";
      }, 1200);
    });
  });
}

async function toggleSavedEntry(button) {
  const entry = button.closest(".mini-entry");
  const children = entry?.querySelector(".mini-children");
  if (!children) {
    return;
  }

  const expanded = button.getAttribute("aria-expanded") === "true";
  if (expanded) {
    button.setAttribute("aria-expanded", "false");
    children.hidden = true;
    return;
  }

  button.setAttribute("aria-expanded", "true");
  children.hidden = false;

  if (children.dataset.loaded === "true") {
    return;
  }

  children.innerHTML = `<div class="mini-child-empty">正在读取子项…</div>`;
  const params = new URLSearchParams({
    shareLink: button.dataset.entryLink,
    q: state.lastSearchQuery,
    limit: "300",
    matchedOnly: "1",
  });

  try {
    const result = await api(`/api/indexes/children?${params.toString()}`);
    children.dataset.loaded = "true";
    children.innerHTML = renderEntryChildren(result.items, result);
  } catch (error) {
    children.innerHTML = `<div class="mini-child-empty">${escapeHtml(error.message)}</div>`;
  }
}

function renderEntryChildren(items, result) {
  if (!items.length) {
    return `<div class="mini-child-empty">这个入口下没有直接命中当前关键词的子项。</div>`;
  }

  return `
    <div class="mini-child-summary">显示 ${items.length} / ${result.matchedTotal} 个命中子项，入口下共 ${result.total} 个已索引子项。</div>
    ${items.map((item) => `
      <div class="mini-child matched">
        <span class="child-type">${item.type === "folder" ? "目录" : "文件"}</span>
        <strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
        <span title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span>
        <em>命中</em>
      </div>
    `).join("")}
  `;
}

function updatePermissionState() {
  elements.collectButton.disabled = !elements.confirmAuthorized.checked;
  elements.batchCollectButton.disabled = !elements.confirmAuthorized.checked;
  elements.csvCollectButton.disabled = !elements.confirmAuthorized.checked || !state.csvLinks.length;
  elements.permissionHint.hidden = elements.confirmAuthorized.checked;
  elements.batchPermissionHint.hidden = elements.confirmAuthorized.checked;
}

function beginTask(mode) {
  state.isCancelled = false;
  setFormBusy(true);
  elements.stopTaskButton.hidden = mode !== "single";
  elements.stopBatchButton.hidden = mode !== "batch";
  elements.stopCsvButton.hidden = mode !== "csv";
  setPrimaryLoading(mode, true);
}

function endTask() {
  stopProgress();
  setFormBusy(false);
  elements.stopTaskButton.hidden = true;
  elements.stopBatchButton.hidden = true;
  elements.stopCsvButton.hidden = true;
  setPrimaryLoading("single", false);
  setPrimaryLoading("batch", false);
  setPrimaryLoading("csv", false);
  updatePermissionState();
}

function stopTask() {
  state.isCancelled = true;
  for (const controller of state.activeControllers) {
    controller.abort();
  }
  state.activeControllers.clear();
  setMessage("任务已停止。", "error");
}

function setPrimaryLoading(mode, loading) {
  const map = {
    single: elements.collectButton,
    batch: elements.batchCollectButton,
    csv: elements.csvCollectButton,
  };
  const labels = {
    single: "开始解析并生成索引",
    batch: "批量解析并生成索引",
    csv: "从 CSV 生成索引",
  };
  const button = map[mode];
  if (!button) return;
  button.classList.toggle("loading", loading);
  button.textContent = loading ? "正在解析…" : labels[mode];
}

function startProgress(stages) {
  let index = 0;
  clearInterval(state.progressTimer);
  elements.progressPanel.hidden = false;
  elements.progressText.textContent = stages[0] || "正在处理";
  elements.progressMeta.textContent = "当前处理链接：- · 已发现目录 0 · 已发现文件 0 · 当前递归深度 -";

  if (stages.length > 1) {
    state.progressTimer = setInterval(() => {
      index = (index + 1) % stages.length;
      elements.progressText.textContent = stages[index];
    }, 1100);
  }
}

function stopProgress() {
  clearInterval(state.progressTimer);
  state.progressTimer = null;
  elements.progressPanel.hidden = true;
}

function currentProviderName() {
  return state.providers.find((provider) => provider.id === state.providerId)?.displayName || state.providerId;
}

function currentProviderLimits() {
  return state.providers.find((provider) => provider.id === state.providerId)?.limits || {};
}

function currentProviderCopy() {
  return PROVIDER_COPY[state.providerId] || {
    example: "https://example.com/s/xxxx",
    label: "分享链接",
  };
}

function summarizeItems(items) {
  return {
    total: items.length,
    folders: items.filter((item) => item.type === "folder").length,
    files: items.filter((item) => item.type === "file").length,
    generatedAt: new Date().toISOString(),
  };
}

function setSegment(selector, activeButton) {
  document.querySelectorAll(selector).forEach((button) => {
    button.classList.toggle("active", button === activeButton);
  });
}

function getBatchConcurrency() {
  const limits = currentProviderLimits();
  const maxConcurrency = limits.maxConcurrency || 8;
  const fallback = limits.defaultBatchConcurrency || 3;
  const value = Number(elements.batchConcurrency.value || fallback);
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, maxConcurrency);
}

function downloadResult(format) {
  if (!state.lastResult) return;
  const filename = `video-collect-${new Date().toISOString().replace(/[:.]/g, "-")}.${format}`;
  const content = format === "json"
    ? JSON.stringify(state.lastResult, null, 2)
    : toCsv(state.lastResult.items);
  const type = format === "json" ? "application/json" : "text/csv";

  const blob = new Blob([content], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function api(path, options = {}) {
  const controller = new AbortController();
  state.activeControllers.add(controller);
  try {
    const response = await fetch(path, {
      method: options.method || "GET",
      headers: {
        "content-type": "application/json",
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || "请求失败");
    }
    return data;
  } finally {
    state.activeControllers.delete(controller);
  }
}

function setMessage(text, type = "") {
  elements.message.textContent = text;
  elements.message.className = `message ${type}`.trim();
}

function setCsvStatus(text, type = "") {
  elements.csvFileStatus.textContent = text;
  elements.csvFileStatus.className = `message inline-message ${type}`.trim();
}

function setBusy(button, isBusy) {
  button.disabled = isBusy;
}

function setFormBusy(isBusy) {
  elements.collectorForm
    .querySelectorAll("button, input, textarea")
    .forEach((element) => {
      if (element.id?.startsWith("stop")) {
        return;
      }
      element.disabled = isBusy;
    });
  elements.csvFileInput.disabled = isBusy;
}

function setDownloadsEnabled(enabled) {
  elements.downloadJson.disabled = !enabled;
  elements.downloadCsv.disabled = !enabled;
}

function toCsv(rows) {
  const columns = [
    "title",
    "normalizedTitle",
    "type",
    "path",
    "shareLink",
    "linkTarget",
    "sourceShareUrl",
    "fid",
    "parentFid",
    "fileType",
    "size",
    "updatedAt",
  ];
  return [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n");
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}
