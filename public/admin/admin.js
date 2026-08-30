// @ts-check

/**
 * 管理後台。
 *
 * 安全與無障礙規則（階段二計畫第 11.2、14.2 節）：
 *   - 所有來自 API 的文字一律用 textContent 寫入，不使用 innerHTML。
 *   - 每個輸入欄位都有可見的 label，錯誤訊息放在欄位下方並以 aria-describedby 關聯。
 *   - 送出過程一定有回饋：載入中 → 成功或失敗，不會按下去沒反應。
 *   - 刪除一定要二次確認，且明確說明只刪除 Hub 內的資料。
 *
 * 這一層完全不呼叫任何外部平台 API，也不執行部署或還原。
 */

(() => {
  const VISIBILITY_LABELS = {
    public: "公開",
    unlisted: "不公開連結",
    password: "需要密碼",
    private: "私人",
    disabled: "停用",
  };

  const PLATFORM_LABELS = {
    cloudflare: "Cloudflare",
    vercel: "Vercel",
    supabase: "Supabase",
    external: "外部平台",
  };

  const DEPLOYMENT_STATUS_LABELS = {
    success: "成功",
    failed: "失敗",
    rolled_back: "已還原",
    unknown: "不確定",
  };

  /** API 欄位名稱 → 畫面上錯誤訊息元素的 id。 */
  const FIELD_ERROR_IDS = {
    name: "project-name-error",
    slug: "project-slug-error",
    description: "project-description-error",
    visibility: "project-visibility-error",
    category_id: "project-category-error",
    platform: "project-platform-error",
    deployment_url: "project-deployment-url-error",
    thumbnail_url: "project-thumbnail-url-error",
    repository_url: "project-repository-url-error",
    worker_name: "project-worker-name-error",
  };

  /** 推薦連結表單的 API 欄位名稱 → 錯誤訊息元素 id（與 FIELD_ERROR_IDS 同慣例）。 */
  const LINK_FIELD_ERROR_IDS = {
    name: "link-name-error",
    url: "link-url-error",
    description: "link-description-error",
    icon: "link-icon-error",
    category_id: "link-category-error",
    sort_order: "link-sort-order-error",
    is_listed: "link-is_listed-error",
  };

  const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  const $ = (id) => document.getElementById(id);

  const listLoading = $("list-loading");
  const listError = $("list-error");
  const listErrorMessage = $("list-error-message");
  const listEmpty = $("list-empty");
  const projectList = $("project-list");
  const rowTemplate = $("project-row-template");
  const flash = $("flash");

  const projectDialog = /** @type {HTMLDialogElement} */ ($("project-dialog"));
  const projectForm = /** @type {HTMLFormElement} */ ($("project-form"));
  const projectDialogTitle = $("project-dialog-title");
  const projectSubmit = $("project-submit");
  const formErrorSummary = $("form-error-summary");

  // ---------------------------------------------------------------- 說明文字字數提示（2026-08-28 主畫面改造 Part B5）
  const projectDescriptionInput = /** @type {HTMLTextAreaElement} */ ($("project-description"));
  const projectDescriptionCounter = $("project-description-counter");
  const projectNameInput = /** @type {HTMLInputElement} */ ($("project-name"));
  const projectNameCounter = $("project-name-counter");

  /**
   * 展示中心卡片的說明區高度固定，超過這個字數畫面上就顯示不到——用瀏覽器
   * 實測「最窄的卡片寬度（桌面 4 欄，約 285px）能放進 2 行的中文字數」得出
   * （見 2026-08-28-工作計畫-主畫面改造.md Part B5 與同日工作紀錄回報）。
   * 這只是提醒用的軟性上限，不會、也不應該拿來擋儲存——截斷是顯示層的事，
   * 使用者仍應該能存下完整的說明，這裡完全不參與表單送出的驗證流程。
   */
  /*
   * 26 字＝**實際截斷結果**的量測值，不是用「每行字數 × 行數」估算的。
   *
   * 先前估成 39 字是錯的：那是假設 3 整行都放得下（13 字 × 3），但 18px 字級
   * 的行高是 25.2px，而裁切高度 63px 只放得下 2 整行（第三行只露一半）。
   * 我當時用 Math.round(63 / 25.2) 得到 3，把半行也算成一行。
   * 現在的數字取自線上四個真實專案被截斷後的實際顯示字數（25、29、25、26）。
   *
   * 這個數字隨字級變動過幾次：30（0.98rem）→ 45（15px，估算）→ 39（18px，估算）
   * → 26（18px，實測）。
   * 這是提醒用的軟性上限，不阻擋儲存。
   */
  const PROJECT_DESCRIPTION_SOFT_LIMIT = 26;

  /*
   * 28 字＝實測「最窄的卡片寬度（桌面 4 欄、約 239px 內容寬）在 16px 字級下
   * 每行 14 字 × 名稱最多 2 行」。與說明一樣是提醒用的軟性上限，不阻擋儲存
   * ——完整名稱仍會存下來，切到「純文字清單」版面就看得到全部。
   */
  const PROJECT_NAME_SOFT_LIMIT = 28;

  /** 依目前 textarea 的內容更新字數提示，超過軟性上限時變色但不阻擋輸入。 */
  function updateDescriptionCounter() {
    const length = projectDescriptionInput.value.length;
    projectDescriptionCounter.textContent = `${length} / ${PROJECT_DESCRIPTION_SOFT_LIMIT} 字`;
    projectDescriptionCounter.classList.toggle("is-over-limit", length > PROJECT_DESCRIPTION_SOFT_LIMIT);
  }

  projectDescriptionInput.addEventListener("input", updateDescriptionCounter);

  /** 名稱的字數提示。與說明同一套模式：超過軟性上限變色，但不阻擋輸入或儲存。 */
  function updateNameCounter() {
    const length = projectNameInput.value.length;
    projectNameCounter.textContent = `${length} / ${PROJECT_NAME_SOFT_LIMIT} 字`;
    projectNameCounter.classList.toggle("is-over-limit", length > PROJECT_NAME_SOFT_LIMIT);
  }

  projectNameInput.addEventListener("input", updateNameCounter);

  const deploymentsDialog = /** @type {HTMLDialogElement} */ ($("deployments-dialog"));
  const deleteDialog = /** @type {HTMLDialogElement} */ ($("delete-dialog"));
  const deleteTargetName = $("delete-target-name");
  const deleteError = $("delete-error");
  const deleteConfirm = $("delete-confirm");
  // 用 id 而不是 class：這個對話框裡有兩個 .delete-scope 區塊
  // （專案的說明、分類/標籤的影響範圍），用 class 選會取到順序上的第一個。
  const deleteScope = $("delete-scope");
  const deleteDialogTitle = $("delete-dialog-title");
  const deleteUsage = $("delete-usage");
  const deleteUsageText = $("delete-usage-text");

  const categoryForm = /** @type {HTMLFormElement} */ ($("category-form"));
  const tagForm = /** @type {HTMLFormElement} */ ($("tag-form"));
  const categoryList = $("category-list");
  const tagList = $("tag-list");
  const projectCategorySelect = /** @type {HTMLSelectElement} */ ($("project-category"));
  const projectTagsContainer = $("project-tags");
  const projectTagsEmpty = $("project-tags-empty");

  // ---------------------------------------------------------------- 推薦連結（links）DOM
  const linkListLoading = $("link-list-loading");
  const linkListError = $("link-list-error");
  const linkListErrorMessage = $("link-list-error-message");
  const linkListEmpty = $("link-list-empty");
  const linkList = $("link-list");
  const linkRowTemplate = $("link-row-template");

  const linkDialog = /** @type {HTMLDialogElement} */ ($("link-dialog"));
  const linkForm = /** @type {HTMLFormElement} */ ($("link-form"));
  const linkDialogTitle = $("link-dialog-title");
  const linkSubmit = $("link-submit");
  const linkFormErrorSummary = $("link-form-error-summary");
  const linkCategorySelect = /** @type {HTMLSelectElement} */ ($("link-category"));

  // ---------------------------------------------------------------- 展示中心版面 DOM
  const layoutForm = /** @type {HTMLFormElement} */ ($("layout-form"));
  const layoutError = $("layout-error");
  const layoutSubmit = $("layout-submit");

  // ---------------------------------------------------------------- 配色 DOM（2026-08-29 新增）
  const themeForm = /** @type {HTMLFormElement} */ ($("theme-form"));
  const themeError = $("theme-error");
  const themeSubmit = $("theme-submit");

  // ---------------------------------------------------------------- 站名 DOM（2026-08-28 新增，見 Part C）
  const siteNameForm = /** @type {HTMLFormElement} */ ($("site-name-form"));
  const siteNameInput = /** @type {HTMLInputElement} */ ($("site-name-input"));
  const siteNameError = $("site-name-error");
  const siteNameSubmit = $("site-name-submit");

  // ---------------------------------------------------------------- 網站圖示 DOM（2026-08-28 新增，見同日工作計畫-主畫面改造.md Part A）
  const siteLogoForm = /** @type {HTMLFormElement} */ ($("site-logo-form"));
  const siteLogoError = $("site-logo-error");
  const siteLogoSubmit = $("site-logo-submit");

  const state = {
    projects: [],
    categories: [],
    tags: [],
    links: [],
    editingId: null,
    editingLinkId: null,
    deleteTarget: null,
    deploymentProject: null,
    lastTrigger: null,
  };

  // ---------------------------------------------------------------- 共用工具

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  /**
   * 錯誤代碼對應的中文說明。
   *
   * API 的 error.message 一律是英文——它是給開發者看的除錯字串，穩定的
   * 對外契約是 error.code。後台整個介面是中文，把英文句子直接顯示給
   * 使用者會看不懂，所以在這裡依 code 換成中文。
   *
   * 欄位層級的錯誤（error.fields）在 API 端就已經是中文，各呼叫點也優先
   * 顯示 fields，所以這張表只負責沒有 fields 的那些錯誤。
   */
  const ERROR_MESSAGES = Object.freeze({
    /*
     * 2026-08-30 移除 R2_NOT_CONFIGURED：「圖片儲存空間還沒設定，所以無法上傳
     * 檔案」。縮圖改存 D1 之後，後端已經沒有任何路徑會回這個代碼——留著一句
     * 永遠不會出現的錯誤訊息，只會讓人以為那個按鈕還是壞的。
     */
    DATABASE_NOT_CONFIGURED:
      "這個環境沒有連上資料庫，後台無法讀寫資料。請確認 D1 綁定設定。",
    UNSUPPORTED_IMAGE_TYPE: "只接受 PNG、JPEG、WebP、AVIF 這四種圖片格式。",
    PAYLOAD_TOO_LARGE: "檔案或內容太大，請縮小後再試一次。",
    UNSUPPORTED_MEDIA_TYPE: "送出的資料格式不正確，請重新整理頁面再試一次。",
    INVALID_JSON: "送出的資料格式不正確，請重新整理頁面再試一次。",
    CROSS_SITE_FORBIDDEN: "為了安全，這個操作不接受從其他網站發出的請求。請直接在本站操作。",
    PROJECT_NOT_FOUND: "找不到這個專案，可能已經被刪除了。請重新整理清單。",
    CATEGORY_NOT_FOUND: "找不到這個分類，可能已經被刪除了。請重新整理頁面。",
    TAG_NOT_FOUND: "找不到這個標籤，可能已經被刪除了。請重新整理頁面。",
    NOT_FOUND: "找不到這筆資料，可能已經被刪除了。請重新整理頁面。",
    INTERNAL_ERROR: "伺服器發生預期外的錯誤。請稍後再試一次。",
  });

  /**
   * @param {{ code?: string, message?: string } | null | undefined} error
   */
  function localizeError(error) {
    if (!error) return error;

    const localized = ERROR_MESSAGES[error.code];

    return localized ? { ...error, message: localized } : error;
  }

  async function api(method, path, body) {
    const init = { method, headers: {} };

    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const response = await fetch(path, init);

    if (response.status === 204) {
      return { ok: true, data: null };
    }

    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: localizeError(payload?.error)
          ?? { code: "UNKNOWN", message: `發生未預期的錯誤（HTTP ${response.status}）。` },
      };
    }

    return { ok: true, data: payload?.data ?? null };
  }

  /**
   * @param {string} message
   * @param {"success" | "error"} tone
   */
  function showFlash(message, tone) {
    flash.textContent = `${tone === "success" ? "已完成：" : "發生問題："}${message}`;
    flash.classList.toggle("is-success", tone === "success");
    flash.classList.toggle("is-error", tone === "error");
    flash.hidden = false;
  }

  function clearFlash() {
    flash.hidden = true;
    flash.textContent = "";
  }

  /**
   * 把焦點還給當初開啟對話框的按鈕。
   *
   * 兩個現實問題讓這件事沒有想像中單純：
   *   1. 對話框內的操作常會重新載入清單，原本的按鈕元素整個被換掉，
   *      因此要用「專案 + 動作」把同一列的新按鈕找回來。
   *   2. `<dialog>` 的 close 事件在某些執行環境不會如預期送達，
   *      所以這裡由各個關閉動作主動呼叫，不依賴事件。
   *
   * 延後執行是因為瀏覽器關閉對話框時本身也會動焦點，直接設定會被蓋掉。
   * 用 setTimeout 而非 requestAnimationFrame：後者依賴畫面合成，
   * 分頁在背景時會被暫停，焦點還原就整個失效。
   *
   * @param {HTMLElement | null} trigger
   */
  function restoreFocus(trigger) {
    setTimeout(() => {
      let target = trigger && document.body.contains(trigger) ? trigger : null;

      if (!target && trigger?.dataset?.projectId) {
        target = document.querySelector(
          `[data-project-id="${trigger.dataset.projectId}"][data-action="${trigger.dataset.action}"]`,
        );
      }

      // 推薦連結清單重繪後也會換掉按鈕元素，同一個理由、同一套做法，
      // 只是用 data-link-id 而不是 data-project-id 找回同一列的按鈕。
      if (!target && trigger?.dataset?.linkId) {
        target = document.querySelector(
          `[data-link-id="${trigger.dataset.linkId}"][data-action="${trigger.dataset.action}"]`,
        );
      }

      (target ?? $("add-project"))?.focus();
    }, 0);
  }

  /**
   * 關閉對話框並還原焦點。所有關閉路徑都必須經過這裡。
   *
   * @param {HTMLDialogElement} dialog
   */
  function closeDialog(dialog) {
    const trigger = state.lastTrigger;
    state.lastTrigger = null;

    dialog.close();
    restoreFocus(trigger);
  }

  /**
   * @param {string} value
   */
  function formatDate(value) {
    if (!value) return "";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
      ? ""
      : new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "long", day: "numeric" }).format(parsed);
  }

  // ---------------------------------------------------------------- 表單錯誤

  /**
   * 專案表單是這兩個函式原本唯一的使用者，因此預設值直接指向專案表單，
   * 舊的呼叫端（不帶後兩個參數）行為完全不變。推薦連結表單透過
   * `LINK_FIELD_ERROR_IDS`／`linkForm`／`linkFormErrorSummary` 共用同一套邏輯，
   * 不必另外複製一份（2026-08-27 新增推薦連結表單時擴充，原邏輯不變）。
   *
   * @param {Record<string, string>} [fieldErrorIds]
   * @param {HTMLFormElement} [form]
   * @param {HTMLElement} [summaryEl]
   */
  function clearFieldErrors(fieldErrorIds = FIELD_ERROR_IDS, form = projectForm, summaryEl = formErrorSummary) {
    summaryEl.hidden = true;
    summaryEl.textContent = "";

    for (const [field, errorId] of Object.entries(fieldErrorIds)) {
      const errorEl = $(errorId);
      if (errorEl) {
        errorEl.hidden = true;
        errorEl.textContent = "";
      }

      const input = form.elements.namedItem(field);
      if (input instanceof HTMLElement && "setAttribute" in input) {
        input.removeAttribute("aria-invalid");
      }
    }
  }

  /**
   * @param {string} field
   * @param {string} message
   * @param {Record<string, string>} [fieldErrorIds]
   * @param {HTMLFormElement} [form]
   */
  function setFieldError(field, message, fieldErrorIds = FIELD_ERROR_IDS, form = projectForm) {
    const errorEl = $(fieldErrorIds[field]);

    if (!errorEl) {
      return false;
    }

    errorEl.textContent = message;
    errorEl.hidden = false;

    const input = form.elements.namedItem(field);
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement || input instanceof HTMLSelectElement) {
      input.setAttribute("aria-invalid", "true");
    }

    return true;
  }

  /**
   * 送出前的本機檢查。伺服器仍會再驗一次，這裡只是讓使用者更快看到問題。
   *
   * @returns {boolean} 是否通過
   */
  function validateProjectForm() {
    clearFieldErrors();

    const data = new FormData(projectForm);
    let firstInvalid = null;

    const name = String(data.get("name") ?? "").trim();
    if (name.length === 0 || name.length > 100) {
      setFieldError("name", "請輸入 1 到 100 個字的名稱。");
      firstInvalid = firstInvalid ?? "name";
    }

    const slug = String(data.get("slug") ?? "").trim();
    if (slug.length === 0) {
      setFieldError("slug", "請輸入網址代稱。");
      firstInvalid = firstInvalid ?? "slug";
    } else if (!SLUG_PATTERN.test(slug)) {
      setFieldError("slug", "只能使用小寫英文、數字與連字號，且不能用連字號開頭或結尾。");
      firstInvalid = firstInvalid ?? "slug";
    }

    if (!data.get("visibility")) {
      setFieldError("visibility", "請選擇誰可以看到這個專案。");
      firstInvalid = firstInvalid ?? "visibility";
    }

    for (const field of ["deployment_url", "repository_url"]) {
      const value = String(data.get(field) ?? "").trim();

      if (value && !value.startsWith("https://")) {
        setFieldError(field, "網址必須以 https:// 開頭。");
        firstInvalid = firstInvalid ?? field;
      }
    }

    if (firstInvalid) {
      formErrorSummary.textContent = "表單還有欄位需要修正，請看下方標示。";
      formErrorSummary.hidden = false;

      const target = projectForm.elements.namedItem(firstInvalid);
      if (target instanceof HTMLElement) {
        target.focus();
      } else if (target && "length" in target && target[0] instanceof HTMLElement) {
        target[0].focus();
      }

      return false;
    }

    return true;
  }

  // ---------------------------------------------------------------- 清單渲染

  /**
   * @param {"loading" | "error" | "empty" | "list"} mode
   */
  function setListMode(mode) {
    listLoading.hidden = mode !== "loading";
    listError.hidden = mode !== "error";
    listEmpty.hidden = mode !== "empty";
    projectList.hidden = mode !== "list";
  }

  function renderProjects() {
    projectList.textContent = "";

    if (state.projects.length === 0) {
      setListMode("empty");
      return;
    }

    for (const project of state.projects) {
      const row = rowTemplate.content.cloneNode(true);

      const badge = row.querySelector(".project-admin-visibility");
      badge.textContent = VISIBILITY_LABELS[project.visibility] ?? project.visibility;
      badge.classList.add(project.visibility === "public" ? "is-public" : "is-restricted");

      // sort_order === 1 是 setPrimaryProject 寫入主卡片時固定使用的值
      // （見 src/repositories/projects.js 的同名函式註解）。
      const isPrimary = project.sort_order === 1;
      row.querySelector(".project-admin-primary-badge").hidden = !isPrimary;

      row.querySelector(".project-admin-name").textContent = project.name;
      row.querySelector(".project-admin-slug").textContent = `代稱：${project.slug}`;

      const category = state.categories.find((c) => c.id === project.category_id);
      const parts = [
        PLATFORM_LABELS[project.platform] ?? project.platform,
        category ? `分類：${category.name}` : "未分類",
      ];

      const updated = formatDate(project.updated_at);
      if (updated) parts.push(`更新於 ${updated}`);

      row.querySelector(".project-admin-meta").textContent = parts.join("　·　");

      // 「不公開連結」的專案不會出現在展示中心，唯一的分享方式就是把網址給對方，
      // 因此這裡提供直接複製。其他狀態只要有網址也一併提供，方便自己開啟。
      // 每個按鈕都標上專案與動作：清單重新載入後元素會被換掉，
      // 靠這兩個屬性才能把焦點還給「同一列的同一顆按鈕」。
      const copyButton = row.querySelector(".project-copy-link");
      copyButton.dataset.projectId = String(project.id);
      copyButton.dataset.action = "copy";

      if (project.deployment_url) {
        copyButton.hidden = false;
        copyButton.setAttribute("aria-label", `複製 ${project.name} 的網址`);
        copyButton.addEventListener("click", () => copyProjectLink(project, copyButton));
      }

      const setPrimaryButton = row.querySelector(".project-set-primary");
      setPrimaryButton.dataset.projectId = String(project.id);
      setPrimaryButton.dataset.action = "set-primary";

      if (isPrimary) {
        // 已經是主卡片時停用按鈕：再按一次在後端是安全的不動點
        // （見 setPrimaryProject 註解），但停用能少一次沒意義的網路請求，
        // 也讓「目前狀態」更清楚——上面的徽章已經講了同一件事。
        setPrimaryButton.disabled = true;
        setPrimaryButton.textContent = "目前是主卡片";
      } else {
        setPrimaryButton.disabled = false;
        setPrimaryButton.textContent = "設為主卡片";
        setPrimaryButton.setAttribute("aria-label", `將 ${project.name} 設為主卡片`);
        setPrimaryButton.addEventListener("click", () => setProjectAsPrimary(project, setPrimaryButton));
      }

      const editButton = row.querySelector(".project-edit");
      editButton.dataset.projectId = String(project.id);
      editButton.dataset.action = "edit";
      editButton.setAttribute("aria-label", `編輯 ${project.name}`);
      editButton.addEventListener("click", () => openProjectDialog(project, editButton));

      const deploymentsButton = row.querySelector(".project-deployments");
      deploymentsButton.dataset.projectId = String(project.id);
      deploymentsButton.dataset.action = "deployments";
      deploymentsButton.setAttribute("aria-label", `檢視 ${project.name} 的部署紀錄`);
      deploymentsButton.addEventListener("click", () => openDeployments(project, deploymentsButton));

      const deleteButton = row.querySelector(".project-delete");
      deleteButton.dataset.projectId = String(project.id);
      deleteButton.dataset.action = "delete";
      deleteButton.setAttribute("aria-label", `刪除 ${project.name}`);
      deleteButton.addEventListener("click", () => openDeleteDialog(project, deleteButton));

      projectList.append(row);
    }

    setListMode("list");
  }

  /**
   * 複製專案網址。
   *
   * 剪貼簿 API 需要安全的執行環境（HTTPS 或 localhost），在其他情況會失敗，
   * 因此一定要有退路：直接把網址顯示出來讓使用者自行複製，不能讓操作靜默失效。
   *
   * @param {Record<string, any>} project
   * @param {HTMLElement} button
   */
  async function copyProjectLink(project, button) {
    const url = project.deployment_url;

    if (!url) {
      return;
    }

    try {
      await navigator.clipboard.writeText(url);
      const original = button.textContent;
      button.textContent = "已複製";
      showFlash(`已複製「${project.name}」的網址。`, "success");

      setTimeout(() => {
        button.textContent = original;
      }, 2000);
    } catch {
      showFlash(`無法自動複製，請手動複製這個網址：${url}`, "error");
    }
  }

  /**
   * 把指定專案設為主卡片。成功後整份清單重新載入——不只是這一列的徽章要
   * 更新，原本的主卡片那一列同時要拿掉徽章、恢復成可以再按一次的狀態，
   * 靠 `loadAll()` 一次重繪比自己在 DOM 裡找出舊主卡片那一列更簡單可靠。
   *
   * @param {Record<string, any>} project
   * @param {HTMLButtonElement} button
   */
  async function setProjectAsPrimary(project, button) {
    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "設定中…";

    const result = await api("PUT", `/api/projects/${project.id}/primary`);

    if (!result.ok) {
      button.disabled = false;
      button.textContent = originalLabel;
      showFlash(result.error?.message ?? "設定主卡片失敗，請稍後再試一次。", "error");
      return;
    }

    await loadAll();
    showFlash(`已將「${project.name}」設為主卡片。`, "success");
  }

  // ---------------------------------------------------------------- 密碼設定

  /**
   * 密碼區塊只在「編輯既有專案」且「可見性為需要密碼」時才有意義：
   * 新增中的專案還沒有 id，無從掛上政策。
   */
  function updatePasswordSection() {
    const visibility = projectForm.querySelector('input[name="visibility"]:checked')?.value;
    const isPassword = visibility === "password";
    const canEdit = Boolean(state.editingId);

    $("password-section").hidden = !(isPassword && canEdit);
    $("password-note").hidden = !(isPassword && !canEdit);
  }

  /**
   * @param {number} projectId
   */
  async function loadPolicy(projectId) {
    const statusEl = $("password-status");
    statusEl.textContent = "正在讀取密碼狀態…";

    const result = await api("GET", `/api/projects/${projectId}/policy`);

    if (!result.ok) {
      statusEl.textContent = "無法讀取密碼狀態。";
      return;
    }

    statusEl.textContent = result.data?.has_password
      ? `目前已設定密碼。變更次數：${result.data.policy_version}。`
      : "目前尚未設定密碼，訪客無法通過驗證。";
  }

  /**
   * @param {string | null} password 傳 null 代表移除
   */
  async function submitPassword(password) {
    const errorEl = $("project-password-error");
    const input = /** @type {HTMLInputElement} */ ($("project-password"));
    const saveButton = $("password-save");
    const clearButton = $("password-clear");

    errorEl.hidden = true;
    errorEl.textContent = "";
    input.removeAttribute("aria-invalid");

    if (password !== null && password.length < 8) {
      errorEl.textContent = "密碼至少要 8 個字元。";
      errorEl.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }

    saveButton.disabled = true;
    clearButton.disabled = true;
    $("password-status").textContent = password === null ? "正在移除密碼…" : "正在儲存密碼…";

    const result = await api("PUT", `/api/projects/${state.editingId}/policy`, { password });

    saveButton.disabled = false;
    clearButton.disabled = false;

    if (!result.ok) {
      $("password-status").textContent = "";
      errorEl.textContent = result.error?.fields?.password ?? result.error?.message ?? "儲存失敗。";
      errorEl.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }

    input.value = "";
    $("password-status").textContent = password === null
      ? "已移除密碼。原本輸入過密碼的人都會被要求重新驗證。"
      : `已更新密碼。變更次數：${result.data?.policy_version}。原本輸入過密碼的人都必須重新輸入。`;
  }

  // ---------------------------------------------------------------- 部署紀錄

  /**
   * @param {Record<string, any>} project
   * @param {HTMLElement} trigger
   */
  async function openDeployments(project, trigger) {
    state.deploymentProject = project;
    state.lastTrigger = trigger;

    $("deployments-dialog-title").textContent = `部署紀錄：${project.name}`;
    $("deployment-error").hidden = true;
    $("deployment-form").reset();
    $("deployment-list").textContent = "";
    $("deployment-empty").hidden = true;

    deploymentsDialog.showModal();
    $("deployment-platform").focus();

    await loadDeployments(project.id);
  }

  /**
   * @param {number} projectId
   */
  async function loadDeployments(projectId) {
    const list = $("deployment-list");
    const result = await api("GET", `/api/projects/${projectId}/deployments`);

    list.textContent = "";

    if (!result.ok) {
      $("deployment-error").textContent = result.error?.message ?? "無法讀取部署紀錄。";
      $("deployment-error").hidden = false;
      return;
    }

    const items = result.data?.items ?? [];
    $("deployment-empty").hidden = items.length > 0;

    for (const item of items) {
      const li = document.createElement("li");

      const badge = document.createElement("span");
      badge.className = `deployment-status is-${item.status}`;
      badge.textContent = DEPLOYMENT_STATUS_LABELS[item.status] ?? item.status;

      const url = document.createElement("span");
      url.className = "deployment-url";
      url.textContent = item.deployment_url;

      const meta = document.createElement("span");
      meta.className = "deployment-meta";
      const parts = [formatDate(item.created_at)];
      if (item.version_ref) parts.push(`版本 ${item.version_ref}`);
      meta.textContent = parts.filter(Boolean).join("　·　");

      li.append(badge, url, meta);
      list.append(li);
    }
  }

  /**
   * @param {Event} event
   */
  async function submitDeployment(event) {
    event.preventDefault();

    const errorEl = $("deployment-error");
    const button = $("deployment-submit");
    errorEl.hidden = true;
    errorEl.textContent = "";

    const data = new FormData(/** @type {HTMLFormElement} */ ($("deployment-form")));
    const payload = {
      platform: String(data.get("platform") ?? "cloudflare"),
      deployment_url: String(data.get("deployment_url") ?? "").trim(),
      version_ref: String(data.get("version_ref") ?? "").trim() || null,
      status: String(data.get("status") ?? "success"),
    };

    if (!payload.deployment_url.startsWith("https://")) {
      errorEl.textContent = "部署網址必須以 https:// 開頭。";
      errorEl.hidden = false;
      $("deployment-url").focus();
      return;
    }

    button.disabled = true;
    button.textContent = "新增中…";

    const result = await api("POST", `/api/projects/${state.deploymentProject.id}/deployments`, payload);

    button.disabled = false;
    button.textContent = "新增紀錄";

    if (!result.ok) {
      const fields = result.error?.fields ?? {};
      errorEl.textContent = Object.values(fields)[0] ?? result.error?.message ?? "新增失敗。";
      errorEl.hidden = false;
      return;
    }

    $("deployment-form").reset();
    await loadDeployments(state.deploymentProject.id);
    // 成功的紀錄會更新專案網址，因此主清單也要重新整理。
    await loadAll();
    showFlash("已新增部署紀錄。", "success");
  }

  /**
   * @param {HTMLElement} container
   * @param {Record<string, any>[]} items
   * @param {"categories" | "tags"} kind
   */
  function renderTaxonomyList(container, items, kind) {
    container.textContent = "";

    if (items.length === 0) {
      const empty = document.createElement("li");
      empty.className = "taxonomy-empty";
      empty.textContent = kind === "categories" ? "還沒有分類。" : "還沒有標籤。";
      container.append(empty);
      return;
    }

    for (const item of items) {
      const li = document.createElement("li");

      const label = document.createElement("span");
      label.textContent = item.name;

      const slug = document.createElement("span");
      slug.className = "taxonomy-slug";
      slug.textContent = item.slug;
      label.append(" ", slug);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "button button-quiet";
      remove.textContent = "刪除";
      remove.setAttribute("aria-label", `刪除${kind === "categories" ? "分類" : "標籤"} ${item.name}`);
      remove.addEventListener("click", () => openDeleteDialog({ ...item, __kind: kind }, remove));

      li.append(label, remove);
      container.append(li);
    }
  }

  function renderTaxonomyControls() {
    // 專案表單的分類下拉選單
    const selected = projectCategorySelect.value;
    projectCategorySelect.textContent = "";

    const none = document.createElement("option");
    none.value = "";
    none.textContent = "不指定";
    projectCategorySelect.append(none);

    for (const category of state.categories) {
      const option = document.createElement("option");
      option.value = String(category.id);
      option.textContent = category.name;
      projectCategorySelect.append(option);
    }

    projectCategorySelect.value = selected;

    // 推薦連結表單的分類下拉選單。與上面專案表單的邏輯完全一樣，
    // 但目標是另一個 <select>，兩個表單的分類清單必須保持同步，
    // 因此不共用同一個 DOM 元素、而是各自維護一份選項。
    const linkSelected = linkCategorySelect.value;
    linkCategorySelect.textContent = "";

    const linkNone = document.createElement("option");
    linkNone.value = "";
    linkNone.textContent = "不指定";
    linkCategorySelect.append(linkNone);

    for (const category of state.categories) {
      const option = document.createElement("option");
      option.value = String(category.id);
      option.textContent = category.name;
      linkCategorySelect.append(option);
    }

    linkCategorySelect.value = linkSelected;

    // 專案表單的標籤複選
    projectTagsContainer.textContent = "";

    for (const tag of state.tags) {
      const label = document.createElement("label");
      label.className = "tag-checkbox";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "tag_ids";
      input.value = String(tag.id);

      const text = document.createElement("span");
      text.textContent = tag.name;

      label.append(input, text);
      projectTagsContainer.append(label);
    }

    projectTagsEmpty.hidden = state.tags.length > 0;

    renderTaxonomyList(categoryList, state.categories, "categories");
    renderTaxonomyList(tagList, state.tags, "tags");
  }

  // ---------------------------------------------------------------- 資料載入

  async function loadAll() {
    setListMode("loading");
    setLinkListMode("loading");

    const [projects, categories, tags, links] = await Promise.all([
      api("GET", "/api/projects?limit=100"),
      api("GET", "/api/categories"),
      api("GET", "/api/tags"),
      api("GET", "/api/links"),
    ]);

    if (!projects.ok || !categories.ok || !tags.ok || !links.ok) {
      const failed = [projects, categories, tags, links].find((r) => !r.ok);
      listErrorMessage.textContent = failed?.error?.message ?? "請稍後再試一次。";
      setListMode("error");
      linkListErrorMessage.textContent = failed?.error?.message ?? "請稍後再試一次。";
      setLinkListMode("error");
      return;
    }

    state.projects = projects.data?.items ?? [];
    state.categories = categories.data?.items ?? [];
    state.tags = tags.data?.items ?? [];
    state.links = links.data?.items ?? [];

    renderTaxonomyControls();
    renderProjects();
    renderLinks();
  }

  // ---------------------------------------------------------------- 專案表單

  /**
   * @param {Record<string, any> | null} project
   * @param {HTMLElement | null} trigger
   */
  function openProjectDialog(project, trigger) {
    state.editingId = project?.id ?? null;
    state.lastTrigger = trigger;

    projectDialogTitle.textContent = project ? "編輯專案" : "新增專案";
    projectForm.reset();
    clearFieldErrors();
    renderTaxonomyControls();

    if (project) {
      projectForm.elements.namedItem("name").value = project.name ?? "";
      projectForm.elements.namedItem("slug").value = project.slug ?? "";
      projectForm.elements.namedItem("description").value = project.description ?? "";
      projectCategorySelect.value = project.category_id ? String(project.category_id) : "";
      projectForm.elements.namedItem("platform").value = project.platform ?? "cloudflare";
      projectForm.elements.namedItem("project_type").value = project.project_type ?? "static";
      projectForm.elements.namedItem("database_type").value = project.database_type ?? "none";
      projectForm.elements.namedItem("deployment_url").value = project.deployment_url ?? "";
      projectForm.elements.namedItem("thumbnail_url").value = project.thumbnail_url ?? "";
      projectForm.elements.namedItem("repository_url").value = project.repository_url ?? "";
      projectForm.elements.namedItem("worker_name").value = project.worker_name ?? "";

      const visibility = projectForm.querySelector(`input[name="visibility"][value="${project.visibility}"]`);
      if (visibility) visibility.checked = true;

      const tagIds = new Set((project.tags ?? []).map((tag) => String(tag.id)));
      for (const input of projectTagsContainer.querySelectorAll('input[name="tag_ids"]')) {
        input.checked = tagIds.has(input.value);
      }
    } else {
      const defaultVisibility = projectForm.querySelector('input[name="visibility"][value="public"]');
      if (defaultVisibility) defaultVisibility.checked = true;
    }

    // 上傳圖片需要專案已經存在（要有 id 才知道要掛到哪個專案），
    // 因此只在編輯既有專案時提供，新增時改為提示先儲存。
    const canUpload = Boolean(project);
    $("thumbnail-upload").hidden = !canUpload;
    $("thumbnail-upload-note").hidden = canUpload;
    $("thumbnail-file").value = "";
    $("thumbnail-file-error").hidden = true;
    $("thumbnail-file-error").textContent = "";
    $("thumbnail-status").textContent = "";

    $("project-password").value = "";
    $("project-password-error").hidden = true;
    $("password-status").textContent = "";
    updatePasswordSection();

    // 對話框開啟時（不論新增或編輯）都要同步一次字數提示——編輯時
    // textarea 的值是用 .value 直接賦值（見上方），不會觸發 input 事件。
    updateDescriptionCounter();
    updateNameCounter();

    projectDialog.showModal();
    projectForm.elements.namedItem("name").focus();

    if (project && project.visibility === "password") {
      loadPolicy(project.id);
    }
  }

  /**
   * 上傳展示圖片。
   *
   * 伺服器會以檔案本身的位元組特徵判斷格式，這裡的前端檢查只是讓使用者
   * 更快得到回饋，不能取代伺服器端的驗證。
   */
  async function uploadThumbnail() {
    const input = /** @type {HTMLInputElement} */ ($("thumbnail-file"));
    const errorEl = $("thumbnail-file-error");
    const statusEl = $("thumbnail-status");
    const button = $("thumbnail-upload-button");

    errorEl.hidden = true;
    errorEl.textContent = "";
    statusEl.textContent = "";
    input.removeAttribute("aria-invalid");

    const file = input.files?.[0];

    if (!file) {
      errorEl.textContent = "請先選擇一個圖片檔案。";
      errorEl.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }

    /*
     * 上限與 src/images.js 的 MAX_IMAGE_BYTES 一致（2026-08-30 從 5 MiB 降到
     * 1 MiB）。這裡的檢查只是讓使用者更快得到回饋，伺服器端仍會再驗一次。
     *
     * 訊息刻意講「怎麼辦」而不只是「太大」——對不懂技術的人來說，
     * 「1 MB」這個數字本身不構成可執行的下一步。
     */
    if (file.size > 1024 * 1024) {
      errorEl.textContent =
        "圖片不能超過 1 MB。縮圖只是卡片上的一小塊，不需要原始解析度——"
        + "用「小畫家」開啟圖片 →「重新調整大小」→ 改成 50%，通常就會降到 300 KB 以內。";
      errorEl.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }

    if (!state.editingId) {
      errorEl.textContent = "請先儲存專案，再上傳圖片。";
      errorEl.hidden = false;
      return;
    }

    const body = new FormData();
    body.append("file", file);

    const originalLabel = button.textContent;
    button.disabled = true;
    button.textContent = "上傳中…";
    statusEl.textContent = "正在上傳圖片，請稍候…";

    let response;

    try {
      response = await fetch(`/api/projects/${state.editingId}/thumbnail`, { method: "POST", body });
    } catch {
      button.disabled = false;
      button.textContent = originalLabel;
      statusEl.textContent = "";
      errorEl.textContent = "無法連線到伺服器，請稍後再試一次。";
      errorEl.hidden = false;
      return;
    }

    let payload = null;

    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    button.disabled = false;
    button.textContent = originalLabel;

    if (!response.ok) {
      statusEl.textContent = "";
      // 這裡是自己 fetch（要送 FormData，不能走 api()），所以要自己套中文化。
      errorEl.textContent = payload?.error?.fields?.file
        ?? localizeError(payload?.error)?.message
        ?? "上傳失敗，請稍後再試一次。";
      errorEl.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
      return;
    }

    const url = payload?.data?.thumbnail_url ?? "";
    projectForm.elements.namedItem("thumbnail_url").value = url;
    statusEl.textContent = "圖片已上傳並套用到這個專案。";
    input.value = "";
  }

  function closeProjectDialog() {
    closeDialog(projectDialog);
  }

  async function submitProject(event) {
    event.preventDefault();
    clearFlash();

    if (!validateProjectForm()) {
      return;
    }

    const data = new FormData(projectForm);
    const tagIds = [...projectTagsContainer.querySelectorAll('input[name="tag_ids"]:checked')]
      .map((input) => Number(input.value));

    const categoryValue = String(data.get("category_id") ?? "");

    const payload = {
      name: String(data.get("name") ?? "").trim(),
      slug: String(data.get("slug") ?? "").trim(),
      description: String(data.get("description") ?? ""),
      visibility: String(data.get("visibility") ?? ""),
      category_id: categoryValue === "" ? null : Number(categoryValue),
      platform: String(data.get("platform") ?? "cloudflare"),
      project_type: String(data.get("project_type") ?? "static"),
      database_type: String(data.get("database_type") ?? "none"),
      deployment_url: String(data.get("deployment_url") ?? "").trim() || null,
      thumbnail_url: String(data.get("thumbnail_url") ?? "").trim() || null,
      repository_url: String(data.get("repository_url") ?? "").trim() || null,
      worker_name: String(data.get("worker_name") ?? "").trim() || null,
      tag_ids: tagIds,
    };

    const originalLabel = projectSubmit.textContent;
    projectSubmit.disabled = true;
    projectSubmit.textContent = "儲存中…";

    const result = state.editingId
      ? await api("PATCH", `/api/projects/${state.editingId}`, payload)
      : await api("POST", "/api/projects", payload);

    projectSubmit.disabled = false;
    projectSubmit.textContent = originalLabel;

    if (result.ok) {
      const name = payload.name;
      const wasEditing = Boolean(state.editingId);
      const trigger = state.lastTrigger;

      state.lastTrigger = null;
      state.editingId = null;

      // 先關閉讓畫面立即有反應，等清單重新載入後才還原焦點——
      // 否則焦點會找不到尚未重繪出來的那一列按鈕。
      projectDialog.close();
      await loadAll();
      restoreFocus(trigger);

      showFlash(wasEditing ? `已更新「${name}」。` : `已新增「${name}」。`, "success");
      return;
    }

    // 把伺服器回傳的欄位錯誤放回對應欄位；無法對應的顯示在表單頂端。
    const fields = result.error?.fields ?? {};
    let matched = false;
    let firstField = null;

    for (const [field, message] of Object.entries(fields)) {
      if (setFieldError(field, String(message))) {
        matched = true;
        firstField = firstField ?? field;
      }
    }

    formErrorSummary.textContent = matched
      ? "表單還有欄位需要修正，請看下方標示。"
      : result.error?.message ?? "儲存失敗，請稍後再試一次。";
    formErrorSummary.hidden = false;

    if (firstField) {
      const target = projectForm.elements.namedItem(firstField);
      if (target instanceof HTMLElement) target.focus();
    } else {
      formErrorSummary.focus?.();
    }
  }

  // ---------------------------------------------------------------- 刪除

  /**
   * @param {Record<string, any>} target
   * @param {HTMLElement} trigger
   */
  function openDeleteDialog(target, trigger) {
    state.deleteTarget = target;
    state.lastTrigger = trigger;

    deleteTargetName.textContent = target.name;
    deleteError.hidden = true;
    deleteError.textContent = "";

    const isProject = !target.__kind;
    deleteScope.hidden = !isProject;

    // 標題要跟著刪除對象變。寫死「確認刪除專案」的話，刪分類時會出現
    // 「確認刪除專案／即將刪除：教學工具」這種前後矛盾的畫面。
    deleteDialogTitle.textContent = isProject
      ? "確認刪除專案"
      : target.__kind === "categories" ? "確認刪除分類"
      : target.__kind === "tags" ? "確認刪除標籤"
      : "確認刪除連結";

    // 分類與標籤沒有「不影響已部署網站」這種說明，但有另一種影響：
    // 底下還挂著幾個專案。使用者按下去之前應該先知道。
    const usageCount = Number(target.project_count ?? 0);
    const showUsage = !isProject && usageCount > 0;

    deleteUsage.hidden = !showUsage;

    if (showUsage) {
      deleteUsageText.textContent = target.__kind === "categories"
        ? `目前有 ${usageCount} 個專案使用這個分類。刪除後它們會變成「未分類」，專案本身不會被刪除。`
        : `目前有 ${usageCount} 個專案貼著這個標籤。刪除後這些標籤關聯會一併消失，專案本身不會被刪除。`;
    } else {
      deleteUsageText.textContent = "";
    }

    deleteDialog.showModal();
    document.getElementById("delete-cancel").focus();
  }

  async function confirmDelete() {
    const target = state.deleteTarget;

    if (!target) {
      return;
    }

    const path = target.__kind === "categories"
      ? `/api/categories/${target.id}`
      : target.__kind === "tags"
        ? `/api/tags/${target.id}`
        : target.__kind === "links"
          ? `/api/links/${target.id}`
          : `/api/projects/${target.id}`;

    const originalLabel = deleteConfirm.textContent;
    deleteConfirm.disabled = true;
    deleteConfirm.textContent = "刪除中…";

    const result = await api("DELETE", path);

    deleteConfirm.disabled = false;
    deleteConfirm.textContent = originalLabel;

    if (result.ok) {
      const name = target.name;
      // 「已部署的網站與原始碼不受影響」只對專案成立；刪分類或標籤時
      // 沒有網站可言，該說的是專案本身還在。
      const note = target.__kind === "categories"
        ? "原本使用這個分類的專案都還在，只是變成未分類。"
        : target.__kind === "tags"
          ? "原本貼著這個標籤的專案都還在。"
          : target.__kind === "links"
            ? "只會從展示中心與後台移除這筆連結，不影響其他資料。"
            : "已部署的網站與原始碼不受影響。";

      closeDialog(deleteDialog);
      state.deleteTarget = null;
      await loadAll();
      showFlash(`已刪除「${name}」。${note}`, "success");
      return;
    }

    deleteError.textContent = result.error?.message ?? "刪除失敗，請稍後再試一次。";
    deleteError.hidden = false;
  }

  // ---------------------------------------------------------------- 分類與標籤

  /**
   * @param {HTMLFormElement} form
   * @param {"categories" | "tags"} kind
   */
  async function submitTaxonomy(form, kind) {
    const prefix = kind === "categories" ? "category" : "tag";
    const errorEl = $(`${prefix}-slug-error`);
    const slugInput = form.elements.namedItem("slug");
    const nameInput = form.elements.namedItem("name");

    errorEl.hidden = true;
    errorEl.textContent = "";
    slugInput.removeAttribute("aria-invalid");

    const name = String(nameInput.value ?? "").trim();
    const slug = String(slugInput.value ?? "").trim();

    if (!name) {
      nameInput.focus();
      return;
    }

    // 代稱是選填的。有填才檢查格式；沒填就交給伺服器自動產生。
    if (slug && !SLUG_PATTERN.test(slug)) {
      errorEl.textContent = "只能使用小寫英文、數字與連字號。";
      errorEl.hidden = false;
      slugInput.setAttribute("aria-invalid", "true");
      slugInput.focus();
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;

    const result = await api("POST", `/api/${kind}`, slug ? { name, slug } : { name });

    submitButton.disabled = false;

    if (result.ok) {
      form.reset();
      await loadAll();
      showFlash(`已新增${kind === "categories" ? "分類" : "標籤"}「${name}」。`, "success");
      nameInput.focus();
      return;
    }

    const message = result.error?.fields?.slug ?? result.error?.message ?? "新增失敗。";
    errorEl.textContent = String(message);
    errorEl.hidden = false;
    slugInput.setAttribute("aria-invalid", "true");
    slugInput.focus();
  }

  // ---------------------------------------------------------------- 推薦連結（links）
  //
  // 連結是獨立於專案的頂層資料（見 migrations/0002），後台這裡照專案表單的
  // 複雜度（有分類、有排序、有多個欄位）走同一套 dialog 模式，而不是照
  // 分類／標籤那種單行內嵌表單——欄位數量更接近專案，硬套簡化表單反而要
  // 另外處理欄位錯誤顯示，並不會比較省事。

  /**
   * @param {"loading" | "error" | "empty" | "list"} mode
   */
  function setLinkListMode(mode) {
    linkListLoading.hidden = mode !== "loading";
    linkListError.hidden = mode !== "error";
    linkListEmpty.hidden = mode !== "empty";
    linkList.hidden = mode !== "list";
  }

  function renderLinks() {
    linkList.textContent = "";

    if (state.links.length === 0) {
      setLinkListMode("empty");
      return;
    }

    for (const link of state.links) {
      const row = linkRowTemplate.content.cloneNode(true);

      // 沿用專案清單同一套視覺（is-public／is-restricted），
      // 「顯示」對應公開展示中心看得到，「隱藏」對應 is_listed = 0。
      const badge = row.querySelector(".project-admin-visibility");
      badge.textContent = link.is_listed ? "顯示" : "隱藏";
      badge.classList.add(link.is_listed ? "is-public" : "is-restricted");

      row.querySelector(".project-admin-name").textContent = link.name;
      row.querySelector(".project-admin-slug").textContent = link.url;

      const category = state.categories.find((c) => c.id === link.category_id);
      const parts = [category ? `分類：${category.name}` : "未分類", `排序：${link.sort_order}`];
      row.querySelector(".project-admin-meta").textContent = parts.join("　·　");

      const editButton = row.querySelector(".link-edit");
      editButton.dataset.linkId = String(link.id);
      editButton.dataset.action = "edit";
      editButton.setAttribute("aria-label", `編輯 ${link.name}`);
      editButton.addEventListener("click", () => openLinkDialog(link, editButton));

      const deleteButton = row.querySelector(".link-delete");
      deleteButton.dataset.linkId = String(link.id);
      deleteButton.dataset.action = "delete";
      deleteButton.setAttribute("aria-label", `刪除 ${link.name}`);
      deleteButton.addEventListener("click", () => openDeleteDialog({ ...link, __kind: "links" }, deleteButton));

      linkList.append(row);
    }

    setLinkListMode("list");
  }

  /**
   * @param {Record<string, any> | null} link
   * @param {HTMLElement | null} trigger
   */
  function openLinkDialog(link, trigger) {
    state.editingLinkId = link?.id ?? null;
    state.lastTrigger = trigger;

    linkDialogTitle.textContent = link ? "編輯連結" : "新增連結";
    linkForm.reset();
    clearFieldErrors(LINK_FIELD_ERROR_IDS, linkForm, linkFormErrorSummary);
    renderTaxonomyControls();

    if (link) {
      linkForm.elements.namedItem("name").value = link.name ?? "";
      linkForm.elements.namedItem("url").value = link.url ?? "";
      linkForm.elements.namedItem("description").value = link.description ?? "";
      linkForm.elements.namedItem("icon").value = link.icon ?? "";
      linkCategorySelect.value = link.category_id ? String(link.category_id) : "";
      linkForm.elements.namedItem("sort_order").value = String(link.sort_order ?? 0);
      linkForm.elements.namedItem("is_listed").checked = link.is_listed !== false;
    } else {
      linkForm.elements.namedItem("sort_order").value = "0";
      linkForm.elements.namedItem("is_listed").checked = true;
    }

    linkDialog.showModal();
    linkForm.elements.namedItem("name").focus();
  }

  function closeLinkDialog() {
    closeDialog(linkDialog);
  }

  /**
   * 送出前的本機檢查，邏輯與 `validateProjectForm` 對稱，只是欄位少很多。
   * 伺服器仍會再驗一次（尤其是網址協定），這裡只是讓使用者更快看到問題。
   *
   * @returns {boolean}
   */
  function validateLinkForm() {
    clearFieldErrors(LINK_FIELD_ERROR_IDS, linkForm, linkFormErrorSummary);

    const data = new FormData(linkForm);
    let firstInvalid = null;

    const name = String(data.get("name") ?? "").trim();
    if (!name || name.length > 100) {
      setFieldError("name", "請輸入 1 到 100 個字的名稱。", LINK_FIELD_ERROR_IDS, linkForm);
      firstInvalid = firstInvalid ?? "name";
    }

    // 只做粗略的協定檢查（http/https 開頭）。是不是真的能連上、
    // 是不是校內限定，都不是前端能判斷的事，交給伺服器與使用者自己的備註。
    const url = String(data.get("url") ?? "").trim();
    if (!url || !/^https?:\/\//.test(url)) {
      setFieldError("url", "網址必須以 http:// 或 https:// 開頭。", LINK_FIELD_ERROR_IDS, linkForm);
      firstInvalid = firstInvalid ?? "url";
    }

    if (firstInvalid) {
      linkFormErrorSummary.textContent = "表單還有欄位需要修正，請看下方標示。";
      linkFormErrorSummary.hidden = false;

      const target = linkForm.elements.namedItem(firstInvalid);
      if (target instanceof HTMLElement) {
        target.focus();
      }

      return false;
    }

    return true;
  }

  /**
   * @param {SubmitEvent} event
   */
  async function submitLink(event) {
    event.preventDefault();
    clearFlash();

    if (!validateLinkForm()) {
      return;
    }

    const data = new FormData(linkForm);
    const categoryValue = String(data.get("category_id") ?? "");
    const sortOrderRaw = String(data.get("sort_order") ?? "").trim();
    const sortOrderParsed = Number(sortOrderRaw);

    const payload = {
      name: String(data.get("name") ?? "").trim(),
      url: String(data.get("url") ?? "").trim(),
      description: String(data.get("description") ?? ""),
      icon: String(data.get("icon") ?? ""),
      category_id: categoryValue === "" ? null : Number(categoryValue),
      sort_order: sortOrderRaw === "" || Number.isNaN(sortOrderParsed) ? 0 : sortOrderParsed,
      is_listed: /** @type {HTMLInputElement} */ (linkForm.elements.namedItem("is_listed")).checked,
    };

    const originalLabel = linkSubmit.textContent;
    linkSubmit.disabled = true;
    linkSubmit.textContent = "儲存中…";

    const result = state.editingLinkId
      ? await api("PATCH", `/api/links/${state.editingLinkId}`, payload)
      : await api("POST", "/api/links", payload);

    linkSubmit.disabled = false;
    linkSubmit.textContent = originalLabel;

    if (result.ok) {
      const name = payload.name;
      const wasEditing = Boolean(state.editingLinkId);
      const trigger = state.lastTrigger;

      state.lastTrigger = null;
      state.editingLinkId = null;

      // 與 submitProject 同一個理由：先關閉讓畫面立即有反應，
      // 等清單重新載入後才還原焦點，否則焦點會找不到尚未重繪出來的那一列按鈕。
      linkDialog.close();
      await loadAll();
      restoreFocus(trigger);

      showFlash(wasEditing ? `已更新「${name}」。` : `已新增「${name}」。`, "success");
      return;
    }

    const fields = result.error?.fields ?? {};
    let matched = false;
    let firstField = null;

    for (const [field, message] of Object.entries(fields)) {
      if (setFieldError(field, String(message), LINK_FIELD_ERROR_IDS, linkForm)) {
        matched = true;
        firstField = firstField ?? field;
      }
    }

    linkFormErrorSummary.textContent = matched
      ? "表單還有欄位需要修正，請看下方標示。"
      : result.error?.message ?? "儲存失敗，請稍後再試一次。";
    linkFormErrorSummary.hidden = false;

    if (firstField) {
      const target = linkForm.elements.namedItem(firstField);
      if (target instanceof HTMLElement) target.focus();
    } else {
      linkFormErrorSummary.focus?.();
    }
  }

  // ---------------------------------------------------------------- 展示中心版面

  /**
   * @param {SubmitEvent} event
   */
  async function submitLayout(event) {
    event.preventDefault();
    clearFlash();

    layoutError.hidden = true;
    layoutError.textContent = "";

    const data = new FormData(layoutForm);
    const value = String(data.get("gallery_layout") ?? "");

    if (!value) {
      layoutError.textContent = "請選擇一種版面。";
      layoutError.hidden = false;
      return;
    }

    const originalLabel = layoutSubmit.textContent;
    layoutSubmit.disabled = true;
    layoutSubmit.textContent = "儲存中…";

    const result = await api("PATCH", "/api/settings/gallery_layout", { value });

    layoutSubmit.disabled = false;
    layoutSubmit.textContent = originalLabel;

    if (result.ok) {
      showFlash("已更新展示中心的版面設定。", "success");
      return;
    }

    layoutError.textContent = result.error?.fields?.value ?? result.error?.message ?? "儲存失敗，請稍後再試一次。";
    layoutError.hidden = false;
  }

  // ---------------------------------------------------------------- 網站配色（2026-08-29 新增）

  /**
   * 與 submitLayout() 同一套模式，多一步：存檔成功後**立刻套用到目前這個頁面**。
   *
   * 為什麼要立刻套用而不是等重新整理：配色是視覺設定，使用者按下儲存的當下
   * 就想看到結果。而且後台自己也會換色（2026-08-29 裁定），不套用的話會出現
   * 「展示中心換了、我正在看的後台沒換」這種看起來像壞掉的狀態。
   *
   * @param {SubmitEvent} event
   */
  async function submitTheme(event) {
    event.preventDefault();
    clearFlash();

    themeError.hidden = true;
    themeError.textContent = "";

    const value = String(new FormData(themeForm).get("site_theme") ?? "");

    if (!value) {
      themeError.textContent = "請選擇一種配色。";
      themeError.hidden = false;
      return;
    }

    const originalLabel = themeSubmit.textContent;
    themeSubmit.disabled = true;
    themeSubmit.textContent = "儲存中…";

    const result = await api("PATCH", "/api/settings/site_theme", { value });

    themeSubmit.disabled = false;
    themeSubmit.textContent = originalLabel;

    if (result.ok) {
      applyThemeToThisPage(value);
      showFlash("已更新網站配色，展示中心與這個後台都套用了。", "success");
      return;
    }

    themeError.textContent = result.error?.fields?.value ?? result.error?.message ?? "儲存失敗，請稍後再試一次。";
    themeError.hidden = false;
  }

  /**
   * 套用配色到目前頁面，並更新 localStorage 的快取。
   *
   * 與 `public/site-footer.js` 的 applySiteTheme() 是必要的重複——後台這支
   * 腳本要在存檔當下就套用，不能等下一次頁面載入。兩處的規則必須一致：
   * zero 代表「沒有覆寫」，所以移除屬性而不是寫 data-theme="zero"。
   *
   * @param {string} value
   */
  function applyThemeToThisPage(value) {
    if (value === "zero") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", value);
    }

    try {
      localStorage.setItem("hub-site-theme", value);
    } catch {
      /* 無痕視窗或封鎖網站資料時記不住，不影響本次套用 */
    }
  }

  // ---------------------------------------------------------------- 站名（2026-08-28 新增，見 Part C）

  /**
   * 與 submitLayout() 同一套模式：清錯誤 → 讀表單值 → 送出 → 依結果顯示。
   *
   * @param {SubmitEvent} event
   */
  async function submitSiteName(event) {
    event.preventDefault();
    clearFlash();

    siteNameError.hidden = true;
    siteNameError.textContent = "";

    const value = siteNameInput.value.trim();

    if (!value) {
      siteNameError.textContent = "站名不能是空白。";
      siteNameError.hidden = false;
      return;
    }

    const originalLabel = siteNameSubmit.textContent;
    siteNameSubmit.disabled = true;
    siteNameSubmit.textContent = "儲存中…";

    const result = await api("PATCH", "/api/settings/site_name", { value });

    siteNameSubmit.disabled = false;
    siteNameSubmit.textContent = originalLabel;

    if (result.ok) {
      // 存回 trim 過的值，避免使用者看到欄位裡還留著自己不小心多打的空白。
      siteNameInput.value = result.data?.value ?? value;
      showFlash("已更新站名。", "success");
      return;
    }

    siteNameError.textContent = result.error?.fields?.value ?? result.error?.message ?? "儲存失敗，請稍後再試一次。";
    siteNameError.hidden = false;
  }

  // ---------------------------------------------------------------- 網站圖示（2026-08-28 新增，見同日工作計畫-主畫面改造.md Part A）

  /**
   * 與 submitLayout() 同一套模式：清錯誤 → 讀表單值 → 送出 → 依結果顯示。
   *
   * @param {SubmitEvent} event
   */
  async function submitSiteLogo(event) {
    event.preventDefault();
    clearFlash();

    siteLogoError.hidden = true;
    siteLogoError.textContent = "";

    const data = new FormData(siteLogoForm);
    const value = String(data.get("site_logo") ?? "");

    if (!value) {
      siteLogoError.textContent = "請選擇一張圖示。";
      siteLogoError.hidden = false;
      return;
    }

    const originalLabel = siteLogoSubmit.textContent;
    siteLogoSubmit.disabled = true;
    siteLogoSubmit.textContent = "儲存中…";

    const result = await api("PATCH", "/api/settings/site_logo", { value });

    siteLogoSubmit.disabled = false;
    siteLogoSubmit.textContent = originalLabel;

    if (result.ok) {
      showFlash("已更新網站圖示。", "success");
      return;
    }

    siteLogoError.textContent = result.error?.fields?.value ?? result.error?.message ?? "儲存失敗，請稍後再試一次。";
    siteLogoError.hidden = false;
  }

  // ---------------------------------------------------------------- 事件綁定

  $("add-project").addEventListener("click", (event) => {
    clearFlash();
    openProjectDialog(null, event.currentTarget);
  });

  $("reload-projects").addEventListener("click", () => {
    clearFlash();
    loadAll();
  });

  $("list-retry").addEventListener("click", loadAll);

  projectForm.addEventListener("submit", submitProject);
  $("project-cancel").addEventListener("click", closeProjectDialog);
  $("project-cancel-bottom").addEventListener("click", closeProjectDialog);
  $("thumbnail-upload-button").addEventListener("click", uploadThumbnail);

  // 切換可見性時即時顯示或隱藏密碼設定
  for (const radio of projectForm.querySelectorAll('input[name="visibility"]')) {
    radio.addEventListener("change", () => {
      updatePasswordSection();

      if (state.editingId && radio.value === "password" && !$("password-status").textContent) {
        loadPolicy(state.editingId);
      }
    });
  }

  $("password-save").addEventListener("click", () => {
    submitPassword(/** @type {HTMLInputElement} */ ($("project-password")).value);
  });

  $("password-clear").addEventListener("click", () => submitPassword(null));

  $("deployments-close").addEventListener("click", () => closeDialog(deploymentsDialog));
  $("deployment-form").addEventListener("submit", submitDeployment);

  // 離開欄位時就檢查，讓問題早點出現而不是等到送出。
  for (const field of ["name", "slug", "deployment_url", "repository_url"]) {
    const input = projectForm.elements.namedItem(field);

    if (input instanceof HTMLInputElement) {
      input.addEventListener("blur", () => {
        const value = input.value.trim();
        const errorEl = $(FIELD_ERROR_IDS[field]);

        errorEl.hidden = true;
        errorEl.textContent = "";
        input.removeAttribute("aria-invalid");

        if (field === "slug" && value && !SLUG_PATTERN.test(value)) {
          setFieldError("slug", "只能使用小寫英文、數字與連字號，且不能用連字號開頭或結尾。");
        }

        if (field === "name" && value.length > 100) {
          setFieldError("name", "名稱不能超過 100 個字。");
        }

        if ((field === "deployment_url" || field === "repository_url") && value && !value.startsWith("https://")) {
          setFieldError(field, "網址必須以 https:// 開頭。");
        }
      });
    }
  }

  // Esc 關閉時仍要還原焦點。cancel 事件在按下 Esc 時觸發。
  for (const dialog of [projectDialog, deleteDialog, deploymentsDialog, linkDialog]) {
    dialog.addEventListener("cancel", () => {
      const trigger = state.lastTrigger;
      state.lastTrigger = null;
      restoreFocus(trigger);
    });
  }

  $("delete-cancel").addEventListener("click", () => closeDialog(deleteDialog));
  deleteConfirm.addEventListener("click", confirmDelete);

  categoryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    clearFlash();
    submitTaxonomy(categoryForm, "categories");
  });

  tagForm.addEventListener("submit", (event) => {
    event.preventDefault();
    clearFlash();
    submitTaxonomy(tagForm, "tags");
  });

  $("add-link").addEventListener("click", (event) => {
    clearFlash();
    openLinkDialog(null, event.currentTarget);
  });

  $("link-list-retry").addEventListener("click", loadAll);

  linkForm.addEventListener("submit", submitLink);
  $("link-cancel").addEventListener("click", closeLinkDialog);
  $("link-cancel-bottom").addEventListener("click", closeLinkDialog);

  layoutForm.addEventListener("submit", submitLayout);
  themeForm.addEventListener("submit", submitTheme);
  siteNameForm.addEventListener("submit", submitSiteName);
  siteLogoForm.addEventListener("submit", submitSiteLogo);

  /**
   * 版面設定不屬於 loadAll() 的 Promise.all（那個失敗處理是「整個清單載入
   * 失敗」的語意，版面設定讀不到不該擋住專案清單顯示）。讀不到就維持
   * radio 的 HTML 預設狀態不選取，管理者選一次存檔即可。
   */
  async function loadLayoutSetting() {
    const result = await api("GET", "/api/settings/gallery_layout");

    if (!result.ok) {
      return;
    }

    const value = result.data?.value;
    const radio = layoutForm.querySelector(`input[name="gallery_layout"][value="${value}"]`);
    if (radio) radio.checked = true;
  }

  /**
   * 站名同樣不屬於 loadAll() 的 Promise.all，理由與 loadLayoutSetting() 相同：
   * 這筆設定讀不到不該擋住專案清單顯示。讀不到就維持欄位空白，管理者
   * 打一次存檔即可（/api/settings/site_name 本身在沒有資料時就會回中性
   * 預設值，不是真的空字串，所以這裡幾乎不會遇到空白情況）。
   */
  async function loadSiteNameSetting() {
    const result = await api("GET", "/api/settings/site_name");

    if (!result.ok) {
      return;
    }

    siteNameInput.value = result.data?.value ?? "";
  }

  /**
   * 網站圖示同樣不屬於 loadAll() 的 Promise.all，理由與 loadLayoutSetting()
   * 相同：這筆設定讀不到不該擋住專案清單顯示。讀不到就維持 radio 的 HTML
   * 預設狀態不選取，管理者選一次存檔即可。
   */
  async function loadSiteLogoSetting() {
    const result = await api("GET", "/api/settings/site_logo");

    if (!result.ok) {
      return;
    }

    const value = result.data?.value;
    const radio = siteLogoForm.querySelector(`input[name="site_logo"][value="${value}"]`);
    if (radio) radio.checked = true;
  }

  /**
   * 回填目前的配色，理由與 loadLayoutSetting() 相同：這筆設定讀不到不該擋住
   * 專案清單顯示，所以不放進 loadAll() 的 Promise.all。
   */
  async function loadThemeSetting() {
    const result = await api("GET", "/api/settings/site_theme");

    if (!result.ok) {
      return;
    }

    const value = result.data?.value;
    const radio = themeForm.querySelector(`input[name="site_theme"][value="${value}"]`);
    if (radio) radio.checked = true;
  }

  // ---------------------------------------------------------------- 分頁（2026-08-30 階段 E）

  /**
   * 三個分頁。順序固定，鍵盤左右鍵就是照這個順序走。
   *
   * hash 是給外部連結用的：`AGENTS.md` 現在可以直接給
   * `/admin/#settings`，而不是叫使用者自己在畫面上找「站台設定」。
   */
  const TABS = [
    { hash: "projects", tab: "tab-projects", panel: "panel-projects" },
    { hash: "taxonomy", tab: "tab-taxonomy", panel: "panel-taxonomy" },
    { hash: "links", tab: "tab-links", panel: "panel-links" },
    { hash: "settings", tab: "tab-settings", panel: "panel-settings" },
  ];

  /**
   * 切換分頁。
   *
   * 面板用 `hidden` 屬性開關，不用 class 控制 display——`.admin-panel` 本身
   * 刻意沒有宣告 display，admin.css 另有一條 `[hidden] { display: none }`
   * 當保險（那個坑本專案踩過五次）。
   *
   * @param {string} hash
   * @param {{ focus?: boolean }} [options]
   */
  function activateTab(hash, options = {}) {
    const target = TABS.find((item) => item.hash === hash) ?? TABS[0];

    for (const item of TABS) {
      const isActive = item === target;
      const tab = $(item.tab);
      const panel = $(item.panel);

      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
      // 未選取的分頁移出 Tab 鍵順序：一組分頁在鍵盤上算一個停留點，
      // 進去之後用左右鍵切換（WAI-ARIA 的 tablist 慣例）。
      tab.tabIndex = isActive ? 0 : -1;
      panel.hidden = !isActive;
    }

    if (options.focus) {
      $(target.tab).focus();
    }

    // replaceState 而不是直接指定 location.hash：後者每切一次就多一筆
    // 瀏覽紀錄，使用者按上一頁時會在分頁之間跳來跳去，而不是回到前一個頁面。
    history.replaceState(null, "", `#${target.hash}`);
  }

  for (const [index, item] of TABS.entries()) {
    const tab = $(item.tab);

    tab.addEventListener("click", () => activateTab(item.hash));

    tab.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

      if (step === 0) {
        return;
      }

      event.preventDefault();
      // 取模讓它頭尾相接，跟原生的分頁元件行為一致。
      activateTab(TABS[(index + step + TABS.length) % TABS.length].hash, { focus: true });
    });
  }

  // 直接開 /admin/#settings 就會停在該分頁；沒有 hash 或 hash 不認得就用第一頁。
  activateTab(location.hash.replace("#", ""));

  window.addEventListener("hashchange", () => {
    activateTab(location.hash.replace("#", ""));
  });

  loadAll();
  loadLayoutSetting();
  loadThemeSetting();
  loadSiteNameSetting();
  loadSiteLogoSetting();
})();
