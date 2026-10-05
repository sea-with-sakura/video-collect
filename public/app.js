const PROVIDER_URL_REGEX = {
  "quark-share": /https?:\/\/pan\.quark\.cn\/s\/[^\s"'<>，,；;]+/g,
  "aliyun-share":
    /https?:\/\/(?:www\.)?(?:aliyundrive\.com|alipan\.com)\/s\/[^\s"'<>，,；;]+/g,
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
  activeView: window.location.hash === "#collect" ? "index" : "search",
  isBusy: false,
  searchSequence: 0,
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
  viewBreadcrumb: document.querySelector("#viewBreadcrumb"),
  librarySearchForm: document.querySelector("#librarySearchForm"),
  navLibraryCount: document.querySelector("#navLibraryCount"),
  libraryFolders: document.querySelector("#libraryFolders"),
  libraryFiles: document.querySelector("#libraryFiles"),
  libraryProviders: document.querySelector("#libraryProviders"),
  libraryResultsTitle: document.querySelector("#libraryResultsTitle"),
  libraryResultsMeta: document.querySelector("#libraryResultsMeta"),
  csvFileName: document.querySelector("#csvFileName"),
  resultCountLabel: document.querySelector("#resultCountLabel"),
  showFid: document.querySelector("#showFid"),
  resultTable: document.querySelector("#resultTable"),
  taskProgressBar: document.querySelector("#taskProgressBar"),
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
  setActiveView(state.activeView, false);
  setDownloadsEnabled(false);
  updatePermissionState();
  renderEmptyResult();
  renderLibraryLoading();

  try {
    await api("/api/health");
    elements.apiStatus.textContent = "服务在线";
    elements.apiStatus.classList.add("ok");
    const { providers } = await api("/api/providers");
    state.providers = providers;
    elements.libraryProviders.textContent = formatNumber(providers.length);
    renderProviders();
    syncProviderUi();
  } catch (error) {
    elements.apiStatus.textContent = "连接失败";
    elements.apiStatus.classList.add("error");
    renderLibraryError(error.message);
    setMessage(`无法连接服务：${error.message}`, "error");
    return;
  }
  await refreshLibrary();
  try {
    const status = await api("/api/indexes/cleanup-invalid/status");
    renderCleanupStatus(status);
    if (status.status === "running") {
      elements.cleanupInvalidButton.disabled = true;
      startCleanupPolling();
    }
  } catch {
    /* The library remains usable if cleanup status is unavailable. */
  }
}

function bindEvents() {
  elements.viewButtons.forEach((button) => {
    button.addEventListener("click", () =>
      setActiveView(button.dataset.viewButton),
    );
  });

  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });

  elements.collectorForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.isBusy) return;
    if (state.activeTab === "batch") await collectBatchIndex();
    else if (state.activeTab === "csv") await collectCsvIndex();
    else await collectIndex();
  });

  elements.parseButton.addEventListener("click", parseCurrentUrl);
  elements.batchCollectButton.addEventListener("click", collectBatchIndex);
  elements.csvScanButton.addEventListener("click", scanCsvIntoPreview);
  elements.csvCollectButton.addEventListener("click", collectCsvIndex);
  elements.csvFileInput.addEventListener("change", scanCsvIntoPreview);
  elements.downloadJson.addEventListener("click", () => downloadResult("json"));
  elements.downloadCsv.addEventListener("click", () => downloadResult("csv"));
  elements.retryFailedButton.addEventListener("click", retryFailedLinks);
  elements.refreshLibrary.addEventListener("click", () => refreshLibrary());
  elements.cleanupInvalidButton.addEventListener("click", startInvalidCleanup);
  elements.librarySearchForm.addEventListener("submit", (event) => {
    event.preventDefault();
    searchLibrary();
  });
  elements.searchInput.addEventListener("search", () => {
    if (!elements.searchInput.value) searchLibrary();
  });
  elements.showFid.addEventListener("change", () => {
    elements.resultTable.classList.toggle("show-fid", elements.showFid.checked);
  });
  document.addEventListener("keydown", (event) => {
    const editing = event.target.closest(
      "input, textarea, select, [contenteditable='true']",
    );
    if (
      event.key === "/" &&
      !editing &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      if (state.activeView !== "search") setActiveView("search");
      elements.searchInput.focus();
    }
  });
  window.addEventListener("hashchange", () => {
    setActiveView(window.location.hash === "#collect" ? "index" : "search");
  });
  document.addEventListener("click", (event) => {
    const copy = event.target.closest("[data-copy]");
    if (copy) copyLink(copy);
    const go = event.target.closest("[data-go-view]");
    if (go) setActiveView(go.dataset.goView);
    if (event.target.closest("[data-search-retry]")) {
      if (!state.providers.length) window.location.reload();
      else refreshLibrary();
    }
    if (event.target.closest("[data-search-clear]")) {
      elements.searchInput.value = "";
      searchLibrary();
    }
  });
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("keydown", (event) => {
      const tabs = [...document.querySelectorAll("[data-tab]")];
      const index = tabs.indexOf(button);
      let next;
      if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
      if (event.key === "ArrowLeft")
        next = tabs[(index + tabs.length - 1) % tabs.length];
      if (event.key === "Home") next = tabs[0];
      if (event.key === "End") next = tabs[tabs.length - 1];
      if (next) {
        event.preventDefault();
        setActiveTab(next.dataset.tab);
        next.focus();
      }
    });
  });

  elements.confirmAuthorized.addEventListener("change", updatePermissionState);

  [
    elements.stopTaskButton,
    elements.stopBatchButton,
    elements.stopCsvButton,
  ].forEach((button) => {
    button.addEventListener("click", stopTask);
  });

  elements.batchLinks.addEventListener("input", () => {
    renderPreviewRows(
      elements.batchPreview,
      elements.batchPreviewRows,
      extractShareUrls(elements.batchLinks.value),
    );
  });

  elements.resultSearchInput.addEventListener("input", () => {
    state.resultFilters.query = elements.resultSearchInput.value
      .trim()
      .toLowerCase();
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

function setActiveView(view, load = true) {
  state.activeView = view === "search" ? "search" : "index";
  const label = state.activeView === "search" ? "资源库" : "采集资源";
  document.title = `${label} · Video Collect`;
  elements.viewBreadcrumb.textContent = label;
  elements.viewButtons.forEach((button) => {
    const active = button.dataset.viewButton === state.activeView;
    button.classList.toggle("active", active);
    if (button.classList.contains("workspace-button")) {
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
  });
  elements.indexOnlySections.forEach((section) => {
    section.hidden = state.activeView !== "index";
  });
  elements.searchPanel.hidden = state.activeView !== "search";
  const hash = state.activeView === "index" ? "#collect" : "#library";
  if (window.location.hash !== hash) history.replaceState(null, "", hash);
  if (load && state.activeView === "search") {
    searchLibrary();
    elements.searchInput.focus({ preventScroll: true });
  }
}

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === tab);
    panel.hidden = panel.dataset.panel !== tab;
  });
  updatePermissionState();
}

