/**
 * 把密碼閘道注入到目標專案（`hub ship` 的第 5.5 步，僅靜態專案）。
 *
 * `src/access-gate/` 完全自包含、零外部相依（只用 Web Crypto 標準 API），
 * 所以可以直接把整個目錄複製進目標專案，不需要它有 node_modules——
 * 這是這個機制之所以可行的前提，見 `2026-08-24-工作紀錄.md` 的探查筆記。
 *
 * ## 為什麼每個專案的簽章金鑰各自獨立、不共用
 *
 * `src/admin-gate.js` 共用 Hub 自己的 `SESSION_SIGNING_KEY` 是安全的，因為
 * 那把金鑰跟受它保護的每一項東西（管理後台＋各專案密碼閘道）都是 Hub 自己
 * 管控的程式碼。但部署出去的專案是**獨立的 Worker，之後可能交給別的老師
 * fork 修改**——同一把金鑰用在多個獨立管理的專案上，任何一個外洩就牽連
 * 全部。每個專案各自產生一把，外洩範圍才會限縮在那一個專案。
 *
 * ## 為什麼用文字層面的修補，不是「解析→改物件→重新序列化」
 *
 * `wrangler.jsonc` 含註解，本專案既有慣例（見 `tools/detect.mjs` 檔頭）是
 * 「讀取時」去註解後 JSON.parse——但那是隻讀用途。若要「寫回」，重新序列化
 * 會把所有註解與原始排版全部抹掉，而目標專案的 `wrangler.jsonc` 裡的註解
 * 往往是使用者自己（或先前的 `hub`）寫下的重要說明，不該每次部署就消失。
 * 因此這裡只在原始文字上做最小、針對性的插入，其餘內容逐字保留。
 */

import { randomBytes } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requiresAccessGate, runWorkerFirstFor } from "../src/visibility.js";

/** `src/access-gate/` 的實際位置，複製時的來源。 */
const ACCESS_GATE_SOURCE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "access-gate");

/** 複製到目標專案裡的資料夾名稱，以及產生的進入點檔名。 */
export const GATE_DIR_NAME = "access-gate";
export const GATE_ENTRY_FILENAME = "hub-gate-entry.js";

/**
 * `renderGateEntry()` 產生的檔案開頭固定寫死的標記註解。獨立抽成常數，
 * 讓 `renderGateEntry()`（產生端）與 `isOwnGateAlreadyInjected()`（偵測端）
 * 共用同一份字面值——避免兩處字串各自維護，日後改一邊忘了改另一邊。
 */
export const GATE_ENTRY_MARKER = "// 由 `hub ship` 自動產生，請勿手動編輯——下次部署會被覆寫。";

/**
 * 這個 visibility 需不需要注入閘道。直接重用 `src/visibility.js` 既有的
 * 判斷——「哪些狀態需要閘道」只該有一個答案，不能在這裡另外定義一次。
 *
 * @param {string} visibility
 * @returns {boolean}
 */
export function needsGateInjection(visibility) {
  return requiresAccessGate(visibility);
}

/**
 * 產生一把這個專案專屬的隨機簽章金鑰。32 bytes（64 個十六進位字元），
 * 遠超過 `session.js` 要求的最小 32 字元。
 *
 * @returns {string}
 */
export function generateSigningKey() {
  return randomBytes(32).toString("hex");
}

/**
 * 產生進入點檔案的內容。
 *
 * `createProtectedWorker()` 故意放在 `fetch()` 裡面呼叫，不是在檔案頂層呼叫
 * 一次——`env`（含 `PROJECT_PASSWORD_HASH` 這個 Secret）只有進了 `fetch()`
 * 才存在，Workers 模組頂層看不到它。若在頂層呼叫，`passwordHash` 永遠是
 * `undefined`，密碼保護會悄悄失效而不會有任何錯誤訊息。
 *
 * `passwordHash` 一律接上 `env.PROJECT_PASSWORD_HASH`，不管這個專案是不是
 * `password` 狀態——`createProtectedWorker` 只有在 `visibility === "password"`
 * 時才會用到它，其餘狀態下這個欄位存在與否都沒有影響，不需要另外判斷。
 *
 * @param {{ projectId: number, visibility: string, policyVersion: number, projectName: string }} config
 * @returns {string}
 */
