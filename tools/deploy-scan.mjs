// @ts-check

/**
 * 部署前的「不該上傳的檔案」掃描。
 *
 * 與 `secrets.mjs` 的分工：
 *   - `secrets.mjs` 看**檔案內容**——原始碼裡有沒有寫死金鑰。
 *   - 本模組看**檔案本身**——這個檔案存在就不該被上傳，不必讀內容也能判定。
 *
 * 為什麼需要後者：2026-08-16 的實際稽核在 12 個專案裡找到 4 份真實學生名冊
 * （132 筆學號＋姓名＋班級＋座號）、2 份明文 service_role 金鑰、以及一張
 * 白板背景拍到教室 Wi-Fi 密碼的照片。這些**內容掃描全都抓不到**——
 * `.env` 的內容是合法的 KEY=VALUE、CSV 的內容是合法的表格、照片是二進位。
 * 唯一能攔住它們的線索是**檔名與副檔名**。
 *
 * 三級分類（依 2026-08-17 工作計畫 D11）：
 *   - blocking（阻擋）：直接中止，不詢問。憑證與金鑰類，沒有「確認一下就好」的空間。
 *   - confirm（需確認）：列出來並說明為什麼不能上傳，等使用者放行。
 *   - note（提醒）：無法自動判定、只能請使用者自己看的事。
 *
 * 為什麼 confirm 級要「說明原因」而不只列檔名：使用者要能判斷。
 * 「`彰工夜學生匯入sue.csv` 不能上傳」是命令，
 * 「表頭是學號／姓名／班級／座號，判定為真實名冊，屬個資法範疇」才是能被判斷的資訊。
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

import { SKIPPED_DIRECTORIES } from "./secrets.mjs";

/**
 * 檔案數上限。與 `secrets.mjs` 的 MAX_FILES 同量級，防止走訪超大目錄時卡住。
 */
const MAX_FILES = 20_000;

/**
 * 走訪目錄，收集**所有**檔案。
 *
 * ⚠️ 刻意不沿用 `secrets.mjs` 的 `collectFiles()`。
 *
 * 那一支是給內容掃描用的，會跳過所有二進位副檔名（讀不了二進位內容，跳過是對的）、
 * 跳過範本檔、也跳過超過大小上限的檔案。
 *
 * 但本模組要抓的正好是**二進位檔**：照片（`.png`／`.jpg`）、試算表（`.xlsx`）、
 * PDF、壓縮檔。沿用那一支會讓掃描報告顯示「未發現需確認項目」，
 * 而真正危險的檔案一個都沒被看到——**比沒有這個掃描更糟，因為它會給人安全的錯覺**。
 *
 * （2026-08-17 實作時真的踩到：第一版沿用 collectFiles，
 * 對含 111 KB PNG 的專案回報「掃描 3 個檔案」，那張圖從頭到尾不在清單裡。）
 *
 * @param {string} root
 * @returns {{ files: string[], truncated: boolean }}
 */
function collectAllFiles(root) {
  /** @type {string[]} */
  const files = [];
  let truncated = false;
  const stack = [root];

  while (stack.length > 0) {
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }

    const current = stack.pop();

    if (current === undefined) {
      break;
    }

    let entries;

    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.includes(entry.name)) {
          stack.push(full);
        }

        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      // 不看大小、不看副檔名——本模組的判定只靠檔名，不需要讀內容。
      files.push(full);
    }
  }

  return { files, truncated };
}

/**
 * 放行清單的檔名。
 *
 * 為什麼需要它：如果每次部署都把同樣的 confirm 項目再問一遍，
 * 使用者會養成無腦按「全部放行」的習慣——那這道關卡就等於不存在。
 * 放行一次就記下來，之後只問**新出現**的項目。
 */
export const ALLOW_FILENAME = ".hub-allow";

/** 檔名含這些字樣就視為空白範本，不算真實資料。 */
const TEMPLATE_WORDS = ["範本", "範例", "template", "sample", "example"];