function renderProviders() {
  elements.providerList.innerHTML = "";
  for (const provider of state.providers) {
    const button = document.createElement("button");
    const active = provider.id === state.providerId;
    button.type = "button";
    button.className = `provider-button ${active ? "active" : ""}`;
    button.setAttribute("aria-pressed", String(active));
    button.disabled = state.isBusy;
    button.innerHTML = `
      ${icon("cloud", "provider-icon")}
      <span class="provider-name">${escapeHtml(providerLabel(provider.id))}<small>${escapeHtml(provider.displayName)}</small></span>
      <span class="provider-check">${icon("check")}</span>`;
    button.addEventListener("click", () => {
      if (state.isBusy) return;
      state.providerId = provider.id;
      state.csvLinks = [];
      elements.csvFileInput.value = "";
      elements.csvFileName.textContent = "选择 .csv 文件";
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
  elements.shareUrl.placeholder = copy.example;
  elements.batchLinks.placeholder = `每行输入一个${copy.label}，也支持用空格、逗号或换行分隔。`;
  elements.batchConcurrency.max = String(maxConcurrency);
  if (Number(elements.batchConcurrency.value || 1) > maxConcurrency) {
    elements.batchConcurrency.value = String(maxConcurrency);
  }
  if (!elements.batchConcurrency.value && limits.defaultBatchConcurrency) {
    elements.batchConcurrency.value = String(limits.defaultBatchConcurrency);
  }
  elements.csvFileStatus.textContent = "";
  renderPreviewRows(
    elements.batchPreview,
    elements.batchPreviewRows,
    extractShareUrls(elements.batchLinks.value),
  );
  renderPreviewRows(
    elements.csvPreview,
    elements.csvPreviewRows,
    state.csvLinks,
  );
  updatePermissionState();
}

async function parseCurrentUrl() {
  const payload = formPayload();
  if (state.isBusy) return;

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

  if (state.isBusy) return;

  if (!payload.shareUrl) {
    setMessage("请输入有效的分享链接。", "error");
    return;
  }

  if (!payload.confirmAuthorized) {
    setMessage("请先确认你拥有索引该资源的权限。", "error");
    return;
  }

  beginTask("single");
  startProgress(["正在读取分享目录，较大的目录可能需要一些时间"]);
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
  const shareUrls = state.csvLinks.length
    ? state.csvLinks
    : await readCsvLinks();
  await collectLinks(payload, shareUrls, "CSV 文件");
}

async function collectLinks(payload, shareUrls, sourceLabel) {
  if (state.isBusy) return;
  if (!shareUrls.length) {
    setMessage(
      `${sourceLabel}中没有识别到${currentProviderCopy().label}。`,
      "error",
    );
    return;
  }

  if (!payload.confirmAuthorized) {
    setMessage("请先确认你拥有索引该资源的权限。", "error");
    return;
  }

  beginTask(state.activeTab);
  startProgress(["正在采集批量链接"]);
  const concurrency = getBatchConcurrency();
  setMessage(
    `已识别 ${shareUrls.length} 个链接，并发数 ${concurrency}，正在解析…`,
  );

  try {
    const result = await collectBatchConcurrently(
      payload,
      shareUrls,
      concurrency,
    );
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
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
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
    }),
  );

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

function updateBatchProgress({
  completed,
  total,
  succeeded,
  failed,
  active,
  current,
  maxDepth = 12,
}) {
  const text = `已完成 ${completed} / ${total}，成功 ${succeeded}，失败 ${failed}，运行中 ${active}`;
  elements.taskProgressBar.parentElement.classList.remove("indeterminate");
  elements.taskProgressBar.style.width = `${total ? (completed / total) * 100 : 0}%`;
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
    updatePermissionState();
    setCsvStatus(
      `已从 CSV 识别 ${links.length} 个唯一${currentProviderCopy().label}。`,
      "ok",
    );
  } catch (error) {
    state.csvLinks = [];
    renderPreviewRows(elements.csvPreview, elements.csvPreviewRows, []);
    updatePermissionState();
    setCsvStatus(error.message, "error");
  }
}

async function readCsvLinks() {
  const file = elements.csvFileInput.files?.[0];
  elements.csvFileName.textContent = file?.name || "选择 .csv 文件";
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
    return new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/, "");
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
  const matcher =
    PROVIDER_URL_REGEX[state.providerId] || PROVIDER_URL_REGEX["quark-share"];
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
  elements.metricTotal.textContent = formatNumber(result.summary.total);
  elements.metricFolders.textContent = formatNumber(result.summary.folders);
  elements.metricFiles.textContent = formatNumber(result.summary.files);
  elements.metricFailed.textContent = formatNumber(result.batch?.failed || 0);
  elements.metricFailed
    .closest(".stat-card")
    .classList.toggle("has-failures", Boolean(result.batch?.failed));
  elements.retryFailedButton.hidden = !result.batch?.failedItems?.length;
  renderResultRows();
}