export function renderGateEntry(config) {
  return `${GATE_ENTRY_MARKER}
// 這個檔案存在的原因，以及為什麼每個專案各自一把簽章金鑰，
// 見 Hub 專案的 \`tools/inject-gate.mjs\` 檔頭說明。

import { createProtectedWorker } from "./${GATE_DIR_NAME}/protected-worker.js";

/**
 * @param {Request} request
 * @param {{ ASSETS: { fetch(request: Request): Promise<Response> }, SESSION_SIGNING_KEY?: string, PROJECT_PASSWORD_HASH?: string }} env
 * @param {ExecutionContext} ctx
 */
export default {
  fetch(request, env, ctx) {
    const worker = createProtectedWorker({
      projectId: ${JSON.stringify(config.projectId)},
      visibility: ${JSON.stringify(config.visibility)},
      policyVersion: ${JSON.stringify(config.policyVersion)},
      projectName: ${JSON.stringify(config.projectName)},
      passwordHash: env.PROJECT_PASSWORD_HASH,
    });

    return worker.fetch(request, env, ctx);
  },
};
`;
}

/**
 * 去掉 JSONC 的註解，只用於「這個欄位存不存在」的判斷——不用在真正要
 * 修改的插入位置上，那部分仍然對含註解的原始文字操作，見下方兩個函式。
 *
 * 2026-08-25 由獨立驗證 agent 抓到的真實問題：如果 `wrangler.jsonc` 裡有
 * 說明性的註解剛好寫到 `// "main": "old-entry.js"` 這種文字，原本直接對
 * 含註解的原始文字做 `/"main"\s*:/` 比對會被騙，把合法的靜態專案誤判成
 * 「已經有 main」而拒絕注入。方向是安全的（寧可拒絕也不要誤寫），
 * 但誤判本身仍該修掉，不是靠下游驗證兜底就算了事。
 *
 * @param {string} text
 * @returns {string}
 */
function stripJsoncComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * 在原始文字中插入 `"main"` 欄位。插在第一個 `{` 之後，沿用檔案本身的縮排風格
 * （偵測第一個縮排行用 tab 還是空白，兩種目標專案的 `wrangler.jsonc` 都用 tab，
 * 但不假設一定是這樣）。
 *
 * @param {string} text
 * @param {string} entryPath 相對路徑，例如 "./hub-gate-entry.js"
 * @returns {string}
 */
function insertMainField(text, entryPath) {
  if (/"main"\s*:/.test(stripJsoncComments(text))) {
    throw new Error("wrangler.jsonc 已經有 main 欄位——這個工具只處理純 assets 的靜態專案，不會覆寫既有的 Worker 邏輯。");
  }

  const openBraceIndex = text.indexOf("{");

  if (openBraceIndex === -1) {
    throw new Error("wrangler.jsonc 格式異常：找不到起始的 {。");
  }

  const indentMatch = text.match(/\n([ \t]+)\S/);
  const indent = indentMatch ? indentMatch[1] : "\t";

  return `${text.slice(0, openBraceIndex + 1)}\n${indent}"main": ${JSON.stringify(entryPath)},${text.slice(openBraceIndex + 1)}`;
}

/**
 * 在 `"assets": { ... }` 區塊內插入 `binding` 與 `run_worker_first`。
 *
 * **已知殘留限制**（獨立驗證 agent 於 2026-08-25 發現，經評估後保留不修）：
 * 若整份大段的假 `assets` 區塊被寫成多行註解、且出現在真正的 assets 區塊
 * 之前，這裡的正則仍可能先比對到註解裡的假區塊。這比「comment 提到 main」
 * 更罕見（需要整段 JSON 語法被完整寫進註解，不是隨手一句說明），且後果
 * 不是資料損毀：`assertPatchedJsoncIsValid()` 會在寫入前發現結果不是合法
 * JSON 而拋錯，不寫入任何檔案（已實測確認）。真正修好需要完整的括號配對
 * 演算法或引入 JSONC 解析器，成本高於目前的風險等級，故先記錄、不動手。
 *
 * 用 `[^{}]*` 抓區塊內容是刻意的簡化：這個區塊目前只會有純字串／陣列的
 * key-value（`directory`、`binding`、`run_worker_first` 皆不含巢狀物件），
 * 因此不需要真正的括號配對演算法。若目標專案的 `assets` 區塊出現巢狀物件，
 * 這個正規表達式會抓不到完整區塊、下面的檢查會明確拋錯，不會靜默產生錯誤結果。
 *
 * @param {string} text
 * @param {string[]} runWorkerFirst
 * @returns {string}
 */
