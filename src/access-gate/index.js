// @ts-check

/**
 * Access Gate：受保護專案共用的權限閘道模組。
 *
 * 這個模組會由 `hub deploy` 在部署時注入到各個受保護專案的 Worker 中
 * （見主規格 RULE-002：每個 Project 是獨立的 Data Plane）。
 * Hub **不會**成為所有專案流量的反向代理——那會讓每個請求消耗兩份
 * Worker 額度，也會讓 Hub 成為單點故障。
 *
 * 因此這裡刻意只提供純函式與小工具，不假設任何框架，也不產生 Response：
 * 要導向密碼頁、要回 404 還是回 403，由各專案自己決定。
 */

export {
  DENY_REASONS,
  importSigningKey,
  issueSession,
  verifySession,
} from "./session.js";

import { verifySession } from "./session.js";

/** 工作階段 Cookie 名稱。刻意不含專案名稱或任何可辨識的資訊。 */
export const SESSION_COOKIE_NAME = "hub_session";

/** 預設有效期：8 小時。 */
export const DEFAULT_SESSION_SECONDS = 8 * 60 * 60;

/**
 * 從請求標頭讀出指定的 Cookie。
 *
 * 這裡自行解析而不依賴任何套件，並且對格式異常的輸入保持安靜，
 * 因為受保護資源的每個子請求都會經過這段程式。
 *
 * @param {Request} request
 * @param {string} [name]
 * @returns {string | null}
 */
export function readSessionCookie(request, name = SESSION_COOKIE_NAME) {
  const header = request.headers.get("Cookie");

  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) {
      continue;
    }

    if (part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim() || null;
    }
  }

  return null;
}

/**
 * 組出工作階段 Cookie。
 *
 * 依第 13.2 節：HttpOnly、SameSite=Lax、Path=/、明確 Max-Age，
 * 正式環境必須加 Secure。
 *
 * @param {string} token
 * @param {{ maxAge?: number, secure?: boolean, name?: string }} [options]
 * @returns {string}
 */
export function buildSessionCookie(token, options = {}) {
  const name = options.name ?? SESSION_COOKIE_NAME;
  const maxAge = options.maxAge ?? DEFAULT_SESSION_SECONDS;
  const secure = options.secure !== false;

  const attributes = [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];

  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

/**
 * 產生清除 Cookie 的標頭值，用於登出或工作階段失效。
 *
 * @param {{ secure?: boolean, name?: string }} [options]
 * @returns {string}
 */
export function buildClearedSessionCookie(options = {}) {
  return buildSessionCookie("", { ...options, maxAge: 0 });
}

/**
 * 建立一個綁定特定專案的閘道。
 *
 * 回傳的 `check()` 只做兩件事：讀 Cookie、驗簽章與聲明。
 * 沒有資料庫查詢，也沒有密碼雜湊運算。
 *
 * @param {{ signingKey: CryptoKey, projectId: number, policyVersion: number, cookieName?: string }} config
 */
export function createAccessGate(config) {
  const cookieName = config.cookieName ?? SESSION_COOKIE_NAME;

  return {
    /**
     * @param {Request} request
     * @param {{ now?: number }} [options]
     * @returns {Promise<{ allowed: boolean, reason?: string, claims?: object }>}
     */
    async check(request, options = {}) {
      const token = readSessionCookie(request, cookieName);

      return verifySession(config.signingKey, token, {
        projectId: config.projectId,
        policyVersion: config.policyVersion,
        now: options.now,
      });
    },
  };
}
