#!/usr/bin/env node

/**
 * 產生管理後台密碼的雜湊，供 `wrangler secret put ADMIN_PASSWORD_HASH` 使用。
 *
 * 為什麼要有這個工具：密碼絕對不能以明碼形式進聊天記錄、不能進版控，
 * 也不該有機會被終端機的輸出記錄留下明碼。這個工具在你自己的終端機
 * 讀取密碼（輸入時遮蔽成星號，不印出明碼），算完雜湊後只印出雜湊字串——
 * 那個字串本身不是密碼，被看到也不能反推出原始密碼。
 *
 * 用法：
 *   node tools/hash-admin-password.mjs
 */

import { hashPassword } from "../src/access-gate/password.js";

/** 跟 `src/routes/policies.js` 的專案密碼要求一致，但這裡是獨立常數——
 *  管理後台密碼跟專案密碼是兩個不同的關注點，不值得為一個數字互相耦合。 */
const MIN_PASSWORD_LENGTH = 8;

/**
 * 讀完非 TTY stdin 的全部內容，依換行切成陣列。
 *
 * 2026-08-25 由獨立驗證 agent 抓到的真實 bug：舊版每問一題就用
 * `readline.createInterface().question()` 問一次、問完就 `close()`。
 * 管道輸入的 stdin 是一次性資料流，實測發現用 `readline` 連問兩次
 * 即使全程共用同一個 Interface 仍不可靠——`await` 造成的微任務延遲，
 * 剛好讓串流在第二次 `question()` 掛上監聽器前就已經自動進入關閉狀態，
 * 導致第二個問題永遠等不到答案，而呼叫端只能無限等待或（舊版）安靜地
 * 以 exit code 0 結束、什麼都沒印。
 *
 * 修法是徹底避開這個時序問題：非 TTY 情境下**不逐題問**，一次把全部輸入
 * 讀完、按換行切好，之後兩個問題都從這個陣列裡直接取值，不再依賴
 * `readline` 的事件時序。這樣不管使用者一次貼了幾行、中途有沒有延遲，
 * 結果都是可預期的。
 *
 * @returns {Promise<string[]>}
 */
function readAllStdinLines() {
  return new Promise((resolve) => {
    const chunks = [];

    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8").split(/\r?\n/));
    });
  });
}

/**
 * 隱藏輸入地讀一行。沒有 TTY（例如被導管、被其他程式呼叫）時沒辦法遮蔽，
 * 退回一般讀取並明講原因，而不是假裝遮蔽了——這種情況下 `nonTtyLines`
 * 是必填的（見 `readAllStdinLines`），`lineIndex` 是目前要取用第幾行。
 *
 * @param {string} prompt
 * @param {{ nonTtyLines: string[] | null, lineIndex: number }} context
 * @returns {Promise<string | null>} 該行不存在（輸入提前結束）時回傳 null
 */
function readHiddenLine(prompt, context) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;

    if (!stdin.isTTY) {
      stdout.write(`${prompt}（此環境無法遮蔽輸入，會顯示明碼）：\n`);
      const line = context.nonTtyLines[context.lineIndex];

      context.lineIndex += 1;
      resolve(line === undefined ? null : line);
      return;
    }

    stdout.write(`${prompt}：`);

    let input = "";

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    function finish(value) {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      resolve(value);
    }

    function onData(chunk) {
      for (const char of chunk) {
        if (char === "\n" || char === "\r") {
          stdout.write("\n");
          finish(input);
          return;
        }

        if (char === "\u0003") {
          // Ctrl+C：照一般終端機慣例直接結束，不留下任何狀態。
          stdout.write("\n");
          process.exit(1);
        }

        if (char === "\u007f" || char === "\b") {
          if (input.length > 0) {
            input = input.slice(0, -1);
            stdout.write("\b \b");
          }

          continue;
        }

        input += char;
        stdout.write("*");
      }
    }

    stdin.on("data", onData);
  });
}

async function main() {
  const { stdin } = process;

  // 非 TTY 時一次讀完全部輸入（見 readAllStdinLines 的說明）；
  // 互動式終端機走 raw-mode 分支，完全不用這個陣列。
  const context = {
    nonTtyLines: stdin.isTTY ? null : await readAllStdinLines(),
    lineIndex: 0,
  };

  const password = await readHiddenLine("請輸入管理後台密碼", context);

  if (password === null) {
    process.stderr.write("輸入在讀到密碼前就結束了，未產生雜湊。\n");
    process.exitCode = 1;
    return;
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    process.stderr.write(`密碼至少需要 ${MIN_PASSWORD_LENGTH} 個字元，未產生雜湊。\n`);
    process.exitCode = 1;
    return;
  }

  const confirmation = await readHiddenLine("再輸入一次確認", context);

  if (confirmation === null) {
    process.stderr.write("輸入在讀到確認密碼前就結束了，未產生雜湊。\n");
    process.exitCode = 1;
    return;
  }

  if (confirmation !== password) {
    process.stderr.write("兩次輸入不一致，未產生雜湊。\n");
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);

  process.stdout.write("\n雜湊已產生。這一整行不是密碼，貼出去也不能反推回你的密碼：\n\n");
  process.stdout.write(`${hash}\n\n`);
  process.stdout.write("接下來請執行，並在提示出現時貼上上面那一行：\n");
  process.stdout.write("  wrangler secret put ADMIN_PASSWORD_HASH\n");
}

main();
