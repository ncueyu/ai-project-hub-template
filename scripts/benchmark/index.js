// @ts-check

/**
 * PBKDF2 成本量測。
 *
 * 用途：階段二計畫第 13.3 節要求「PBKDF2 iterations 必須在真實 Worker
 * 環境量測後定案，不得憑猜測」。這支 Worker 就是為此存在。
 *
 * 執行方式（在專案根目錄）：
 *   pnpm exec wrangler dev -c scripts/benchmark/wrangler.jsonc --port 8794
 *   然後開啟 http://127.0.0.1:8794/
 *
 * 注意：這是本機 workerd 的量測結果。正式對外前仍應在實際部署的
 * Cloudflare 環境重跑一次，因為硬體與排程條件可能不同。
 */

import { benchmarkIterations } from "../../src/access-gate/password.js";

/** 要量測的重複次數。涵蓋足夠寬的範圍以便觀察成長趨勢。 */
const CANDIDATES = [10_000, 25_000, 50_000, 75_000, 100_000, 150_000, 200_000];

/** Workers 免費方案每次呼叫的 CPU 時間上限。 */
const CPU_LIMIT_MS = 10;

export default {
  async fetch() {
    const measurements = [];

    for (const iterations of CANDIDATES) {
      const result = await benchmarkIterations(iterations, 3);

      measurements.push({
        iterations: result.iterations,
        averageMs: Number(result.averageMs.toFixed(2)),
        withinCpuLimit: result.averageMs < CPU_LIMIT_MS,
      });
    }

    // 在限制內能負擔的最高重複次數，就是安全性最好的選擇。
    const affordable = measurements.filter((m) => m.withinCpuLimit);
    const recommended = affordable.length > 0
      ? affordable[affordable.length - 1].iterations
      : null;

    return new Response(JSON.stringify({
      cpuLimitMs: CPU_LIMIT_MS,
      note: "本機 workerd 量測；正式部署後仍須重跑確認。",
      measurements,
      recommended,
    }, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  },
};
