// @ts-check

/**
 * 網域鎖：讓「整包複製回去、打開 index.html」跑不起來（2026-08-30）。
 *
 * ## 這個功能擋得住什麼、擋不住什麼
 *
 * **擋得住**：學生按右鍵看原始碼、把整個資料夾複製回去、雙擊 `index.html`
 * 打開——那時候網址是 `file://`，注入的檢查會攔下來。這正是使用者要防的
 * 「直覺操作」。
 *
 * **擋不住**：看得懂這段程式碼、把它刪掉的人。也擋不住把檔案放到自己的
 * 伺服器上、而且剛好把網站名稱取成一樣的人。
 *
 * **這是嚇阻，不是保護。** 使用者 2026-08-30 明確接受這個界線
 * （「真的高手是防不住的」）。真正要保護的東西（例如測驗答案）唯一有效的
 * 做法是不要送到瀏覽器——見 `專案適用範圍與提示詞.md`。
 *
 * ## 為什麼放行 localhost
 *
 * 作者自己要能在本機測試（`wrangler dev` 會是 `localhost:8787`）。
 * 擋掉 localhost 只會讓作者每次開發都撞到自己設的鎖，而複製的人只要
 * 起一個本機伺服器就繞過——代價全部由作者承擔，效果幾乎是零。
 *
 * ## 為什麼不用 innerHTML
 *
 * `AGENTS.md` 第 8 節：網頁的文字內容一律用 `textContent`。這裡注入的
 * 腳本自己也遵守，不然就是一邊寫規則一邊違反它。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectProject } from "./detect.mjs";

/** 注入區塊的起訖標記。用它做冪等與移除，不靠比對整段內容。 */
export const LOCK_START = "<!-- hub:domain-lock:start 由 hub lock 注入，可用 hub lock --remove 移除 -->";
export const LOCK_END = "<!-- hub:domain-lock:end -->";

/**
 * 產生要注入的腳本。
 *
 * 刻意寫成看得懂的樣子，不做混淆：混淆擋不住真的想拆的人，卻會讓作者
 * 自己日後看不懂這段是什麼、為什麼在這裡。
 *
 * @param {string} slug 專案代稱，線上網址的第一段
 * @returns {string}
 */
export function renderLockScript(slug) {
  /*
   * 代稱的形狀在這裡再擋一次，而不是想辦法跳脫它。
   *
   * `JSON.stringify` 不會處理 `<`，所以代稱裡若出現 script 結束標籤會提前
   * 結束整個 script 區塊。實務上 slug 早就被 SLUG_PATTERN（只允許小寫英數與
   * 連字號）擋住了，但這個函式是公開匯出的，不能假設呼叫端一定驗過。
   *
   * 選擇「拒絕」而不是「跳脫」：跳脫寫錯了會靜默產生一份壞掉的 HTML，
   * 那種錯誤要等到有人打開網頁才會發現；丟例外則是當場就知道。
   */
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) {
    throw new Error(
      `代稱「${slug}」不合格式，無法產生網域鎖。`
        + "只能使用小寫英文字母、數字與單一連字號（與 project-hub.json 的 slug 規則相同）。",
    );
  }

  const literal = JSON.stringify(`${slug}.`);

  return `${LOCK_START}
<script>
(function () {
  /*
   * 只在這個網站自己的網址下執行。
   *
   * 放行：<slug>.*（線上）、localhost 與 127.0.0.1（本機開發）。
   * 攔下：file://（把資料夾複製回去、雙擊 index.html 就是這個情況）
   *       以及其他網域。
   */
  var host = location.hostname;
  var isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
  var isOwn = host.indexOf(${literal}) === 0;

  if (location.protocol !== "file:" && (isLocal || isOwn)) {
    return;
  }

  document.addEventListener("DOMContentLoaded", function () {
    var body = document.body;
    while (body.firstChild) { body.removeChild(body.firstChild); }

    var box = document.createElement("div");
    box.style.cssText = "max-width:34rem;margin:18vh auto;padding:0 1.5rem;"
      + "font-family:system-ui,sans-serif;line-height:1.8;color:#334155;text-align:center";

    var title = document.createElement("h1");
    title.style.cssText = "font-size:1.4rem;margin:0 0 1rem;color:#0f172a";
    title.textContent = "請從原本的網址開啟這個頁面";

    var note = document.createElement("p");
    note.style.cssText = "margin:0";
    note.textContent = "這個網頁需要從它自己的網址載入才能運作。"
      + "如果你是從複製下來的檔案打開的，請改用原本的連結。";

    box.appendChild(title);
    box.appendChild(note);
    body.appendChild(box);
  });
})();
</script>
${LOCK_END}`;
}

