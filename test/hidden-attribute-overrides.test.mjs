/**
 * `hidden` 屬性被 class 的 `display` 蓋掉——本專案的第一大重複坑。
 *
 * 到 2026-08-29 為止累計踩過**五次**（`.nav-link`、`.filter-groups`、
 * `.project-category` 等、`.project-admin-primary-badge`、`.project-grid` ＋
 * `.project-admin-list`）。每一次的共同特徵是**不會報錯**：`hidden` 屬性設下去了、
 * JS 沒有異常、瀏覽器也不抗議，元素就是還在畫面上。全部靠人工發現。
 *
 * 這個測試是那個坑的護欄。原理是 CSS 的層級規則：`hidden` 屬性的效果來自
 * UA 樣式表的 `[hidden] { display: none }`，而**作者樣式表的任何類別選擇器
 * 都勝過 UA 樣式表**。所以只要某個元素的 class／id 在我們自己的 CSS 裡設了
 * `display`，`hidden` 就失效，必須另外配一條 `[hidden]` 覆寫。
 *
 * 檢查範圍刻意含兩種來源，因為兩者都出過事：
 *   1. HTML 裡直接寫 `hidden` 屬性的元素。
 *   2. JS 用 `x.hidden = ...` 切換的元素（HTML 上可能沒有 `hidden` 字樣，
 *      `.project-grid` 就是這一類——它在 HTML 有 hidden，但 setMode() 也在改）。
 *
 * 只在「該元素真的有 `display` 規則」時才要求覆寫。不加這個條件會產生大量
 * 假警報，並逼出一堆沒有必要的 CSS——沒有 `display` 規則的元素，
 * 原生的 `hidden` 本來就有效。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(PROJECT_ROOT, "public");

/** @param {string} dir @param {string} ext @returns {string[]} */
function collectFiles(dir, ext) {
  /** @type {string[]} */
  const found = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      found.push(...collectFiles(full, ext));
      continue;
    }

    if (extname(entry) === ext) {
      found.push(full);
    }
  }

  return found;
}

/**
 * 去掉 CSS 註解。不做這一步的話，被註解掉的規則會被當成真的規則，
 * 讓測試在該紅的時候變綠——那比沒有測試更糟。
 *
 * @param {string} css
 */
function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 把 CSS 拆成「選擇器清單 → 宣告內容」。
 *
 * 用這個簡單的正規表示式而不是完整的 CSS 解析器，是刻意的取捨：
 * `[^{}]*` 的內容部分無法匹配含巢狀大括號的 at-rule 前言（`@media (...) { ... }`），
 * 於是引擎會跳過 `@media` 那一層、直接匹配到裡面的規則——正好是我們要的行為
 * （媒體查詢裡的 `display` 一樣會蓋掉 `hidden`，必須算進來）。
 *
 * @param {string} css
 * @returns {Array<{ selectors: string[], body: string }>}
 */
function parseRules(css) {
  /** @type {Array<{ selectors: string[], body: string }>} */
  const rules = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;

  let match;
  while ((match = pattern.exec(css)) !== null) {
    const prelude = match[1].trim();

    // at-rule 的前言（@media／@supports／@keyframes 的百分比等）不是選擇器。
    if (prelude.startsWith("@") || /^\d/.test(prelude) || prelude === "from" || prelude === "to") {
      continue;
    }

    rules.push({
      selectors: prelude.split(",").map((one) => one.trim()).filter(Boolean),
      body: match[2],
    });
  }

  return rules;
}

/**
 * 收集 HTML 裡「帶 hidden 屬性」與「被 JS 切換 hidden」的元素選擇器。
 *
 * @returns {Map<string, Set<string>>} 選擇器 → 出處描述集合
 */