/**
 * 阻擋級：這些檔案存在就不准部署。
 *
 * 判定一律用「檔名比對」而非內容，因為內容看起來都是合法的。
 */
const BLOCKING_RULES = [
  {
    id: "pre-mask-backup",
    test: (name, rel) => /遮罩前|未遮罩|遮罩備份|pre-?mask/i.test(rel),
    reason: "遮罩前的原始截圖備份。**這是最反直覺的一條規則**——"
      + "遮罩截圖時先備份原檔是正確做法（2026-08-17 就靠備份救回遮錯位置的三張），"
      + "但那份備份保留的正是「帳號、金鑰、個資還看得見」的版本。"
      + "把它一起上傳，整個遮罩工作等於白做，而且沒有任何錯誤訊息會提醒你。"
      + "2026-08-22 實測時它有 11 個檔案準備被 commit，靠人工看檔案清單才發現。"
      + " 做對的事（備份）製造了新的洩漏來源——備份留在本機，不要進版控、不要上傳。",
  },
  {
    id: "dotenv",
    test: (name) => /^\.env(\..+)?$/i.test(name) && !TEMPLATE_WORDS.some((w) => name.toLowerCase().includes(w)),
    reason: "環境變數檔。正式環境的設定值應由平台的環境變數機制注入，不隨原始碼上傳。"
      + "這類檔案常含資料庫連線字串或金鑰，且內容格式完全合法，內容掃描抓不到。",

    // 產物目錄外時降級為「需確認」（2026-08-22 修正）。
    //
    // 原本無條件阻擋，但那讓**需要建置的專案根本無法部署**：
    // Vite／Next.js 這類前端在 build 時必須讀 `.env`（`VITE_*` 變數會被編進 bundle），
    // 那個檔案本來就該留在專案根目錄。而它不在產物目錄內，也就不會被上傳。
    //
    // 一條讓正當流程無法進行的規則，最後只會被繞過或關掉，等於沒有規則。
    // 因此改為：在產物目錄內才阻擋（那是真的外洩），在外則列出來讓使用者確認。
    // 只有**專案根目錄**的 `.env` 才降級（2026-08-22 收緊）。
    //
    // ⚠️ 2026-08-23 修正：上面「它不在產物目錄內，也就不會被上傳」那句話**已經不成立**。
    //    產物目錄外只保證「不會公開在網站上」；專案同時會被推到 GitHub，
    //    而 git 送出去的是所有沒被 .gitignore 擋掉的檔案。
    //    因此降級條件已加上 `inGit !== true`——確定會進版控的一律不降級。
    //
    // 降級的正當理由是「建置需要它」，而 Vite／Next.js 只讀**專案根目錄**的 `.env`。
    // 子目錄裡的 `.env` 服務的是別的元件（例如同一個 repo 內的 Python 後台），
    // 對這次的前端建置毫無用處——它沒有降級的正當理由，維持阻擋。
    //
    // 實際案例：`app-multi-cert-dora-work/teacher-dashboard/.env` 裡是
    // Supabase **service_role** 金鑰（資料庫最高權限）。它不參與前端建置，
    // 卻因為「在產物目錄外」被降級成需確認——那是規則太寬，不是判斷正確。
    downgradeOutsideOutput: true,
    downgradeOnlyAtRoot: true,
    outsideReason: "環境變數檔，位於產物目錄外，因此**這次不會被上傳**。"
      + "需要建置的專案（Vite／Next.js 等）在 build 時必須讀它，所以留在這裡是正常的。"
      + "但請確認兩件事：①裡面若有**不該公開的金鑰**（例如 service_role），"
      + "整包資料夾分享出去時仍會外洩；②前端框架會把特定前綴的變數"
      + "（如 `VITE_`、`NEXT_PUBLIC_`）**直接編進 bundle**——那些等於公開，不要放機密。",
  },
  {
    id: "streamlit-secrets",
    test: (name, rel) => name.toLowerCase() === "secrets.toml" && rel.includes(`.streamlit${sep}`),
    reason: "Streamlit 的機密設定檔。實際案例中曾在此發現明文的 Supabase service_role 金鑰"
      + "（資料庫最高權限，可繞過所有存取規則）。",
  },
  {
    id: "private-key",
    test: (name) => /\.(pem|key|p12|pfx|jks)$/i.test(name) || /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name),
    reason: "私密金鑰檔。外流等同把身分交出去，且無法靠改密碼補救，只能重新產生金鑰。",
  },
  {
    id: "service-account",
    test: (name) => /service[-_]?account.*\.json$/i.test(name),
    reason: "服務帳戶憑證。這類金鑰通常權限很大且不會自動過期。",
  },
  {
    id: "git-bundle",
    test: (name) => name.toLowerCase().endsWith(".bundle"),
    reason: "Git 歷史備份檔。它含**完整的提交歷史**——即使目前的檔案是乾淨的，"
      + "歷史裡可能留著曾經 commit 過又刪掉的金鑰。實際案例中就有一份 bundle 的舊歷史含明文 JWT。",
  },
];