function renderResultRows() {
  const result = state.lastResult;
  if (!result) {
    renderEmptyResult();
    return;
  }
  const { query, type, status } = state.resultFilters;
  const filtered = result.items.filter((item) => {
    return (
      (!query || `${item.title} ${item.path}`.toLowerCase().includes(query)) &&
      (type === "all" || item.type === type) &&
      status !== "failed"
    );
  });
  const failures = (result.batch?.failedItems || []).filter((item) => {
    return (
      status !== "success" &&
      type === "all" &&
      (!query ||
        `${item.shareUrl} ${item.message}`.toLowerCase().includes(query))
    );
  });
  const count = filtered.length + failures.length;
  elements.resultCountLabel.textContent = `${formatNumber(count)} 条结果${count > 500 ? " · 显示前 500 条" : ""}`;
  if (!count) {
    renderEmptyResult(
      result.items.length || result.batch?.failed
        ? "没有匹配的结果"
        : "这个分享中没有可索引的资源",
      result.items.length || result.batch?.failed
        ? "试试其他关键词或筛选条件。"
        : "尝试其他分享链接，或调整递归深度。",
    );
    return;
  }
  const failureRows = failures.slice(0, 500).map(
    (item) => `
    <tr class="failed-row"><td title="${escapeAttribute(item.shareUrl)}"><span class="item-name">${icon("warning-circle")}<span>${escapeHtml(item.shareUrl)}</span></span></td>
    <td><span class="type-badge failed">失败</span></td><td title="${escapeAttribute(item.message)}">${escapeHtml(item.message)}</td>
    <td><button class="link-copy" type="button" data-copy="${escapeAttribute(item.shareUrl)}">复制链接</button></td><td class="fid-cell">—</td></tr>`,
  );
  const successRows = filtered
    .slice(0, Math.max(0, 500 - failureRows.length))
    .map(
      (item) => `
    <tr><td title="${escapeAttribute(item.title)}"><span class="item-name">${icon(item.type === "folder" ? "folder" : "file")}<span>${escapeHtml(item.title)}</span></span></td>
    <td><span class="type-badge ${item.type === "folder" ? "folder" : "file"}">${item.type === "folder" ? "目录" : "文件"}</span></td>
    <td title="${escapeAttribute(item.path)}">${escapeHtml(item.path)}</td>
    <td><button class="link-copy" type="button" data-copy="${escapeAttribute(item.shareLink)}">复制链接</button><a class="link-cell" href="${escapeAttribute(safeLink(item.shareLink))}" target="_blank" rel="noreferrer">打开 ↗</a></td>
    <td class="fid-cell" title="${escapeAttribute(item.fid)}">${escapeHtml(item.fid)}</td></tr>`,
    );
  elements.resultRows.innerHTML = [...failureRows, ...successRows].join("");
}

