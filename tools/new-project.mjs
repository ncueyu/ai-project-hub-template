/**
 * `hub new <資料夾>`：把一個資料夾初始化成可以部署的專案。
 *
 * ## 這個指令解決什麼
 *
 * 老師做出來的東西很可能就是**一個 `index.html`**，但 `hub ship` 需要：
 * 資料夾 ＋ `public/` 子目錄 ＋ `wrangler.jsonc` ＋ `project-hub.json`。
 * 在這支之前沒有任何工具做這個轉換，只能靠 AI 每次臨場手寫——而手寫就會不一致。
 *
 * ## 為什麼叫 `new` 而不是 `init`
 *
 * `hub init` 已經存在，而且做的是完全不同的事：初始化**展示中心自己**，
 * 會建立 D1 資料庫並部署到 Cloudflare。2026-08-29 查證發現它原本
 * **完全不讀位置參數**，所以 `hub init 某資料夾` 會靜默丟掉那個路徑、
 * 直接跑展示中心的初始化。用不同的名字，打錯的代價才只是「指令不存在」
 * 而不是意外部署。（那個靜默忽略也已一併修掉，見 `bin/hub.mjs` 的
 * `rejectUnexpectedPositional()`。）
 *
 * ## 結構基準
 *
 * 產出的形狀直接對齊 `templates/範例專案-連連看/`——那份已經實測
 * `hub detect` 判為 static、`hub check` 無阻擋級問題。不重新發明目錄形狀。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { stripJsonComments } from "./config.mjs";

/** 網站檔案要搬進去的子目錄。 */
export const ASSETS_DIRECTORY = "public";

/**
 * 不搬進 `public/` 的東西：它們是中介資料或工具產物，不是網站內容。
 *
 * 這份清單直接對應既有慣例——`wrangler.jsonc` 的 assets 目錄【嚴禁】指向專案
 * 根目錄，因為 wrangler 會把 `.wrangler/tmp/` 暫存檔一起算進資產並上傳，
 * 而 `.assetsignore` 放在根目錄不會生效（2026-08-16 在其他專案實測）。
 * 縮圖也留在根目錄：它是給展示中心用的中介資料，不是那個網站的內容，
 * `hub ship` 部署時會自動裁切轉檔搬走。
 */
const KEEP_AT_ROOT = Object.freeze([
  ".git",
  ".gitignore",
  ".wrangler",
  "node_modules",
  "project-hub.json",
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "README.md",
]);

/** 縮圖檔名（留在根目錄，不搬）。 */
const THUMBNAIL_NAMES = Object.freeze(["thumbnail.png", "thumbnail.jpg", "thumbnail.jpeg", "thumbnail.webp"]);

/**
 * slug 的格式規則。與 `src/validation.js` 的 `SLUG_PATTERN` 一致——
 * 這裡再寫一次是因為 tools/ 不 import src/ 的驗證模組（那是 Worker 端程式碼），
 * 但兩邊必須同步：slug 會變成永久網址的一部分，不合格會在登錄時才被擋下。
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 從資料夾名生出一個 slug 建議。
 *
 * **刻意不做音譯**：老師的資料夾名幾乎必然是中文（「我的班網」），
 * 音譯的結果不穩定又難看，而 slug 會變成永久網址的一部分。
 * 中文字元一律丟掉；丟完是空的就回 null，由呼叫端要求使用者自己輸入。
 *
 * @param {string} folderName
 * @returns {string | null}
 */
export function suggestSlug(folderName) {
  const ascii = folderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return ascii !== "" && SLUG_PATTERN.test(ascii) ? ascii : null;
}

/**
 * 盤點資料夾，決定要搬什麼。
 *
 * @param {string} dir
 * @returns {{ hasAssetsDir: boolean, toMove: string[], htmlFiles: string[] }}
 */
export function planMove(dir) {
  const entries = readdirSync(dir);
  const hasAssetsDir = entries.includes(ASSETS_DIRECTORY) && statSync(join(dir, ASSETS_DIRECTORY)).isDirectory();

  const htmlFiles = entries.filter((name) => /\.html?$/i.test(name));

  const toMove = hasAssetsDir
    ? []
    : entries.filter((name) => !KEEP_AT_ROOT.includes(name) && !THUMBNAIL_NAMES.includes(name.toLowerCase()));

  return { hasAssetsDir, toMove, htmlFiles };
}

/**
 * 產生 `wrangler.jsonc`。
 *
 * **沒有 `main`**：這是 static-only Worker，沒有伺服器端程式碼。加上 `main`
 * 會讓 `hub detect` 判成 worker 型專案，而 `hub ship` 只處理純靜態。
 *
 * @param {string} slug
 * @param {string} compatibilityDate
 */
