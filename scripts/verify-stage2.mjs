#!/usr/bin/env node
// @ts-check

/**
 * 階段二完整性檢查。
 *
 * 這支腳本只做**不需要啟動伺服器**的靜態檢查：檔案是否齊備、關鍵契約
 * 是否還在、設定是否正確。它的價值在於快速抓出「有人不小心刪掉或改壞了
 * 某條安全規則」這類問題。
 *
 * 需要真實資料庫與 HTTP 的端對端驗證，由 `scripts/integration-stage2.mjs`
 * 負責，那支會實際啟動 wrangler dev。
 *
 * 執行：pnpm run verify:stage2
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @type {{ ok: boolean, label: string, detail?: string }[]} */
const results = [];

function record(ok, label, detail) {
  results.push({ ok, label, detail });
}

/**
 * @param {string} relativePath
 * @returns {Promise<string | null>}
 */
async function read(relativePath) {
  try {
    return await readFile(path.join(ROOT, relativePath), "utf8");
  } catch {
    return null;
  }
}

/**
 * 移除註解後再做內容比對。
 *
 * 這一步是必要的：說明「為什麼不使用某個東西」的註解，本身就會含有
 * 那個關鍵字。例如 gallery.js 的註解寫著「不碰 repository_url」，
 * 直接比對字串就會誤判成違規。
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // 區塊註解與 JSDoc
    .replace(/^[ \t]*\/\/.*$/gm, " ")     // 整行的行註解
    .replace(/[ \t]+\/\/.*$/gm, " ")      // 行尾的行註解
    /*
     * SQL 的行註解。
     *
     * `(?!-)` 是 2026-08-30 補上的：CSS 自訂屬性也是 `--` 開頭
     * （`--color-surface: #172033;`），原本的規則會把每一行自訂屬性
     * 整行當成註解抹掉。後果不是誤判，是**漏判**——「gallery.css 不得
     * 出現寫死色碼」那條契約因此可以被藏在自訂屬性裡繞過，而且完全沒有
     * 徵兆（實際發生過：階段 D 在 gallery.css 寫了 13 個色碼，檢查照樣全綠）。
     *
     * 分辨依據寫成「後面接的是不是一個自訂屬性宣告」——`--識別字:` 這個形狀
     * 只會是 CSS，SQL 註解不會長這樣。用「第三個字元是不是連字號」之類的
     * 近似規則會漏（`--color-surface` 第三個字元是 c，照樣被抹掉）。
     */
    .replace(/^[ \t]*--(?![A-Za-z0-9_-]+\s*:).*$/gm, " ");
}

/** 階段二必須存在的檔案。 */
const REQUIRED_FILES = [
  "migrations/0001_hub_schema.sql",
  "src/index.js",
  "src/http.js",
  "src/validation.js",
  "src/visibility.js",
  "src/images.js",
  "src/repositories/projects.js",
  "src/repositories/taxonomy.js",
  "src/repositories/gallery.js",
  "src/repositories/policies.js",
  "src/repositories/deployments.js",
  "src/routes/projects.js",
  "src/routes/taxonomy.js",
  "src/routes/gallery.js",
  "src/routes/thumbnails.js",
  "src/routes/policies.js",
  "src/routes/deployments.js",
  "src/access-gate/index.js",
  "src/access-gate/session.js",
  "src/access-gate/password.js",
  "src/access-gate/protected-worker.js",
  "public/index.html",
  "public/gallery.css",
  "public/app.js",
  "public/admin/index.html",
  "public/admin/admin.css",
  "public/admin/admin.js",
  "public/site-footer.js",
  "scripts/write-build-info.mjs",
  "scripts/seed-local-d1.sql",
  "test/worker.test.mjs",
  "test/database.test.mjs",
  "test/http.test.mjs",
  "test/validation.test.mjs",
  "test/api-contract.test.mjs",
  "test/gallery.test.mjs",
  "test/images.test.mjs",
  "test/visibility.test.mjs",
  "test/access-gate.test.mjs",
  "test/protected-worker.test.mjs",
  "test/admin-gate.test.mjs",
  ".dev.vars.example",
];

/**
 * 內容契約：每一條都對應一個具體的安全或架構要求，
 * 被改掉就代表某個保證失效了。
 */
