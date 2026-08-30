/**
 * 專案型態偵測（2026-08-14 工作計畫 TASK B-1）。
 *
 * **只回傳判斷結果，不做任何部署動作**（原規格 TASK-3.2）。這個界線是刻意的：
 * 偵測錯了只是報告不準，偵測順便部署錯了就是線上事故。
 *
 * 判斷順序是設計的一部分，不是實作細節——一個專案可以同時符合多個特徵
 * （Next.js 一定含有 React；React 專案多半用 Vite 打包），所以必須明訂
 * 誰優先。順序的依據是「哪個特徵決定了它要怎麼被部署」。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 依判斷優先序排列。前面的條件成立就不再往下看。 */
export const PROJECT_KINDS = Object.freeze([
  "worker",
  "nextjs",
  "vue",
  "react",
  "vite",
  "node-api",
  "static",
  "unknown",
]);

/** 後端框架的相依套件名稱。出現其中之一即視為 Node API。 */
const SERVER_FRAMEWORKS = Object.freeze([
  "express",
  "fastify",
  "koa",
  "hono",
  "@nestjs/core",
  "restify",
]);

/**
 * @param {string} dir
 * @param {string} name
 * @returns {boolean}
 */
function has(dir, name) {
  return existsSync(join(dir, name));
}

/**
 * 判斷 wrangler 設定檔描述的是「有伺服器端程式碼的 Worker」還是「純靜態上傳」。
 *
 * 判斷依據是 `main` 欄位：
 *   - 有 `main` → 有進入點，是真正的 Worker。
 *   - 沒有 `main` 但有 `assets` → Cloudflare 稱為 static-only Worker，
 *     wrangler 只是上傳靜態檔案的工具，專案本質仍是靜態網站。
 *
 * 為什麼不引入完整的 TOML／JSONC 解析器：只需要知道兩個欄位在不在，
 * 為此增加依賴不值得（而且空白殼的使用者也得裝）。
 * JSONC 用「去註解後 JSON.parse」處理；TOML 用字串比對。
 * 解析失敗時明確回報 readable: false，由呼叫端決定保守做法。
 *
 * 同時取出 assets 目錄，供建置計畫決定「產物位置」——
 * 靜態專案的產物位置必須是那個子目錄，不能是專案根目錄（理由見 build-plan.mjs）。
 *
 * @param {string} path wrangler 設定檔的完整路徑
 * @returns {{ readable: boolean, hasMain: boolean, hasAssets: boolean, assetsDirectory: string | null }}
 */
function readWranglerShape(path) {
  /** @type {{ readable: boolean, hasMain: boolean, hasAssets: boolean, assetsDirectory: string | null }} */
  const unreadable = { readable: false, hasMain: false, hasAssets: false, assetsDirectory: null };

  let raw;

  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return unreadable;
  }

  /**
   * 把設定檔裡的寫法（`./public/`、`public`）統一成相對路徑（`public`）。
   *
   * @param {unknown} value
   * @returns {string | null}
   */
  function normalizeDirectory(value) {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim().replace(/^\.\//, "").replace(/[\\/]+$/, "");

    return trimmed === "" || trimmed === "." ? null : trimmed;
  }

  if (path.endsWith(".toml")) {
    // TOML：`main = "src/index.js"`、`[assets]` 區段或 `assets = { ... }` 行內表。
    const tomlDirectory = /^\s*directory\s*=\s*["']([^"']+)["']/m.exec(raw)
      ?? /assets\s*=\s*\{[^}]*directory\s*=\s*["']([^"']+)["']/m.exec(raw);

    return {
      readable: true,
      hasMain: /^\s*main\s*=/m.test(raw),
      hasAssets: /^\s*\[assets\]/m.test(raw) || /^\s*assets\s*=/m.test(raw),
      assetsDirectory: normalizeDirectory(tomlDirectory?.[1]),
    };
  }

  // JSON／JSONC：先去掉註解再解析。
  // 字串值裡的 `//` 會被誤刪，但 wrangler 設定不會有那種值（路徑寫 `./`，不含 `//`）。
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  try {
    const parsed = JSON.parse(stripped);

    return {
      readable: true,
      hasMain: typeof parsed?.main === "string" && parsed.main.trim() !== "",
      hasAssets: parsed?.assets !== undefined && parsed.assets !== null,
      assetsDirectory: normalizeDirectory(parsed?.assets?.directory),
    };
  } catch {
    return unreadable;
  }
}