/**
 * 需確認級：列出來並說明原因，等使用者放行。
 */
const CONFIRM_RULES = [
  {
    id: "spreadsheet",
    test: (name) => /\.(xlsx|xls|xlsm|csv|tsv)$/i.test(name),
    reason: "試算表或名單檔。上線後這類資料應由使用者自行匯入，不隨網站上傳。"
      + "若內容是真實名冊（學號、姓名、班級、座號等），屬個資法範疇。",
    hint: "檔名含「範本」「範例」的空白模板會自動略過，不需放行。",
  },
  {
    id: "roster-name",
    test: (name) => /名單|名冊|匯入|學生|成績/.test(name),
    reason: "檔名顯示可能是名冊或成績資料。即使副檔名不是試算表，仍需確認內容不含個資。",
  },
  {
    id: "work-doc",
    test: (name) => /想法|對話紀錄|對話記錄|工作紀錄|工作記錄|工作計畫|工作進度|未完成事項|未來擴充|討論|巡檢|checklist|walkthrough|implementation_plan/i.test(name),
    reason: "開發過程文件。不影響程式執行，但會讓你的內部討論、決策過程與待辦事項隨網站一併公開。",
  },
  {
    id: "office-doc",
    test: (name) => /\.(doc|docx|ppt|pptx|odt|pdf)$/i.test(name),
    reason: "文書或 PDF 檔。需確認是網站要提供的內容，還是不小心留在資料夾裡的參考資料。"
      + "考卷、講義類文件另有散布授權問題。",
  },
  {
    id: "photo",
    test: (name) => /^(IMG|DSC|DSCN|P\d{7})[-_]?\d*\./i.test(name) || /照片|相片/.test(name),
    reason: "看起來是相機或手機拍的照片。**照片背景最容易夾帶非預期資訊**——"
      + "實際案例中曾在教室白板照片的右上角發現 Wi-Fi 名稱與密碼。",
  },
  {
    id: "archive",
    test: (name) => /\.(zip|rar|7z|tar|gz)$/i.test(name),
    reason: "壓縮檔。需確認是刻意提供下載的檔案，還是備份或重複打包。"
      + "壓縮檔的內容不會被掃描，裡面有什麼只有你知道。",
  },
  {
    id: "backup",
    test: (name) => /\.(bak|old|orig|save)$/i.test(name) || /[-_](備份|舊版|old|copy)/i.test(name),
    reason: "備份或舊版檔案。舊版可能含已經修掉的問題或已輪替的金鑰。",
  },
];

/**
 * 讀取放行清單。
 *
 * 格式刻意用最單純的「一行一個相對路徑」，`#` 開頭為註解——
 * 使用者要能自己打開看、自己編輯，不需要工具輔助。
 *
 * @param {string} root
 * @returns {Set<string>}
 */
