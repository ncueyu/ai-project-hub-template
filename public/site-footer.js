// @ts-check

/**
 * 全站共用頁尾，以及站名的執行期套用。
 *
 * 每一頁只需要放一個空的 <footer data-site-footer> 容器，內容由這裡填入，
 * 這樣版權宣告與更新時間只需要維護一份。
 *
 * 更新時間來自 /build-info.json，那是**部署當下**寫入的時間。
 * 刻意不使用 new Date()——那會取到訪客電腦的時鐘，每個人看到的都不一樣，
 * 而且與網站實際更新時間無關。
 *
 * 2026-08-28 新增站名套用：本專案要抽成範本給其他老師使用，站名不能寫死
 * 成作者的名字。`public/` 沒有建置步驟、同時是原始碼與部署產物，所以站名
 * 不能在部署時改寫 HTML（會持續污染 git status），改為 HTML 一律寫中性
 * 預設值，執行期由這裡 fetch `/api/site` 套用管理者設定的站名——這個檔案
 * 已經被全部頁面載入，是天然的單一注入點（見
 * 2026-08-27-工作計畫-站名與hub-init.md 第三節 Part A）。
 *
 * 2026-08-28 再新增品牌圖示（`.brand-mark`）套用，理由相同：後台可更換的
 * logo 不能靠部署時改寫 HTML，一樣由這裡 fetch 到值後即時套用（見
 * 2026-08-28-工作計畫-主畫面改造.md Part A）。
 */

