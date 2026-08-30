// @ts-check

/**
 * `hub link`——把一個**已經在別的地方上線**的網站登錄進展示中心
 * （2026-08-30，縮圖與外部連結專案計畫階段 5）。
 *
 * ## 這個指令解決的問題
 *
 * 老師手上常常已經有做好的網頁（Google Sites、別人幫他架的、以前用別的服務
 * 放上去的）。那些網站**不需要也不應該被重新部署**——我們沒有它的原始碼，
 * 動它只會壞事。使用者要的只有兩件事：讓它出現在展示中心，並且有張預覽圖。
 *
 * ## 為什麼走 wrangler 而不是後台 API
 *
 * 與 `tools/register.mjs`、`tools/thumbnail-store.mjs` 同一個理由：
 * 管理 API 要後台密碼，而 `AGENTS.md` 第 6 節規定密碼不經過 AI。
 * 走 `wrangler` 用的是使用者電腦上已經有的 Cloudflare 憑證，
 * **全程沒有任何地方需要輸入密碼**——這是「請 AI 幫我把這個網站加進去」
 * 能成立的前提。
 *
 * ## 為什麼不限定文字檔的檔名
 *
 * 與 `tools/thumbnail.mjs` 檔頭「為什麼不限定檔名」是同一個教訓。使用者在
 * 檔案總管按右鍵新增文字檔，得到的是「新增 文字文件.txt」；他也可能存成
 * 「連結.txt」「網址.txt」或直接叫「我的班網.txt」。要求記住特定檔名，
 * 違背了「使用者只要把東西放進去，其他都給你處理」。
 *
 * 因此改成：讀資料夾根目錄的任何 .txt／.md，取出第一個 http(s) 網址。
 * 計畫書點名的三個檔名仍然優先（使用者刻意命名就尊重他的意圖）。
 */

import { basename } from "node:path";

import { detectLinkFolder, findLinkFile } from "./link-detect.mjs";
import { SLUG_PATTERN, suggestSlug } from "./new-project.mjs";
import { getProject } from "./queries.mjs";
import { registerDeployment } from "./register.mjs";
import { findThumbnailSource } from "./thumbnail.mjs";
import { storeThumbnailFromFile } from "./thumbnail-store.mjs";

/** 抓下來的網頁最多讀這麼多位元組。標題與描述都在 <head>，不需要整頁。 */
const MAX_PAGE_BYTES = 512 * 1024;

/** 抓網頁的逾時。抓不到不是致命錯誤，只是少了建議值。 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * 把 HTML 實體還原成字元。
 *
 * 只處理最常見的幾個 —— 標題裡出現 `&amp;` 的機率很高（「甲班 & 乙班」），
 * 而使用者看到建議值寫著 `&amp;` 只會覺得程式壞了。不引入完整的 HTML
 * 解析器：這裡的產出是「給人確認的建議值」，不是要拿去渲染的內容。
 *
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // &amp; 必須放最後，否則 &amp;lt; 會先變成 &lt; 再被解成 <。
    .replace(/&amp;/gi, "&");
}

/**
 * 從網頁原始碼裡挖出建議的名稱與說明。
 *
 * @param {string} html
 * @returns {{ name: string | null, description: string | null }}
 */