function collectHiddenTargets() {
  /** @type {Map<string, Set<string>>} */
  const targets = new Map();

  /** @param {string} selector @param {string} origin */
  const add = (selector, origin) => {
    if (!targets.has(selector)) targets.set(selector, new Set());
    targets.get(selector)?.add(origin);
  };

  // --- 來源 1：HTML 裡直接寫 hidden 屬性的元素 ---
  for (const file of collectFiles(PUBLIC_DIR, ".html")) {
    const html = readFileSync(file, "utf8");
    const where = relative(PROJECT_ROOT, file).replace(/\\/g, "/");

    // 只抓開始標籤，且該標籤含獨立的 hidden 屬性（不是 data-hidden 之類）。
    for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      if (!/\shidden(?=[\s/>=])/.test(tag)) continue;

      const id = tag.match(/\sid="([^"]+)"/)?.[1];
      if (id) add(`#${id}`, where);

      for (const className of (tag.match(/\sclass="([^"]+)"/)?.[1] ?? "").split(/\s+/)) {
        if (className) add(`.${className}`, where);
      }
    }
  }

  // --- 來源 2：JS 用 x.hidden = ... 切換的元素 ---
  for (const file of collectFiles(PUBLIC_DIR, ".js")) {
    const js = readFileSync(file, "utf8");
    const where = relative(PROJECT_ROOT, file).replace(/\\/g, "/");

    // 變數名 → 它 getElementById 到的 id。只認最直接的寫法；查不到對應的
    // 變數（例如來自函式參數或 querySelector 的結果）就跳過——這個測試的
    // 目的是攔住常見寫法，不是做完整的資料流分析。
    /** @type {Map<string, string>} */
    const varToId = new Map();
    const declaration = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\/\*\*[\s\S]*?\*\/\s*)?\(?\s*(?:\/\*\*[\s\S]*?\*\/\s*)?document\.getElementById\(\s*"([^"]+)"/g;

    let declared;
    while ((declared = declaration.exec(js)) !== null) {
      varToId.set(declared[1], declared[2]);
    }

    let toggled;
    const toggle = /([A-Za-z_$][\w$]*)\.hidden\s*=/g;
    while ((toggled = toggle.exec(js)) !== null) {
      const id = varToId.get(toggled[1]);
      if (id) add(`#${id}`, where);
    }
  }

  return targets;
}

test("每個會被 hidden 隱藏、又自己設了 display 的元素，都有配 [hidden] 覆寫", () => {
  const cssFiles = collectFiles(PUBLIC_DIR, ".css");
  assert.ok(cssFiles.length > 0, "找不到任何 CSS 檔，測試本身壞了");

  const rules = cssFiles.flatMap((file) => parseRules(stripCssComments(readFileSync(file, "utf8"))));
  assert.ok(rules.length > 0, "解析不到任何 CSS 規則，測試本身壞了");

  const targets = collectHiddenTargets();
  assert.ok(targets.size > 0, "找不到任何用 hidden 隱藏的元素，測試本身壞了");

  /** 某個選擇器有沒有在任何規則裡設 display。 */
  const declaresDisplay = (selector) =>
    rules.some(
      (rule) =>
        /(^|[\s;])display\s*:/.test(rule.body) &&
        rule.selectors.some((one) => one === selector || one.startsWith(`${selector}:`)),
    );

  /** 某個選擇器有沒有 [hidden] 覆寫，且該覆寫真的是 display: none。 */
  const hasHiddenOverride = (selector) =>
    rules.some(
      (rule) =>
        /display\s*:\s*none/.test(rule.body) &&
        rule.selectors.some((one) => one === `${selector}[hidden]`),
    );

  /** @type {string[]} */
  const missing = [];

  for (const [selector, origins] of targets) {
    if (!declaresDisplay(selector)) continue;
    if (hasHiddenOverride(selector)) continue;

    missing.push(`${selector}（出處：${[...origins].join("、")}）`);
  }

  assert.deepEqual(
    missing,
    [],
    `以下元素會被 hidden 隱藏、但自己的 CSS 設了 display，hidden 會失效。\n` +
      `每一個都要補一條 \`<選擇器>[hidden] { display: none; }\`：\n  ` +
      missing.join("\n  "),
  );
});
