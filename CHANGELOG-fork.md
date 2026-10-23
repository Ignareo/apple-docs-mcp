# 变更记录（Fork 维护日志）

> 本文件记录 **Ignareo/apple-docs-mcp** fork 相对上游 `kimsungwhee/apple-docs-mcp` 的全部变更。
> 仅存在于本 fork，**不随 PR 提交上游**。
> 新条目写在「变更条目」最上方，格式参照模板（见文末）。

## 变更条目

### 2026-10-23 — feat: 带日期更新页 + 搜索 locale + framework 索引缓存复用 + 渲染边角

- **分支**：`fix/search-apple-jsonl-api`（commit `9d444ff`，26 文件，+2855/−272）
- **状态**：已推送 fork
- **问题**（来自 `research/REPORT.md` §8 待办的第 2/4/5/6/7 项）：
  1. `get_documentation_updates` 只是静态字母序链接目录，没有日期、没有"新变化"；Apple 的 `/documentation/updates/<tech>` 明明有带月份小节的内容却从不去取。
  2. `search_apple_docs` 无法本地化标题（中文/日文用户看 WWDC 条目仍是英文）。
  3. 框架预热缓存 key 与真实查询 key 永远不相等（预热白下载）；索引请求沿用 30s 全局超时，大索引抖动即失败；无 path 的 GroupMarker 生成 `…/undefined` 链接，且 "Found: N" 实为截断后的数量。
  4. 文档渲染仍有边角丢失：tabNavigator 只渲染第一个 tab；Parameters 只取每参数第一段 inlineContent（嵌套列表/代码/aside 全丢）；图片以 inline run 形式出现时完全不渲染；`termList`/`row`/`video` 块未知。
  5. 四语言 README 与工具描述仍有 2012/13 years/不存在的工具名/30 条上限等过时文案。
- **改动**：
  - `get_documentation_updates` 新增 `detail=auto|index|timeline`：给 `technology` 时解析 `/index/updates` 的 technology→slug（大小写/空格/连字符归一），抓 `/tutorials/data/documentation/updates/<slug>.json`，把 "September 2026" 等 heading 渲染成 `## 日期段`、其余 heading 成子主题，reference 转 markdown 链接、codeVoice 转行内代码；单条 400 字符、输出 14K 硬上限、`limit`/`year`/`searchQuery` 过滤；未知技术名返回 `isError` 并列 20 个合法值；index 模式输出与缓存键保持原样。
  - `search_apple_docs` 新增 `locale`（`en-US`/`zh-CN`/`ja-JP`/`ko-KR`，实测仅这四个真正本地化），透传 Apple `targetResultLocale`，搜索缓存键加入 locale。
  - `search_framework_symbols`：原始索引 JSON 单独缓存（`framework-index-json:<url>`，工具与 preloader 同键、in-flight 去重），格式化结果仍按 limit 缓存；索引超时提到 60s（`APPLE_DOCS_FRAMEWORK_INDEX_TIMEOUT_MS`）并给可执行提示；跳过无 path 的 groupMarker、空标题；输出 `Found X of Y`（全量计数）。
  - `preloader`：预热改用同一原始索引 key，并发从 `Promise.all` 降到 2（`APPLE_DOCS_PRELOAD_ENABLED/CONCURRENCY/DELAY_MS` 可调），启动期不再抢带宽。
  - 渲染：tabNavigator 渲染全部 tab（4 tab / 2.5K 字符预算 + 省略标记）；Parameters 用 `formatContentBlocks` 完整渲染并兼容旧 `inlineContent`；inline image（reference/block variants、caption、`name` 兜底）与 `termList`/`row`/`columns`/`video` 块支持。
  - 文案：`definitions.ts` + 各工具文件去掉 "Perfect for / Essential for" 营销句，补 60 条上限、`detail`、locale 作用范围、`Found X of Y` 等真实语义；四份 README 工具表对齐 18 个工具、统一 2014–2025 / 1,266 sessions / snapshot 2025-07-18、删除 4 个不存在的工具名。
  - 新增 `scripts/refresh-wwdc-catalog.mjs`（`npm run wwdc:audit` / `wwdc:refresh`）：从 `/videos/wwdc<year>/` 解析 session 目录，默认只审计、不写数据；`--write-catalog` 可选，且明确不伪造 transcript/code（Apple 的 transcript 由 JS/AJAX 加载，静态 HTML 取不到）。
  - 审计与验证脚本：`research/verify-batch3.mjs`（19 项真实调用断言）；`research/REPORT.md` 增补 §8 第二批实现记录 / §9 验证命令 / §10 剩余待办。