function patchAssetsBlock(text, runWorkerFirst) {
  const match = text.match(/"assets"\s*:\s*\{([^{}]*)\}/);

  if (!match) {
    throw new Error("找不到完整的 assets 區塊，無法注入閘道——請確認 wrangler.jsonc 裡 assets 區塊沒有巢狀物件。");
  }

  const inner = match[1];
  const innerWithoutComments = stripJsoncComments(inner);

  if (/"binding"\s*:/.test(innerWithoutComments) || /"run_worker_first"\s*:/.test(innerWithoutComments)) {
    throw new Error("assets 區塊已經有 binding 或 run_worker_first，這個專案可能已經注入過閘道——請確認後手動處理。");
  }

  const indentMatch = text.match(/\n([ \t]+)\S/);
  const indent = indentMatch ? indentMatch[1] : "\t";
  const trimmedInner = inner.replace(/\s+$/, "");
  const needsComma = trimmedInner.trim() !== "" && !trimmedInner.trimEnd().endsWith(",");

  const newInner = `${trimmedInner}${needsComma ? "," : ""}\n${indent}${indent}"binding": "ASSETS",\n${indent}${indent}"run_worker_first": ${JSON.stringify(runWorkerFirst)}\n${indent}`;

  return text.replace(match[0], `"assets": {${newInner}}`);
}

/**
 * 驗證修補後的文字仍然是合法的 JSONC（去註解後可以 `JSON.parse`），
 * 且 `main` 與 `run_worker_first` 確實出現在解析結果裡——不能只驗證
 * 字串插入「看起來」對，必須驗證最終結果真的能被 Wrangler 讀懂。
 *
 * @param {string} text
 * @param {string} entryPath
 * @param {string[]} runWorkerFirst
 */
