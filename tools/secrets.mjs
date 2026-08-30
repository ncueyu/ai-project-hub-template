/**
 * Secret 掃描（2026-08-14 工作計畫 TASK B-3 的核心項目）。
 *
 * 這是部署前檢查裡唯一「寧可誤擋也不要放過」的項目：金鑰一旦隨產物上線，
 * 撤銷的成本遠高於多花五分鐘確認一次誤判。
 *
 * 兩個設計重點：
 *
 * 1. **先去除註解再比對。** 說明「不要把金鑰寫在這裡」的註解本身就含有金鑰
 *    的樣子。本專案在這個坑上跌過三次，`source-text.mjs` 就是為此而存在，
 *    而且它保留換行，行號才不會位移。
 * 2. **佔位值不算外洩。** `change-me`、`your-api-key`、`${VAR}`、`process.env.X`
 *    這類值出現在範本裡是正常的。把它們一律當成外洩，使用者很快就會學會
 *    忽略這個檢查——那才是真正的風險。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { blankComments, blankHashComments, toLineColumn } from "./source-text.mjs";

/** 不掃描的目錄。產物目錄（dist、public）刻意**不在**此列——那才是會上線的東西。 */
export const SKIPPED_DIRECTORIES = Object.freeze([
  "node_modules",
  ".git",
  ".wrangler",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

/** 不掃描的副檔名：二進位檔案掃了也只會產生亂碼比對。 */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".webm", ".wav", ".ogg",
  ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar",
  ".wasm", ".exe", ".dll", ".so", ".dylib",
  ".sqlite", ".db",
]);

/** 範本檔案：裡面本來就該是假值。 */
const TEMPLATE_SUFFIXES = Object.freeze([".example", ".sample", ".template", ".dist"]);

/** 單一檔案的大小上限（位元組）。超過的檔案幾乎都是產物或資料檔。 */
const MAX_FILE_BYTES = 512 * 1024;

/** 掃描檔案數上限。達到上限時會明確回報，不做無聲截斷。 */
const MAX_FILES = 5000;

/**
 * 已知金鑰格式。這些樣式的誤判率極低，命中就是重大問題。
 *
 * @type {{ id: string, label: string, pattern: RegExp }[]}
 */
