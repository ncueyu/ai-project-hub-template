// @ts-check

/**
 * 密碼雜湊與驗證。
 *
 * **這個模組只會在登入端點被呼叫一次。** 受保護資源的後續請求一律只驗
 * 工作階段簽章（見 `session.js`），絕不重跑這裡的運算。
 *
 * 為什麼不用 bcrypt 或 Argon2：
 *   那類演算法刻意設計成慢（典型 50–100 毫秒），而 Cloudflare Workers
 *   免費方案每次呼叫的 CPU 時間上限是 10 毫秒，放進請求路徑必定超時。
 *   因此改用 Web Crypto 內建的 PBKDF2，並把重複次數降到能在限制內完成，
 *   實際次數必須經真實 Worker 環境量測後決定，不可憑猜測。
 *
 * 儲存格式（固定，見計畫第 9.5 節）：
 *   pbkdf2-sha256$<iterations>$<base64-salt>$<base64-derived-key>
 */

const PREFIX = "pbkdf2-sha256";
const SALT_BYTES = 16;
const KEY_BITS = 256;

const encoder = new TextEncoder();

/**
 * 目前採用的重複次數，依實際量測結果決定。
 *
 * 2026-08-13 於本機 workerd 量測（三次平均）：
 *   10,000 →  3.33 ms
 *   25,000 →  8.67 ms
 *   50,000 → 18.00 ms
 *  100,000 → 36.33 ms
 *  200,000 → 71.67 ms
 *
 * Workers 免費方案每次呼叫的 CPU 上限是 10 ms。25,000 雖然勉強在限制內，
 * 但只剩約 1.3 ms 給表單解析、簽發工作階段與產生回應，容易超標；
 * 因此取 10,000，保留約 6.7 ms 餘裕。
 *
 * ⚠️ 這個數字**遠低於**一般密碼儲存的建議強度（OWASP 對 PBKDF2-SHA256
 * 的建議是 600,000 次量級）。在免費方案的 10 ms 限制下，兩者無法同時滿足。
 * 詳細說明與可行選項記錄於 2026-08-12-工作進度.md 的 SPEC BLOCKER 一節。
 * 正式對外提供密碼保護前，必須先解決該項。
 */
export const PROVISIONAL_ITERATIONS = 10_000;

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

/**
 * @param {string} text
 * @returns {Uint8Array}
 */
function fromBase64(text) {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

/**
 * 長度固定的位元組比較，執行時間不隨相符程度改變。
 *
 * 一般的相等比較會在第一個不同的位元組就返回，攻擊者可以藉由測量
 * 回應時間，一個位元組一個位元組地推敲出正確值。
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let difference = 0;

  for (let i = 0; i < a.length; i += 1) {
    difference |= a[i] ^ b[i];
  }

  return difference === 0;
}

/**
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} iterations
 * @returns {Promise<Uint8Array>}
 */
async function deriveKey(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    baseKey,
    KEY_BITS,
  );

  return new Uint8Array(bits);
}

/**
 * 建立密碼雜湊。只在設定或變更密碼時呼叫。
 *
 * @param {string} password
 * @param {{ iterations?: number }} [options]
 * @returns {Promise<string>}
 */
export async function hashPassword(password, options = {}) {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("Password must be a non-empty string.");
  }

  const iterations = options.iterations ?? PROVISIONAL_ITERATIONS;
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveKey(password, salt, iterations);

  return `${PREFIX}$${iterations}$${toBase64(salt)}$${toBase64(derived)}`;
}

/**
 * 解析儲存的雜湊字串。格式不符時回傳 null，不拋出例外。
 *
 * @param {string} encoded
 * @returns {{ iterations: number, salt: Uint8Array, key: Uint8Array } | null}
 */
export function parsePasswordHash(encoded) {
  if (typeof encoded !== "string") {
    return null;
  }

  const parts = encoded.split("$");

  if (parts.length !== 4 || parts[0] !== PREFIX) {
    return null;
  }

  const iterations = Number(parts[1]);

  if (!Number.isInteger(iterations) || iterations < 1) {
    return null;
  }

  try {
    return {
      iterations,
      salt: fromBase64(parts[2]),
      key: fromBase64(parts[3]),
    };
  } catch {
    return null;
  }
}

/**
 * 驗證密碼。
 *
 * 無論失敗原因為何都只回傳 false，不區分「格式錯誤」與「密碼不符」——
 * 對外的錯誤訊息也必須一致，不可透露雜湊、鹽值或該專案是否存在。
 *
 * @param {string} password
 * @param {string} encoded
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || password.length === 0) {
    return false;
  }

  const parsed = parsePasswordHash(encoded);

  if (!parsed) {
    return false;
  }

  try {
    const derived = await deriveKey(password, parsed.salt, parsed.iterations);
    return timingSafeEqual(derived, parsed.key);
  } catch {
    return false;
  }
}

/**
 * 量測指定重複次數所需的時間，用於在真實 Worker 環境決定正式參數。
 *
 * @param {number} iterations
 * @param {number} [samples]
 * @returns {Promise<{ iterations: number, averageMs: number, samples: number }>}
 */
export async function benchmarkIterations(iterations, samples = 3) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const durations = [];

  for (let i = 0; i < samples; i += 1) {
    const started = Date.now();
    await deriveKey("benchmark-password-sample", salt, iterations);
    durations.push(Date.now() - started);
  }

  return {
    iterations,
    averageMs: durations.reduce((total, value) => total + value, 0) / durations.length,
    samples,
  };
}
