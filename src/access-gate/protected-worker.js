// @ts-check

/**
 * 受保護專案的 Worker 原型。
 *
 * 這段程式會由未來的 `hub deploy` 在部署時注入受保護專案，讓每個專案
 * 自己守自己的門（見主規格 RULE-002）。Hub 不做反向代理。
 *
 * 五種狀態的對外行為（2026-09-04 起所有專案都注入這個 Worker，不只受保護的）：
 *   - public／unlisted：直接放行。
 *   - password：未驗證時，網頁請求得到密碼頁，其他資源一律 404。
 *   - private ：非管理者一律 404。
 *   - disabled：所有人一律 404。
 *
 * private 與 disabled 刻意回傳相同的 404，不區分「不存在」「沒權限」
 * 與「已停用」。否則光看狀態碼差異就能推斷出某個網址確實有東西。
 */

import { buildClearedSessionCookie, buildSessionCookie, createAccessGate } from "./index.js";
import { issueSession } from "./session.js";
import { verifyPassword } from "./password.js";

/** 登入與登出端點。前綴刻意少見，避免與專案自身的路徑衝突。 */
export const LOGIN_PATH = "/__access/login";
export const LOGOUT_PATH = "/__access/logout";

/**
 * 統一的拒絕回應。內容固定，不透露任何內部狀態。
 *
 * @returns {Response}
 */
function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

/**
 * 判斷這個請求想要的是網頁，還是網頁裡的子資源。
 *
 * 未驗證時只有網頁請求該看到密碼頁；若對 CSS 或 JS 也回傳密碼頁的 HTML，
 * 瀏覽器會拿到型別錯誤的內容，反而製造難以理解的錯誤。
 *
 * 匯出給 `src/index.js` 重用：管理後台未登入時，同一條規則也適用——
 * 網頁請求給登入頁，子資源請求給 404，不重寫一份一樣的判斷。
 *
 * @param {Request} request
 * @returns {boolean}
 */
export function wantsHtml(request) {
  const accept = request.headers.get("Accept") ?? "";
  const mode = request.headers.get("Sec-Fetch-Dest");

  if (mode) {
    return mode === "document" || mode === "iframe";
  }

  return accept.includes("text/html");
}

/**
 * 密碼輸入頁。刻意自包含，不引用任何外部樣式或指令碼——
 * 那些檔案在未驗證前同樣是被擋住的。
 *
 * `loginPath` 預設是這個模組自己的 `LOGIN_PATH`（每個受保護專案共用）。
 * 2026-08-25 起 `src/admin-gate.js` 重用這個頁面來保護 Hub 自己的
 * `/admin`，但表單要送到 `/admin/login` 而不是 `/__access/login`，
 * 因此開放呼叫端覆寫——不然表單會送錯地方，看起來輸入密碼卻永遠進不去。
 *
 * @param {{ projectName?: string, error?: string, loginPath?: string }} [options]
 * @returns {Response}
 */
