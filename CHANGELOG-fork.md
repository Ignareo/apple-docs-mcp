# 变更记录（Fork 维护日志）

> 本文件记录 **Ignareo/apple-docs-mcp** fork 相对上游 `kimsungwhee/apple-docs-mcp` 的全部变更。
> 仅存在于本 fork，**不随 PR 提交上游**。
> 新条目写在「变更条目」最上方，格式参照模板（见文末）。

## 变更条目

### 2026-10-22 — fix: 堵静默空结果漏洞 + 重试/UA 反馈接线 + 参数错误可读化

- **分支**：`fix/search-apple-jsonl-api`（commit `1c05af9`，9 文件，+329/−20）
- **状态**：已提交 fork 分支本地（随 search JSONL PR 一并推送）
- **问题**：审查 14b9eb2 发现三个问题——
  1. `parseJsonl` 仅按「JSON 行可解析」判断格式变更：若 Apple 调整事件结构（`kind` 改名等），每行仍是合法 JSON，会**静默返回 "No results."**——恰是硬约束禁止的失败形态（实测 `{"foo":1}` 型 payload 可复现）。
  2. `postQuery` 单次请求无重试，瞬时网络抖动直接 `isError` 抛给调用方；search 专用 UA 池配了 `disableDuration`/`failureThreshold`/`minSuccessRate`，但 `markSuccess`/`markFailure` 从未被调用，禁用/恢复机制是死代码。
  3. 参数校验失败（如 `limit=99`）时 `handleToolCall` 把 ZodError 原始 JSON dump 丢给 LLM 调用方。
- **改动**：
  - `parseJsonl` 增加 `recognizedEvents` 计数（`quickSearch` / `*Finished` / `diff` 视为协议内事件），为 0 即抛 "response format may have changed"；带 `searchFinished` 标记的合法空结果不受影响。
  - `postQuery` 增加重试：网络错误 / 5xx / 429 指数退避重试（默认 3 次、1s 起，可用 `SEARCH_API_MAX_RETRIES` / `SEARCH_API_RETRY_DELAY_MS` 覆盖），每次尝试换 UA 并回报 `markSuccess`/`markFailure`；超时与其余 4xx 快速失败不重试。
  - `handleToolCall` 与 `index.ts` 两处 catch 特判 ZodError，只输出首条 issue 的可读单行（实测：`Invalid arguments for search_apple_docs: limit: Too big: expected number to be <=30`）。
  - 顺带把 DSH 沙箱用的 `.corepack-home/`、`.npm-cache/` 加入 `.gitignore`。
  - 单测 +10：结构变更回归 2 / 重试行为 5 / UA 池反馈 1 / Zod 可读化 2（index 与 handlers 层各一）。
- **测试/验证**：`pnpm build` ✅ / `pnpm test` 493/493 ✅ / `pnpm lint` 0 error（190 warning 均为存量）✅ / 真实网络探针 12/12 ✅（含 `limit=99` 实测返回可读单行）。
- **备注**：**行为变更**——瞬时故障现在会被静默恢复而非报错，`tests/response-format.test.ts` 的 network-error 用例已改为持久失败语义；单测经 `SEARCH_API_RETRY_DELAY_MS=1` 保持套件速度。上一批 🟡 建议（search_scope 值文档化、locale 参数、excerpt 截断、probe 脚本入库）未动，留待后续。

---

### 2026-10-21 — fix: migrate search_apple_docs to Apple's JSONL search API

- **分支**：`fix/search-apple-jsonl-api`（commit `14b9eb2`，12 文件，+1083/−736）
- **状态**：已推送 fork；PR 待开
- **问题**：上游 `search_apple_docs` 抓取 `developer.apple.com/search` 的 HTML 并用 CSS 选择器解析；Apple 搜索页改版为 JS 前端渲染后，旧 HTML 只剩应用外壳，工具对任何 query 恒返回 0 结果（上游 6 个测试文件全部只测 http-client/UA 池，search 链路零测试，故半年无人察觉）。
- **修复**：改为调用 Apple 实际搜索后端 `POST https://devintserv.msc.sbz.apple.com/api/v1/query`（`Accept: application/jsonl`），从已验证的 Python 参考实现逐函数移植：
  - `src/tools/search-api-client.ts`（新增）：`postQuery`（必须带 `Origin`/`Referer` 头，UA 走 UserAgentPool，20s 超时）/ `parseJsonl` / `dedupeMerge` / `searchAppleDocsApi`
  - **核心语义**：`search` 结果是一串 diff 增量事件——每个事件先从缓冲区末尾删除 `removeLast` 个字符，再追加 `append` 片段；全部事件处理完后对整个缓冲区 `JSON.parse` 得到 `{"results": [...]}`。直接拼接/逐行解析会失败。
  - quickSearch 与 search 结果按 permalink 去重合并，search 条目（带命中 excerpt）优先。
- **删除**：`src/tools/search-result-parser.ts`（旧 HTML 节点解析器，无残留引用）。
- **工具参数变更**：`query` / `limit`（1-30，默认 10）/ `search_scope`；移除旧 `type` 过滤（新 API 无此概念）。
- **错误处理（硬约束）**：空 query、HTTP 4xx/5xx、网络错误、响应结构变更 → 一律 `isError=true` 并提示该端点为 Apple 未公开接口可能变更；**禁止静默返回 "No results"**。
- **测试**：新增 42 个用例——`src/__tests__/search-api-client.test.ts`（13：removeLast 重建 4 / 去重合并 3 / 错误路径 6）+ 重写 `tests/tools/search-parser.test.ts`（29）等 `tests/` 三个套件。`pnpm build` ✅ / `pnpm test` 483/483 ✅ / `pnpm lint` 0 error ✅。
- **探针五条验收（真实网络）**：UIButton configuration 首条 UIButtonConfiguration ✅ / UIWindowScene.windows 符号 ✅ / 精确符号命中 ✅ / 空 query isError ✅ / 断网-4xx 由错误路径用例 + 实测超时验证 ✅。
- **环境备忘**：corepack 缓存须放 workspace（`COREPACK_HOME`/`npm_config_cache` 指向 workspace 内目录，DSH 沙箱拦 `~/Library` 与 `~/.cache` 写入）；pnpm 拦截 esbuild/unrs-resolver 的 postinstall 不影响 tsc/jest/eslint 链路，无需处理。

---

## 新条目模板

```markdown
### YYYY-MM-DD — <类型>: <一句话标题>

- **分支**：`<branch>`（commit `<hash>`，N 文件，+x/−y）
- **状态**：已推送 fork / PR 已开(#N) / 仅本地
- **问题**：<为什么改>
- **改动**：<改了什么，核心语义/接口变化>
- **测试/验证**：<命令与结果>
- **备注**：<环境坑、回滚方式、与其他变更的依赖>
```

*维护人：Ignareo。最后更新：2026-10-22。*