export function renderWranglerConfig(slug, compatibilityDate) {
  return `{
\t// 靜態網站專用設定：沒有 "main"，只有 assets。
\t// Cloudflare 稱這種形態為「static-only Worker」——沒有伺服器端程式碼，
\t// 純粹把檔案送出去，所以不需要 D1、R2 或任何 binding。
\t//
\t// Worker 名稱＝project-hub.json 的 slug，兩邊刻意一致：
\t// 網址會是 https://<slug>.<帳號子網域>.workers.dev。
\t"name": "${slug}",
\t"compatibility_date": "${compatibilityDate}",

\t// ⚠️ assets 目錄【嚴禁】指向專案根目錄（"./"）：wrangler 會把自己產生的
\t// .wrangler/tmp/ 暫存檔一起算進資產並上傳，而 .assetsignore 放在根目錄
\t// 不會生效。網站檔案一律放進 ${ASSETS_DIRECTORY}/，設定檔與縮圖留在根目錄。
\t"assets": {
\t\t"directory": "./${ASSETS_DIRECTORY}/"
\t}
}
`;
}

/**
 * 產生 `project-hub.json`。
 *
 * `visibility` 寫 `private` 而不是 `public`：`tools/register.mjs` 的
 * `decideRegisteredVisibility()` 對新專案**一律回 private 並忽略這個檔寫的值**，
 * 寫 public 會是誤導。想公開要到管理後台改。
 *
 * @param {string} name
 * @param {string} slug
 */
export function renderManifest(name, slug) {
  return `${JSON.stringify(
    {
      name,
      slug,
      visibility: "private",
      platform: "cloudflare",
      project_type: "static",
      database_type: "none",
    },
    null,
    2,
  )}\n`;
}

/**
 * 把一個資料夾初始化成可部署的專案。
 *
 * @param {{
 *   dir: string,
 *   confirm: (message: string) => Promise<boolean>,
 *   prompt: (question: string) => Promise<string>,
 *   compatibilityDate?: string,
 * }} options
 * @returns {Promise<{ ok: boolean, steps: { step: string, status: string, detail: string }[] }>}
 */