export const KEY_PATTERNS = Object.freeze([
  { id: "aws-access-key", label: "AWS 存取金鑰", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "google-api-key", label: "Google API 金鑰", pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { id: "github-token", label: "GitHub 權杖", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "github-pat", label: "GitHub 個人存取權杖", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: "slack-token", label: "Slack 權杖", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "stripe-key", label: "Stripe 金鑰", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
  { id: "private-key", label: "私密金鑰檔內容", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    id: "jwt",
    label: "JSON Web Token",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
]);

/**
 * 一般的秘密賦值：`api_key = "……"`、`"token": "……"`。
 *
 * 值的字元集刻意限制在「權杖看起來的樣子」（英數與 `-_+/=.~`），不允許空白
 * 與中文。這是實測後收緊的：原本接受任意字元，導致
 * `fields.password = "長度必須介於 8 到 128 個字元。"` 這種**錯誤訊息**被
 * 判為外洩。誤判會讓人學會忽略這個檢查，那比漏報更危險。
 */
const ASSIGNMENT_PATTERN =
  /\b(api[_-]?key|secret[_-]?key|secret|access[_-]?token|auth[_-]?token|token|password|passwd|signing[_-]?key|private[_-]?key)\b\s*["']?\s*[:=]\s*["'`]([A-Za-z0-9_\-+/=.~]{12,})["'`]/gi;

/**
 * 判斷是不是測試檔案。
 *
 * 測試**必須**含有假的憑證，否則沒辦法驗證擋不擋得住。這類檔案也不會進入
 * 任何一種支援型態的部署產物，因此降級為提醒而非重大——但仍然回報，
 * 因為「測試裡放了真金鑰」確實會發生。
 *
 * @param {string} relativePath 以 `/` 分隔的相對路徑
 * @returns {boolean}
 */
export function isTestPath(relativePath) {
  return /(^|\/)(test|tests|__tests__|spec|fixtures?)(\/|$)/.test(relativePath)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
}

/**
 * 是否為第三方套件的打包產物。
 *
 * 為什麼需要這個判定（2026-08-22 新增）：**vendor bundle 必然會踩到內容掃描器**。
 * 實測 Supabase SDK 的打包檔含這一段常數表：
 *
 * ```js
 * { close: "phx_close", error: "phx_error", access_token: "access_token" }
 * ```
 *
 * `access_token` 只是屬性名對應到同名字串，不是憑證值——但樣式比對看不出差別。
 * 這類命中在每次建置後都會重複出現，而且**你無法修它**（那是別人的程式碼）。
 *
 * 把它算成重大失敗，結果會是「每次建置後檢查都是紅的」，
 * 接著使用者就學會忽略整個 Secret 掃描——那比沒有這項檢查更糟。
 * 因此降為提醒級，但**仍然列出來**，因為理論上第三方套件也可能真的夾帶金鑰。
 *
 * 判定依據是路徑特徵而非檔名：Vite／Rollup 的慣例是把第三方程式碼
 * 拆進 `vendor-*` 或 `chunk-*`，也可能落在 `node_modules` 的鏡像路徑下。
 *
 * @param {string} relativePath
 * @returns {boolean}
 */
export function isVendorBundlePath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");

  return /(^|[\\/])node_modules([\\/]|$)/.test(normalized)
    || /[\\/](vendor|vendors|chunk)[-.][A-Za-z0-9_-]+[.][cm]?js$/i.test(normalized)
    || /^(vendor|vendors|chunk)[-.][A-Za-z0-9_-]+[.][cm]?js$/i.test(normalized);
}

/**
 * 看起來像佔位值就不算外洩。
 *
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikePlaceholder(value) {
  const lowered = value.toLowerCase();

  if (/^\s*(\$\{|<|process\.env|import\.meta\.env|env\.)/.test(value)) {
    return true;
  }

  if (/^[x*.\-_\s]+$/.test(value)) {
    return true;
  }

  return [
    "change-me",
    "changeme",
    "your-",
    "your_",
    "yourkey",
    "example",
    "placeholder",
    "dummy",
    "sample",
    "test-key",
    "fake",
    "todo",
    "xxxxx",
    "local-development-only",
  ].some((needle) => lowered.includes(needle));
}

/**
 * 依副檔名選擇去註解的方式。
 *
 * @param {string} path
 * @param {string} source
 * @returns {string}
 */
export function prepareSource(path, source) {
  const extension = extname(path).toLowerCase();

  if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx", ".css", ".json", ".jsonc"].includes(extension)) {
    return blankComments(source);
  }

  if ([".sh", ".yml", ".yaml", ".toml", ".ini", ".conf", ".env", ""].includes(extension)) {
    return blankHashComments(source);
  }

  return source;
}

/**
 * 明確標記「這裡的假值是刻意的」。
 *
 * 提供這個機制，而不是為了個別檔案放寬規則——放寬規則會同時降低所有檔案的
 * 保護力，而且沒有人會知道當初為什麼放寬。標記寫在原始碼裡，是一次由人做出
 * 並留下痕跡的決定。
 *
 * 用法：在該行或上一行加上 `hub-ignore-secret` 註解。
 */
export const IGNORE_MARKER = "hub-ignore-secret";

/**
 * 該行是否被標記為刻意。
 *
 * 比對**原始**內容而不是去註解後的內容——標記本身就寫在註解裡。
 *
 * @param {string[]} rawLines
 * @param {number} line 從 1 起算
 * @returns {boolean}
 */
function isMarkedIgnored(rawLines, line) {
  const current = rawLines[line - 1] ?? "";
  const previous = rawLines[line - 2] ?? "";

  return current.includes(IGNORE_MARKER) || previous.includes(IGNORE_MARKER);
}

/**
 * 掃描一份文字內容。
 *
 * @param {string} path 用於回報的路徑
 * @param {string} source
 * @returns {{ path: string, line: number, column: number, rule: string, label: string, excerpt: string }[]}
 */
export function scanText(path, source) {
  const prepared = prepareSource(path, source);
  const rawLines = source.split("\n");
  const findings = [];

  for (const { id, label, pattern } of KEY_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match;

    while ((match = regex.exec(prepared)) !== null) {
      const { line, column } = toLineColumn(prepared, match.index);

      if (isMarkedIgnored(rawLines, line)) {
        continue;
      }

      findings.push({ path, line, column, rule: id, label, excerpt: mask(match[0]) });
    }
  }

  const assignment = new RegExp(ASSIGNMENT_PATTERN.source, ASSIGNMENT_PATTERN.flags);
  let match;

  while ((match = assignment.exec(prepared)) !== null) {
    const value = match[2];

    if (looksLikePlaceholder(value)) {
      continue;
    }

    const { line, column } = toLineColumn(prepared, match.index);

    if (isMarkedIgnored(rawLines, line)) {
      continue;
    }

    findings.push({
      path,
      line,
      column,
      rule: "hardcoded-secret",
      label: `疑似寫死的 ${match[1]}`,
      excerpt: mask(value),
    });
  }

  return findings;
}

/**
 * 回報時只露出頭尾，中間遮掉。
 *
 * 掃描報告本身也可能被貼進聊天或記錄檔，完整印出等於再外洩一次。
 *
 * @param {string} value
 * @returns {string}
 */
export function mask(value) {
  if (value.length <= 8) {
    return "*".repeat(value.length);
  }

  return `${value.slice(0, 4)}${"*".repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isTemplateFile(name) {
  return TEMPLATE_SUFFIXES.some((suffix) => name.toLowerCase().endsWith(suffix));
}

/**
 * 走訪目錄下要掃描的檔案。
 *
 * @param {string} root
 * @returns {{ files: string[], truncated: boolean }}
 */
export function collectFiles(root) {
  /** @type {string[]} */
  const files = [];
  let truncated = false;
  const stack = [root];

  while (stack.length > 0) {
    if (files.length >= MAX_FILES) {
      truncated = true;
      break;
    }

    const current = stack.pop();

    let entries;

    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.includes(entry.name)) {
          stack.push(full);
        }

        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (BINARY_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        continue;
      }

      if (isTemplateFile(entry.name)) {
        continue;
      }

      try {
        if (statSync(full).size > MAX_FILE_BYTES) {
          continue;
        }
      } catch {
        continue;
      }

      files.push(full);
    }
  }

  return { files, truncated };
}

/**
 * 掃描一個目錄。
 *
 * @param {string} root
 * @returns {{ findings: any[], scanned: number, truncated: boolean }}
 */
export function scanDirectory(root) {
  const { files, truncated } = collectFiles(root);
  const findings = [];

  for (const file of files) {
    let source;

    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const shown = relative(root, file).split(sep).join("/");
    // 三種脈絡：test（假憑證是必要的）、vendor（別人的程式碼，改不了）、source（真正要擋的）。
    const context = isTestPath(shown)
      ? "test"
      : (isVendorBundlePath(shown) ? "vendor" : "source");

    for (const finding of scanText(shown, source)) {
      findings.push({ ...finding, context });
    }
  }

  return { findings, scanned: files.length, truncated };
}