export function passwordPage(options = {}) {
  const name = options.projectName ?? "這個專案";
  const loginPath = options.loginPath ?? LOGIN_PATH;
  const error = options.error
    ? `<p class="error" role="alert">${options.error}</p>`
    : "";

  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>需要密碼</title>
<style>
:root { color-scheme: light; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
  background:#f6f6f4; color:#1d1d1f; font-size:17px; line-height:1.65;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif; }
main { width:min(420px,calc(100% - 32px)); padding:32px; background:#fff;
  border:1px solid #dededb; border-radius:22px; }
h1 { margin:0 0 8px; font-size:1.3rem; font-weight:650; }
p { margin:0 0 20px; color:#515154; font-size:0.98rem; }
label { display:block; margin-bottom:6px; font-weight:600; font-size:0.95rem; }
input { width:100%; min-height:44px; padding:10px 12px; box-sizing:border-box;
  border:1px solid #dededb; border-radius:12px; font-size:1rem; font-family:inherit; }
input:focus-visible { outline:3px solid #35677d; outline-offset:2px; }
button { width:100%; min-height:44px; margin-top:16px; border:none; border-radius:12px;
  background:#35677d; color:#fff; font-size:1rem; font-weight:600; font-family:inherit; cursor:pointer; }
button:hover { background:#285367; }
.error { margin:0 0 16px; padding:12px 14px; border-radius:12px;
  background:#f4f0e9; color:#7a2b24; font-size:0.92rem; }
</style>
</head>
<body>
<main>
<h1>需要密碼才能檢視</h1>
<p>${name}設定為需要密碼。請輸入密碼後繼續。</p>
${error}
<form method="POST" action="${loginPath}">
<label for="password">密碼</label>
<input type="password" id="password" name="password" required autocomplete="current-password" autofocus>
<button type="submit">進入</button>
</form>
</main>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      // 受保護內容不應被搜尋引擎收錄。
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

/**
 * @typedef {{ visibility: string, policyVersion: number, passwordHash: string | null }} ResolvedPolicy
 */

/**
 * @typedef {{
 *   projectId: number,
 *   visibility: string,
 *   policyVersion: number,
 *   passwordHash?: string | null,
 *   projectName?: string,
 *   sessionSeconds?: number,
 *   secureCookie?: boolean,
 *   isAdmin?: (request: Request) => boolean | Promise<boolean>,
 *   resolvePolicy?: () => Promise<ResolvedPolicy | null>,
 * }} ProtectedConfig
 */

/**
 * 建立受保護專案的 Worker。
 *
 * ## 權限從哪裡來：即時查詢優先，烙印值當後援（2026-09-04）
 *
 * `config.visibility`／`policyVersion`／`passwordHash` 是**部署當下**烙進
 * 進入點的值。只靠它們的話，使用者在管理後台把專案改成公開之後必須重新部署
 * 才會生效——而後台其他設定（站名、版面、公開／私人在展示中心的顯示）全部
 * 都是即時的，沒有人會預期權限是例外。實際發生過的後果：使用者在後台改成
 * 公開、展示中心的卡片出現了，點進去卻是 404，他無法從畫面上看出原因。
 *
 * 所以 `config.resolvePolicy` 存在時，改以它回傳的即時值為準。
 *
 * **查不到時回退到烙印值，不是放行也不是封鎖。** 三種選擇的後果差很多：
 *   - 查不到就放行 → 資料庫抖動一次，所有私人專案外洩。
 *   - 查不到就封鎖 → 資料庫抖動一次，所有公開專案掛掉。
 *   - 回退到烙印值 → 回到「部署當下的權限」，這是唯一兩邊都不失控的選擇。
 * 一個以 private 部署的專案，在資料庫連不上時仍然是 private。
 *
 * **回退是整筆一起換，不是逐欄位補。** 即時查詢成功時，就算
 * `password_hash` 是 NULL 也要照用——那代表使用者剛剛在後台把密碼刪掉了。
 * 逐欄位 `??` 會讓被刪掉的密碼從烙印值裡復活。
 *
 * @param {ProtectedConfig} config
 */
export function createProtectedWorker(config) {
  const sessionSeconds = config.sessionSeconds ?? 8 * 60 * 60;
  const secureCookie = config.secureCookie !== false;

  /**
   * @param {Request} request
   * @param {{ SESSION_SIGNING_KEY?: string, ASSETS: { fetch(request: Request): Promise<Response> } }} env
   * @param {{ signingKey?: CryptoKey, now?: number }} [runtime] 測試用的注入點
   */
  async function fetch(request, env, runtime = {}) {
    const url = new URL(request.url);

    // 一次請求只查一次，之後全部讀這個結果（見 createProtectedWorker 檔頭）。
    const policy = await resolvePolicy();

    // 停用中的專案：任何人、任何路徑都一樣。
    if (policy.visibility === "disabled") {
      return notFound();
    }

    // 私人專案：只有通過管理者驗證的請求能進入。
    // 管理者判斷由部署時注入（正式環境預定使用 Cloudflare Access 的身分標頭）。
    if (policy.visibility === "private") {
      const isAdmin = config.isAdmin ? await config.isAdmin(request) : false;

      return isAdmin ? env.ASSETS.fetch(request) : notFound();
    }

    if (policy.visibility !== "password") {
      // public 與 unlisted：直接放行。2026-09-04 起這是**正常路徑**而不是
      // 「設定失誤時的保險」——所有專案一律注入這個 Worker，權限才能即時
      // 生效（見 createProtectedWorker 檔頭）。代價是公開專案的靜態請求
      // 從「免費無上限」變成計入 Worker 的每日請求額度。
      return env.ASSETS.fetch(request);
    }

    const signingKey = runtime.signingKey ?? await resolveSigningKey(env);

    if (!signingKey) {
      // 沒有簽章金鑰就無法安全地驗證任何人，此時一律不提供內容。
      return notFound();
    }

    if (url.pathname === LOGOUT_PATH) {
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/",
          "Set-Cookie": buildClearedSessionCookie({ secure: secureCookie }),
          "Cache-Control": "no-store",
        },
      });
    }

    if (url.pathname === LOGIN_PATH) {
      if (request.method === "GET") {
        return passwordPage({ projectName: config.projectName });
      }

      if (request.method !== "POST") {
        return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
      }

      return handleLogin(request, signingKey, policy);
    }

    const gate = createAccessGate({
      signingKey,
      projectId: config.projectId,
      policyVersion: policy.policyVersion,
    });

    const result = await gate.check(request, { now: runtime.now });

    if (result.allowed) {
      return env.ASSETS.fetch(request);
    }

    // 未通過：網頁請求看到密碼頁，其餘資源一律 404，不洩漏任何內容。
    return wantsHtml(request) ? passwordPage({ projectName: config.projectName }) : notFound();
  }

  /**
   * 登入。這是整個流程中唯一做密碼運算的地方。
   *
   * @param {Request} request
   * @param {CryptoKey} signingKey
   * @param {ResolvedPolicy} policy 這次請求解析出來的權限，見 createProtectedWorker 檔頭
   */
  async function handleLogin(request, signingKey, policy) {
    let password = "";

    try {
      const form = await request.formData();
      password = String(form.get("password") ?? "");
    } catch {
      password = "";
    }

    const hash = policy.passwordHash;
    const ok = hash ? await verifyPassword(password, hash) : false;

    if (!ok) {
      // 一般化的錯誤訊息：不區分密碼錯誤、未設定密碼或專案不存在。
      return passwordPage({
        projectName: config.projectName,
        error: "密碼不正確，請再試一次。",
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const token = await issueSession(signingKey, {
      project_id: config.projectId,
      policy_version: policy.policyVersion,
      expires_at: now + sessionSeconds,
    });

    return new Response(null, {
      status: 303,
      headers: {
        Location: "/",
        "Set-Cookie": buildSessionCookie(token, {
          maxAge: sessionSeconds,
          secure: secureCookie,
        }),
        "Cache-Control": "no-store",
      },
    });
  }

  /**
   * 取得這次請求該用的權限。即時查詢優先，失敗回退到烙印值——
   * 為什麼是回退而不是放行或封鎖，見 createProtectedWorker 檔頭。
   *
   * @returns {Promise<ResolvedPolicy>}
   */
  async function resolvePolicy() {
    /** @type {ResolvedPolicy} */
    const baked = {
      visibility: config.visibility,
      policyVersion: config.policyVersion,
      passwordHash: config.passwordHash ?? null,
    };

    if (!config.resolvePolicy) {
      return baked;
    }

    // 即時查詢自己已經吞掉所有錯誤（見 policy-lookup.js），但這裡再包一層：
    // 注入端若換成別的實作而它會拋錯，整個網站不該因此掛掉。
    try {
      return (await config.resolvePolicy()) ?? baked;
    } catch {
      return baked;
    }
  }

  return { fetch };
}

/**
 * 從環境變數取出簽章金鑰。金鑰只能來自 Secret 或本機 .dev.vars。
 *
 * 匯出給 `src/admin-gate.js` 重用——管理後台的簽章金鑰與各專案共用同一把
 * `SESSION_SIGNING_KEY`（見該檔案的說明：`project_id` 哨兵值天然隔離兩種用途，
 * 共用金鑰不會讓兩者的 session 互通）。
 *
 * @param {{ SESSION_SIGNING_KEY?: string }} env
 * @returns {Promise<CryptoKey | null>}
 */
export async function resolveSigningKey(env) {
  const secret = env?.SESSION_SIGNING_KEY;

  if (typeof secret !== "string" || secret.length < 32) {
    return null;
  }

  const { importSigningKey } = await import("./session.js");

  return importSigningKey(secret);
}