export async function newProject(options) {
  const { dir, confirm, prompt } = options;
  const compatibilityDate = options.compatibilityDate ?? "2026-08-08";

  /** @type {{ step: string, status: string, detail: string }[]} */
  const steps = [];
  const stop = (step, detail) => {
    steps.push({ step, status: "stopped", detail });
    return { ok: false, steps };
  };
  const ok = (step, detail) => steps.push({ step, status: "ok", detail });

  // ── 檢查資料夾 ──────────────────────────────────────────────
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return stop("check-folder", `找不到資料夾：${dir}`);
  }

  /*
   * 擋掉「拿展示中心自己來跑」。展示中心是 Worker 型專案（wrangler.jsonc 有
   * main），把它當成待部署的靜態專案初始化會破壞它的設定。
   */
  const existingWrangler = join(dir, "wrangler.jsonc");
  if (existsSync(existingWrangler)) {
    /*
     * 比對前先去掉註解——`tools/inject-gate.mjs` 也是這樣做的。
     * 直接比對原文會被註解裡提到的 "main" 騙到；本工具自己產生的設定檔
     * 註解就寫著「沒有 "main"，只有 assets」，正是會誤判的形狀。
     */
    const text = stripJsonComments(String(readFileSyncSafe(existingWrangler)));
    if (/"main"\s*:/.test(text)) {
      return stop(
        "check-folder",
        "這個資料夾的 wrangler.jsonc 有 main 欄位，是 Worker 型專案（展示中心自己就是這一種）。\n"
          + "hub new 只處理純靜態專案，不會動它。",
      );
    }
  }

  const plan = planMove(dir);

  if (plan.htmlFiles.length === 0 && !plan.hasAssetsDir) {
    /*
     * 刻意停下而不是建一個空白頁：使用者要部署的是他自己做的東西，
     * 我們猜不出他的網站入口在哪。硬建一個 index.html 只會讓他部署出一個
     * 不是他做的網頁，而且他不會知道那是哪來的。
     */
    return stop(
      "scan",
      `${dir} 裡找不到任何 .html 檔案，也沒有 ${ASSETS_DIRECTORY}/ 目錄。\n`
        + "請先把你的網頁檔案放進這個資料夾（至少要有一個 index.html），再執行一次。",
    );
  }

  // ── 搬移前先取得同意 ────────────────────────────────────────
  if (plan.hasAssetsDir) {
    ok("move", `已經有 ${ASSETS_DIRECTORY}/ 目錄，保留原樣不搬動。`);
  } else if (plan.toMove.length === 0) {
    ok("move", "沒有需要搬動的檔案。");
  } else {
    const list = plan.toMove.map((name) => `  · ${name}`).join("\n");
    const agreed = await confirm(
      `要把這些項目搬進 ${ASSETS_DIRECTORY}/：\n${list}\n\n`
        + `（設定檔與縮圖會留在根目錄——Cloudflare 只上傳 ${ASSETS_DIRECTORY}/ 裡的東西，\n`
        + "  設定檔留在外面才不會被當成網站內容公開出去。）\n"
        + "要繼續嗎？",
    );

    if (!agreed) {
      return stop("move", "你取消了搬移，沒有動任何檔案。");
    }

    mkdirSync(join(dir, ASSETS_DIRECTORY), { recursive: true });

    for (const name of plan.toMove) {
      renameSync(join(dir, name), join(dir, ASSETS_DIRECTORY, name));
    }

    ok("move", `已把 ${plan.toMove.length} 個項目搬進 ${ASSETS_DIRECTORY}/。`);
  }

  // ── 問答：專案名稱與 slug ───────────────────────────────────
  const folderName = basename(dir);
  const name = (await prompt(`專案名稱（顯示在展示中心上，中文可，直接按 Enter 用「${folderName}」）：`)).trim()
    || folderName;

  const suggested = suggestSlug(folderName);

  /*
   * slug 一律由使用者確認，**刻意不自動修正**：這個值會變成永久網址的一部分
   * （https://<slug>.<帳號子網域>.workers.dev），替使用者亂改比讓他重打更糟。
   *
   * 次數上限而不是無限重問：非互動情境（測試、--yes、被腳本呼叫）下 prompt
   * 可能一直回同一個值，無限迴圈會讓整支程式掛住而沒有任何訊息。
   */
  const MAX_SLUG_ATTEMPTS = 5;
  let slug = "";
  let hint = "";

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !SLUG_PATTERN.test(slug); attempt += 1) {
    const base = suggested
      ? `網址代稱（只能用小寫英文、數字、連字號，直接按 Enter 用「${suggested}」）：`
      : "網址代稱（只能用小寫英文、數字、連字號，例如 my-class-site）：";

    slug = (await prompt(hint + base)).trim() || suggested || "";
    hint = SLUG_PATTERN.test(slug) ? "" : `「${slug}」不合格式。\n`;
  }

  if (!SLUG_PATTERN.test(slug)) {
    return stop(
      "slug",
      `試了 ${MAX_SLUG_ATTEMPTS} 次都沒有取得合格的網址代稱，先停下來。\n`
        + "格式規則：只能用小寫英文字母、數字與連字號，例如 my-class-site。\n"
        + "已經搬好的檔案不會退回去——重新執行一次即可，它會偵測到 public/ 並跳過搬移。",
    );
  }

  // ── 產生設定檔（既存不覆寫）─────────────────────────────────
  writeIfAbsent(join(dir, "wrangler.jsonc"), renderWranglerConfig(slug, compatibilityDate), "wrangler.jsonc", steps);
  writeIfAbsent(join(dir, "project-hub.json"), renderManifest(name, slug), "project-hub.json", steps);

  // ── 縮圖提醒 ────────────────────────────────────────────────
  const hasThumbnail = readdirSync(dir).some((entry) => THUMBNAIL_NAMES.includes(entry.toLowerCase()));

  ok(
    "thumbnail",
    hasThumbnail
      ? "已找到縮圖，部署時會自動裁切搬進展示中心。"
      : "還沒有縮圖。把一張截圖存成 thumbnail.png 放在這個資料夾的根目錄即可——\n"
        + "  注意：放進去還不夠，要實際部署一次才會出現在展示中心。",
  );

  ok(
    "next-steps",
    `準備好了。接下來跟 AI 說「部署 ${folderName}」，或執行：\n`
      + `  node bin/hub.mjs ship ${dir}\n\n`
      + "部署完成後它預設是「私人」狀態，展示中心還看不到——到管理後台改成「公開」才會出現。\n"
      + "想只給班上看的話，改成「密碼」（這個選項的完整支援還在做，目前先用公開或私人）。",
  );

  return { ok: true, steps };
}

/** 讀檔但不因為讀不到而拋例外——呼叫端只想知道內容長什麼樣。 */
function readFileSyncSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * 只在檔案不存在時寫入。
 *
 * **絕不覆寫**：使用者可能已經自己調過設定，或這是第二次執行。
 * 覆寫會靜默毀掉他的設定，而他不會知道發生了什麼。
 */
function writeIfAbsent(path, content, label, steps) {
  if (existsSync(path)) {
    steps.push({ step: label, status: "skipped", detail: `${label} 已經存在，保留原有內容不覆寫。` });
    return;
  }

  writeFileSync(path, content, "utf8");
  steps.push({ step: label, status: "ok", detail: `已建立 ${label}。` });
}