const CONTENT_CONTRACTS = [
  {
    file: "src/repositories/gallery.js",
    // 2026-08-24：條件從單一 'public' 改為 GALLERY_LISTED_STATES（public ＋ password）。
    // 這裡驗的是「條件在模組內固定、不由呼叫端決定」，不是驗那個字串長什麼樣，
    // 所以檢查的是常數的來源與產生條件的程式，而不是 SQL 字面值。
    must: ["GALLERY_LISTED_STATES", "LISTED_VISIBILITY_SQL"],
    label: "展示中心查詢把可見性條件寫死在模組內（單一事實來源）",
  },
  {
    file: "src/visibility.js",
    must: ["GALLERY_LISTED_STATES"],
    label: "可見性的列出範圍有單一事實來源",
  },
  {
    file: "src/repositories/gallery.js",
    mustNot: ["repository_url", "worker_name", "password_hash"],
    label: "展示中心查詢不碰管理欄位與密碼雜湊",
  },
  {
    file: "src/access-gate/session.js",
    mustNot: [".prepare(", "deriveBits", "deriveKey"],
    label: "工作階段驗證路徑不查資料庫、不做金鑰衍生",
  },
  {
    file: "src/access-gate/password.js",
    must: ["PBKDF2"],
    mustNotMatch: [/(?:from|require\()\s*["'][^"']*(bcrypt|argon2|scrypt)/i],
    label: "密碼雜湊使用 PBKDF2，未引入 bcrypt／argon2／scrypt",
  },
  {
    file: "src/images.js",
    must: ["image/png", "image/jpeg", "image/webp", "image/avif"],
    label: "只接受四種影像格式",
  },
  {
    file: "src/routes/thumbnails.js",
    must: ["detectImageType", "isValidObjectKey"],
    label: "圖片上傳檢查位元組特徵，讀取端驗證物件名稱形狀",
  },
  {
    file: "src/repositories/policies.js",
    must: ["policy_version = project_policies.policy_version + 1"],
    label: "變更密碼時在同一語句內遞增政策版本",
  },
  {
    file: "src/repositories/deployments.js",
    must: ["db.batch("],
    label: "部署紀錄與專案網址更新放在同一批次",
  },
  {
    file: "public/index.html",
    mustNot: ["fonts.googleapis.com"],
    label: "展示中心不載入外部字型",
  },
  {
    file: "public/styles.css",
    mustNot: ["fonts.googleapis.com", "Fira"],
    label: "共用樣式不使用外部字型",
  },
  {
    file: ".gitignore",
    must: [".dev.vars"],
    label: "簽章金鑰的本機設定檔已被版本控制忽略",
  },
  {
    // 2026-08-27 置換。原本這一項要求 wrangler.jsonc 必須含
    // `"ADMIN_ENABLED": "false"`，標籤是「管理介面預設關閉」。
    //
    // 那是在管理後台**還沒有任何登入驗證**的時期寫的——當時「預設關閉」
    // 是唯一的防線，開啟就等於把可以清空資料庫的介面公開在網路上。
    //
    // 2026-08-25 起改由 `src/admin-gate.js` 的密碼閘道保護，防線變成三層：
    // ADMIN_ENABLED 旗標、密碼閘道、以及兩把 Secret 缺任一把時一律登入失敗
    // （fail closed）。且 2026-08-26 已裁定空殼的 ADMIN_ENABLED 預設為 "true"，
    // 原檢查與該裁決直接矛盾——一個會對「刻意的正確狀態」報錯的檢查，
    // 會教人習慣忽略驗證輸出，比沒有這項檢查更糟（同檔 R2 那段的相同教訓）。
    //
    // 因此改為斷言**真正該保護的不變量**：管理路由確實經過密碼閘道。
    // 這比原檢查的保護力更強——原本沒有任何一項檢查在確認這件事。
    file: "src/index.js",
    must: ["isAdminAuthenticated"],
    label: "管理路由受密碼閘道保護（不是只靠 ADMIN_ENABLED 旗標）",
  },
  {
    file: "src/index.js",
    must: ['env?.ADMIN_ENABLED === "true"'],
    label: "只有明確設為 true 才開啟管理介面",
  },
  {
    file: "public/site-footer.js",
    must: ["build-info.json", "內容製作者"],
    mustNot: ["new Date()"],
    label: "頁尾的更新時間取自部署資訊，不使用瀏覽器時鐘",
  },

  /*
   * 顏色的單一事實來源（2026-08-29，風格切換的前置）。
   *
   * 站台風格切換只會覆寫 `styles.css` 的 :root token。任何寫死在規則裡的
   * 色碼都不會跟著換——結果是換了風格但邊框、標籤、按鈕還是舊顏色，
   * 看起來像壞掉，而且**不會有任何錯誤訊息**。
   *
   * 所以這兩支樣式表一律不得出現字面色碼。`styles.css` 不在此列，
   * 因為 token 本身就定義在那裡。
   *
   * 正規表達式結尾的 (?![\w-]) 是為了放過 ID 選擇器：`#add-form` 的前三個
   * 字元剛好都是合法的十六進位字元，沒有這個條件就會被誤判。
   * 註解在比對前已由 stripComments() 移除，所以說明文字裡提到色碼不受影響。
   */
  {
    file: "public/gallery.css",
    mustNotMatch: [/#[0-9a-fA-F]{3,8}(?![\w-])/],
    label: "展示中心樣式的顏色全部來自 token，沒有寫死的色碼",
  },

  /*
   * 兩種版面的主卡必須看得出差別，而且都不靠旋轉光暈（2026-08-30 使用者裁定）。
   *
   *   - hero「大圖主打」：主卡佔滿整列。
   *   - grid「整齊小卡」：每張卡同大小，主卡只靠各風格的靜態強調。
   *
   * 兩者一度都是 `span 2`，結果選哪一種版面都長得一樣——這條就是防止那個
   * 情況再發生。旋轉光暈則是使用者明確要求移除的（「真的很礙眼」），
   * 一併釘住，避免哪天又被加回來。
   */
  {
    file: "public/gallery.css",
    must: ['[data-layout="hero"] > .project-card:first-child'],
    mustNot: ["primary-glow-spin", 'grid"] > .project-card.is-primary'],
    label: "大圖主打佔滿整列、整齊小卡每張同大小，且沒有旋轉光暈",
  },

  /*
   * 三套風格各自的主卡視覺語言（2026-08-29 階段 D）。
   *
   * 風格文件第六節的重點就是「三種主卡不要只做換顏色」。這三個字串各自
   * 對應一套的識別特徵，少了任何一個就代表那套退化成只有配色不同。
   */
  {
    file: "public/gallery.css",
    must: [
      "-webkit-text-stroke",  // 方案一：SHOW 線框字
      "PROJECT SHOW",         // 方案二：浮貼標題牌
      "--color-primary-card-surface", // 方案三：深色主卡
    ],
    label: "三套風格各有自己的主卡視覺語言，不是只換顏色",
  },
  {
    file: "public/admin/admin.css",
    mustNotMatch: [/#[0-9a-fA-F]{3,8}(?![\w-])/],
    label: "後台樣式的顏色全部來自 token，沒有寫死的色碼",
  },

  /*
   * 密碼的時序限制（2026-08-29，順位 7；2026-08-29 從 verify-stage1 搬來）。
   *
   * 專案密碼是「部署當下注入」的，不像站名、版面、公開／私人那樣存好就生效。
   * 後台其他設定都是即時生效的，使用者沒有理由預期密碼是例外——不講的話
   * 他會以為已經鎖起來了，而那正是「以為有保護、其實沒有」這一類最危險的誤解。
   *
   * 這兩條驗的是這個 app 的行為契約，不是階段一教材，所以歸屬在這支腳本。
   */
  {
    file: "public/admin/index.html",
    must: ["改完密碼要重新部署那個專案才會生效"],
    label: "後台有提醒：改完密碼要重新部署才生效",
  },
  {
    file: "AGENTS.md",
    must: ["使用者改了專案密碼之後，你一定要說的話"],
    label: "AGENTS.md 要求 AI 主動提醒密碼需重新部署",
  },
];

/** Seed 必須涵蓋的七種 fixture。 */
const REQUIRED_FIXTURES = [
  { label: "A Public Static", match: /'public'[^;]*'static'/s },
  { label: "B Unlisted", match: /'unlisted'/ },
  { label: "C Password", match: /'password'/ },
  { label: "D Private", match: /'private'/ },
  { label: "E Disabled", match: /'disabled'/ },
  { label: "F Worker + D1", match: /'worker',\s*'d1'/ },
  { label: "G Supabase", match: /'supabase',\s*'fullstack',\s*'supabase'|'supabase'[^;]*'supabase'/s },
];

async function main() {
  // 1. 必要檔案
  let missing = 0;

  for (const file of REQUIRED_FILES) {
    if (await read(file) === null) {
      record(false, `缺少檔案：${file}`);
      missing += 1;
    }
  }

  record(missing === 0, `階段二必要檔案齊備（${REQUIRED_FILES.length} 個）`);

  // 2. 內容契約
  for (const contract of CONTENT_CONTRACTS) {
    const source = await read(contract.file);

    if (source === null) {
      record(false, contract.label, `讀不到 ${contract.file}`);
      continue;
    }

    const failures = [];
    // 「必須存在」允許出現在註解中；「不得存在」則只看實際程式碼。
    const code = stripComments(source);

    for (const needle of contract.must ?? []) {
      if (!source.includes(needle)) {
        failures.push(`缺少「${needle}」`);
      }
    }

    for (const needle of contract.mustNot ?? []) {
      if (code.includes(needle)) {
        failures.push(`不該出現「${needle}」`);
      }
    }

    for (const pattern of contract.mustNotMatch ?? []) {
      if (pattern.test(code)) {
        failures.push(`不該符合 ${pattern}`);
      }
    }

    record(failures.length === 0, contract.label, failures.join("；"));
  }

  // 3. Seed 的七種 fixture
  const seed = await read("scripts/seed-local-d1.sql");

  if (seed === null) {
    record(false, "讀不到 seed 檔案");
  } else {
    for (const fixture of REQUIRED_FIXTURES) {
      record(fixture.match.test(seed), `Seed 包含 ${fixture.label}`);
    }
  }

  // 4. Wrangler 設定
  const wrangler = await read("wrangler.jsonc");

  if (wrangler === null) {
    record(false, "讀不到 wrangler.jsonc");
  } else {
    const config = stripComments(wrangler);

    record(config.includes('"binding": "DB"'), "已設定 D1 繫結");

    // R2 是選配（2026-08-17 修正）。
    //
    // 原本這裡無條件要求 THUMBNAILS 繫結存在，但 2026-08-16 已裁定刻意不啟用 R2。
    //
    // 當時的理由是「縮圖只能透過管理後台上傳，而正式環境沒有後台，線上不存在
    // 任何上傳途徑」。**2026-08-27 起這個理由已不成立**（管理後台已上線），
    // 但結論不變、理由換了：縮圖有更輕量的替代方案——把截圖放進專案資料夾，
    // `hub ship` 部署時自動裁切轉檔、搬進 Hub 自己的靜態檔案，不需要另外的
    // 儲存服務、也不必考慮付款方式。後台的「上傳圖片」按鈕仍會回 503，
    // 這是已知、刻意的取捨（說明見 stage-1/08 的更新註記與 README）。
    //
    // 一個會對「刻意的正確狀態」報錯的檢查，會教人習慣忽略驗證輸出，
    // 比沒有這項檢查更糟。因此改為：未宣告 r2_buckets 不算失敗；
    // 一旦宣告了，繫結名稱就必須是 THUMBNAILS（程式讀的是 env.THUMBNAILS）。
    const r2Declared = config.includes('"r2_buckets"');

    record(
      !r2Declared || config.includes('"binding": "THUMBNAILS"'),
      r2Declared ? "R2 繫結名稱正確（THUMBNAILS）" : "R2 未啟用（刻意；縮圖功能停用）",
    );
    record(config.includes('"binding": "ASSETS"'), "已設定靜態資源繫結");
    record(config.includes('"/api/*"'), "API 路徑會先進 Worker");
    record(config.includes('"/media/*"'), "媒體路徑會先進 Worker");
    record(!config.includes("r2.dev"), "未把 r2.dev 當成正式網址");
  }

  // 5. 資料庫結構契約
  const migration = await read("migrations/0001_hub_schema.sql");

  if (migration === null) {
    record(false, "讀不到 migration");
  } else {
    for (const table of ["projects", "categories", "tags", "project_tags", "project_policies", "deployments"]) {
      record(migration.includes(`CREATE TABLE ${table}`), `資料表 ${table} 已定義`);
    }

    record(
      migration.includes("'public', 'unlisted', 'password', 'private', 'disabled'"),
      "五種可見性由資料庫層強制",
    );
    record(migration.includes("ON DELETE CASCADE"), "已定義連帶刪除行為");
    record(migration.includes("ON DELETE SET NULL"), "刪除分類時保留專案");
  }

  // 輸出
  const failed = results.filter((r) => !r.ok);

  for (const result of results) {
    if (!result.ok) {
      console.error(`FAIL  ${result.label}${result.detail ? ` :: ${result.detail}` : ""}`);
    }
  }

  if (failed.length > 0) {
    console.error(`\nStage 2 verification failed: ${failed.length} of ${results.length} checks.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Stage 2 verification passed: ${results.length} checks.`);
}

await main();
