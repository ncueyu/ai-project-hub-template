// @ts-check

/**
 * 部署踩坑清單 —— 單一權威來源。
 *
 * ## 為什麼要有這個檔案
 *
 * 這些坑每一個都花了實際的除錯時間才找到。它們的共同特徵是
 * **不會有錯誤訊息告訴你哪裡錯了**：
 *   - 部署顯示成功，但頁尾時間是三天前的
 *   - 掃描回報「未發現需確認項目」，但危險的檔案從頭到尾不在清單裡
 *   - 遮罩程式跑完了，尺寸也沒變，但馬賽克蓋在錯誤的位置
 *
 * 寫在對話裡會隨對話消失；寫成散落的紀錄檔沒人會在對的時機讀到。
 * 因此集中成結構化資料，讓 `hub pitfalls` 與 MCP 工具都讀這一份。
 *
 * ## 給 AI 助理的使用方式
 *
 * 執行任何部署相關操作**之前**先查詢對應情境的項目。
 * 每一項的 `detect` 欄位寫的是「怎麼確認自己踩到了」——
 * 這比 `fix` 更重要，因為多數坑的難處在於察覺，不在於修。
 */

/**
 * @typedef {{
 *   id: string,
 *   scope: string,
 *   title: string,
 *   symptom: string,
 *   cause: string,
 *   fix: string,
 *   detect?: string,
 * }} Pitfall
 */

/** 情境分類。查詢時可用來篩選。 */
export const SCOPES = Object.freeze({
  tooling: "指令與環境",
  config: "設定檔",
  deploy: "部署",
  database: "資料庫（D1）",
  verify: "驗證方式",
  content: "教材與圖片",
});