/**
 * 副檔名不固定的設定檔（`vite.config.js` / `.ts` / `.mjs` …）。
 *
 * @param {string} dir
 * @param {string} base
 * @returns {string | null}
 */
function findConfig(dir, base) {
  for (const extension of ["js", "ts", "mjs", "cjs", "mts", "json", "jsonc", "toml"]) {
    const name = `${base}.${extension}`;

    if (has(dir, name)) {
      return name;
    }
  }

  return null;
}

/**
 * @param {string} dir
 * @returns {Record<string, any> | null}
 */
export function readPackageJson(dir) {
  const path = join(dir, "package.json");

  if (!existsSync(path)) {
    return null;
  }

  try {
    const text = readFileSync(path, "utf8");

    return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
  } catch {
    return null;
  }
}

/**
 * 判斷套件管理器。
 *
 * 依 Lockfile 而不是猜測——用錯的管理器執行建置，輕則裝出不同版本的相依
 * 套件，重則直接失敗。
 *
 * @param {string} dir
 * @returns {"pnpm" | "yarn" | "npm" | null}
 */
export function detectPackageManager(dir) {
  if (has(dir, "pnpm-lock.yaml")) {
    return "pnpm";
  }

  if (has(dir, "yarn.lock")) {
    return "yarn";
  }

  if (has(dir, "package-lock.json")) {
    return "npm";
  }

  return has(dir, "package.json") ? "npm" : null;
}

/**
 * 專案根目錄是否有可直接開啟的 HTML。
 *
 * @param {string} dir
 * @returns {boolean}
 */
function hasRootHtml(dir) {
  if (has(dir, "index.html")) {
    return true;
  }

  try {
    return readdirSync(dir).some((name) => name.toLowerCase().endsWith(".html"));
  } catch {
    return false;
  }
}

/**
 * 偵測專案型態。
 *
 * @param {string} dir 專案目錄
 * @returns {{
 *   kind: string,
 *   bundler: "vite" | "next" | null,
 *   packageManager: "pnpm" | "yarn" | "npm" | null,
 *   evidence: string[],
 *   hasBuildScript: boolean,
 * }}
 */
