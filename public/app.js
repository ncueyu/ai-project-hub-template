// @ts-check

/**
 * 展示中心前端。
 *
 * 安全規則（階段二計畫第 11.2 節）：
 *   - 所有來自 API 的文字一律使用 textContent 寫入，不使用 innerHTML。
 *   - 外部連結使用 target="_blank" 時必須同時加上 rel="noopener noreferrer"。
 *
 * 可見性規則：前端不做任何過濾。伺服器只會回傳 public 專案，
 * 其他狀態的專案根本不會出現在回應中，因此也不會進入 DOM。
 */

(() => {
  const grid = document.getElementById("project-grid");
  const template = document.getElementById("project-card-template");
  const loadingState = document.getElementById("gallery-loading");
  const errorState = document.getElementById("gallery-error");
  const errorMessage = document.getElementById("gallery-error-message");
  const emptyState = document.getElementById("gallery-empty");
  const emptyTitle = document.getElementById("gallery-empty-title");
  const emptyMessage = document.getElementById("gallery-empty-message");
  const clearFilterButton = document.getElementById("gallery-clear-filter");
  const retryButton = document.getElementById("gallery-retry");
  const countLabel = document.getElementById("project-count");
  const filterGroups = document.getElementById("filter-groups");
  const categoryGroup = document.getElementById("category-filter-group");
  const tagGroup = document.getElementById("tag-filter-group");
  const categoryFilters = document.getElementById("category-filters");
  const tagFilters = document.getElementById("tag-filters");

  const linksSection = document.getElementById("links-section");
  const linksGrid = document.getElementById("links-grid");
  const linkTemplate = document.getElementById("link-card-template");

  if (!grid || !template) {
    return;
  }

  const state = { category: null, tag: null };
  let filtersRendered = false;

  const dateFormatter = new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  /**
   * @param {string} value
   * @returns {string}
   */
  function formatDate(value) {
    if (!value) {
      return "";
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? "" : dateFormatter.format(parsed);
  }

  /**
   * 把文字截到「剛好放得下」，並在結尾補上刪節號。
   *
   * 為什麼要用 JavaScript 而不是 CSS：`-webkit-line-clamp` 只在
   * `display: -webkit-box` 上生效，而卡片的說明與名稱都是 flex 子元素，
   * flex 子元素的 display 會被瀏覽器區塊化（實測 computed value 是 flow-root），
   * 所以那個屬性在這個結構下完全無效——2026-08-28 用三種寫法實測確認過
   * （-webkit-box、標準 line-clamp 都試過）。CSS 只能靠 overflow: hidden 硬切，
   * 切在哪裡不受控、也不會有刪節號。
   *
   * 為什麼用二分搜尋而不是「用平均字寬估算字數」：中英數字混排時每個字元的
   * 寬度差很多（「測」16px 而「a」約 8px），用平均值估會在混排的說明上失準，
   * 有時留白一大塊、有時還是溢出。直接量測實際渲染高度是唯一可靠的方式。
   *
   * @param {HTMLElement} el 要截斷的元素（文字內容會被改寫）
   * @param {HTMLElement} clip 限制高度的外層容器
   */
  function truncateToFit(el, clip) {
    const full = el.dataset.fullText ?? el.textContent ?? "";

    el.textContent = full;

    // 沒有溢出就不動它——短文字不該被加上刪節號。
    if (el.scrollHeight <= clip.clientHeight) {
      return;
    }

    // 二分搜尋「加上刪節號後仍放得下」的最長前綴。
    let low = 0;
    let high = full.length;

    while (low < high) {
      const mid = Math.ceil((low + high) / 2);

      el.textContent = `${full.slice(0, mid)}…`;

      if (el.scrollHeight <= clip.clientHeight) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    el.textContent = low > 0 ? `${full.slice(0, low)}…` : "…";
  }

  /**
   * 精簡日期格式：`YYYY.MMDD`（例如 2026-08-22 → `2026.0822`）。
   *
   * 2026-08-28 使用者實際看過畫面後裁定：卡片寬度放得下完整年份，
   * 所以從最初的 `YY-MMDD` 改為 `YYYY.MMDD`——年份完整比較好讀，
   * 而實測第一行仍然不會換行。
   *
   * 為什麼不用完整格式：卡片高度 2026-08-28 壓縮到 356px 後，
   * 「最後更新：2026年8月22日」會自己佔掉第一行的大部分寬度，把分類與型態標記
   * 擠到第二行——那等於用掉一整行來顯示一個對訪客價值不高的資訊。
   * 壓縮後它只佔第一行末端一小塊，完整日期仍在 title 裡。
   *
   * @param {string} value
   * @returns {string}
   */
  function formatDateCompact(value) {
    if (!value) {
      return "";
    }

    const parsed = new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      return "";
    }

    const mm = String(parsed.getMonth() + 1).padStart(2, "0");
    const dd = String(parsed.getDate()).padStart(2, "0");

    return `${parsed.getFullYear()}.${mm}${dd}`;
  }

  /**
   * @param {"loading" | "error" | "empty" | "list"} mode
   */
  function setMode(mode) {
    loadingState.hidden = mode !== "loading";
    errorState.hidden = mode !== "error";
    emptyState.hidden = mode !== "empty";
    grid.hidden = mode !== "list";
  }

  function hasActiveFilter() {
    return Boolean(state.category || state.tag);
  }

  /**
   * @param {HTMLElement} container
   * @param {Record<string, any>[]} items
   * @param {"category" | "tag"} kind
   */
  function renderFilterChips(container, items, kind) {
    container.textContent = "";

    for (const item of items) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "filter-chip";
      chip.dataset.kind = kind;
      chip.dataset.slug = item.slug;
      chip.setAttribute("aria-pressed", String(state[kind] === item.slug));

      const label = document.createElement("span");
      label.textContent = item.name;
      chip.append(label);

      if (typeof item.count === "number") {
        const count = document.createElement("span");
        count.className = "filter-chip-count";
        count.textContent = `（${item.count}）`;
        chip.append(count);
      }

      chip.addEventListener("click", () => {
        state[kind] = state[kind] === item.slug ? null : item.slug;
        load();
      });

      container.append(chip);
    }
  }

  /**
   * 篩選選項只在第一次載入時建立，避免套用篩選後選項消失、使用者無法取消。
   *
   * @param {{ categories: Record<string, any>[], tags: Record<string, any>[] }} filters
   */
  function renderFilters(filters) {
    if (filtersRendered) {
      syncChipStates();
      return;
    }

    const hasCategories = filters.categories.length > 0;
    const hasTags = filters.tags.length > 0;

    if (hasCategories) {
      renderFilterChips(categoryFilters, filters.categories, "category");
    }

    if (hasTags) {
      renderFilterChips(tagFilters, filters.tags, "tag");
    }

    categoryGroup.hidden = !hasCategories;
    tagGroup.hidden = !hasTags;
    filterGroups.hidden = !hasCategories && !hasTags;
    filtersRendered = hasCategories || hasTags;
  }

  function syncChipStates() {
    const chips = filterGroups.querySelectorAll(".filter-chip");

    for (const chip of chips) {
      const kind = chip.dataset.kind;
      chip.setAttribute("aria-pressed", String(state[kind] === chip.dataset.slug));
    }
  }

  /**
   * @param {Record<string, any>} project
   * @returns {DocumentFragment}
   */
  function createCard(project) {
    const fragment = template.content.cloneNode(true);

    // 主卡片標記（2026-08-28 主畫面改造 Part D）。只加 class，光暈本身的
    // CSS（含只在 grid／hero 版面出現、list 版面不出現）與
    // prefers-reduced-motion 的靜態版全部在 public/gallery.css 處理，
    // 這裡不判斷版面——三種版面共用同一份卡片 DOM 的既有前提（2026-08-27
    // 設計決定）不能因為這個新標記被打破。
    const cardRoot = fragment.querySelector(".project-card");
    if (cardRoot) {
      cardRoot.classList.toggle("is-primary", project.is_primary === true);
    }

    const image = fragment.querySelector(".project-thumb img");
    const fallback = fragment.querySelector(".project-thumb-fallback");
    const note = fragment.querySelector(".project-thumb-note");

    if (project.thumbnail_url) {
      image.src = project.thumbnail_url;
      image.alt = "";

      // 預設先顯示替代圖示，等圖片真的載入成功才隱藏它。
      // 這樣「載入中」「載入失敗」「網址無回應」三種情況都不會出現空白區塊，
      // 只有 error 事件的話，遇到一直 pending 的網址就會留下空白。
      fallback.hidden = false;

      // 但「此專案尚無預覽圖」這句話在載入期間是**錯的**——它有預覽圖，只是還沒到。
      // img 帶 loading="lazy"，捲動到畫面才開始載入，所以這段時間可能長達數百毫秒，
      // 使用者真的會看到那句話再看到圖片閃過去。載入中只留圖示，不留文字。
      if (note !== null) {
        note.hidden = true;
      }

      image.addEventListener("load", () => {
        fallback.hidden = true;
      }, { once: true });

      image.addEventListener("error", () => {
        image.hidden = true;
        fallback.hidden = false;

        // 載入失敗才是真的沒有預覽圖可看，這時文字才成立。
        if (note !== null) {
          note.hidden = false;
        }
      }, { once: true });
    } else {
      image.hidden = true;
      fallback.hidden = false;

      if (note !== null) {
        note.hidden = false;
      }
    }

    const category = fragment.querySelector(".project-category");
    if (project.category) {
      category.textContent = project.category.name;
      category.hidden = false;
    }

    // 型態標記。只有「不是網站」的型態才標，一般網站不需要多一個標籤製造雜訊。
    //
    // schema 的 project_type 允許 static / worker / fullstack / other。
    // 前三種都是可以直接開啟的網站；other 用在桌面程式、瀏覽器擴充功能、
    // 需要常駐執行環境的服務——那些的「開啟」連結指向的是說明頁，不是程式本身。
    const kind = fragment.querySelector(".project-kind");
    if (kind !== null && project.project_type === "other") {
      kind.textContent = "需下載安裝";
      kind.title = "這不是可直接在瀏覽器開啟的網站。點進去是說明頁，裡面有下載連結與安裝步驟。";
      kind.hidden = false;
    }

    // 權限標記。加密專案會列在展示中心，所以必須先講明「點進去要密碼」，
    // 否則訪客按下開啟看到密碼頁，會以為網站壞了或自己沒權限。
    const access = fragment.querySelector(".project-access");
    if (access !== null && project.requires_password === true) {
      access.textContent = "需要密碼";
      access.title = "這個專案需要密碼才能看內容。若你應該有存取權限，請向網站作者索取密碼。";
      access.hidden = false;
    }

    fragment.querySelector(".project-name").textContent = project.name;
    fragment.querySelector(".project-description").textContent = project.description ?? "";
    // 完整原文留在 dataset 裡：截斷是顯示層的事，換版面或改視窗寬度時要能
    // 從原文重新算，不能拿已經被截過的字再截一次（那會越截越短）。
    fragment.querySelector(".project-description").dataset.fullText = project.description ?? "";
    fragment.querySelector(".project-name").dataset.fullText = project.name ?? "";

    const tagList = fragment.querySelector(".project-tags");
    if (Array.isArray(project.tags) && project.tags.length > 0) {
      for (const tag of project.tags) {
        const item = document.createElement("li");
        item.textContent = tag.name;
        tagList.append(item);
      }
      tagList.hidden = false;
    }

    // 日期在精簡版面（grid／hero）只有第一行的一小塊空間，所以顯示壓縮成
    // YY-MMDD（2026-08-28 使用者裁定）。完整日期放進 title，滑鼠停留就看得到，
    // 語意不會因為壓縮而流失。
    const rawUpdated = project.last_deployed_at || project.updated_at;
    const updated = formatDate(rawUpdated);
    const updatedEl = fragment.querySelector(".project-updated");

    if (updated) {
      updatedEl.textContent = formatDateCompact(rawUpdated);
      updatedEl.title = `最後更新：${updated}`;
      updatedEl.hidden = false;
    } else {
      updatedEl.textContent = "";
      updatedEl.hidden = true;
    }

    const openContainer = fragment.querySelector(".project-open");
    if (project.deployment_url) {
      const link = document.createElement("a");
      link.href = project.deployment_url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      // 2026-08-28 主畫面改造 Part B6：連結改用按鈕外觀。沿用全站既有的
      // .button/.button-primary（見 public/styles.css），不另外做一套平行的
      // 按鈕樣式；陰影與置中由 public/gallery.css 的 .project-open 規則負責
      // （置中） 與 .project-open .button 規則負責（陰影，只加在這個情境，
      // 不影響全站其他用到 .button-primary 的地方）。
      link.className = "button button-primary";
      /*
       * 2026-08-28 使用者裁定：按鈕上的字統一為「開啟連結」，每張卡片都一樣。
       *
       * 但**可見文字改成通用詞會拿掉螢幕閱讀器使用者的關鍵資訊**——他們原本
       * 靠「開啟 某某專案」知道這個連結會去哪裡；一頁四個按鈕都唸「開啟連結」
       * 等於全部無法分辨。因此用 aria-label 把專案名稱（與「需要密碼」的提醒）
       * 補回去：視覺上是統一的短字，輔助技術讀到的仍然是完整資訊。
       */
      link.textContent = "開啟連結";
      link.setAttribute(
        "aria-label",
        project.requires_password === true
          ? `開啟 ${project.name}（需要密碼）`
          : `開啟 ${project.name}`,
      );
      openContainer.append(link);
    } else {
      const note = document.createElement("span");
      note.className = "project-open-missing";
      note.textContent = "尚未提供開啟連結";
      openContainer.append(note);
    }

    return fragment;
  }

  /** 合法版面清單。與 src/repositories/settings.js 的 GALLERY_LAYOUTS 同步——
   * 前端沒有辦法 import 後端模組，這裡是唯一需要重複這份清單的地方。
   * 未知或缺席的值一律退回 grid，理由與後端 getGalleryLayout() 一致：
   * 版面設定缺席不該讓整頁掛掉或套用未定義的 CSS 屬性選擇器。
   * 2026-08-28 新增 `rows`（分類橫排，見下方 renderCategoryRows()）。 */
  const GALLERY_LAYOUTS = ["hero", "grid", "list", "rows"];

  /**
   * 把公開專案依分類分組，用來畫 rows 版面的橫排。
   *
   * 依 filters.categories 的順序輸出（那份清單已經照分類的 sort_order 排好，
   * 見 src/repositories/gallery.js 的 listPublicFilters()）；沒有分類
   * （project.category 為 null）的專案歸到最後一個「未分類」橫排；
   * **沒有專案的分類不會出現在結果裡**——這裡只在某個分類實際收集到至少
   * 一筆專案時才推入 rows，而不是無條件走訪 filters.categories 全部產生列。
   *
   * @param {Record<string, any>[]} items
   * @param {Record<string, any>[]} categories filters.categories，已依 sort_order 排序
   * @returns {{ key: string, title: string, items: Record<string, any>[] }[]}
   */
  function buildCategoryRows(items, categories) {
    /** @type {Map<number, Record<string, any>[]>} */
    const byCategoryId = new Map();
    const uncategorized = [];

    for (const project of items) {
      const categoryId = project.category?.id;

      if (categoryId !== undefined && categoryId !== null) {
        if (!byCategoryId.has(categoryId)) {
          byCategoryId.set(categoryId, []);
        }
        byCategoryId.get(categoryId).push(project);
      } else {
        uncategorized.push(project);
      }
    }

    const rows = [];
    const consumed = new Set();

    for (const category of categories) {
      const list = byCategoryId.get(category.id);

      if (list && list.length > 0) {
        rows.push({ key: `category-${category.id}`, title: category.name, items: list });
        consumed.add(category.id);
      }
    }

    // 保險分支：理論上不會走到——filters.categories 已涵蓋所有帶有公開專案的
    // 分類（見 listPublicFilters() 的 JOIN，沒有專案的分類本來就不在清單裡）。
    // 這裡防禦性地把「items 裡出現、卻不在 categories 清單中」的分類也畫出來，
    // 避免兩份資料萬一不同步時整排專案憑空消失、卻沒有任何錯誤訊息可查。
    for (const [categoryId, list] of byCategoryId) {
      if (!consumed.has(categoryId) && list.length > 0) {
        rows.push({ key: `category-${categoryId}`, title: list[0].category?.name ?? "其他", items: list });
      }
    }

    if (uncategorized.length > 0) {
      rows.push({ key: "uncategorized", title: "未分類", items: uncategorized });
    }

    return rows;
  }

  /**
   * 計算單一橫排的箭頭啟用/停用狀態，並實際套用到按鈕上。
   *
   * 停用用 `disabled` 屬性而非 `hidden`：本專案的 `hidden` 會被 class 的
   * `display` 覆蓋（已踩過四次，見 AGENTS.md 第 8 節），`disabled` 是原生
   * 表單控制項屬性，視覺與互動語意由瀏覽器保證、不受那個坑影響。
   *
   * 兩層處理，不是只有停用：
   * 1. 整排放得下、根本不需要捲動 → 把整個箭頭層隱藏（`is-static`）。
   *    箭頭現在疊在卡片上，留兩顆永遠按不動的灰箭頭會遮住封面圖。
   *    （箭頭還在標題列右上角的版本不需要這一層——那時兩顆灰箭頭無傷，
   *    反而刻意保留以免標題列寬度隨箭頭數量跳動。箭頭移到卡片上之後，
   *    那個理由連同標題列的箭頭一起消失了。）
   * 2. 可以捲動但已到某一端 → 該側停用變灰、另一側仍可按。
   *    這一顆灰箭頭要留著：它是「這一排還可以左右滑」的視覺提示，
   *    整層藏掉會讓使用者看不出這排是可捲動的。
   *
   * @param {HTMLElement} track
   * @param {HTMLButtonElement} prevButton
   * @param {HTMLButtonElement} nextButton
   */
  function updateRowArrowState(track, prevButton, nextButton) {
    const maxScrollLeft = track.scrollWidth - track.clientWidth;

    // 內容本來就放得下、不需要捲動：兩側都停用，不留一個永遠按不動的按鈕
    // （E3 明確要求：「只有一張卡片、不需要捲動時，箭頭要停用或不顯示」）。
    const scrollable = maxScrollLeft > 1;

    // 誤差容忍 1px：不同瀏覽器對小數捲動位置的四捨五入不一致，用「<=1」
    // 判斷「已到頭」比要求剛好等於 0 更可靠。
    /*
     * 「已在最左」的判斷要扣掉 track 自己的左內距，不能跟 0 比。
     *
     * 2026-08-28 實測發現的問題：卡片是 scroll-snap-align: start，而 track 有
     * 左內距（`padding: 18px 16px 24px`，且那個值是 clamp() 會隨視窗變動）。
     * snap 對齊第一張卡時 scrollLeft 會停在**內距寬度**（實測 16px）而不是 0，
     * 所以原本 `<= 1` 的容差永遠不成立——左箭頭在最左端仍然看起來可按，
     * 按下去卻只移動 16px。
     *
     * 用 paddingInlineStart 動態計算而不是寫死 16：那個內距是 clamp()，
     * 寫死的數字在不同視窗寬度下會失準。
     */
    const startInset = Number.parseFloat(getComputedStyle(track).paddingInlineStart) || 0;
    const atStart = track.scrollLeft <= startInset + 1;
    const atEnd = track.scrollLeft >= maxScrollLeft - 1;

    prevButton.disabled = !scrollable || atStart;
    nextButton.disabled = !scrollable || atEnd;

    // 用 class 切 visibility，不用 `hidden` 屬性（見上方註解的坑）。
    // parentElement 就是 .gallery-row-controls（createCategoryRow 建的結構）。
    prevButton.parentElement?.classList.toggle("is-static", !scrollable);
  }

  /**
   * @param {(track: HTMLElement, prevButton: HTMLButtonElement, nextButton: HTMLButtonElement) => void} callback
   */
  function forEachRow(callback) {
    for (const row of grid.querySelectorAll(".gallery-row")) {
      const track = /** @type {HTMLElement | null} */ (row.querySelector(".gallery-row-track"));
      const prevButton = /** @type {HTMLButtonElement | null} */ (row.querySelector(".gallery-row-arrow-prev"));
      const nextButton = /** @type {HTMLButtonElement | null} */ (row.querySelector(".gallery-row-arrow-next"));

      if (track && prevButton && nextButton) {
        callback(track, prevButton, nextButton);
      }
    }
  }

  /** 只重算箭頭的啟用/停用狀態，不重新綁事件——resize 時用這個。 */
  function refreshRowArrowStates() {
    forEachRow(updateRowArrowState);
  }

  /**
   * 觀察每個橫排容器的尺寸變化，尺寸一變就重算箭頭狀態。
   *
   * 2026-08-28 線上實測抓到的 bug：某排明明放得下（scrollWidth === clientWidth）
   * 箭頭層卻沒隱藏。手動觸發一次 resize 就正確了——所以不是判斷邏輯錯，
   * 是**狀態過期**：initRowScrolling() 只在建好 DOM 時算一次，之後只有
   * scroll 與 window resize 會重算。
   *
   * 成因是 track 的 clientWidth 在初次計算之後才變成最終值（卡片寬度是 CSS
   * 固定的 300px，內容寬度不變，變的是容器）。這種「容器晚一步才定寬」的情況
   * window resize 事件不會發生，所以原本的 resize 監聽補不到。
   *
   * 本機測不出來的原因也記在這裡：本機測試資料的每一排要嘛明顯放得下、要嘛
   * 明顯放不下，初次量測跟最終量測落在同一邊，所以狀態過期不會顯現。
   *
   * 用 ResizeObserver 而不是再加一輪 setTimeout：後者是猜「多久之後版面會穩」，
   * 猜錯就又是同一個 bug；ResizeObserver 是尺寸真的變了才回呼。
   */
  let rowResizeObserver = null;

  function observeRowSizes() {
    if (typeof ResizeObserver !== "function") return;

    // 每次 render() 都會重建 DOM，舊的 track 已從文件移除。先 disconnect
    // 再重新觀察，避免觀察者一路累積、持有已移除節點的參照。
    if (rowResizeObserver) {
      rowResizeObserver.disconnect();
    } else {
      rowResizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const track = /** @type {HTMLElement} */ (entry.target);
          const row = track.closest(".gallery-row");
          const prevButton = /** @type {HTMLButtonElement | null} */ (
            row?.querySelector(".gallery-row-arrow-prev") ?? null
          );
          const nextButton = /** @type {HTMLButtonElement | null} */ (
            row?.querySelector(".gallery-row-arrow-next") ?? null
          );
          if (prevButton && nextButton) {
            updateRowArrowState(track, prevButton, nextButton);
          }
        }
      });
    }

    forEachRow((track) => rowResizeObserver?.observe(track));
  }

  /**
   * 版面定案後再重算一次箭頭狀態。這是 observeRowSizes() 的備援層。
   *
   * 為什麼需要兩層：真正的 bug 是**初次計算與版面定案之間的競爭**——
   * initRowScrolling() 在建好 DOM 時就量測，但那一刻 track 的 clientWidth
   * 還不是最終值。ResizeObserver 是對付這件事的正解，然而它的回呼是在瀏覽器
   * 的 render 步驟派送的，在不繪製畫面的環境（無頭測試、背景分頁、本專案用來
   * 驗證的瀏覽器面板）完全不會送達——2026-08-28 實測連規格強制的「observe()
   * 後的初始回呼」都是 0。也就是說只靠 RO，這個修法無法在 CI 或任何不繪製的
   * 環境裡被驗證，而它修的又是一個不會報錯、只會靜靜顯示錯誤的 bug。
   *
   * 所以再掛兩個與繪製無關的事件當備援：
   * - window load：所有圖片與子資源載入完成，卡片尺寸不會再變。
   * - document.fonts.ready：字型換掉後文字量測會變，可能改變版面寬度。
   *
   * 這兩個都是「事件真的發生了」才重算，不是 setTimeout 猜「多久之後會穩」——
   * 猜錯就又回到同一個 bug。
   */
  function recheckAfterLayoutSettles() {
    if (document.readyState === "complete") {
      refreshRowArrowStates();
    } else {
      window.addEventListener("load", refreshRowArrowStates, { once: true });
    }

    // fonts 在舊瀏覽器可能不存在；沒有就跳過，不要讓整段掛掉。
    document.fonts?.ready.then(refreshRowArrowStates).catch(() => {});
  }

  /**
   * 幫每個橫排的捲動容器與左右箭頭掛上事件。只在 render() 建立好 rows 版面
   * 的 DOM 之後呼叫一次；下一次 render() 會先把 grid 清空重建，舊的
   * track／按鈕連同監聽器一起被丟棄，不會殘留重複綁定。
   */
  function initRowScrolling() {
    observeRowSizes();
    recheckAfterLayoutSettles();

    // scrollBy() 的 behavior:"smooth" 是明確指定的選項，會蓋過 CSS 的
    // scroll-behavior（規格規定顯式選項優先於元素的 CSS 值），所以「減少
    // 動態」不能只靠 gallery.css 那條 scroll-behavior:auto 覆寫生效——
    // 這裡要在呼叫時就判斷，主動把選項換成 "auto"（跳轉不做動畫）。
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scrollBehavior = prefersReducedMotion ? "auto" : "smooth";

    forEachRow((track, prevButton, nextButton) => {
      updateRowArrowState(track, prevButton, nextButton);

      // 使用者用觸控板／滑鼠拖曳捲軸手動捲動時，也要同步更新箭頭狀態。
      track.addEventListener("scroll", () => updateRowArrowState(track, prevButton, nextButton), { passive: true });

      prevButton.addEventListener("click", () => {
        track.scrollBy({ left: -track.clientWidth * 0.9, behavior: scrollBehavior });
      });

      nextButton.addEventListener("click", () => {
        track.scrollBy({ left: track.clientWidth * 0.9, behavior: scrollBehavior });
      });
    });
  }

  /**
   * 建立一個分類橫排的 DOM：標題列（分類名稱 ＋ 數量 ＋ 左右箭頭）
   * ＋ 一個橫向捲動的卡片清單。
   *
   * @param {{ key: string, title: string, items: Record<string, any>[] }} row
   * @returns {HTMLLIElement}
   */
  function createCategoryRow(row) {
    const rowEl = document.createElement("li");
    rowEl.className = "gallery-row";
    rowEl.dataset.rowKey = row.key;

    const head = document.createElement("div");
    head.className = "gallery-row-head";

    const title = document.createElement("h3");
    title.className = "gallery-row-title";
    title.textContent = row.title;

    const count = document.createElement("span");
    count.className = "gallery-row-count";
    count.textContent = `${row.items.length} 個專案`;

    const controls = document.createElement("div");
    controls.className = "gallery-row-controls";

    const prevButton = document.createElement("button");
    prevButton.type = "button";
    prevButton.className = "gallery-row-arrow gallery-row-arrow-prev";
    prevButton.setAttribute("aria-label", `往左看更多 ${row.title} 的專案`);
    /*
     * 箭頭本身由 CSS 畫（見 gallery.css 的 .gallery-row-arrow::before），
     * 這裡刻意不放文字（2026-09-06）。
     *
     * 原本用的是 ‹ › 這兩個字元，但它們是**標點符號**：字型裡的字身本來就
     * 比數字或字母小，而且貼著基線排。flex 的置中對齊的是「行框」不是
     * 看得見的那一筆，所以無論字級調多大，看起來都是又小又偏下。
     * 用 CSS 畫的 V 形沒有這個問題，尺寸與位置都能算準，也不受字型影響。
     *
     * 無障礙靠上面那行 aria-label，不靠這個字元。
     */

    const nextButton = document.createElement("button");
    nextButton.type = "button";
    nextButton.className = "gallery-row-arrow gallery-row-arrow-next";
    nextButton.setAttribute("aria-label", `往右看更多 ${row.title} 的專案`);

    // 2026-08-28 使用者修正：箭頭要疊在最左／最右的卡片上，不是放在分類標題的
    // 右上角。所以 controls 從 head 移到 rowEl（見下方 append），由 CSS 絕對定位
    // 貼到捲動區的左右邊緣。head 只留標題與數量。
    controls.append(prevButton, nextButton);
    head.append(title, count);

    // tabindex="0"：讓這個橫向捲動容器本身可以用鍵盤（Tab 移入後方向鍵）操作
    // ——E3 明確要求「橫向捲動容器本身也要能用鍵盤操作」。原生可捲動元素
    // 加上 tabindex 後，方向鍵捲動是瀏覽器內建行為，不需要另外寫鍵盤事件。
    const track = document.createElement("ul");
    track.className = "gallery-row-track";
    track.tabIndex = 0;
    track.setAttribute("aria-label", `${row.title} 分類的專案，可左右捲動`);

    for (const project of row.items) {
      track.append(createCard(project));
    }

    /*
     * viewport 這一層存在的唯一理由是「箭頭的定位基準」。
     *
     * 箭頭要垂直置中在**卡片**上，不是在含標題的整個橫排上。如果直接把
     * 絕對定位的 controls 錨定到 rowEl（它含標題列），inset: 0 會連標題一起
     * 覆蓋，箭頭就會偏高。多包一層剛好只包住捲動區的容器，才能用 inset: 0
     * 精準對齊卡片區——比用寫死的 top 值扣掉標題高度可靠（標題高度會隨
     * 分類名稱長度換行而變）。
     *
     * controls 放在 track 之後：DOM 順序在後面，不必額外調 z-index 就蓋在卡片上。
     */
    const viewport = document.createElement("div");
    viewport.className = "gallery-row-viewport";
    viewport.append(track, controls);

    rowEl.append(head, viewport);
    return rowEl;
  }

  /**
   * rows 版面的渲染路徑：按分類分組，每個分類一個橫排。
   *
   * 為什麼不沿用 hero/grid/list 共用同一份平鋪 DOM 的既有前提（2026-08-27
   * 設計決定，見上方 createCard() 註解與 gallery.css 對應段落）：要用純 CSS
   * 把一份平鋪清單變成「按分類分組的多個橫向捲動區」需要 display:contents
   * 之類的技巧，且分類數量是動態的——硬做會產生一份很難維護、分類增減時
   * 容易出錯的 CSS。兩條渲染路徑比一份過度聰明的 CSS 好維護，這是刻意的
   * 例外（2026-08-28 工作計畫 3-3 節裁定），不是對「不要在 JS 裡分三套
   * 渲染邏輯」這條既有原則的退化。
   *
   * @param {Record<string, any>[]} items
   * @param {{ categories: Record<string, any>[] }} filters
   */
  function renderCategoryRows(items, filters) {
    const rows = buildCategoryRows(items, filters.categories ?? []);

    for (const row of rows) {
      grid.append(createCategoryRow(row));
    }
  }

  /**
   * @param {Record<string, any>} data
   */
  function render(data) {
    const items = Array.isArray(data.items) ? data.items : [];
    const filters = data.filters ?? { categories: [], tags: [] };

    // `unlisted_count` 是條件性欄位——後端只在一個可列出的專案都沒有時才輸出
    // （見 src/routes/gallery.js 的註解）。所以這裡要容許它不存在，
    // 並且擋掉非數字的值：這個數字會直接印進使用者看到的句子，
    // 壞值會變成「你有 NaN 個專案」，比留白更糟。
    const rawUnlisted = Number(data.unlisted_count);
    const unlistedCount = Number.isFinite(rawUnlisted) && rawUnlisted > 0 ? Math.floor(rawUnlisted) : 0;

    // hero/grid/list 三種版面共用同一份卡片 DOM，只靠 [data-layout] 屬性
    // 選擇器切換樣式（public/gallery.css）——這裡只負責設屬性，不依版面
    // 產生不同 HTML（2026-08-27 工作計畫階段 7 的設計要求）。rows 版面是
    // 刻意的例外，見下方分支與 renderCategoryRows() 的註解。
    grid.dataset.layout = GALLERY_LAYOUTS.includes(data.gallery_layout) ? data.gallery_layout : "grid";

    renderFilters(filters);
    syncChipStates();

    countLabel.textContent = items.length > 0 ? `共 ${items.length} 個專案` : "";

    grid.textContent = "";

    if (items.length === 0) {
      /*
       * 空狀態分三種，說的話完全不同（2026-08-29 工作計畫階段 5）。
       *
       * 為什麼不能只有兩種：新專案登錄時一律是 private（刻意的安全預設），
       * 而這裡只列出 public 與 password。所以使用者**成功**部署第一個專案之後
       * 展示中心仍然是空的——如果照舊顯示「之後有新的公開專案時就會顯示在這裡」，
       * 他會以為部署失敗了。那正是我們要避免的失敗模式。
       *
       * 分辨的依據是 API 的 `unlisted_count`。那個欄位是**條件性**的：
       * 只有在一個可列出的專案都沒有時後端才輸出它（見 src/routes/gallery.js），
       * 所以這裡必須容許它不存在，不能假設一定有值。
       */
      if (hasActiveFilter()) {
        emptyTitle.textContent = "沒有符合篩選條件的專案";
        emptyMessage.textContent = "試著換一個分類或標籤，或清除篩選條件看全部專案。";
        clearFilterButton.hidden = false;
      } else if (unlistedCount > 0) {
        emptyTitle.textContent =
          unlistedCount === 1 ? "你有 1 個專案，但它還沒公開" : `你有 ${unlistedCount} 個專案，但都還沒公開`;
        emptyMessage.textContent =
          "專案已經上線了，只是權限是「私人」，所以這裡看不到它。"
          + "到管理後台把權限改成「公開」，重新整理這一頁就會出現。";
        clearFilterButton.hidden = true;
      } else {
        emptyTitle.textContent = "你的展示中心已經上線了";
        emptyMessage.textContent =
          "目前還沒有專案。下一步請跟 AI 說「部署範例專案」，"
          + "你就會看到第一個專案出現在這裡。";
        clearFilterButton.hidden = true;
      }

      setMode("empty");
      return;
    }

    if (grid.dataset.layout === "rows") {
      renderCategoryRows(items, filters);
    } else {
      for (const project of items) {
        grid.append(createCard(project));
      }
    }

    setMode("list");
    applyTruncation();

    if (grid.dataset.layout === "rows") {
      initRowScrolling();
    }
  }

  /**
   * 對所有卡片重算文字截斷。
   *
   * 必須在卡片進入頁面（setMode("list")）之後才做——截斷靠量測實際渲染高度，
   * 元素還沒佈局時 scrollHeight 是 0，量出來的結果沒有意義。
   *
   * 清單版面不截斷：那個版面存在的目的就是「想完整看到說明」
   * （見 public/gallery.css 的 list 區塊註解），截斷違背它的用途。
   * 使用者 2026-08-28 也明確要求「版面改成清單模式的時候，就可以看到完整的字」。
   */
  function applyTruncation() {
    const compact = grid.dataset.layout !== "list";

    for (const card of grid.querySelectorAll(".project-card")) {
      const pairs = [
        [card.querySelector(".project-description"), card.querySelector(".project-description-clip")],
        [card.querySelector(".project-name"), card.querySelector(".project-name-clip")],
      ];

      for (const [el, clip] of pairs) {
        if (!el || !clip) {
          continue;
        }

        if (compact) {
          truncateToFit(el, clip);
        } else {
          // 還原完整原文——切到清單版面時不能留著上一次截斷的結果。
          el.textContent = el.dataset.fullText ?? el.textContent ?? "";
        }
      }
    }
  }

  /*
   * 視窗大小改變會改變卡片寬度，能放下的字數也跟著變，所以要重算截斷。
   * 去抖動 150ms：resize 事件會連續觸發很多次，每次都做二分搜尋量測會很卡。
   */
  let resizeTimer = null;

  window.addEventListener("resize", () => {
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
    }

    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      applyTruncation();

      // rows 版面的橫排寬度會隨視窗變化，捲得到／捲不到的判斷要跟著重算
      // ——例如視窗變寬後某排原本要捲動的卡片全部放得下了，右箭頭要跟著
      // 停用，不能維持縮小視窗時算出來的舊狀態。
      if (grid.dataset.layout === "rows") {
        refreshRowArrowStates();
      }
    }, 150);
  });

  async function load() {
    setMode("loading");

    const params = new URLSearchParams();
    if (state.category) params.set("category", state.category);
    if (state.tag) params.set("tag", state.tag);

    const query = params.toString();

    try {
      const response = await fetch(`/api/gallery/projects${query ? `?${query}` : ""}`, {
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      render(payload.data ?? { items: [], filters: { categories: [], tags: [] } });
    } catch (error) {
      countLabel.textContent = "";
      errorMessage.textContent = "無法連線到伺服器，請稍後再試一次。";
      setMode("error");
    }
  }

  retryButton?.addEventListener("click", load);

  clearFilterButton?.addEventListener("click", () => {
    state.category = null;
    state.tag = null;
    load();
  });

  /** 沒有圖示時使用的預設 emoji（2026-08-27 工作計畫階段 6 裁決）。 */
  const DEFAULT_LINK_ICON = "🔗";

  /**
   * @param {Record<string, any>} link
   * @returns {DocumentFragment}
   */
  function createLinkCard(link) {
    const fragment = linkTemplate.content.cloneNode(true);

    const anchor = fragment.querySelector(".link-card-link");
    anchor.href = link.url;

    // 全部文字一律用 textContent 寫入，理由同檔頭安全規則：來自 API 的內容
    // 不可信任，innerHTML 會讓惡意內容當成 HTML 解析執行。
    fragment.querySelector(".link-card-icon").textContent = link.icon || DEFAULT_LINK_ICON;
    fragment.querySelector(".link-card-name").textContent = link.name;
    fragment.querySelector(".link-card-description").textContent = link.description ?? "";

    const category = fragment.querySelector(".link-card-category");
    if (link.category) {
      category.textContent = link.category.name;
      category.hidden = false;
    }

    return fragment;
  }

  /**
   * 推薦連結沒有篩選功能，只在頁面載入時抓一次，不隨專案篩選重新整理。
   *
   * 一個連結都沒有時整個區塊隱藏——不要顯示一個空的「推薦連結」標題
   * （2026-08-27 工作計畫階段 6 明確要求；隱藏方式見 index.html 對
   * #links-section 的註解，避免 tools/pitfalls.mjs 的 hidden-overridden-by-class）。
   * 連結是輔助內容，載入失敗時保持隱藏即可，不需要像專案清單那樣顯示
   * 完整的錯誤狀態並提供重試按鈕，避免主要內容（專案）之外還有第二組
   * 醒目的錯誤訊息搶注意力。
   */
  async function loadLinks() {
    if (!linksSection || !linksGrid || !linkTemplate) {
      return;
    }

    try {
      const response = await fetch("/api/gallery/links", {
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      const items = Array.isArray(payload.data?.items) ? payload.data.items : [];

      if (items.length === 0) {
        linksSection.hidden = true;
        return;
      }

      linksGrid.textContent = "";

      for (const link of items) {
        linksGrid.append(createLinkCard(link));
      }

      linksSection.hidden = false;
    } catch {
      linksSection.hidden = true;
    }
  }

  load();
  loadLinks();
})();