export function parsePageMeta(html) {
  const head = html.slice(0, MAX_PAGE_BYTES);

  /**
   * @param {RegExp} pattern
   * @returns {string | null}
   */
  function first(pattern) {
    const match = head.match(pattern);

    if (!match) {
      return null;
    }

    const value = decodeEntities(match[1]).replace(/\s+/g, " ").trim();

    return value === "" ? null : value;
  }

  const name =
    first(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
    ?? first(/<meta[^>]+content=["']([^"']*)["'][^>]+property=["']og:title["']/i)
    ?? first(/<title[^>]*>([\s\S]*?)<\/title>/i);

  const description =
    first(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    ?? first(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)
    ?? first(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);

  return { name, description };
}

/**
 * 抓一次網頁，只為了取建議值。
 *
 * 失敗**一律不是致命錯誤**：網站可能擋機器人、可能暫時掛了、使用者可能沒網路。
 * 那些都不影響「把這個網址登錄進展示中心」這件事本身。
 *
 * @param {string} url
 * @param {{ fetchFn?: typeof fetch }} [options]
 * @returns {Promise<{ ok: boolean, name: string | null, description: string | null, error: string | null }>}
 */
export async function fetchPageMeta(url, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;

  try {
    const response = await fetchFn(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "text/html,application/xhtml+xml" },
    });

    if (!response.ok) {
      return { ok: false, name: null, description: null, error: `網站回應 ${response.status}` };
    }

    const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
    const meta = parsePageMeta(html);

    return { ok: true, name: meta.name, description: meta.description, error: null };
  } catch (error) {
    return {
      ok: false,
      name: null,
      description: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 從網址生一個 slug 建議。
 *
 * 取主機名稱的第一段（`my-class.pages.dev` → `my-class`），因為那通常就是
 * 使用者自己取的名字。整串主機名當 slug 會得到 `my-class-pages-dev`，
 * 而 slug 會出現在展示中心的網址列上，愈短愈好。
 *
 * @param {string} url
 * @param {string} [folderName] 網址推不出東西時的備援
 * @returns {string | null}
 */
export function suggestSlugFromUrl(url, folderName) {
  let host;

  try {
    host = new URL(url).hostname;
  } catch {
    return folderName ? suggestSlug(folderName) : null;
  }

  /*
   * 中文網域要排除（2026-08-30 被測試抓到）。`new URL().hostname` 回的是
   * punycode：`例子.tw` → `xn--fsqu00a.tw`，取第一段再過 suggestSlug 會得到
   * `xn-fsqu00a`。那串東西會變成展示中心網址的一部分，而且完全看不出是什麼。
   * 這種情況回 null，讓呼叫端要求使用者自己取——與 suggestSlug() 刻意不做
   * 中文音譯是同一個判斷。
   */
  const labels = host.replace(/^www\./i, "").split(".");

  /*
   * 只要有任何一段是 punycode 就整個放棄，**不是**把那一段濾掉。
   * 濾掉的話 `例子.tw` 只剩 `tw`，於是建議值變成頂級網域——那比
   * `xn-fsqu00a` 更糟：它看起來像個正常的 slug，使用者很可能就直接按 Enter。
   */
  const candidates = labels.some((label) => label.startsWith("xn--")) || labels[0] === ""
    ? []
    : [labels[0], labels.join("-")];

  for (const candidate of candidates) {
    const slug = suggestSlug(candidate);

    if (slug !== null) {
      return slug;
    }
  }

  return folderName ? suggestSlug(folderName) : null;
}

/**
 * 登錄一個外部連結專案。
 *
 * 注入點（`fetchFn`／`register`／`storeThumbnail`／`findThumbnail`）的用途與
 * `tools/register.mjs` 相同：讓測試完全不碰網路、不碰 Wrangler。
 *
 * @param {{
 *   dir: string,
 *   prompt: (message: string) => Promise<string>,
 *   confirm: (message: string) => Promise<boolean>,
 *   remote?: boolean,
 *   now?: string,
 *   fetchFn?: typeof fetch,
 *   getProjectFn?: typeof getProject,
 *   register?: typeof registerDeployment,
 *   storeThumbnail?: typeof storeThumbnailFromFile,
 *   findThumbnail?: typeof findThumbnailSource,
 * }} options
 * @returns {Promise<{ ok: boolean, steps: { step: string, status: string, detail: string }[], projectId?: number, slug?: string, url?: string, visibility?: string }>}
 */
export async function linkProject(options) {
  const { dir, prompt, confirm } = options;
  const registerFn = options.register ?? registerDeployment;
  const getProjectFn = options.getProjectFn ?? getProject;
  const storeThumbnailFn = options.storeThumbnail ?? storeThumbnailFromFile;
  const findThumbnailFn = options.findThumbnail ?? findThumbnailSource;

  /** @type {{ step: string, status: string, detail: string }[]} */
  const steps = [];
  const stop = (step, detail) => {
    steps.push({ step, status: "stopped", detail });
    return { ok: false, steps };
  };
  const ok = (step, detail) => steps.push({ step, status: "ok", detail });
  const warn = (step, detail) => steps.push({ step, status: "warn", detail });

  // ── 1. 讀出網址 ─────────────────────────────────────────────
  const detected = detectLinkFolder(dir);

  if (!detected.isLink) {
    const link = findLinkFile(dir);

    if (link !== null) {
      return stop(
        "read-link",
        `「${basename(dir)}」裡有 HTML 檔案，看起來是一個要部署的專案，不是外部連結。\n`
          + "外部連結專案的資料夾裡只放一個寫著網址的文字檔（可以再放一張截圖），不放網頁檔案。\n"
          + `要部署它請用：node bin/hub.mjs ship ${dir}`,
      );
    }

    return stop(
      "read-link",
      `在「${basename(dir)}」的根目錄找不到寫著網址的文字檔。\n`
        + "作法：在那個資料夾裡新增一個文字檔（檔名不拘，例如「連結.txt」），\n"
        + "裡面貼上網站的完整網址（要有 https:// 開頭）。\n"
        + "想一併設定預覽圖的話，把截圖也放進同一個資料夾。",
    );
  }

  const url = /** @type {string} */ (detected.url);

  ok("read-link", `從「${detected.source}」讀到網址：${url}`);

  if (url.startsWith("http://")) {
    warn(
      "read-link",
      "這個網址是 http:// 而不是 https://，連線不會被加密。\n"
        + "      展示中心仍然會正常連過去，但如果那個網站有 https 版本，建議改用 https。",
    );
  }

  // ── 2. 抓網頁當建議值 ───────────────────────────────────────
  const meta = await fetchPageMeta(url, { fetchFn: options.fetchFn });

  if (meta.ok) {
    ok(
      "fetch",
      `讀到網頁標題：${meta.name ?? "（這個網站沒有標題）"}\n`
        + `      說明：${meta.description ?? "（這個網站沒有寫說明）"}`,
    );
  } else {
    warn(
      "fetch",
      `抓不到那個網頁（${meta.error}），所以沒有建議值可以給你。\n`
        + "      這不影響登錄——名稱與說明自己填就好。",
    );
  }

  // ── 3. 問名稱、代稱、說明 ───────────────────────────────────
  const folderName = basename(dir);
  const suggestedName = meta.name ?? folderName;

  const name = (await prompt(`專案名稱（顯示在展示中心上，直接按 Enter 用「${suggestedName}」）：`)).trim()
    || suggestedName;

  const suggestedSlug = suggestSlugFromUrl(url, folderName);

  /*
   * 與 `hub new` 同一套：slug 一律由使用者確認、次數有上限。
   * 上限的理由見 new-project.mjs——非互動情境下 prompt 會一直回空字串，
   * 無限迴圈會讓程序靜默掛住。
   */
  const MAX_SLUG_ATTEMPTS = 5;
  let slug = "";
  let hint = "";

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS && !SLUG_PATTERN.test(slug); attempt += 1) {
    const base = suggestedSlug
      ? `網址代稱（只能用小寫英文、數字、連字號，直接按 Enter 用「${suggestedSlug}」）：`
      : "網址代稱（只能用小寫英文、數字、連字號，例如 my-class-site）：";

    slug = (await prompt(hint + base)).trim() || suggestedSlug || "";
    hint = SLUG_PATTERN.test(slug) ? "" : `「${slug}」不合格式。\n`;
  }

  if (!SLUG_PATTERN.test(slug)) {
    return stop(
      "slug",
      `試了 ${MAX_SLUG_ATTEMPTS} 次都沒有取得合格的網址代稱，先停下來。\n`
        + "格式規則：只能用小寫英文字母、數字與連字號，例如 my-class-site。\n"
        + "還沒有寫入任何資料，重新執行一次即可。",
    );
  }

  const suggestedDescription = meta.description ?? "";
  const descriptionPrompt = suggestedDescription === ""
    ? "一句話說明（可以直接按 Enter 跳過）："
    : `一句話說明（直接按 Enter 用「${suggestedDescription}」）：`;

  const description = (await prompt(descriptionPrompt)).trim() || suggestedDescription;

  // ── 4. 確認 ─────────────────────────────────────────────────
  const thumbnail = findThumbnailFn(dir);

  /*
   * 先查一次既有的專案，有兩個用途，缺一不可：
   *
   * ① **把 repository_url／worker_name 原樣帶回去。** `buildUpsertProjectSql()`
   *    的 UPDATE 分支是無條件覆寫這兩欄的——呼叫端沒給值就寫成 NULL。
   *    `hub ship` 每次都帶著它們所以看不出問題，但 `hub link` 手上根本沒有
   *    這兩個值。不帶回去的話，對一個曾經 ship 過的 slug 跑 link，
   *    會靜默清掉它的 GitHub 網址與 Worker 名稱。
   *
   * ② **警告 slug 撞號。** 用一個已經部署過的 slug 跑 link，等於把那張卡片的
   *    連結改指到別的網站。這件事使用者多半不是故意的，所以在確認畫面上
   *    講清楚，而不是照做完再讓他自己發現。
   */
  let existing = null;

  try {
    existing = await getProjectFn(slug, { remote: options.remote });
  } catch (error) {
    return stop(
      "lookup",
      `查詢「${slug}」是否已存在時失敗：${error instanceof Error ? error.message : String(error)}\n`
        + "還沒有寫入任何資料。",
    );
  }

  const collision = existing === null
    ? ""
    : `\n  ⚠ 「${slug}」已經在展示中心裡了（編號 ${existing.id}，`
      + `目前平台 ${existing.platform}，目前網址 ${existing.deployment_url ?? "（無）"}）。\n`
      + "    繼續的話，那張卡片的連結會改指到上面這個網址。\n"
      + "    如果這不是你要的，請取消，換一個代稱再跑一次。";

  const approved = await confirm(
    "要登錄這個外部連結專案：\n"
      + `  名稱：${name}\n`
      + `  代稱：${slug}\n`
      + `  說明：${description || "（沒有）"}\n`
      + `  網址：${url}\n`
      + `  預覽圖：${thumbnail ? thumbnail.name : "（沒有，卡片會顯示「此專案尚無預覽圖」）"}\n`
      + "  平台：external（外部平台）——展示中心只會連過去，不會部署、不會動那個網站\n"
      + `  寫入對象：${options.remote === true ? "遠端 D1（線上）" : "本機模擬資料庫"}`
      + collision,
  );

  if (!approved) {
    return stop("confirm", "已取消，沒有寫入任何資料。");
  }

  // ── 5. 登錄 ─────────────────────────────────────────────────
  let registered;

  try {
    registered = await registerFn(
      {
        name,
        slug,
        description,
        visibility: "private",
        platform: "external",

        /*
         * project_type 用 "static" 而不是 "other"（2026-08-30 實測後改）。
         *
         * "other" 語意上比較誠實——我們確實不知道那個網站是怎麼做的。但這個
         * 欄位在展示中心只驅動一件事：`public/app.js` 看到 "other" 就在卡片上
         * 標「需下載安裝」，tooltip 寫「這不是可直接在瀏覽器開啟的網站，
         * 點進去是說明頁」。那句話對外部連結是**錯的**——它就是一個網頁，
         * 點下去直接開得起來。
         *
         * 本機實測時那張卡片真的印出了「需下載安裝」，才發現這件事。
         * 在「欄位語意精確」與「訪客看到的標籤正確」之間選後者：
         * 那個標籤是訪客唯一會看到的東西，而「這是外部網站」這個資訊
         * 已經由 platform=external 在後台如實呈現了。
         */
        project_type: "static",
        database_type: "none",
        deployment_url: url,
        repository_url: existing?.repository_url ?? null,
        worker_name: existing?.worker_name ?? null,
      },
      { remote: options.remote, now: options.now },
    );
  } catch (error) {
    return stop(
      "register",
      `登錄失敗：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  ok(
    "register",
    registered.isNew
      ? `已登錄「${name}」（編號 ${registered.projectId}），權限：${registered.visibility}`
      : `「${slug}」原本就在展示中心裡（編號 ${registered.projectId}），已更新網址與時間。\n`
        + `      名稱、說明與權限維持後台目前的設定（權限：${registered.visibility}），沒有被覆蓋。`,
  );

  // ── 6. 縮圖 ─────────────────────────────────────────────────
  if (thumbnail === null) {
    warn(
      "thumbnail",
      "這個資料夾裡沒有圖片，所以沒有設定預覽圖。\n"
        + "      補的方法：把截圖放進這個資料夾再跑一次，或用\n"
        + `      node bin/hub.mjs thumbnail ${slug} <圖片路徑>`,
    );
  } else {
    try {
      const stored = await storeThumbnailFn({
        imagePath: thumbnail.path,
        projectId: registered.projectId,
        remote: options.remote,
        now: options.now,
      });

      ok(
        "thumbnail",
        `已把「${thumbnail.name}」設成預覽圖（${Math.round(stored.byteSize / 1024)} KB，`
          + `分成 ${stored.chunkCount} 段存進資料庫）。\n`
          + "      縮圖存在資料庫裡，不需要重新部署。",
      );
    } catch (error) {
      warn(
        "thumbnail",
        `預覽圖設定失敗：${error instanceof Error ? error.message : String(error)}\n`
          + "      專案本身已經登錄成功，只是卡片會顯示「此專案尚無預覽圖」。",
      );
    }
  }

  return {
    ok: true,
    steps,
    projectId: registered.projectId,
    slug,
    url,
    visibility: registered.visibility,
  };
}