function assertPatchedJsoncIsValid(text, entryPath, runWorkerFirst) {
  const withoutComments = stripJsoncComments(text);

  /** @type {any} */
  let parsed;

  try {
    parsed = JSON.parse(withoutComments);
  } catch (error) {
    throw new Error(
      `注入後的 wrangler.jsonc 不是合法的 JSON，已中止（原始檔案未被寫入）：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (parsed.main !== entryPath) {
    throw new Error("注入後驗證失敗：main 欄位沒有正確出現在結果中。");
  }

  if (JSON.stringify(parsed.assets?.run_worker_first) !== JSON.stringify(runWorkerFirst)) {
    throw new Error("注入後驗證失敗：assets.run_worker_first 沒有正確出現在結果中。");
  }
}

/**
 * 判斷目標專案資料夾裡的「已經有 main／已經有 access-gate」痕跡，是不是
 * `hub ship` 自己上次注入留下的——用來分辨「這是重試時看到自己上次的殘留」
 * 跟「這本來就是別人的 Worker 型專案」這兩種完全不同的狀況（見
 * `2026-08-26-工作計畫.md` 三、設計）。
 *
 * 三個訊號同時成立才回傳 `true`，刻意保守：任一訊號缺失或不符，一律安全
 * 預設為 `false`（含檔案不存在、JSON 解析失敗等情況，一律吞下例外，不拋錯）
 * ——維持現有的拒絕行為，好過冒然把別人的專案當成自己的接續執行。
 *
 * 1. `wrangler.jsonc` 的 `main` 欄位值精確等於 `./${GATE_ENTRY_FILENAME}`。
 * 2. `hub-gate-entry.js` 存在，且內容開頭是 `GATE_ENTRY_MARKER`——防止別人
 *    自己寫了一個同名檔案卻恰好也把 main 指過去，被誤判成我們的注入。
 * 3. `access-gate/`（`GATE_DIR_NAME`）目錄存在。
 *
 * @param {string} dir 目標專案資料夾
 * @returns {boolean}
 */
export function isOwnGateAlreadyInjected(dir) {
  try {
    const wranglerPath = join(dir, "wrangler.jsonc");

    if (!existsSync(wranglerPath)) {
      return false;
    }

    const withoutComments = stripJsoncComments(readFileSync(wranglerPath, "utf8"));
    const parsed = JSON.parse(withoutComments);

    if (parsed.main !== `./${GATE_ENTRY_FILENAME}`) {
      return false;
    }

    const entryPath = join(dir, GATE_ENTRY_FILENAME);

    if (!existsSync(entryPath) || !readFileSync(entryPath, "utf8").startsWith(GATE_ENTRY_MARKER)) {
      return false;
    }

    return existsSync(join(dir, GATE_DIR_NAME));
  } catch {
    return false;
  }
}

/**
 * @typedef {{
 *   projectId: number,
 *   visibility: string,
 *   policyVersion: number,
 *   projectName: string,
 * }} GateConfig
 */

/**
 * 把密碼閘道注入到目標專案資料夾。
 *
 * 三個動作，任何一步失敗都不留下部分結果：先在記憶體裡把 `wrangler.jsonc`
 * 的新內容準備好並驗證過，全部準備妥當才開始寫檔案，避免「複製了 access-gate
 * 目錄，但 wrangler.jsonc 沒改成功」這種半完成狀態。
 *
 * @param {string} dir 目標專案資料夾
 * @param {GateConfig} config
 * @returns {{ signingKey: string, entryPath: string }}
 */
/**
 * 讀出目前注入的進入點是**為哪一個 visibility 產生的**。
 *
 * 2026-08-29 真實端到端測試抓到的 bug：專案第一次以 `private` 部署，之後在後台
 * 改成 `password` 再重新部署，`hub ship` 會走「已經注入過、不重複寫入」那條路，
 * 於是現場的 `hub-gate-entry.js` 裡仍然烙著 `visibility: "private"`。
 * 結果是密碼雜湊確實被注入成 Secret，但閘道根本不看它——訪客拿到 404 而不是
 * 密碼輸入頁。
 *
 * 內容有保護（fail-safe 的方向是對的），但功能等於沒做出來，而且**完全沒有錯誤
 * 訊息**：每一步都顯示成功。單元測試抓不到，因為它需要「先以某個權限部署、
 * 再改權限、再部署」這個順序。
 *
 * @param {string} dir
 * @returns {string | null} 讀不到時回 null
 */
export function readInjectedVisibility(dir) {
  const entryPath = join(dir, GATE_ENTRY_FILENAME);

  if (!existsSync(entryPath)) return null;

  // 進入點是本工具產生的，格式固定（見 renderGateEntry），所以用正規表示式讀
  // 是安全的——不是在解析任意的使用者程式碼。
  const match = readFileSync(entryPath, "utf8").match(/visibility:\s*"([a-z]+)"/);

  return match ? match[1] : null;
}

/**
 * 只重寫進入點檔案，不動 `wrangler.jsonc`。
 *
 * 為什麼不動設定檔：`runWorkerFirstFor()` 對所有需要閘道的狀態都回 `["/*"]`
 * （`src/visibility.js`），所以 private 與 password 之間切換時設定檔沒有差異。
 * 而 `injectGate()` 會因為 `main` 已存在而拒絕執行——那個保護是對的，不該為了
 * 這件事放寬它。
 *
 * @param {string} dir
 * @param {{ projectId: number, visibility: string, policyVersion: number, projectName: string }} config
 */
export function rewriteGateEntry(dir, config) {
  writeFileSync(join(dir, GATE_ENTRY_FILENAME), renderGateEntry(config), "utf8");
}

export function injectGate(dir, config) {
  const wranglerPath = join(dir, "wrangler.jsonc");

  if (!existsSync(wranglerPath)) {
    throw new Error(`找不到 ${wranglerPath}，無法注入閘道。`);
  }

  const entryPath = `./${GATE_ENTRY_FILENAME}`;
  const runWorkerFirst = runWorkerFirstFor(config.visibility);

  const originalText = readFileSync(wranglerPath, "utf8");
  const withMain = insertMainField(originalText, entryPath);
  const patchedText = patchAssetsBlock(withMain, runWorkerFirst);

  assertPatchedJsoncIsValid(patchedText, entryPath, runWorkerFirst);

  const entryContent = renderGateEntry({
    projectId: config.projectId,
    visibility: config.visibility,
    policyVersion: config.policyVersion,
    projectName: config.projectName,
  });

  const gateDirTarget = join(dir, GATE_DIR_NAME);

  if (existsSync(gateDirTarget)) {
    rmSync(gateDirTarget, { recursive: true, force: true });
  }

  cpSync(ACCESS_GATE_SOURCE_DIR, gateDirTarget, { recursive: true });
  writeFileSync(join(dir, GATE_ENTRY_FILENAME), entryContent, "utf8");
  writeFileSync(wranglerPath, patchedText, "utf8");

  const signingKey = generateSigningKey();

  return { signingKey, entryPath };
}
