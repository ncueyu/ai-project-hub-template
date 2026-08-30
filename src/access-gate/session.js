// @ts-check

/**
 * 受保護專案的工作階段權杖（Session Token）。
 *
 * 設計重點（階段二計畫第 13 節）：
 *   - 驗證一次請求只做一件事：驗 HMAC 簽章，然後檢查聲明內容。
 *     **不查資料庫、不做 PBKDF2。** 這兩者只發生在登入那一次。
 *     理由是 Workers 免費方案每次呼叫的 CPU 時間上限只有 10 毫秒，
 *     而 PBKDF2 是刻意設計成慢的演算法，放在每個請求上必然超時。
 *   - 驗證函式只回傳判斷結果，不產生 Response。要拒絕的時候要回什麼、
 *     要不要導向密碼頁，是呼叫端的決定，不該和密碼學混在一起。
 *   - 任何格式錯誤的輸入都必須安靜地判定為不通過，不可拋出例外造成 500。
 */

/** 權杖格式版本。日後若改變結構，可用它區分。 */
const TOKEN_VERSION = "v1";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64Url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {string} text
 * @returns {Uint8Array}
 */
function fromBase64Url(text) {
  const normalised = text.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (normalised.length % 4)) % 4;
  const binary = atob(normalised + "=".repeat(padding));

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * 匯入簽章金鑰。
 *
 * 金鑰只能來自 Cloudflare Secret 或本機的 .dev.vars，絕不可寫在程式碼裡。
 *
 * @param {string} secret
 * @returns {Promise<CryptoKey>}
 */
export async function importSigningKey(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("Signing key must be a string of at least 32 characters.");
  }

  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/**
 * @typedef {{ project_id: number, policy_version: number, expires_at: number }} SessionClaims
 */

/**
 * 簽發工作階段權杖。只在登入成功後呼叫一次。
 *
 * @param {CryptoKey} key
 * @param {SessionClaims} claims
 * @returns {Promise<string>}
 */
export async function issueSession(key, claims) {
  const payload = JSON.stringify({
    project_id: claims.project_id,
    policy_version: claims.policy_version,
    expires_at: claims.expires_at,
  });

  const encodedPayload = toBase64Url(encoder.encode(payload));
  const message = `${TOKEN_VERSION}.${encodedPayload}`;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));

  return `${message}.${toBase64Url(new Uint8Array(signature))}`;
}

/** 驗證失敗的原因。呼叫端可據此決定要導向密碼頁還是直接拒絕。 */
export const DENY_REASONS = Object.freeze({
  MISSING: "MISSING",
  MALFORMED: "MALFORMED",
  BAD_SIGNATURE: "BAD_SIGNATURE",
  EXPIRED: "EXPIRED",
  PROJECT_MISMATCH: "PROJECT_MISMATCH",
  POLICY_VERSION_MISMATCH: "POLICY_VERSION_MISMATCH",
});

/**
 * 驗證工作階段權杖。
 *
 * 這個函式**不會**拋出例外：任何無法解析的輸入都回傳 allowed=false。
 * 受保護資源的每一個子請求都會經過這裡，必須極輕量且絕對穩定。
 *
 * @param {CryptoKey} key
 * @param {string | null | undefined} token
 * @param {{ projectId: number, policyVersion: number, now?: number }} expected
 * @returns {Promise<{ allowed: true, claims: SessionClaims } | { allowed: false, reason: string }>}
 */
export async function verifySession(key, token, expected) {
  if (!token || typeof token !== "string") {
    return { allowed: false, reason: DENY_REASONS.MISSING };
  }

  const parts = token.split(".");

  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { allowed: false, reason: DENY_REASONS.MALFORMED };
  }

  const [version, encodedPayload, encodedSignature] = parts;

  /** @type {Uint8Array} */
  let signature;

  try {
    signature = fromBase64Url(encodedSignature);
  } catch {
    return { allowed: false, reason: DENY_REASONS.MALFORMED };
  }

  // 先驗簽章再看內容：內容尚未證明可信之前，不做任何依賴它的判斷。
  let signatureValid = false;

  try {
    signatureValid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      encoder.encode(`${version}.${encodedPayload}`),
    );
  } catch {
    return { allowed: false, reason: DENY_REASONS.BAD_SIGNATURE };
  }

  if (!signatureValid) {
    return { allowed: false, reason: DENY_REASONS.BAD_SIGNATURE };
  }

  /** @type {any} */
  let claims;

  try {
    claims = JSON.parse(decoder.decode(fromBase64Url(encodedPayload)));
  } catch {
    return { allowed: false, reason: DENY_REASONS.MALFORMED };
  }

  if (
    !claims
    || typeof claims !== "object"
    || typeof claims.project_id !== "number"
    || typeof claims.policy_version !== "number"
    || typeof claims.expires_at !== "number"
  ) {
    return { allowed: false, reason: DENY_REASONS.MALFORMED };
  }

  const now = expected.now ?? Math.floor(Date.now() / 1000);

  if (claims.expires_at <= now) {
    return { allowed: false, reason: DENY_REASONS.EXPIRED };
  }

  // 一個專案的權杖不能拿去開另一個專案。
  if (claims.project_id !== expected.projectId) {
    return { allowed: false, reason: DENY_REASONS.PROJECT_MISMATCH };
  }

  // 擁有者改密碼或改權限時會提高 policy_version，讓已發出的權杖立即失效。
  if (claims.policy_version !== expected.policyVersion) {
    return { allowed: false, reason: DENY_REASONS.POLICY_VERSION_MISMATCH };
  }

  return { allowed: true, claims };
}
