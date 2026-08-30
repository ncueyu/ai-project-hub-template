// @ts-check

/**
 * Hub 自己的管理後台密碼閘道。
 *
 * ## 為什麼不是 Cloudflare Access
 *
 * 原計畫是掛 Cloudflare Access，2026-08-25 放棄：使用者不想輸入卡號（Zero Trust
 * 設定要求同意超額自動扣款），而且查證發現 2026-08-14 那個「保護 Worker」的新功能
 * 只能保護整個 Worker（會連首頁與展示中心一起擋掉），要做到「只擋 /admin」得靠
 * 要求自訂網域的舊機制——`workers.dev` 不算 zone，Cloudflare 自己的文件在這點
 * 互相矛盾。詳見 `2026-08-25-工作計畫.md`。`README.md` 也寫著「本專案不會代為
 * 註冊帳號、輸入密碼、接受計費條款」，這次剛好撞到這條線。
 *
 * ## 重用而非重寫
 *
 * 這裡直接重用 `src/access-gate/`（保護加密專案用的那套，已有 22 個測試）的
 * 底層機制：HMAC 簽章工作階段（`session.js`）、密碼雜湊驗證（`password.js`）、
 * 密碼輸入頁（`protected-worker.js` 的 `passwordPage`）。不重新發明一套邏輯。
 *
 * ## 哨兵值隔離（重要的安全設計，見 `test/admin-gate.test.mjs` 的實測證明）
 *
 * 管理員的工作階段用固定的 `project_id = 0`。真正的專案 id 從資料庫的
 * AUTOINCREMENT 起跳，最小值是 1，永遠不會是 0。這代表：
 *   - 管理員 session 拿去任何加密專案都會被拒絕（project_id 不符）。
 *   - 任何加密專案的訪客 session 也進不了管理後台。
 * 兩者因此可以**共用同一把 `SESSION_SIGNING_KEY`**，不必為管理後台另開一把金鑰——
 * `verifySession` 本來就會核對 `project_id`，用途不同的 session 天生互相隔離。
 */

import { buildClearedSessionCookie, buildSessionCookie, readSessionCookie } from "./access-gate/index.js";
import { issueSession, verifySession } from "./access-gate/session.js";
import { verifyPassword } from "./access-gate/password.js";
import { passwordPage, resolveSigningKey } from "./access-gate/protected-worker.js";

/** 管理後台工作階段的 Cookie 名稱，刻意跟每專案的 `hub_session` 分開，避免混淆兩種用途。 */
export const ADMIN_SESSION_COOKIE = "hub_admin_session";

/** 登入與登出端點。 */
export const ADMIN_LOGIN_PATH = "/admin/login";
export const ADMIN_LOGOUT_PATH = "/admin/logout";

/** 哨兵值：見檔頭「哨兵值隔離」說明。真實專案 id 從 1 起跳，0 永遠不會撞到。 */
export const ADMIN_PROJECT_ID = 0;

/**
 * 管理後台的政策版本。若要一次性讓所有既有管理員工作階段失效
 * （例如懷疑金鑰或密碼已外洩），改這個數字並重新部署即可——
 * 不需要資料庫寫入，因為管理後台本身不是資料庫裡的一筆專案。
 */
export const ADMIN_POLICY_VERSION = 1;

/** 工作階段有效期：8 小時，與每專案密碼閘道一致。 */
const ADMIN_SESSION_SECONDS = 8 * 60 * 60;

/**
 * 判斷這個請求是否帶有有效的管理員工作階段。
 *
 * @param {Request} request
 * @param {{ SESSION_SIGNING_KEY?: string }} env
 * @param {{ signingKey?: CryptoKey, now?: number }} [runtime] 測試用的注入點
 * @returns {Promise<boolean>}
 */
export async function isAdminAuthenticated(request, env, runtime = {}) {
  const signingKey = runtime.signingKey ?? (await resolveSigningKey(env));

  if (!signingKey) {
    // 沒有簽章金鑰就無法安全地驗證任何人，一律視為未登入。
    return false;
  }

  const token = readSessionCookie(request, ADMIN_SESSION_COOKIE);
  const result = await verifySession(signingKey, token, {
    projectId: ADMIN_PROJECT_ID,
    policyVersion: ADMIN_POLICY_VERSION,
    now: runtime.now,
  });

  return result.allowed;
}

/**
 * 渲染管理後台的登入頁。重用每專案密碼閘道的頁面，只是把表單指到
 * 管理後台自己的登入端點，而不是各專案的 `/__access/login`。
 *
 * @param {{ error?: string }} [options]
 * @returns {Response}
 */
export function renderAdminLoginPage(options = {}) {
  return passwordPage({ projectName: "管理後台", error: options.error, loginPath: ADMIN_LOGIN_PATH });
}

/**
 * 處理登入表單送出。這是整個管理後台閘道中唯一做密碼運算（PBKDF2）的地方——
 * 其餘每個請求只驗 HMAC 簽章，不重跑雜湊，避免 Workers 免費方案的 10ms CPU
 * 上限被輕易吃光（原理與 `session.js` 檔頭說明的理由一致）。
 *
 * @param {Request} request
 * @param {{ SESSION_SIGNING_KEY?: string, ADMIN_PASSWORD_HASH?: string }} env
 * @param {{ signingKey?: CryptoKey, now?: number, secureCookie?: boolean }} [runtime]
 * @returns {Promise<Response>}
 */
export async function handleAdminLogin(request, env, runtime = {}) {
  const signingKey = runtime.signingKey ?? (await resolveSigningKey(env));

  if (!signingKey) {
    // 這不是使用者的錯，是部署設定缺漏——但錯誤訊息一律不透露內部細節，
    // 一般管理者看到「密碼不正確」也足以知道要找人排查。
    return renderAdminLoginPage({ error: "密碼不正確，請再試一次。" });
  }

  let password = "";

  try {
    const form = await request.formData();
    password = String(form.get("password") ?? "");
  } catch {
    password = "";
  }

  const hash = env?.ADMIN_PASSWORD_HASH;
  const ok = hash ? await verifyPassword(password, hash) : false;

  if (!ok) {
    // 一般化的錯誤訊息：不區分密碼錯誤、雜湊未設定、金鑰缺失。
    return renderAdminLoginPage({ error: "密碼不正確，請再試一次。" });
  }

  const now = runtime.now ?? Math.floor(Date.now() / 1000);
  const token = await issueSession(signingKey, {
    project_id: ADMIN_PROJECT_ID,
    policy_version: ADMIN_POLICY_VERSION,
    expires_at: now + ADMIN_SESSION_SECONDS,
  });

  return new Response(null, {
    status: 303,
    headers: {
      Location: "/admin/",
      "Set-Cookie": buildSessionCookie(token, {
        name: ADMIN_SESSION_COOKIE,
        maxAge: ADMIN_SESSION_SECONDS,
        secure: runtime.secureCookie !== false,
      }),
      "Cache-Control": "no-store",
    },
  });
}

/**
 * 登出：清除工作階段 Cookie，導回登入頁。
 *
 * @param {{ secureCookie?: boolean }} [options]
 * @returns {Response}
 */
export function handleAdminLogout(options = {}) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/admin",
      "Set-Cookie": buildClearedSessionCookie({
        name: ADMIN_SESSION_COOKIE,
        secure: options.secureCookie !== false,
      }),
      "Cache-Control": "no-store",
    },
  });
}