function renderEmptyResult(
  title = "还没有采集结果",
  description = "添加分享链接并开始采集，结果会显示在这里。",
) {
  elements.resultRows.innerHTML = `<tr class="empty-row"><td colspan="5">${icon("tray")}<strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></td></tr>`;
}

function renderPreviewRows(wrapper, container, links) {
  wrapper.hidden = !links.length;
  if (!links.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML =
    links
      .slice(0, 20)
      .map(
        (link, index) => `
    <div class="preview-row">
      <span>${index + 1}</span>
      <strong title="${escapeAttribute(link)}">${escapeHtml(link)}</strong>
      <em>待处理</em>
    </div>
  `,
      )
      .join("") +
    (links.length > 20
      ? `<div class="preview-overflow">共 ${links.length} 个链接，预览前 20 个；采集时会处理全部链接。</div>`
      : "");
}

async function retryFailedLinks() {
  const payload = formPayload();
  setActiveView("index", false);
  const links = state.failedLinks.map((item) => item.shareUrl).filter(Boolean);
  await collectLinks(payload, links, "失败项");
}

async function refreshLibrary() {
  elements.refreshLibrary.disabled = true;
  elements.refreshLibrary.classList.add("loading");
  try {
    const stats = await api("/api/indexes/stats");
    elements.metricStored.textContent = formatNumber(stats.total);
    elements.navLibraryCount.textContent = compactNumber(stats.total);
    elements.libraryFolders.textContent = formatNumber(stats.folders);
    elements.libraryFiles.textContent = formatNumber(stats.files);
    await searchLibrary();
  } catch (error) {
    renderLibraryError(error.message);
  } finally {
    elements.refreshLibrary.disabled = false;
    elements.refreshLibrary.classList.remove("loading");
  }
}

async function searchLibrary() {
  const sequence = ++state.searchSequence;
  const query = elements.searchInput.value.trim();
  state.lastSearchQuery = query;
  elements.libraryResultsTitle.textContent = query ? "搜索结果" : "全部资源";
  elements.libraryResultsMeta.textContent = "正在查找…";
  elements.searchButton.disabled = true;
  elements.savedRows.setAttribute("aria-busy", "true");
  renderLibraryLoading();
  try {
    const params = new URLSearchParams({ q: query, limit: "50" });
    const result = await api(`/api/indexes/search?${params}`);
    if (sequence !== state.searchSequence) return;
    renderSavedRows(result.items, result.total, result);
  } catch (error) {
    if (sequence === state.searchSequence) renderLibraryError(error.message);
  } finally {
    if (sequence === state.searchSequence) {
      elements.searchButton.disabled = false;
      elements.savedRows.setAttribute("aria-busy", "false");
    }
  }
}

async function startInvalidCleanup() {
  const query = elements.searchInput.value.trim();
  const scope = query ? `关键词「${query}」匹配的资源` : "整个资源库";
  if (
    !window.confirm(
      `将校验${scope}，并删除失效文件或空目录的索引。确认开始清理吗？`,
    )
  ) {
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

  const percent = status.total
    ? Math.round((status.completed / status.total) * 100)
    : 0;
  const statusText =
    {
      running: "正在清理无效索引",
      completed: "无效索引清理完成",
      failed: "无效索引清理失败",
    }[status.status] || "清理状态";

  elements.cleanupProgressText.textContent = statusText;
  elements.cleanupProgressMeta.textContent = `已完成 ${status.completed} / ${status.total}，运行中 ${status.active || 0}，保留 ${status.valid}，删除 ${status.deleted}，跳过 ${status.skipped}，失败 ${status.failed}`;
  elements.cleanupProgressBar.style.width = `${Math.max(0, Math.min(percent, 100))}%`;
  elements.cleanupProgressBar.parentElement.setAttribute(
    "aria-valuenow",
    String(percent),
  );
  elements.cleanupRecent.innerHTML = renderCleanupRecent(status);
}

function renderCleanupRecent(status) {
  const currentItems = Array.isArray(status.current)
    ? status.current
    : status.current
      ? [status.current]
      : [];
  const current = currentItems
    .map(
      (item) => `
    <div class="cleanup-row active">
      <strong>处理中</strong>
      <span>${escapeHtml(item.title || item.path || item.id)}</span>
      <em>${escapeHtml(item.providerId || "")}</em>
    </div>
  `,
    )
    .join("");
  const recent = (status.recent || [])
    .map(
      (item) => `
    <div class="cleanup-row ${item.action}">
      <strong>${cleanupActionLabel(item.action)}</strong>
      <span title="${escapeAttribute(item.reason || "")}">${escapeHtml(item.title || item.shareLink || item.id)}</span>
      <em>${escapeHtml(item.reason || "")}</em>
    </div>
  `,
    )
    .join("");

  return current || recent ? `${current}${recent}` : "";
}

function cleanupActionLabel(action) {
  return (
    {
      kept: "保留",
      deleted: "删除",
      skipped: "跳过",
      failed: "失败",
      not_found: "未找到",
    }[action] ||
    action ||
    "-"
  );
}

function renderSavedRows(items, total, meta = {}) {
  const summary =
    meta.collapsed && meta.rawTotal > total
      ? `${formatNumber(total)} 个入口 · 合并 ${formatNumber(meta.rawTotal)} 条明细`
      : `${formatNumber(total)} 条资源${total > items.length ? ` · 显示前 ${items.length} 条` : ""}`;
  elements.libraryResultsMeta.textContent = summary;
  if (!items.length) {
    const query = state.lastSearchQuery;
    elements.savedRows.innerHTML = `<div class="empty-state">${icon(query ? "magnifying-glass" : "tray")}
      <strong>${query ? "没有找到相关资源" : "从第一个分享链接开始"}</strong>
      <p>${query ? `未找到与「${escapeHtml(query)}」相关的索引，试试更短的关键词。` : "采集网盘分享链接，将目录保存到资源库，之后就能在这里搜索。"}</p>
      <button class="ghost-button" type="button" ${query ? "data-search-clear" : 'data-go-view="index"'}>${query ? "查看全部资源" : "采集第一个资源"}${icon("arrow-right")}</button></div>`;
    return;
  }
  elements.savedRows.innerHTML = `
    <div class="library-columns" aria-hidden="true"><span>资源名称 / 所在路径</span><span>数据源</span><span>类型</span><span>操作</span></div>
    ${items
      .map(
        (item) => `
      <article class="mini-entry">
        <button class="mini-item" type="button" data-entry-link="${escapeAttribute(item.shareLink)}" aria-expanded="false" aria-label="展开 ${escapeAttribute(item.title)} 的子项">
          <span class="resource-icon ${item.type === "folder" ? "folder" : "file"}">${icon(item.type === "folder" ? "folder" : "file")}</span>
          <span class="resource-copy"><strong title="${escapeAttribute(item.title)}">${escapeHtml(item.title)}</strong><span title="${escapeAttribute(item.path)}">${escapeHtml(providerLabel(item.providerId))} · ${escapeHtml(item.path || "/")}</span></span>
          ${icon("caret-right", "icon entry-chevron")}
        </button>
        <span class="provider-label">${escapeHtml(providerLabel(item.providerId))}</span>
        <span class="type-badge ${item.type === "folder" ? "folder" : "file"}">${item.type === "folder" ? "目录" : "文件"}</span>
        <div class="mini-entry-actions"><a class="ghost-link" href="${escapeAttribute(safeLink(item.shareLink))}" target="_blank" rel="noreferrer" aria-label="打开 ${escapeAttribute(item.title)} 的分享入口">打开入口${icon("arrow-up-right")}</a><button class="copy-button" type="button" data-copy="${escapeAttribute(item.shareLink)}" title="复制链接" aria-label="复制 ${escapeAttribute(item.title)} 的分享链接">${icon("copy")}</button></div>
        <div class="mini-children" hidden></div>
      </article>`,
      )
      .join("")}`;
  elements.savedRows
    .querySelectorAll("[data-entry-link]")
    .forEach((button, index) => {
      const children = button
        .closest(".mini-entry")
        .querySelector(".mini-children");
      children.id = `entry-children-${index}`;
      button.setAttribute("aria-controls", children.id);
      button.addEventListener("click", () => toggleSavedEntry(button));
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
    ${items
      .map(
        (item) => `
      <div class="mini-child matched">
        <span class="child-type">${item.type === "folder" ? "目录" : "文件"}</span>
        <strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>
        <span title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span>
        <em>命中</em>
      </div>
    `,
      )
      .join("")}
  `;
}

function updatePermissionState() {
  elements.collectButton.disabled =
    state.isBusy || !elements.confirmAuthorized.checked;
  elements.batchCollectButton.disabled =
    state.isBusy || !elements.confirmAuthorized.checked;
  elements.csvCollectButton.disabled =
    state.isBusy ||
    !elements.confirmAuthorized.checked ||
    !state.csvLinks.length;
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
    single: "开始采集",
    batch: "开始批量采集",
    csv: "开始导入",
  };
  const button = map[mode];
  if (!button) return;
  button.classList.toggle("loading", loading);
  button.innerHTML = loading
    ? "正在采集…"
    : `${labels[mode]}${icon("arrow-right")}`;
}

function startProgress(stages) {
  clearInterval(state.progressTimer);
  elements.progressPanel.hidden = false;
  elements.taskProgressBar.style.width = "";
  elements.taskProgressBar.parentElement.classList.add("indeterminate");
  elements.progressText.textContent = stages[0] || "正在处理";
  elements.progressMeta.textContent =
    "当前处理链接：- · 已发现目录 0 · 已发现文件 0 · 当前递归深度 -";
}

function stopProgress() {
  clearInterval(state.progressTimer);
  state.progressTimer = null;
  elements.progressPanel.hidden = true;
}

function currentProviderName() {
  return (
    state.providers.find((provider) => provider.id === state.providerId)
      ?.displayName || state.providerId
  );
}

function currentProviderLimits() {
  return (
    state.providers.find((provider) => provider.id === state.providerId)
      ?.limits || {}
  );
}

function currentProviderCopy() {
  return (
    PROVIDER_COPY[state.providerId] || {
      example: "https://example.com/s/xxxx",
      label: "分享链接",
    }
  );
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
    button.setAttribute("aria-pressed", String(button === activeButton));
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
  const content =
    format === "json"
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
  const taskRequest =
    path === "/api/index/export" || path === "/api/indexes/save";
  if (taskRequest) state.activeControllers.add(controller);
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
  state.isBusy = isBusy;
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
    ...rows.map((row) =>
      columns.map((column) => csvCell(row[column])).join(","),
    ),
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

function icon(name, className = "icon") {
  return `<svg class="${className}" aria-hidden="true"><use href="/icons.svg#${name}" /></svg>`;
}

function providerLabel(id) {
  return (
    { "quark-share": "夸克网盘", "aliyun-share": "阿里云盘" }[id] ||
    state.providers.find((provider) => provider.id === id)?.displayName ||
    "其他来源"
  );
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function compactNumber(value) {
  return Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

function safeLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    /* Invalid resource links must not execute code. */
  }
  return "about:blank";
}

function renderLibraryLoading() {
  elements.savedRows.innerHTML = `<div class="library-loading" aria-label="正在读取资源">${Array.from({ length: 3 }, () => `<div class="skeleton-row"><span class="skeleton-icon"></span><span class="skeleton-copy"><span class="skeleton-line"></span><span class="skeleton-line short"></span></span></div>`).join("")}</div>`;
}

function renderLibraryError(message) {
  elements.libraryResultsMeta.textContent = "读取失败";
  elements.savedRows.innerHTML = `<div class="empty-state">${icon("warning-circle")}<strong>暂时无法读取资源库</strong><p>${escapeHtml(message)}</p><button class="ghost-button" type="button" data-search-retry>重新加载${icon("arrows-clockwise")}</button></div>`;
}

async function copyLink(button) {
  const original = button.innerHTML;
  const originalLabel = button.getAttribute("aria-label");
  const originalTitle = button.getAttribute("title");
  button.disabled = true;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(button.dataset.copy);
    } else {
      const field = document.createElement("textarea");
      field.value = button.dataset.copy;
      field.className = "clipboard-fallback";
      document.body.append(field);
      field.select();
      const copied = document.execCommand("copy");
      field.remove();
      button.focus({ preventScroll: true });
      if (!copied) throw new Error("复制失败");
    }
    button.innerHTML = button.classList.contains("copy-button")
      ? icon("check")
      : "已复制";
    button.setAttribute("aria-label", "链接已复制");
    button.setAttribute("title", "链接已复制");
  } catch {
    button.innerHTML = button.classList.contains("copy-button")
      ? icon("warning-circle")
      : "复制失败";
    button.setAttribute("aria-label", "复制失败，请打开分享入口复制地址");
    button.setAttribute("title", "复制失败，请打开分享入口复制地址");
  } finally {
    window.setTimeout(() => {
      button.innerHTML = original;
      if (originalLabel) button.setAttribute("aria-label", originalLabel);
      else button.removeAttribute("aria-label");
      if (originalTitle) button.setAttribute("title", originalTitle);
      else button.removeAttribute("title");
      button.disabled = false;
    }, 1600);
  }
}