/** @type {Pitfall[]} */
export const PITFALLS = Object.freeze([
  // ─── 指令與環境 ───────────────────────────────────────────────
  {
    id: "cli-not-in-path",
    scope: "tooling",
    title: "wrangler 與 pnpm 不在系統 PATH",
    symptom: "輸入 `wrangler` 得到「無法辨識 'wrangler' 詞彙」（CommandNotFoundException）。",
    cause: "兩者都是專案的本地依賴，不是系統工具。",
    fix: "用 `.\\node_modules\\.bin\\wrangler.CMD`（或 `npx wrangler`）；pnpm 用 `corepack pnpm`。",
  },
  {
    id: "windows-npm-env",
    scope: "tooling",
    title: "Windows 的 npm script 設不了環境變數",
    symptom: "`BUILD_ENVIRONMENT=production node script.mjs` 在 cmd／PowerShell 完全無效，變數讀不到。",
    cause: "`VAR=x cmd` 這種前綴語法是 POSIX shell 專屬，Windows 不支援。",
    fix: "改用 CLI 參數（例如 `--env=production`），最單純且跨平台，不必為此裝 cross-env。",
  },
  {
    id: "powershell-tls",
    scope: "tooling",
    title: "PowerShell 5.1 連 Cloudflare 需指定 TLS 1.2",
    symptom: "`Invoke-WebRequest` 回「無法建立 SSL/TLS 的安全通道」。",
    cause: "PowerShell 5.1 預設用 TLS 1.0，Cloudflare 直接拒絕。",
    fix: "`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`；"
      + "更可靠的做法是改用 `node -e \"fetch(...)\"`。",
  },

  // ─── 設定檔 ──────────────────────────────────────────────────
  {
    id: "d1-create-adds-binding",
    scope: "config",
    title: "`wrangler d1 create` 會偷改設定檔",
    symptom: "同一個資料庫掛在兩個 binding 名稱下，程式讀到的那個還帶著舊的佔位 ID。",
    cause: "指令會問「Would you like Wrangler to add it on your behalf?」，"
      + "選 yes 時它是**附加一組新的 binding**（名稱取自資料庫名），不是更新既有那組。",
    fix: "建完資料庫立刻打開 wrangler 設定檔核對，把真實 ID 併進程式實際使用的 binding，刪掉多出來的。",
    detect: "搜尋設定檔裡 `d1_databases` 的項數，以及程式碼實際讀的 binding 名稱（例如 `env.DB`）。",
  },
  {
    id: "assets-root-directory",
    scope: "config",
    title: "assets 目錄不可指向專案根目錄",
    symptom: "上傳檔案數比實際網站檔案多，而且**每次執行的數字都不一樣**。",
    cause: "Wrangler 會把自己產生的 `.wrangler/tmp/` 暫存檔算進資產；"
      + "根目錄的設定檔與中介資料也會被當成網站內容上傳。`.assetsignore` 在此情境沒有生效。",
    fix: "網站檔案放專屬子目錄（例如 `public/`），設定檔與中介資料留在根目錄。",
    detect: "連跑兩次 dry-run，比較「Read N file(s)」的數字。會漂移就是踩到了。",
  },
  {
    id: "static-only-worker",
    scope: "config",
    title: "有 wrangler 設定檔不等於是 Worker",
    symptom: "純靜態網站被判定為 worker，接著去找不存在的進入點檔案。",
    cause: "Cloudflare 支援 static-only Worker：設定檔只有 `assets`、沒有 `main`，"
      + "代表沒有伺服器端程式碼，wrangler 只是上傳工具。",
    fix: "型態判定要看 `main` 欄位是否存在，不能只看設定檔是否存在。",
  },

  // ─── 部署 ────────────────────────────────────────────────────
  {
    id: "deploy-skips-buildinfo",
    scope: "deploy",
    title: "直接呼叫 wrangler deploy 會跳過前置步驟",
    symptom: "部署成功，但網頁頁尾顯示的是上一次的舊時間。",
    cause: "`pnpm run deploy` 是兩個動作（先產生部署資訊，再部署）。"
      + "直接呼叫底層指令只做了第二個。",
    fix: "一律用 `corepack pnpm run deploy`。",
  },
  {
    id: "tls-cert-wait",
    scope: "deploy",
    title: "新網址的 TLS 憑證要等一下（不是部署失敗）",
    symptom: "部署成功、DNS 查得到，但 HTTPS 連線回 `SSL alert number 40`（handshake failure）。",
    cause: "workers.dev 子網域第一次註冊或剛改名後，Cloudflare 需要時間簽發憑證。實測約 60 秒。",
    fix: "等待並重試。",
    detect: "拿 `https://www.cloudflare.com` 當對照組。對照組 200、目標 ERR → 等憑證；兩個都 ERR → 自己的網路問題。",
  },
  {
    id: "route-propagation-404",
    scope: "deploy",
    title: "剛部署完的 404 是路由未生效",
    symptom: "部署成功但所有路徑都回 404。",
    cause: "Cloudflare 還沒把該 Worker 掛上該主機名。實測約 15 秒。",
    fix: "等待並重試。",
    detect: "**看回應長度**：約 19,984 位元組且內容是 `Page not found` 的 404 是 **Cloudflare** 回的"
      + "（Worker 還沒接手）；長度 0 的 404 是 **Worker 自己**回的（它在服務，只是沒這個檔）。",
  },
  {
    id: "subdomain-is-account-wide",
    scope: "deploy",
    title: "workers.dev 子網域是帳號層級，不是專案層級",
    symptom: "取了專案名當子網域，之後在同一帳號放別的網站就很怪。",
    cause: "網址是 `<Worker 名稱>.<帳號子網域>.workers.dev`，後半段整個帳號共用。",
    fix: "子網域取個人或單位識別代號。要改就趁還沒把網址給任何人時改——舊網址會立刻 DNS 查不到。"
      + "修改位置：Cloudflare Dashboard → Workers & Pages → Subdomain。",
  },
  {
    id: "dryrun-not-remote",
    scope: "deploy",
    title: "dry-run 不驗證遠端資源是否存在",
    symptom: "dry-run 通過，正式部署卻失敗。",
    cause: "dry-run 只檢查設定檔語法與打包，不會去問 Cloudflare「這個資源真的存在嗎」。",
    fix: "設定裡宣告的每個資源（資料庫、儲存桶）都要確認已實際建立。",
  },

  {
    id: "asset-count-includes-dirs",
    scope: "deploy",
    title: "dry-run 的「Read N files」把子目錄也算進去",
    symptom: "產物目錄有子資料夾時，回報的數字比實際檔案數多，看起來像夾帶了不明檔案。",
    cause: "那個數字是「檔案數 ＋ 子目錄數」。實際上傳的只有檔案 ——"
      + "實測 3 個檔 ＋ 1 個子目錄，dry-run 報 4，deploy 卻是「Uploaded 3 of 3 assets」。",
    fix: "核對時算進子目錄數。**不要拿它直接跟檔案數比對**，否則任何有子目錄的專案都會被誤判成壞掉。",
    detect: "這個數字仍然適合用來抓「漂移」：連跑兩次，數字變動就是暫存檔被算進去了。"
      + "但要確認絕對值，看 deploy 輸出的「Uploaded N of N assets」。",
  },
  {
    id: "platform-config-conflict",
    scope: "deploy",
    title: "別的平台留下的設定檔會讓部署失敗",
    symptom: "資產全部上傳成功，最後建立版本那一步失敗：`Invalid _redirects configuration: Infinite loop detected`。",
    cause: "`public/_redirects` 是 Cloudflare **Pages** / Netlify 的 SPA fallback 慣例，"
      + "但在 Cloudflare **Workers static assets** 上，同一條 `/* /index.html 200` 會被判定為無限迴圈。"
      + "Workers 的 SPA fallback 要寫在 wrangler 設定檔的 `assets.not_found_handling`。",
    fix: "移除 `_redirects`（在 Workers 上既無效又有害），改用 "
      + "`\"assets\": { \"not_found_handling\": \"single-page-application\" }`。"
      + "**留一份說明檔記錄為什麼移除**，否則日後有人會把它加回來。",
    detect: "從別的平台遷移過來的專案要先找平台專屬設定檔："
      + "`_redirects`、`_headers`、`netlify.toml`、`vercel.json`、`.vercelignore`。",
  },
  {
    id: "spa-fallback-breaks-404-check",
    scope: "deploy",
    title: "SPA fallback 讓「404 檢查」完全失效",
    symptom: "驗證設定檔沒外洩時，`/.env`、`/wrangler.jsonc` 全部回 **200**，看起來像大量外洩。",
    cause: "開了 `not_found_handling: single-page-application` 之後，**所有未知路徑都回 index.html 並帶 200**。"
      + "先前用的「404 且長度 0 = 沒外洩」判準在 SPA 部署上不成立。",
    fix: "改用**內容比對**：抓一份首頁當基準，逐一比對可疑路徑的回應是否與首頁完全相同。"
      + "相同 = SPA fallback（安全）；不同且看起來像 `KEY=VALUE` 或 JSON = 真的外洩。",
    detect: "所有可疑路徑的回應長度**完全一樣**就是 fallback 的特徵——"
      + "但別停在這裡，要真的比對內容，長度相同也可能是巧合。",
  },
  // ─── 資料庫 ──────────────────────────────────────────────────
  {
    id: "d1-command-quoting",
    scope: "database",
    title: "PowerShell 會弄壞含多重引號的 `--command`",
    symptom: "SQL 明明正確，卻回 Cloudflare API failed 或語法錯誤。",
    cause: "PowerShell 對引號的處理會改寫傳給外部程式的字串。",
    fix: "複雜 SQL 寫進 `.sql` 檔，用 `--file` 執行。",
  },
  {
    id: "d1-compound-select-limit",
    scope: "database",
    title: "D1 的 compound SELECT 有數量上限",
    symptom: "`too many terms in compound SELECT: SQLITE_ERROR`。",
    cause: "6 個 `UNION ALL` 就會超過上限。",
    fix: "拆成多次查詢。",
  },
  {
    id: "timestamp-by-sqlite",
    scope: "database",
    title: "時間戳交給資料庫現算，不要人工填",
    symptom: "資料庫裡的日期比預期晚一天（或早一天）。",
    cause: "長時間工作會跨日；人腦記的日期與實際時間不同步，而且錯了不容易發現。",
    fix: "用 `strftime('%Y-%m-%dT%H:%M:%SZ','now')`。同理，工作紀錄檔名跨日時要換新檔。",
  },
  {
    id: "local-d1-per-database-id",
    scope: "database",
    title: "本機模擬資料庫是依 database_id 分目錄的",
    symptom: "換了真實 `database_id` 之後，本機查詢回 `no such table`。",
    cause: "Wrangler 的本機 D1 檔案以 database_id 命名，換 ID 等於指向一個全新的空資料庫。",
    fix: "重新 `d1 migrations apply --local` 並灌種子資料。",
  },

  // ─── 驗證方式 ────────────────────────────────────────────────
  {
    id: "deploy-success-not-proof",
    scope: "verify",
    title: "「部署成功」不能證明檔案真的換了",
    symptom: "部署完成，但線上看到的還是舊內容。",
    cause: "可能拿到快取，也可能根本沒上傳到那個檔案。",
    fix: "抓線上檔案下來**比對位元組大小**與本機檔案是否相同。",
    detect: "`fetch(線上網址) → buffer.length` 與 `fs.statSync(本機檔).size` 相等才算數。",
  },
  {
    id: "verifier-vs-intent",
    scope: "verify",
    title: "會對「刻意的正確狀態」報錯的檢查，比沒有檢查更糟",
    symptom: "驗證腳本永遠有一項紅的，而那一項其實是刻意的決定。",
    cause: "決定改變了（例如刻意不啟用某個服務），但驗證條件沒跟著改。",
    fix: "把那項改成選配式檢查：未宣告不算失敗，一旦宣告就檢查其正確性。"
      + "**放著不管會教人習慣忽略驗證輸出。**",
  },
  {
    id: "scanner-blind-to-binary",
    scope: "verify",
    title: "內容掃描器看不到二進位檔",
    symptom: "掃描回報「未發現問題」，但危險的檔案從頭到尾不在清單裡。",
    cause: "內容掃描會跳過二進位副檔名（讀不了內容，跳過是對的）。"
      + "但照片、試算表、PDF、壓縮檔全是二進位——那些正是最需要抓的。",
    fix: "檔名判定與內容判定要用**兩套不同的走訪**：後者可以跳過二進位，前者不行。",
    detect: "拿一個含 PNG 的資料夾測掃描器，看回報的檔案數是否包含那張圖。",
  },
  {
    id: "masking-needs-second-pair-of-eyes",
    scope: "verify",
    title: "圖片遮罩必須由另一個人（或另一次獨立檢視）驗證",
    symptom: "遮罩程式跑完、尺寸沒變，但馬賽克蓋在錯誤的位置。",
    cause: "座標多為目視估計，有偏差。而程式只能確認「像素被改了」，無法確認「改對地方」。",
    fix: "遮罩後逐張獨立複查三個問題：①遮到了嗎（原文是否已不可辨讀）②**遮過頭了嗎**"
      + "（有沒有蓋住要點擊的按鈕、紅色標註框）③還有別的漏網嗎。"
      + "遮過頭比漏遮更嚴重——教材直接失效，而且不會有任何錯誤訊息。",
    detect: "務必先備份原圖。實測第一輪 11 張裡有 3 張遮錯，其中一張完全沒遮到。",
  },
  {
    id: "fake-secrets-in-tests",
    scope: "verify",
    title: "Secret 掃描的測試檔警告要人工看過",
    symptom: "掃描報告列出測試檔裡的金鑰。",
    cause: "測試**必須**含假憑證才驗得了擋不擋得住，所以這類警告是預期的。",
    fix: "打開看過確認是假的（例如 jwt.io 官方範例、`MIIE...` 截斷佔位）。"
      + "**不要無腦忽略，也不要無腦相信**——你必須真的看過才能說它是假的。",
  },

  {
    id: "zip-filename-encoding",
    scope: "config",
    title: "zip 內的中文檔名可能在別台機器解出亂碼",
    symptom: "解壓後網頁的圖片破圖，但在你自己電腦上一切正常。",
    cause: "zip 若沒有設 UTF-8 旗標（`flag_bits & 0x800` 為 0），檔名是用**建立時的本機碼頁**存的。"
      + "解壓工具會依自己的環境猜——在同語系機器上猜對，換一台就變亂碼，"
      + "而 HTML 裡引用的是正確的中文檔名，於是 404。",
    fix: "不要靠猜編碼。**解壓後逐一驗證 HTML 引用的每個本機檔案都真的存在** ——"
      + "這條檢查不管成因（編碼、漏檔、路徑層級不同）都能抓到。",
    detect: "解析 index.html 的 src/href，濾掉外部網址，逐一檢查檔案是否存在於產物目錄。",
  },
  {
    id: "scan-noise-outside-output",
    scope: "verify",
    title: "掃描範圍大於實際上傳範圍，會製造無效警告",
    symptom: "每次部署都要為同樣一個「其實不會被上傳」的檔案做確認。",
    cause: "掃描看整個專案資料夾，但實際上傳的只有產物目錄（例如 `public/`）。"
      + "不區分的話，產物在子目錄的專案會一直收到不相關的警告。",
    fix: "每筆發現都標示是否位於產物目錄內，並讓「會被上傳」的排在前面。"
      + "兩者都要報（整包壓縮分享時仍會外洩），但優先序必須不同。",
    detect: "**雜訊本身就是症狀**：使用者開始不看警告內容直接放行，這道關卡就已經失效了。",
  },
  {
    id: "rule-blocks-legit-workflow",
    scope: "verify",
    title: "讓正當流程無法進行的規則，最後會被繞過",
    symptom: "需要建置的專案永遠無法通過部署前檢查，因為專案根目錄有 `.env`。",
    cause: "把「`.env` 存在就阻擋」寫成無條件規則。但 Vite／Next.js 在 build 時**必須**讀它"
      + "（`VITE_`／`NEXT_PUBLIC_` 前綴的變數會被編進 bundle），那個檔案本來就該在專案根目錄。",
    fix: "規則要看**位置**而不只看存在：在產物目錄內才阻擋（那是真的外洩），"
      + "在外則降為需確認並說明「這次不會上傳，但整包分享時仍會外洩」。",
    detect: "**規則被繞過或關掉就是症狀。** 一條讓正當流程無法進行的規則等於沒有規則——"
      + "使用者會加例外、改設定，或乾脆不跑檢查。",
  },
  {
    id: "vendor-bundle-trips-scanner",
    scope: "verify",
    title: "第三方套件的打包產物必然會踩到內容掃描器",
    symptom: "每次建置後 Secret 掃描都紅一次，命中處在 `vendor-*.js` 裡，而且你改不了。",
    cause: "打包後的 SDK 含大量字串常數。實測 Supabase SDK 有這一段："
      + "`{ close: \"phx_close\", access_token: \"access_token\" }` —— "
      + "`access_token` 只是屬性名對應到同名字串，不是憑證，但樣式比對看不出差別。",
    fix: "把 vendor 產物與自己的原始碼**分開判定**：vendor 命中降為提醒級但仍列出"
      + "（第三方套件理論上也可能真的夾帶金鑰）。"
      + "**不要整項忽略** —— 那會讓人連自己原始碼的命中一起滑過去。",
    detect: "路徑特徵：`node_modules/`、`vendor-*.js`、`chunk-*.js`。"
      + "判定是否誤報要**真的看上下文**：有沒有「`access_token` = <20 字以上的隨機字串>」這種賦值。",
  },
  // ─── 教材與圖片 ──────────────────────────────────────────────
  {
    id: "hidden-overridden-by-class",
    scope: "content",
    title: "`hidden` 屬性會被類別選擇器的 display 覆蓋",
    symptom:
      "元素加了 `hidden` 卻照樣顯示。已知在本專案發生四次："
      + "`.nav-link`（管理後台連結）、`.project-category` 與 `.project-kind`（卡片標記）、"
      + "`.filter-group`（沒有標籤時的「依標籤」標題）、`.button`（「清除篩選條件」按鈕）。",
    cause:
      "`hidden` 只是靠瀏覽器預設樣式的 `display: none` 生效，"
      + "任何來自類別選擇器的 `display` 都會蓋掉它。",
    fix:
      "**逐個修是沒用的——這條坑重複發生四次，就是因為只記了修法沒記偵測法。**"
      + " 規則：任何會被 JS 設 `hidden` 的元素，只要它的 class 有 `display`，就必須配一條 `[hidden]` 覆寫；"
      + "共用類別（`.button` 這種）要寫在共用樣式表，不要在各頁面重複補。"
      + " 改完一定要用下面的偵測指令掃過每一頁，不要只確認自己剛改的那一個。",
    detect:
      "在瀏覽器 console 對**每一個頁面狀態**（首頁、後台、表單開啟後、篩選套用後）執行：\n"
      + "  [...document.querySelectorAll('[hidden]')]\n"
      + "    .filter(el => getComputedStyle(el).display !== 'none')\n"
      + "    .map(el => el.id || el.className)\n"
      + "回傳空陣列才算過。這一招會把所有失效處一次列完，不必等使用者回報。",
  },
  {
    id: "lazy-image-placeholder-lies",
    scope: "content",
    title: "lazy 載入期間的佔位文字會說謊",
    symptom: "有縮圖的卡片先閃過「尚無預覽圖」再顯示圖片。",
    cause: "`loading=\"lazy\"` 的圖片捲到畫面才開始載入，佔位區塊在那之前就顯示了。",
    fix: "分開控制「佔位圖示」與「說明文字」：載入中只留圖示，載入失敗或真的沒有圖時才顯示文字。",
  },
  {
    id: "no-compositing-no-lazyload",
    scope: "content",
    title: "自動化瀏覽器不合成畫面時 lazy 載入不會觸發",
    symptom: "測試時圖片永遠 `naturalWidth: 0`、`currentSrc` 為空，看起來像圖片壞了。",
    cause: "瀏覽器面板未顯示時頁面不合成畫面，IntersectionObserver 不會觸發。",
    fix: "測試時暫時把 `loading` 改成 `eager` 並重新指定 `src`。",
    detect: "用一個全新的 `new Image()` 測同一個 URL。它載入成功而頁面上的 `<img>` 仍 `complete: false`，"
      + "就是 lazy 沒觸發，不是圖片問題。",
  },
  {
    id: "screenshot-background-leaks",
    scope: "content",
    title: "照片背景是最容易夾帶敏感資訊的地方",
    symptom: "沒有症狀——這就是問題所在。",
    cause: "拍攝時注意力在主體上，背景的白板、螢幕、文件不會被注意到。",
    fix: "凡是教室、實作現場、含螢幕的照片，上傳前**逐張檢視四個角落**。",
    detect: "實際案例：一張教室維修紀錄照片的白板右上角拍到了 Wi-Fi 名稱與密碼。",
  },
  {
    id: "reverse-test-cannot-distinguish",
    scope: "verify",
    title: "反向測試也會假通過：情境本身分不出新舊行為",
    symptom:
      "為了確認新測試真的守住修正，把修正整條移除後重跑——**測試仍然全過**。"
      + "看起來像「修正其實沒必要」，實際上是測試情境選錯了。",
    cause:
      "反向測試的前提是「這個情境在新舊行為下結果不同」。"
      + "2026-08-23 的實例：新排序依「會被送到幾個出口」，舊排序只看「是否在產物目錄」。"
      + "第一版測試挑的兩個檔案，一個是兩個出口都會送（新算 2、舊算 1），"
      + "另一個兩個出口都不送（新算 0、舊算 0）——**兩種算法排出來的順序一模一樣**，"
      + "所以移除修正也不會失敗。",
    fix:
      "設計反向測試的情境時，先問：**新舊規則在這個情境下的結果會不同嗎？**"
      + " 讓兩個判斷軸**互相衝突**才有鑑別力——上面的例子改成兩個檔案都在產物目錄"
      + "（第一軸相同），只有一個會進版控（第二軸不同），"
      + "並讓檔名的字母順序與正確順序**相反**，這樣舊規則會退回字母序而排錯。",
    detect:
      "反向測試「沒有失敗」時不要當成好消息，那是**兩種結論**："
      + "①修正沒必要　②測試沒鑑別力。"
      + "先假設是②去檢查，因為①很少見而②很常見。"
      + " 判斷方法：把該情境的輸入手算一遍新舊兩種結果，不同才算有效測試。",
  },
  {
    id: "mosaic-block-too-small",
    scope: "content",
    title: "馬賽克格子太小，看起來遮了其實還讀得出來",
    symptom:
      "同一組參數遮四張圖，三張成功、一張的驗證碼「5 1 1 8 - 9 E 2 5」"
      + "隔著馬賽克還是清清楚楚。**而且外觀上看起來是遮過的**——"
      + "有格子、有模糊感，很容易就當成處理完了。",
    cause:
      "馬賽克是把區域縮小再放大。格子邊長固定 5px 時，"
      + "終端機的小字（約 14px）會被打散，但輸入框裡約 40px 高的大數字"
      + "只被切成 8 格左右，字形輪廓完整保留下來。"
      + "遮蔽強度取決於**格子相對於字高的比例**，不是格子的絕對大小。",
    fix:
      "格子邊長要跟字級成比例，抓約**字高的三分之一以上**"
      + "（本專案實測：14px 終端機字用 5px 可以，40px 大數字要 16px）。"
      + " 同一批圖若字級差很多，不能套同一個參數——分開處理。",
    detect:
      "**唯一可靠的驗證是把遮完的圖打開來看，並試著把內容念出來。**"
      + "念得出來就是沒遮到。比對檔案雜湊、確認程式沒報錯、看到「有馬賽克」"
      + "都不算驗證過——2026-08-17 那次「遮錯位置的三張」也是這樣漏掉的。",
  },
  {
    id: "backup-becomes-the-leak",
    scope: "content",
    title: "遮罩前的備份，本身就是洩漏來源",
    symptom:
      "截圖都遮好了、也複查過了，但 `_遮罩前備份-20260817/` 這個資料夾"
      + "跟著一起進了版控——裡面 11 張是帳號資訊還看得見的原檔。"
      + "**沒有任何錯誤訊息**，畫面上也看不出異常。",
    cause:
      "遮罩是破壞性編輯，所以動手前先備份原檔——這是正確做法，"
      + "2026-08-17 就靠備份救回遮錯位置的三張。"
      + "但備份保留的正是「還沒遮」的版本。做對的事製造了新的風險。",
    fix:
      "備份留在本機，**不進版控、不上傳**。`.gitignore` 加 `_遮罩前備份*/`、"
      + "`*_未遮罩備份*/`、`*-遮罩前/`；掃描工具也要有對應規則"
      + "（本專案已加 `pre-mask-backup` 阻擋規則）。"
      + " 更一般的原則：**任何「處理前」的備份都要跟著遮罩／清理規則一起被排除**，"
      + "不然清理只是把原始資料換了個資料夾放。",
    detect:
      "commit 前把「實際會被上傳的檔案清單」拉出來，用關鍵字掃一遍："
      + "`遮罩前`、`未遮`、`備份`、`backup`、`_orig`、`before`。"
      + " 不要只看掃描工具的結論——這個資料夾是圖片，內容掃描讀不出來，"
      + "只有檔名層級的規則或人工看清單才抓得到。",
  },
  {
    id: "taxonomy-duplicate-names",
    scope: "database",
    title: "分類與標籤只擋代稱重複，沒擋名稱重複",
    symptom:
      "下拉選單裡出現兩個一模一樣的「老師行政用」，專案被拆到不同分類，"
      + "但畫面上看不出差別，篩選時每邊都只有一半的專案。",
    cause:
      "唯一性檢查只做在代稱（slug）上。代稱由系統自動產生所以永遠不重複，"
      + "名稱卻是使用者手打的——重打一次就多一個。"
      + "而代稱只出現在網址上，使用者根本不會注意到兩者代稱不同。",
    fix:
      "名稱也要檢查唯一性，比對時去掉前後空白並忽略大小寫"
      + "（`LOWER(TRIM(name)) = LOWER(TRIM(?))`），更新時記得把自己排除（`id != ?`），"
      + "否則把名稱改成原本的值會被自己擋住。"
      + " 錯誤訊息要指向正確動作：「請從清單中選用既有的分類」，而不只是「名稱重複」。",
    detect:
      "連續送兩次同樣的名稱到 `POST /api/categories`。第二次必須回 409，"
      + "而不是 201。再測三種變形：前後加空白、改大小寫、把某一筆改名成別人的名稱。",
  },
  {
    id: "api-english-ui-chinese",
    scope: "content",
    title: "API 錯誤訊息是英文，介面卻是中文",
    symptom:
      "中文介面上突然冒出一句英文，例如按了上傳圖片後顯示"
      + "「Thumbnail storage is not configured.」。",
    cause:
      "`error.message` 是給開發者的除錯字串，寫成英文是合理的；"
      + "但前端直接把它顯示給使用者。本專案 42 處 `jsonError` 全是英文，"
      + "只有欄位層級的 `error.fields` 是中文——所以「有 fields 的錯誤」看起來正常，"
      + "偏偏沒有 fields 的那些（儲存空間沒設定、找不到資料、內部錯誤）才是使用者最常撞到的。",
    fix:
      "不要去改 API 的英文訊息——`error.code` 才是穩定契約，改 message 會打壞測試。"
      + "在前端做一張 code → 中文的對照表，並統一套在送出請求的那個函式裡"
      + "（一處改完所有呼叫點都受益）。"
      + " 注意用 FormData 的上傳通常有自己的 `fetch`，不會經過那個函式，要另外補。",
    detect:
      "把每個錯誤碼實際觸發一次，看畫面上的字。"
      + "或用 `/[a-z]{4,}\\s+[a-z]{4,}/i` 比對錯誤區塊的文字——命中就是還沒中文化。",
  },
  {
    id: "lazy-image-false-negative",
    scope: "verify",
    title: "驗證圖片載入時，lazy 會讓好的圖片看起來是壞的",
    symptom:
      "`img.complete` 是 false、`naturalWidth` 是 0，看起來四張圖全掛，"
      + "但 curl 明明回 200 image/png。",
    cause:
      "`loading=\"lazy\"` 的圖片要進入可視區才開始載入。"
      + "自動化環境裡瀏覽器窗格可能沒有顯示、不合成畫面，圖片永遠不會進可視區，"
      + "於是永遠停在未載入狀態——這是驗證環境的假象，不是網站的問題。",
    fix:
      "不要憑 `img.complete` 就下結論。用 `new Image()` 直接抓同一個網址，"
      + "或把 `loading` 改成 `eager` 再重設 `src`，確認圖片本身沒問題。"
      + " 更根本的一層：先用 curl 確認 HTTP 狀態與 content-type，那一層不受 lazy 影響。",
    detect:
      "同一個網址在 curl 回 200 而瀏覽器說載入失敗，就要先懷疑是 lazy 或窗格未顯示，"
      + "而不是急著去改網站。",
  },
]);