export function readAllowList(root) {
  /** @type {Set<string>} */
  const allowed = new Set();

  let raw;

  try {
    raw = readFileSync(join(root, ALLOW_FILENAME), "utf8");
  } catch {
    return allowed;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    // 統一成當前平台的分隔符再比對，避免 Windows 與 POSIX 寫法不一致。
    allowed.add(trimmed.split(/[\\/]/).join(sep));
  }

  return allowed;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isTemplate(name) {
  const lower = name.toLowerCase();

  return TEMPLATE_WORDS.some((word) => lower.includes(word.toLowerCase()));
}

/**
 * 掃描專案資料夾，找出不該上傳的檔案。
 *
 * 每一筆結果標示兩個獨立的軸——**一個檔案有兩個出口，要分別回答**：
 *
 *   inOutput：會不會被部署到 Cloudflare，也就是公開在網路上
 *   inGit   ：會不會被 git 納入版控，也就是推到 GitHub
 *             （true / false / null＝呼叫方沒提供版控資訊）
 *
 * 為什麼需要 inOutput（2026-08-22 新增）：掃描範圍是整個專案資料夾，
 * 但實際部署的只有產物目錄（例如 `public/`）。若不區分，使用者會為了
 * 「明明不會被部署的檔案」反覆做確認——那種雜訊正是讓人養成無腦放行的原因，
 * 而無腦放行等於這道關卡不存在。
 *
 * 為什麼需要 inGit（2026-08-23 新增）：上面那個推論漏了第二個出口。
 * 產物目錄外只代表「不會出現在網站上」，不代表「不會被上傳」——
 * 專案同時會被推到 GitHub，而 git 送出去的是所有沒被 `.gitignore` 擋掉的檔案。
 * 合成案例實測：根目錄一個沒被 ignore 的 `.env`（含 service_role 樣式金鑰）
 * 被降級為「這次不會上傳」，而 git 會把它 commit 上去。
 *
 * 四種組合的威脅模型都不同：
 *   inOutput=true,  inGit=true  → 兩個出口都會送出，最高優先
 *   inOutput=true,  inGit=false → 公開在網站上但沒有版本紀錄（常見於建置產物）
 *   inOutput=false, inGit=true  → 不在網站上，但會永久留在 git 歷史裡
 *   inOutput=false, inGit=false → 只在本機。仍要報，因為整包壓縮分享時會外洩
 *
 * ⚠️ 對 worker 型專案 inOutput 恆為 true（產物是打包後的腳本，沒有單一輸出目錄），
 *    那個軸完全不具鑑別力，此時 inGit 是唯一有資訊的維度。
 *
 * @param {string} root 專案資料夾
 * @param {{
 *   thumbnail?: string | null,
 *   outputDir?: string | null,
 *   gitFiles?: Set<string> | string[] | null,
 * }} [options]
 *   thumbnail 為縮圖檔的絕對路徑，會被排除；outputDir 為產物目錄（相對於 root）；
 *   gitFiles 為 git 會納入版控的相對路徑清單（通常來自 `git add -A --dry-run`），
 *   不提供時 inGit 一律為 null，且降級行為與 2026-08-22 版本相同。
 * @returns {{
 *   blocking: { path: string, reason: string, ruleId: string, inOutput: boolean, inGit: boolean | null }[],
 *   confirm: { path: string, reason: string, ruleId: string, hint?: string, inOutput: boolean, inGit: boolean | null }[],
 *   allowedCount: number,
 *   scanned: number,
 *   truncated: boolean,
 *   outputDir: string | null,
 * }}
 */
export function scanDeployables(root, options = {}) {
  const { files, truncated } = collectAllFiles(root);
  const allowed = readAllowList(root);
  const thumbnail = options.thumbnail ?? null;

  // 產物目錄正規化成「相對路徑 + 分隔符」的前綴，方便用 startsWith 判斷。
  const rawOutput = typeof options.outputDir === "string" ? options.outputDir.trim() : "";
  const outputDir = rawOutput === "" || rawOutput === "."
    ? null
    : rawOutput.replace(/^\.[\\/]/, "").replace(/[\\/]+$/, "");
  const outputPrefix = outputDir === null ? null : outputDir.split(/[\\/]/).join(sep) + sep;

  // 會被 git 納入版控的檔案清單（呼叫方提供，通常來自 `git add -A --dry-run`）。
  //
  // 為什麼需要這個：
  // 產物目錄決定「會不會公開在網路上」，但那不是唯一的出口。專案同時會被推到
  // GitHub，而 git 送出去的是「所有沒被 .gitignore 擋掉的檔案」——兩批檔案不同。
  //
  // 2026-08-23 合成案例實測：產物目錄是 public/，根目錄放一個沒被 ignore 的
  // .env（含 service_role 樣式金鑰）與一份含姓名的名單 CSV。掃描器因為
  // 「不在產物目錄」把兩者降級為「這次不會上傳」，而 git 會把它們 commit 上去。
  //
  // git 的路徑一律用正斜線，本模組用平台分隔符，所以要正規化後再比對。
  const gitFiles = options.gitFiles instanceof Set
    ? new Set([...options.gitFiles].map((p) => p.split(/[\\/]/).join(sep)))
    : Array.isArray(options.gitFiles)
      ? new Set(options.gitFiles.map((p) => p.split(/[\\/]/).join(sep)))
      : null;

  /** @type {{ path: string, reason: string, ruleId: string }[]} */
  const blocking = [];
  /** @type {{ path: string, reason: string, ruleId: string, hint?: string }[]} */
  const confirm = [];
  let allowedCount = 0;

  for (const full of files) {
    // 縮圖是刻意放在專案根目錄的中介資料，不是夾帶物。
    if (thumbnail !== null && full === thumbnail) {
      continue;
    }

    const rel = relative(root, full);
    const name = basename(full);

    // outputPrefix 為 null 表示產物就是整個專案根目錄，那時所有檔案都會被上傳。
    const inOutput = outputPrefix === null ? true : rel.startsWith(outputPrefix);

    // 三態：true=會進版控、false=不會、null=沒有版控資訊（呼叫方沒提供清單）。
    // null 不等於 false——「不知道」和「確定不會」是兩件事，後面的降級判斷要分開處理。
    const inGit = gitFiles === null ? null : gitFiles.has(rel);

    // 放行清單只作用於 confirm 級。阻擋級不接受放行——
    // 若真的需要保留某個 .env，正確做法是把它移出專案資料夾，不是宣告它沒問題。
    const isAllowed = allowed.has(rel);

    const blockingRule = BLOCKING_RULES.find((rule) => rule.test(name, rel));

    if (blockingRule !== undefined) {
      // 可降級的規則：不在產物目錄時改列為「需確認」，並換一段說明。
      // 放行清單對降級後的項目有效——它此時的性質與其他 confirm 項相同。
      // 只在根目錄降級的規則：路徑含分隔符就代表它在子目錄裡。
      const atRoot = rel.includes(sep) === false;
      const mayDowngrade = blockingRule.downgradeOutsideOutput === true
        && (blockingRule.downgradeOnlyAtRoot !== true || atRoot);

      // 降級的正當性建立在「這個檔案不會被送出去」。
      // 產物目錄外只保證它不會公開在網路上，不保證它不會進版控——
      // 所以 inGit 為 true 時不能降級，那是確定會被上傳到 GitHub。
      //
      // inGit 為 null（沒有版控資訊）時仍然降級，維持原本行為。
      // 理由：無條件擋下會讓需要 `.env` 的建置流程無法進行，而
      // 「一條讓正當流程無法進行的規則，最後只會被繞過或關掉」。
      // 但說明文字要誠實標示這次沒有檢查版控，見 versionControlNote。
      if (mayDowngrade && inOutput === false && inGit !== true) {
        if (isAllowed) {
          allowedCount += 1;
          continue;
        }

        const base = blockingRule.outsideReason ?? blockingRule.reason;
        const note = inGit === null
          ? " ⚠️ 這次掃描沒有取得版本控制資訊，因此**無法確認它會不會被推到 GitHub**。"
            + "若這個資料夾是 git 專案，請另外用 `git check-ignore -v <路徑>` 確認它已被排除。"
          : "";

        confirm.push({
          path: rel,
          reason: base + note,
          ruleId: blockingRule.id,
          inOutput,
          inGit,
        });
        continue;
      }

      // 走到這裡有兩種情況：規則本來就不可降級，或它會被推上 GitHub。
      // 後者要把理由講清楚，否則使用者會困惑「不是說產物目錄外就不會上傳嗎」。
      const gitReason = mayDowngrade && inOutput === false && inGit === true
        ? blockingRule.reason
          + " ⚠️ **這個檔案不在產物目錄內，所以不會公開在網站上——但它會被 git 納入版控，"
          + "也就是會被推到 GitHub。** 兩個出口的檔案範圍不同，"
          + "「不會出現在網站上」不等於「不會被上傳」。"
          + "正確做法是把它加進 `.gitignore`，或移出專案資料夾。"
        : blockingRule.reason;

      blocking.push({ path: rel, reason: gitReason, ruleId: blockingRule.id, inOutput, inGit });
      continue;
    }

    const confirmRule = CONFIRM_RULES.find((rule) => rule.test(name, rel));

    if (confirmRule === undefined) {
      continue;
    }

    // 空白範本不是真實資料，不必每次都問。
    if (confirmRule.id === "spreadsheet" && isTemplate(name)) {
      continue;
    }

    if (isAllowed) {
      allowedCount += 1;
      continue;
    }

    confirm.push({
      path: rel,
      reason: confirmRule.reason,
      ruleId: confirmRule.id,
      hint: confirmRule.hint,
      inOutput,
      inGit,
    });
  }

  // 排序依「會被送到幾個地方」由多到少——那才是風險高低。
  //
  // 只看 inOutput 不夠：對 worker 型專案 inOutput 恆為 true（產物是打包後的
  // 腳本，沒有單一輸出目錄），那個軸完全不具鑑別力，此時 inGit 是唯一有資訊的維度。
  const destinationCount = (item) => (item.inOutput ? 1 : 0) + (item.inGit === true ? 1 : 0);

  const sortByRisk = (a, b) => {
    const diff = destinationCount(b) - destinationCount(a);

    if (diff !== 0) {
      return diff;
    }

    // 出口數相同時，「確定會進版控」排在「不確定」前面。
    if ((a.inGit === null) !== (b.inGit === null)) {
      return a.inGit === null ? 1 : -1;
    }

    return a.path.localeCompare(b.path);
  };

  blocking.sort(sortByRisk);
  confirm.sort(sortByRisk);

  return { blocking, confirm, allowedCount, scanned: files.length, truncated, outputDir };
}

/**
 * 掃描無法涵蓋、只能請使用者自己判斷的事。
 *
 * 誠實宣告限制比假裝掃乾淨了更有用——使用者才知道還有哪些要自己看。
 *
 * @param {string} root
 * @returns {string[]}
 */
export function scanLimitations(root) {
  const { files } = collectAllFiles(root);
  /** @type {string[]} */
  const notes = [];

  const images = files.filter((file) => /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(extname(file)));
  const pdfs = files.filter((file) => extname(file).toLowerCase() === ".pdf");

  if (images.length > 0) {
    notes.push(
      `專案內有 ${images.length} 個圖片檔。圖片內容無法自動判讀——`
      + "若其中有教室、實作現場或螢幕的照片，請自行檢視四個角落是否拍到白板、螢幕或文件資訊。",
    );
  }

  if (pdfs.length > 0) {
    notes.push(
      `專案內有 ${pdfs.length} 個 PDF。本掃描只看檔名，不讀內文——`
      + "若是考卷或講義，請自行確認散布授權，以及頁面上有無手寫註記。",
    );
  }

  return notes;
}