export function detectProject(dir) {
  const pkg = readPackageJson(dir);
  const dependencies = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
  };

  /** @type {string[]} */
  const evidence = [];

  /**
   * @param {string} name
   * @returns {boolean}
   */
  function dep(name) {
    const present = Object.prototype.hasOwnProperty.call(dependencies, name);

    if (present) {
      evidence.push(`相依套件 ${name}`);
    }

    return present;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  function file(name) {
    const present = has(dir, name);

    if (present) {
      evidence.push(`檔案 ${name}`);
    }

    return present;
  }

  const packageManager = detectPackageManager(dir);
  const hasBuildScript = typeof pkg?.scripts?.build === "string";
  const viteConfig = findConfig(dir, "vite.config");
  const nextConfig = findConfig(dir, "next.config");
  const wranglerConfig = findConfig(dir, "wrangler");
  const bundler = nextConfig || dependencies.next ? "next" : (viteConfig || dependencies.vite ? "vite" : null);

  /** @type {string | null} */
  let wranglerAssets = null;
  /** wrangler 設定檔是否宣告 main（有 main = 真正的 Worker；無 main = 以靜態資產部署）。 */
  let wranglerHasMain = false;

  /**
   * @param {string} kind
   */
  function result(kind) {
    // wranglerAssets 只在有 wrangler 設定檔時才有值。
    // 建置計畫用它決定靜態專案的產物位置——不能用專案根目錄，
    // 否則設定檔與 Wrangler 暫存檔都會被算成網站內容（見 build-plan.mjs 說明）。
    return { kind, bundler, packageManager, evidence, hasBuildScript, wranglerAssets, wranglerHasMain };
  }

  // 1. Worker：部署方式與其他型態完全不同（wrangler，不是靜態上傳），
  //    因此即使同時是 React 專案，也必須先當成 Worker 處理。
  //
  //    但「有 wrangler 設定檔」不等於「是 Worker」（2026-08-17 修正）。
  //    Cloudflare 支援 static-only Worker：設定檔只有 assets、**沒有 main**，
  //    代表沒有任何伺服器端程式碼，wrangler 只是上傳靜態檔案的工具。
  //    那種專案的本質仍是靜態網站——它沒有進入點、不需要型別檢查、
  //    也不該被檢查 Worker 指令碼大小。
  //
  //    實際案例：`工丙-量測板焊接模擬程式` 只有一個 index.html。
  //    加上 wrangler.jsonc 之前 detect 正確判為 static；加上之後變成 worker，
  //    於是建置計畫開始找不存在的 `src/index.js`。
  if (wranglerConfig) {
    evidence.push(`檔案 ${wranglerConfig}`);

    const shape = readWranglerShape(join(dir, wranglerConfig));

    wranglerAssets = shape.assetsDirectory;
    wranglerHasMain = shape.hasMain;

    // 只有「沒有建置工具鏈」時才判為 static（2026-08-22 收緊）。
    //
    // 原本只看 hasMain/hasAssets 就回傳 static，但那把兩件事混為一談：
    //   ① 怎麼部署 —— 靜態資產 vs Worker 腳本
    //   ② 需不需要建置 —— 有沒有 vite／next／build script
    //
    // Vite → Cloudflare 正好兩者兼具：部署形態是 static-only Worker，
    // 但**必須先 npm run build**。硬判成 static 會讓建置步驟被跳過，
    // 部署出去的會是沒有 JS 的空殼。
    //
    // 實測：`app-multi-cert-dora-work` 在加上 wrangler.jsonc 之前判為 react（建置指令：有），
    // 加上之後變成 static（不需建置）——設定檔的存在不該改變「這個專案要不要建置」。
    //
    // 部署形態的資訊改由 wranglerHasMain / wranglerAssets 傳給 build-plan，
    // 讓它決定產物位置，而不是塞進 kind。
    if (shape.hasMain === false && shape.hasAssets === true
        && bundler === null && hasBuildScript === false) {
      evidence.push("設定檔沒有 main、只有 assets，且無建置工具鏈（純靜態上傳）");

      return result("static");
    }

    // 有 assets、沒有 main，但有建置工具鏈 → **不在這裡結案**。
    // 讓它繼續往下走框架偵測（nextjs／vue／react／vite），
    // 這樣建置計畫才會排出 `npm run build`。
    // 部署形態由 wranglerHasMain（false）與 wranglerAssets 表達，不塞進 kind。
    if (shape.hasMain === false && shape.hasAssets === true) {
      evidence.push("設定檔沒有 main、只有 assets（以靜態資產部署），但專案有建置工具鏈，仍需建置");
    } else {
      if (shape.readable === false) {
        // 讀不出來就當作 Worker。理由：worker 的檢查比 static 嚴格，
        // 把 worker 誤判成 static 會讓真正需要的檢查被跳過；反過來只是多做幾項檢查。
        evidence.push("設定檔無法解析，保守起見仍當作 Worker");
      }

      return result("worker");
    }
  }

  if (dep("wrangler")) {
    return result("worker");
  }

  // 2. Next.js：一定含有 React，所以必須排在 React 之前。
  if (nextConfig) {
    evidence.push(`檔案 ${nextConfig}`);
    return result("nextjs");
  }

  if (dep("next")) {
    return result("nextjs");
  }

  // 3. Vue 與 React：框架決定建置產物的結構。
  if (dep("vue") || file("vue.config.js")) {
    return result("vue");
  }

  if (dep("react")) {
    return result("react");
  }

  // 4. 只有打包工具、沒有框架。
  if (viteConfig) {
    evidence.push(`檔案 ${viteConfig}`);
    return result("vite");
  }

  if (dep("vite")) {
    return result("vite");
  }

  // 5. 後端服務。
  for (const framework of SERVER_FRAMEWORKS) {
    if (dep(framework)) {
      return result("node-api");
    }
  }

  // 6. 純靜態：沒有 package.json，但有可以直接開的 HTML。
  if (hasRootHtml(dir)) {
    evidence.push("根目錄有 HTML 檔案");

    if (!pkg) {
      return result("static");
    }

    // 有 package.json 但沒有 build 指令，仍然當成靜態網站。
    if (!hasBuildScript) {
      return result("static");
    }
  }

  return result("unknown");
}