/**
 * 取得踩坑清單，可依情境篩選。
 *
 * @param {{ scope?: string, id?: string }} [filter]
 * @returns {Pitfall[]}
 */
export function listPitfalls(filter = {}) {
  return PITFALLS.filter((item) => {
    if (typeof filter.id === "string" && filter.id !== "" && item.id !== filter.id) {
      return false;
    }

    if (typeof filter.scope === "string" && filter.scope !== "" && item.scope !== filter.scope) {
      return false;
    }

    return true;
  });
}

/**
 * render 成給人看的文字。
 *
 * @param {Pitfall[]} items
 * @returns {string}
 */
export function renderPitfalls(items) {
  if (items.length === 0) {
    return "找不到符合條件的項目。可用情境："
      + Object.entries(SCOPES).map(([key, label]) => `${key}（${label}）`).join("、");
  }

  /** @type {string[]} */
  const lines = [];
  let currentScope = "";

  for (const item of items) {
    if (item.scope !== currentScope) {
      currentScope = item.scope;
      lines.push("");
      lines.push(`── ${SCOPES[currentScope] ?? currentScope} ──`);
    }

    lines.push("");
    lines.push(`[${item.id}] ${item.title}`);
    lines.push(`  症狀：${item.symptom}`);
    lines.push(`  原因：${item.cause}`);
    lines.push(`  修法：${item.fix}`);

    if (typeof item.detect === "string") {
      lines.push(`  怎麼確認：${item.detect}`);
    }
  }

  lines.push("");
  lines.push(`共 ${items.length} 項。`);

  return lines.join("\n");
}