(() => {
  // 中性預設值，必須與 `src/repositories/settings.js` 的 `DEFAULT_SITE_NAME`
  // 保持一致——這裡沒有建置步驟可以共用同一份常數，兩邊各自維護。
  const DEFAULT_SITE_NAME = "專案展示中心";

  // 四個合法 logo 代號與預設值，必須與 `src/repositories/settings.js` 的
  // `SITE_LOGOS`／`DEFAULT_SITE_LOGO` 保持一致，理由同上。
  const SITE_LOGOS = ["logo-01", "logo-02", "logo-03", "logo-04"];
  const DEFAULT_SITE_LOGO = "logo-01";

  const AUTHOR = "";
  const startYear = 2026;

  /** 目前套用中的站名，預設中性值；`/api/site` 回來後由 applySiteName() 更新。 */
  let siteName = DEFAULT_SITE_NAME;

  const footerContainer = document.querySelector("[data-site-footer]");

  /**
   * 以台北時間顯示，讓所有訪客看到的是同一個時間點。
   *
   * @param {string} iso
   * @returns {string}
   */
  function formatDeployedAt(iso) {
    const parsed = new Date(iso);

    if (Number.isNaN(parsed.getTime())) {
      return "";
    }

    const formatted = new Intl.DateTimeFormat("zh-TW", {
      timeZone: "Asia/Taipei",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(parsed);

    return `${formatted}（台北時間）`;
  }

  /**
   * 把站名套用到頁面上會顯示站名的地方。
   *
   * 選擇器刻意保守、找不到就跳過——首頁、後台、教材頁的品牌區塊 DOM
   * 結構略有差異，不能假設每頁都有同一組元素，否則其中一頁缺了什麼就會
   * 讓整個頁尾（含這支腳本後面的其他邏輯）壞掉。
   *
   * @param {string} name
   */
  /**
   * 自動配寬的下限與上限（px）。
   *
   * 上限 34：短的拉丁站名（例如「yucs」）要 34px 才跟 17px 的主標等寬，再大就
   * 沒有意義了。下限 13：很長的站名要「等寬」得縮到 5px 以下才行——那已經看不見了。
   * **可讀性優先於幾何上的完全等寬**：超過下限就停止縮小，寧可比主標寬一點。
   *
   * 實測落點：「yucs」→ 34px（與主標等寬，差 0px）；空殼預設的「專案展示中心」
   * → 約 13px（寬度接近主標）；十字以上的長站名 → 停在 13px，會比主標寬，
   * 但仍然清楚可讀。
   */
  const SITE_NAME_MIN_PX = 13;
  const SITE_NAME_MAX_PX = 34;

  /**
   * 把站名的字級調到「與上一行的主標（brand-name）等寬」。
   *
   * 為什麼需要動態計算，不能寫死一個 CSS 字級（2026-08-28 使用者要求
   * 「讓『展示中心』與站名盡量一樣寬，讓畫面比較協調」）：
   *
   * 站名是變數，而**拉丁字母與中文字的字身寬度差距很大**。實測同一支字型下，
   * 「yucs」要 34px 才跟 17px 的「展示中心」等寬（都是 71px）；但空殼的預設
   * 站名「專案展示中心」有 6 個中文字，34px 下會超過 200px，直接把標頭撐爛。
   * 也就是說**任何寫死的字級都只能服務一種長度的站名**。
   *
   * 做法：文字寬度與字級成正比，所以只要量一次就能換算——量出目前字級下的
   * 實際文字寬度，再依「主標寬度 ÷ 站名寬度」的比例縮放，最後夾在上下限之間。
   * 用 Range 量文字本身的寬度而不是元素的 offsetWidth，因為元素可能是 block、
   * 寬度等於容器而不等於文字。
   *
   * 任何一步拿不到有效數值就直接放棄、保留 CSS 的預設字級——這個函式只是
   * 視覺微調，不該有機會讓站名顯示不出來。
   *
   * @param {Element} subtitleEl
   */
  function fitSiteNameWidth(subtitleEl) {
    try {
      const brand = subtitleEl.closest(".brand");
      const nameEl = brand?.querySelector(".brand-name");

      if (!nameEl) {
        return;
      }

      /** @param {Element} el */
      const textWidth = (el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().width;
      };

      // 先清掉上一次算出的字級，才能在目前的 CSS 基準值上重新量測
      // （否則反覆呼叫會以自己算出的值當基準，一路漂移）。
      subtitleEl.style.fontSize = "";

      const target = textWidth(nameEl);
      const current = textWidth(subtitleEl);
      const baseSize = Number.parseFloat(getComputedStyle(subtitleEl).fontSize);

      if (!(target > 0) || !(current > 0) || !(baseSize > 0)) {
        return;
      }

      const scaled = baseSize * (target / current);
      const clamped = Math.min(SITE_NAME_MAX_PX, Math.max(SITE_NAME_MIN_PX, scaled));

      subtitleEl.style.fontSize = `${clamped.toFixed(1)}px`;
    } catch {
      // 量測失敗就維持 CSS 預設字級，不讓視覺微調影響站名本身的顯示。
    }
  }

  function applySiteName(name) {
    siteName = name;

    // brand-subtitle：全站每個品牌區塊都用這個 class（見各頁 <header>），
    // 直接套用即可，不需要額外標記。
    document.querySelectorAll(".brand-subtitle").forEach((el) => {
      el.textContent = siteName;
      fitSiteNameWidth(el);
    });

    // aria-label：只有首頁與後台的品牌連結需要換（其餘頁面的 aria-label
    // 本來就是中性描述，不含站名，不動它們），用 data 屬性明確標出。
    document.querySelectorAll("[data-site-aria-suffix]").forEach((el) => {
      const suffix = el.getAttribute("data-site-aria-suffix") ?? "";
      el.setAttribute("aria-label", suffix ? `${siteName} ${suffix}` : siteName);
    });

    // document.title：只有首頁與後台的標題含站名，同樣用 data 屬性標出
    // 「站名之前固定不變的那段」，不靠猜測字串結構去解析既有 title。
    const titlePrefix = document.body?.dataset?.siteTitlePrefix;

    if (titlePrefix) {
      document.title = `${titlePrefix}｜${siteName}`;
    }

    // 頁尾版權文字若已經渲染過（build-info 的 fetch 比這裡先完成），
    // 補一次更新，避免兩個並行 fetch 的完成順序不同造成頁尾顯示舊站名。
    const copyrightEl = footerContainer?.querySelector(".footer-copyright");

    if (copyrightEl) {
      copyrightEl.textContent = `© ${startYear} ${siteName}．保留一切權利`;
    }
  }

  /**
   * 把品牌圖示（`.brand-mark`）換成管理者在後台選的 logo，並讓它的寬高
   * 等於右邊「展示中心」＋站名兩行文字的合計高度（2026-08-28 新增，見
   * 2026-08-28-工作計畫-主畫面改造.md Part A3）。
   *
   * **呼叫時機刻意排在 `applySiteName()` 之後**：站名字級是動態算出來的
   * （見 `fitSiteNameWidth`），量測文字高度必須在字級調整完成、版面穩定
   * 之後才準確，先呼叫這個函式會量到舊字級下的高度。
   *
   * 高度來源是 `.brand-mark` 的下一個手足元素——全站每個品牌區塊的 DOM
   * 結構固定是「圖示 span、緊接著一個包住 brand-name／brand-subtitle 的
   * span」（見 `public/index.html` 等各頁 `<header>`），不需要額外標記。
   *
   * 任何一步拿不到有效值（找不到手足元素、量到 0 或負值）就只換圖片、
   * 不覆寫容器尺寸，保留 CSS 的預設 44×44px——原則與 `fitSiteNameWidth`
   * 相同：這個函式是視覺微調，不該讓品牌區塊因為量測失敗而消失或跑版。
   *
   * @param {string} logoId
   */
  function applySiteLogo(logoId) {
    const safeLogoId = SITE_LOGOS.includes(logoId) ? logoId : DEFAULT_SITE_LOGO;

    document.querySelectorAll(".brand-mark").forEach((mark) => {
      try {
        const img = document.createElement("img");
        img.src = `/logos/${safeLogoId}.png`;
        img.alt = ""; // 裝飾用圖示：.brand-mark 本身已有 aria-hidden，不需要重複語意。

        mark.textContent = "";
        mark.append(img);

        const textBox = mark.nextElementSibling;
        const height = textBox instanceof HTMLElement ? textBox.getBoundingClientRect().height : 0;

        if (height > 0) {
          mark.style.width = `${height}px`;
          mark.style.height = `${height}px`;
        }
      } catch {
        // 量測或 DOM 操作失敗就跳過這一個 .brand-mark，不讓單一品牌區塊的
        // 錯誤影響同一頁其他邏輯，也不影響其他頁面各自的 .brand-mark。
      }
    });
  }

  function renderFooter(deployedAt, environment) {
    if (!footerContainer) {
      return;
    }

    footerContainer.textContent = "";
    footerContainer.classList.add("site-footer", "shell");


    const info = document.createElement("div");
    info.className = "footer-info";

    const copyright = document.createElement("p");
    copyright.className = "footer-copyright";
    copyright.textContent = `© ${startYear} ${siteName}．保留一切權利`;

    info.append(copyright);

    /*
     * 空殼預設不顯示內容製作者：這個網站的內容是你做的。
     * 想顯示的話，把上面的 AUTHOR 改成你的名字就會出現。
     */
    if (AUTHOR !== "") {
      const author = document.createElement("p");
      author.className = "footer-author";
      author.textContent = `內容製作者：${AUTHOR}`;
      info.append(author);
    }

    const meta = document.createElement("div");
    meta.className = "footer-meta";

    const updated = document.createElement("p");
    updated.className = "footer-updated";

    if (deployedAt) {
      updated.textContent = `最後更新：${formatDeployedAt(deployedAt)}`;
    } else {
      updated.textContent = "最後更新：尚未取得";
    }

    meta.append(updated);

    if (environment && environment !== "production") {
      const badge = document.createElement("p");
      badge.className = "footer-environment";
      badge.textContent = "本機開發版本";
      meta.append(badge);
    }

    const links = document.createElement("nav");
    links.className = "footer-links";
    links.setAttribute("aria-label", "頁尾導覽");

    for (const [label, href] of [
      ["展示中心", "/"],
    ]) {
      const link = document.createElement("a");
      link.href = href;
      link.textContent = label;
      links.append(link);
    }

    meta.append(links);
    footerContainer.append(info, meta);
  }

  /**
   * 四套配色風格。與 `src/repositories/settings.js` 的 `SITE_THEMES` 是必要的
   * 重複清單（前端無法 import 後端模組），新增風格時兩處都要改，漏一處會出現
   * 「後台選得到但前端不認」。
   */
  const SITE_THEMES = ["zero", "one", "two", "three"];
  const DEFAULT_SITE_THEME = "zero";
  const THEME_STORAGE_KEY = "hub-site-theme";

  /**
   * 套用配色，並把結果記在 localStorage。
   *
   * 記住的值是給下一次載入時的 <head> 同步腳本用的：後台是靜態頁，
   * 主題要等這支腳本 fetch 回來才知道，中間會先閃一下預設色。記住上次的值
   * 就能在 CSS 生效前先掛上 data-theme，把那個閃爍消掉。
   *
   * zero 是「沒有覆寫」，所以直接移除屬性而不是寫 data-theme="zero"——
   * CSS 那邊刻意沒有 [data-theme="zero"] 區塊。
   *
   * @param {unknown} theme
   */
  function applySiteTheme(theme) {
    const value = typeof theme === "string" && SITE_THEMES.includes(theme) ? theme : DEFAULT_SITE_THEME;

    if (value === DEFAULT_SITE_THEME) {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", value);
    }

    // localStorage 在無痕視窗或封鎖網站資料時會直接拋錯，不能讓它擋住套用。
    try {
      localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
      /* 記不住就算了，下次載入頂多閃一下 */
    }
  }

  // 與 build-info 的 fetch 並行發出，不互相等待——兩者互不依賴，串行只會
  // 平白拉長頁面套用站名與頁尾內容的時間。
  fetch("/api/site", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((body) => {
      // 回應包在 `{ data: { site_name, site_logo } }` 底下——與全站其他 API
      // 同一種信封格式（見 `src/http.js` 的 `jsonData()`）。
      const name = body?.data?.site_name;
      const logo = body?.data?.site_logo;

      // 失敗（網路錯誤、非 200、回應格式不對、空字串／非法代號）一律安全
      // 退回中性預設值，不可以顯示 undefined 或讓頁尾套用邏輯拋錯。
      applySiteName(typeof name === "string" && name.trim() ? name : DEFAULT_SITE_NAME);
      // 呼叫順序刻意在 applySiteName() 之後——見 applySiteLogo() 的說明。
      applySiteLogo(typeof logo === "string" ? logo : DEFAULT_SITE_LOGO);
      applySiteTheme(body?.data?.site_theme);
    })
    .catch(() => {
      applySiteName(DEFAULT_SITE_NAME);
      applySiteLogo(DEFAULT_SITE_LOGO);
      // 主題刻意不退回預設值：<head> 的同步腳本已經套上了上次記住的值，
      // 這裡再蓋成 zero 反而會在網路不穩時讓畫面閃一下又變回去。
    });

  fetch("/build-info.json", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .then((info) => renderFooter(info?.deployedAt ?? "", info?.environment ?? ""))
    .catch(() => renderFooter("", ""));
})();
