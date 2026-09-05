// @ts-check

/**
 * 從 Hub 的 D1 即時查一個專案的權限設定。
 *
 * ## 為什麼需要這個模組
 *
 * 在此之前，專案的權限是**部署當下**烙進 `hub-gate-entry.js` 的常數。使用者
 * 在管理後台把專案改成公開之後，線上那個 Worker 完全不知道，仍然回 404——
 * 而後台其他設定（站名、版面、卡片要不要列出）全部都是即時的。實際發生的
 * 後果是：展示中心的卡片出現了、點進去是 404，畫面上看不出任何原因。
 *
 * 這個模組讓部署出去的專案 Worker 直接查 Hub 的資料庫，權限存好就生效，
 * 不需要重新部署。
 *
 * ## 為什麼三個欄位一起查，不是只查 visibility
 *
 * 只把 visibility 改成即時的話會做出一個新的壞狀態：專案原本是 private
 * （沒有密碼），使用者在後台設了密碼並改成「需要密碼」。即時的 visibility
 * 說是 password，但烙印的 `passwordHash` 是 null——密碼頁出現了，而**任何
 * 密碼都不會對**，使用者被鎖在自己的專案外面，且沒有任何錯誤訊息。
 *
 * 所以連 `password_hash` 與 `policy_version` 一起查。同一個 JOIN、同一次
 * 查詢，不多花任何成本，順帶讓改密碼也變成即時生效。
 *
 * ## 快取為什麼放在模組層
 *
 * 進入點每個請求都重新呼叫 `createProtectedWorker()`（`env` 只有進了
 * `fetch()` 才存在），所以快取不能放在閘道實例裡——那等於沒有快取。放在
 * 模組層才會跨請求共用：同一個 isolate 內，一次頁面載入的 11 個請求
 * （HTML ＋ CSS ＋ JS ＋ 圖片）只會查一次資料庫。
 *
 * 不用 Cloudflare 的 Cache API：那是跨 isolate 持久的，權限這種東西快取
 * 太久有風險。模組層變數會隨 isolate 回收自然消失，行為比較保守。
 *
 * ## 錯誤一律吞掉、回 null
 *
 * 查不到就讓呼叫端回退到烙印值（見 `protected-worker.js` 檔頭）。這個模組
 * 【不可】拋錯——它是每一個請求的必經之路，讓它有機會弄垮整個網站，
 * 換來的只是「知道 D1 出問題了」，不成比例。
 */

/** 預設快取時間。使用者在後台按下儲存之後，最慢這麼久就會生效。 */
export const DEFAULT_POLICY_TTL_MS = 30_000;

/**
 * 模組層快取。key 是 `projectId`，一個 Worker 只服務一個專案，但用 Map
 * 而不是單一變數，是為了讓測試能各自獨立、不互相汙染。
 *
 * @type {Map<number, { expiresAt: number, value: import("./protected-worker.js").ResolvedPolicy | null }>}
 */
const cache = new Map();

/**
 * 清掉快取。只給測試用——正式環境靠 TTL 自然過期。
 */
export function clearPolicyCache() {
  cache.clear();
}

/**
 * 建立一個「查這個專案目前權限」的函式。
 *
 * @param {{
 *   db?: { prepare(sql: string): { bind(...values: unknown[]): { first(): Promise<any> } } } | null,
 *   projectId: number,
 *   ttlMs?: number,
 *   now?: () => number,
 * }} options
 * @returns {() => Promise<import("./protected-worker.js").ResolvedPolicy | null>}
 */
export function createPolicyLookup(options) {
  const { db, projectId } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_POLICY_TTL_MS;
  const now = options.now ?? (() => Date.now());

  return async function lookup() {
    const cached = cache.get(projectId);

    if (cached && cached.expiresAt > now()) {
      return cached.value;
    }

    const value = await queryPolicy(db, projectId);

    /*
     * 失敗的結果也放進快取。否則 D1 出問題時，每一個請求都會再試一次——
     * 一個壞掉的資料庫會被自己的重試流量壓得更難恢復。回退到烙印值本來
     * 就是安全的行為，等 TTL 到了再試一次就好。
     */
    cache.set(projectId, { expiresAt: now() + ttlMs, value });

    return value;
  };
}

/**
 * 真正下查詢的地方。任何失敗都回 null。
 *
 * @param {any} db
 * @param {number} projectId
 * @returns {Promise<import("./protected-worker.js").ResolvedPolicy | null>}
 */
async function queryPolicy(db, projectId) {
  if (!db || typeof db.prepare !== "function") {
    return null;
  }

  try {
    /*
     * LEFT JOIN：`project_policies` 那一列不一定存在（只有設過密碼或改過
     * policy_version 的專案才有）。用 INNER JOIN 的話，一個沒設密碼的公開
     * 專案會查不到自己的權限，然後永遠回退到烙印值——即時生效等於沒做。
     */
    const row = await db
      .prepare(
        `SELECT p.visibility AS visibility,
                pol.policy_version AS policy_version,
                pol.password_hash AS password_hash
           FROM projects AS p
           LEFT JOIN project_policies AS pol ON pol.project_id = p.id
          WHERE p.id = ?`,
      )
      .bind(projectId)
      .first();

    if (!row || typeof row.visibility !== "string") {
      return null;
    }

    return {
      visibility: row.visibility,
      // 沒有 policy 那一列時用 1，與 migration 0001 的 DEFAULT 一致。
      policyVersion: Number(row.policy_version) || 1,
      passwordHash: typeof row.password_hash === "string" ? row.password_hash : null,
    };
  } catch {
    return null;
  }
}