- **测试/验证**：`npx tsc --noEmit` ✅ / `npx jest` 625/625（34 suites，基线 587）✅ / `npm run lint` 0 error（199 存量 warning）✅ / `npm run build` ✅ / `research/verify-batch3.mjs` 19/19 ✅。真实前后对比：SwiftUI 更新页 282 字符链接目录 → 13,446 字符 / 188 条变更 / 3 个日期段；`WWDC 2024`+`zh-CN` 返回中文 WWDC 标题与 `/cn/` URL；uikit 同级 limit 冷 2,421ms → 热 1–5ms，`undefined` 链接 57/200 → 0；UIButton 1→2 tab、0→2 图，declaring-a-custom-view 0→4 图，HIG buttons 0→23 图 + 2 video；URLSession init 参数 1,618→2,201 字符。
- **备注**：`detail=auto` 只在给了 `technology` 时切 timeline，旧的 index 行为与缓存键完全保留；timeline 命中缓存时仍会重拉 ~80KB index 解析 slug（~1s，待优化）；WWDC 目录脚本 `--year 2025` 验证 122/122 已存在、`--year 2026` 识别 138 个新 session，但数据未入包（包体积决策待定）。

---

### 2026-10-23 — fix: 文档渲染重建 + WWDC 输出预算 + 假指标清理 + 错误契约统一

- **分支**：`fix/search-apple-jsonl-api`（commit `2a87777`，41 文件，+4035/−597）
- **状态**：已推送 fork
- **问题**（`research/REPORT.md` §2 的 P0/P1）：文档内容系统性损坏（代码围栏闭合符缺 `\n`、See Also/话题链接 404、正文用原始 slug 当标题、文章页 0 代码块、符号页丢表格/aside/list/image、废弃状态不显示）；WWDC 工具最坏 400+ KB；假指标（写死 Similarity N/10、"Found 200" 实为 11,162 里的 200、`undefined` 链接）；失败伪装成功（`[object Object]`、WWDC handler 不设 `isError`）。
- **改动**：统一 block renderer（heading/paragraph/codeListing/table/aside/有序无序列表/image/links/tabNavigator + 内联 codeVoice/emphasis/link/reference）并在文章页与符号页复用；链接与引用标题统一走 `references[id].url/title`；`deprecatedAt` + `deprecationSummary`；HIG `/design/...` 映射到 `/tutorials/data/design/...json`；WWDC 输出预算（transcript 默认 12K、视频代码 8K/单例 1.5K、snippet 300、每视频 1 条、code example 1.5K）+ `year/topic/language` 校验 + 快照日期上屏；删 `find_similar_apis` 写死相似度，改来源标注 + deprecated 提示；`get_related_apis` 全局 60 条上限 + 分区 + 真实总数；`list_technologies` per-category limit + 真实总数；`get_platform_compatibility` 合并为一张表并识别废弃；`describeError/describeToolError` 统一所有失败路径 + `isError:true`；更新页把 "Past releases" 下的 WWDC 条目正确归类。
- **测试/验证**：`npx tsc --noEmit` ✅ / `npx jest` 587/587 ✅ / `npm run lint` 0 error ✅ / `npm run build` ✅ / `research/verify-batch2.mjs` 15 个真实调用 ✅。关键数字：文章页 0→7 代码块 + 6 标题；UIButton 恢复 17 行表格 + 2 aside；`search_wwdc_content(limit:100)` 403.9KB→39.3KB；`get_wwdc_video(2021,10018)` 179.6KB→23.5KB；UIView related 37.4KB/183→10.6KB/60；technologies 36KB（200/407）→14KB（110/407）。
- **备注**：`get_apple_doc_content` 的 4 个 `include*` 开关与 18 个工具名未动（合并工具属破坏性变更，需另行确认）。

---

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

*维护人：Ignareo。最后更新：2026-10-23。*