/**
 * 找出這個專案實際會被上傳的目錄。
 *
 * 與 `hub ship` 用同一套判斷（`detectProject` 讀 wrangler 設定的 assets 目錄），
 * 免得鎖注入到一個根本不會被部署的地方——那種失敗完全沒有徵兆：
 * 指令回報成功，線上卻沒有那段腳本。
 *
 * @param {string} dir
 * @returns {string}
 */
export function resolveAssetsDir(dir) {
  const detection = detectProject(dir);

  if (detection.wranglerAssets) {
    const candidate = join(dir, detection.wranglerAssets);

    try {
      if (statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      /* 設定檔寫了但目錄不存在，往下走備援 */
    }
  }

  const publicDir = join(dir, "public");

  try {
    if (statSync(publicDir).isDirectory()) {
      return publicDir;
    }
  } catch {
    /* 沒有 public/，用專案根目錄 */
  }

  return dir;
}

/**
 * 列出要處理的 HTML 檔（遞迴）。
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function findHtmlFiles(dir) {
  /** @type {string[]} */
  const found = [];

  /** @param {string} current */
  function walk(current) {
    let entries;

    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);

      if (entry.isDirectory()) {
        // node_modules 與工具產物不是網站內容，不進去。
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".wrangler") {
          continue;
        }

        walk(full);
        continue;
      }

      if (/\.html?$/i.test(entry.name)) {
        found.push(full);
      }
    }
  }

  walk(dir);

  return found.sort();
}

/**
 * 把鎖加進一份 HTML。已經有了就原樣回傳（冪等）。
 *
 * 插在 `</head>` 之前；沒有 `</head>` 就插在最前面。**不用正規表示式改寫
 * 整份文件**——那很容易在有巢狀註解或 `</head>` 出現在字串裡時出錯。
 *
 * @param {string} html
 * @param {string} slug
 * @returns {{ html: string, changed: boolean }}
 */
export function applyLockToHtml(html, slug) {
  if (html.includes(LOCK_START)) {
    return { html, changed: false };
  }

  const block = `${renderLockScript(slug)}\n`;
  const headClose = html.toLowerCase().indexOf("</head>");

  if (headClose === -1) {
    return { html: `${block}${html}`, changed: true };
  }

  return {
    html: `${html.slice(0, headClose)}${block}${html.slice(headClose)}`,
    changed: true,
  };
}

/**
 * 把鎖從一份 HTML 移除。
 *
 * @param {string} html
 * @returns {{ html: string, changed: boolean }}
 */
export function removeLockFromHtml(html) {
  const start = html.indexOf(LOCK_START);

  if (start === -1) {
    return { html, changed: false };
  }

  const end = html.indexOf(LOCK_END, start);

  if (end === -1) {
    // 只有起始標記代表檔案被手動改壞了。不猜要刪到哪裡——刪錯會毀掉使用者的網頁。
    throw new Error(
      "找到鎖的起始標記，但找不到結束標記；這份 HTML 可能被手動改過。\n"
        + "請自行檢查並刪除 hub:domain-lock 那一段，避免自動移除刪錯範圍。",
    );
  }

  const after = end + LOCK_END.length;
  const trimmed = html.slice(after).startsWith("\n") ? after + 1 : after;

  return { html: html.slice(0, start) + html.slice(trimmed), changed: true };
}

/**
 * 對整個專案加上或移除網域鎖。
 *
 * @param {{ dir: string, slug: string, remove?: boolean }} options
 * @returns {{ assetsDir: string, files: { path: string, changed: boolean }[] }}
 */
export function applyDomainLock(options) {
  const assetsDir = resolveAssetsDir(options.dir);
  const files = [];

  for (const path of findHtmlFiles(assetsDir)) {
    const before = readFileSync(path, "utf8");
    const result = options.remove === true
      ? removeLockFromHtml(before)
      : applyLockToHtml(before, options.slug);

    if (result.changed) {
      writeFileSync(path, result.html, "utf8");
    }

    files.push({ path, changed: result.changed });
  }

  return { assetsDir, files };
}
