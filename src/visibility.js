// @ts-check

/**
 * 可見性政策：單一事實來源。
 *
 * 每一種可見性對應三個獨立問題，這三者不可混為一談：
 *   1. 會不會列在展示中心？
 *   2. 知道網址的人能不能直接開啟？
 *   3. 專案部署時要不要注入權限閘道？
 *
 * 例如 unlisted 的重點就是「不列出，但直接開得了」——它不需要密碼，
 * 也不需要任何驗證。
 *
 * 2026-09-04 更正：這裡原本接著寫「因此**不應該**注入閘道」。那句話已經
 * 不成立——所有專案一律注入閘道，權限才能在後台改完就生效（理由見
 * `runWorkerFirstFor()`）。`requiresAccessGate()` 保留原意，現在只用於
 * 「這個狀態要不要對訪客設限」，不再決定「要不要注入」。
 *
 * 對照階段二計畫第 24 節與主規格 RULE-003／RULE-004。
 */

/** 五種可見性狀態，順序固定。 */
export const VISIBILITY_STATES = Object.freeze([
  "public",
  "unlisted",
  "password",
  "private",
  "disabled",
]);

/** 需要在專案 Worker 注入權限閘道的狀態。 */
const GATED_STATES = new Set(["password", "private", "disabled"]);

/**
 * 會列在公開展示中心的狀態 —— **單一事實來源**。
 *
 * `password` 也列出是刻意的（2026-08-23 使用者裁定）：加密專案若完全不列出，
 * 就沒有人知道它存在、也不會來要密碼，那個功能等於白做。列出但打不開，
 * 才是「看得到、要問你拿鑰匙」。
 *
 * 因此列出的判準**不是**「能不能直接開啟」，而是「該不該讓人知道它存在」：
 *   - `unlisted` 明明打得開卻不列出 —— 它的用途就是「不宣傳」。
 *   - `password` 打不開卻要列出 —— 它的用途是「公開存在、限制內容」。
 * 這兩個看似矛盾，其實是同一條規則的兩面，所以兩個軸必須分開判斷。
 *
 * `src/repositories/gallery.js` 的 SQL 條件由這個常數產生，不再各自寫死。
 * 以前兩邊各有一份定義，而漏改的那一次不會有任何錯誤訊息——
 * 首頁就是靜靜地顯示錯的東西。
 */
export const GALLERY_LISTED_STATES = Object.freeze(["public", "password"]);

/** 知道網址就能直接開啟的狀態。 */
const DIRECTLY_REACHABLE_STATES = new Set(["public", "unlisted"]);

/**
 * @param {string} visibility
 * @returns {boolean}
 */
export function isValidVisibility(visibility) {
  return VISIBILITY_STATES.includes(visibility);
}

/**
 * 是否列在公開展示中心。見 `GALLERY_LISTED_STATES` 的說明。
 *
 * @param {string} visibility
 * @returns {boolean}
 */
export function isListedInGallery(visibility) {
  return GALLERY_LISTED_STATES.includes(visibility);
}

/**
 * 列出時是否要標記「需要密碼」。
 *
 * 展示中心對外只輸出這個布林值，**不輸出 visibility 原值**：前端只需要知道
 * 要不要顯示標記，不需要知道權限狀態。少輸出一個欄位就少一條洩漏路徑，
 * 也讓「回應不得包含 visibility」那條既有的安全測試繼續成立。
 *
 * @param {string} visibility
 * @returns {boolean}
 */
export function requiresPasswordToOpen(visibility) {
  return visibility === "password";
}

/**
 * 知道網址的人能否直接開啟，不需要任何驗證。
 *
 * @param {string} visibility
 * @returns {boolean}
 */
export function isDirectlyReachable(visibility) {
  return DIRECTLY_REACHABLE_STATES.has(visibility);
}

/**
 * 部署該專案時是否需要注入權限閘道。
 *
 * @param {string} visibility
 * @returns {boolean}
 */
export function requiresAccessGate(visibility) {
  return GATED_STATES.has(visibility);
}

/**
 * 產生專案部署時應使用的 `run_worker_first` 設定。
 *
 * ## 2026-09-04 起一律回傳 `["/*"]`，不再看 visibility
 *
 * 原本的做法是：不需要閘道的狀態回空陣列，靜態資源直接送出、不經過 Worker，
 * 請求免費且無上限。那在「權限烙印在部署當下」的前提下是對的最佳化。
 *
 * 但那個前提本身就是 bug 的來源：使用者在後台把專案改成公開，線上的 Worker
 * 不知道，仍然回 404，而且**重新部署也修不好**——`hub ship` 會因為
 * 「不需要閘道」而整段跳過。所以權限改成即時查詢（見
 * `src/access-gate/policy-lookup.js`），而即時查詢的前提是 Worker 一定要跑到。
 *
 * 這裡是**安全需求而不是效能選擇**：如果只讓需要閘道的狀態經過 Worker，
 * 一個私人專案的 CSS、JS、圖片就有一條繞過檢查的路徑；而 visibility 隨時
 * 可能從公開變成私人，設定檔卻是部署當下就固定的。
 *
 * 代價已與使用者確認（2026-09-04）：公開專案的靜態請求從「免費、無上限」
 * 變成計入 Worker 的每日 100,000 次請求額度。一次頁面載入含 10 個子資源
 * 就是 11 次，換算約 9,000 次頁面載入／天。
 *
 * 刻意不收參數：留一個被忽略的參數，讀的人會以為它還有作用。
 *
 * @returns {string[]}
 */
export function runWorkerFirstFor() {
  return ["/*"];
}

/**
 * 給管理介面用的說明文字，讓使用者知道每個狀態實際代表什麼。
 *
 * @param {string} visibility
 * @returns {{ listed: boolean, directLink: boolean, gated: boolean }}
 */
export function describeVisibility(visibility) {
  return {
    listed: isListedInGallery(visibility),
    directLink: isDirectlyReachable(visibility),
    gated: requiresAccessGate(visibility),
  };
}
