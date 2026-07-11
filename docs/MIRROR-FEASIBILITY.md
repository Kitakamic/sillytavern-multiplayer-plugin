# 镜像聊天模式可行性验证记录

> 验证对象：SillyTavern **1.16.0**（本仓库旁 `../SillyTavern` 检出，git tag 1.16.0，HEAD e3b866b5）
> 验证方式：源码级验证（2026-07-11，逐点核对源码与行号）。运行时抽查随 P1/P3 实现进行；若实测与本文结论冲突，以实测为准并回写本文。
> 结论：**四项本地验证全部可行，镜像模式可以开工**。第 5 项（资产通道端到端）中继侧已就绪（M2.5 完成），插件侧接入后补验。

## 1. 消息截获 —— ✅ 可行

- 订阅：`eventSource.on(event_types.XXX, handler)`，定义于 `public/scripts/events.js`（`MESSAGE_SENT` L8、`USER_MESSAGE_RENDERED` L48）。**emit 会逐个 `await` handler**（`public/lib/eventemitter.js:130-158`），异常被吞不会中断后续 listener。
- 发送时序（`sendMessageAsUser`，`public/script.js:5707-5756`）：`chat.push` (L5747) → emit `MESSAGE_SENT`(参数=消息下标) (L5749) → `addOneMessage` 渲染 (L5750) → emit `USER_MESSAGE_RENDERED` (L5751) → `saveChatConditional` 落盘 (L5752)。
- 在 `MESSAGE_SENT` handler 里 `chat.splice` 可移除消息且**不落盘、不进 prompt**（`Generate()` 先 `await sendMessageAsUser` script.js:4288，之后才从 chat 构建 `coreChat` L4332）。
- **坑**：`MESSAGE_SENT` 时移除后 L5750 仍会渲染"幽灵 DOM 块"（`addOneMessage` 对不在数组的消息 fallback 到 `chat.length-1` 作 mesid，script.js:2451-2468）。建议在 `USER_MESSAGE_RENDERED` 之后再 splice + 自行清 DOM（或 `clearChat()`+`printMessages()` 重绘）。
- **坑**：带 `insertAt` 的分支（L5740-5745）顺序不同——先落盘再 emit，再 `reloadCurrentChat()`。

## 2. 生成拦截 —— ✅ 可行（官方机制）

- `manifest.json` 写 `"generate_interceptor": "全局函数名"`，函数挂 `globalThis`，签名 `(chat, contextSize, abort, type)`；`abort(true)` 即中止本次生成。执行于 `runGenerationInterceptors`（`public/scripts/extensions.js:1655-1680`），调用点 `Generate()` 内（script.js:4392-4400），中止后 `unblockGeneration` 干净退出。
- interceptor 内可用 `getContext().chatId` / `chatMetadata` 判断是否镜像聊天再决定 abort；`type` 参数可区分 `'swipe'/'regenerate'/'quiet'`。
- 时序：interceptor 在用户消息入 chat 且渲染**之后**运行——正合镜像需求（提案照发、AI 不回）。
- 兜底：`stopGeneration()`（script.js:5440，getContext 已暴露）。`GENERATION_AFTER_COMMANDS`/`GENERATION_STARTED` 事件只能观察、无法中止。`dryRun` 时 interceptor 被跳过（L4401-4403）。

## 3. 编辑/删除/swipe 回滚 —— ✅ 有条件可行

- **MESSAGE_EDITED**（最优雅）：`updateMessage` 先写入新文本（script.js:7945-7948）→ emit `MESSAGE_EDITED`(id) (L8173) → **重新从 chat 读值渲染** (L8174)。handler 里把 `chat[id].mes` 改回旧值即可无闪烁回滚。需自维护旧值副本（事件不带 old/new）。
- **MESSAGE_DELETED**（最麻烦）：三个触发点均在删除完成后 emit，**参数是删除后的 `chat.length`，不带被删消息**（`deleteMessage` script.js:1572-1627）。必须自维护 chat 影子深拷贝，diff 出被删项 → splice 回去 + `saveChat` + `printMessages()` 重绘（会闪一下）。
- **MESSAGE_SWIPED**：emit 时 `swipe_id`/`mes` 已更新、DOM 已重绘（script.js:10048）；回滚 = 改回 `swipe_id`+`mes` → `updateMessageBlock(mesId, chat[mesId])`（script.js:1933）→ `saveChatConditional()`。右滑触发的生成靠第 2 点 interceptor（`type==='swipe'`）拦。另有 `MESSAGE_SWIPE_DELETED`，参数 `{messageId, swipeId, newSwipeId}`（script.js:9124）。
- 重绘工具（getContext 均暴露）：单块 `updateMessageBlock`；整页 `clearChat()` + `printMessages()`；最重 `reloadCurrentChat`（从磁盘重读）。

## 4. 卡片程序化导入/导出 —— ✅ 可行，零人工

- 后端（`src/endpoints/characters.js`）：`POST /api/characters/import`（L1418，multipart，PNG 内嵌 v1/v2/v3 定义完整解析，无交互确认）；`POST /api/characters/export`（L1505，`{format:'png', avatar_url}` 直接返回**含定义的 PNG**，且 `unsetPrivateFields` 清私有字段）。
- 前端入口：`processDroppedFiles(files)`（script.js:10198，**已 export**）——`new File([blob],'x.png')` 后直接调用即零人工导入并自动选中；`importFromExternalUrl`（getContext 暴露）；导出用 `getContext().getRequestHeaders()` 自行 fetch export 端点。
- **坑**：`is_group_generating || is_send_press` 时导入抛错（L10268）；导入后需 `await getCharacters()` 刷新；同名自动加后缀，`preserved_name` 可控制。

## 5. getContext() 暴露面 —— ✅ 需求全覆盖（doNewChat 需绕行）

定义：`public/scripts/st-context.js:108-290`，经 `globalThis.SillyTavern.getContext` 暴露（script.js:290-293）。关键成员（st-context.js 行号）：`chat`(111, **活引用可直接 splice**)、`chatMetadata`(128)、`saveChat: saveChatConditional`(148)、`addOneMessage`(133)、`openCharacterChat`(149)、`characters/getCharacters`(112/218)、`characterId/chatId/selectCharacterById`(116-120/198)、`eventSource/eventTypes`(131-132)、`generate: Generate / generateRaw / generateQuietPrompt / stopGeneration`(136-139/194)、`deleteMessage / updateMessageBlock / printMessages / clearChat / reloadCurrentChat / messageFormatting`(134-135/226/275-276/123/199)、`executeSlashCommandsWithOptions`(163)、`getRequestHeaders`(122)、`symbols.ignore`(286, 消息不进 prompt 但仍显示)。

- **doNewChat 不在 getContext**：绕行 ① `import { doNewChat } from '../../../../script.js'`（第三方扩展通用做法）；② `executeSlashCommandsWithOptions('/newchat')`。
- 消息对象结构（`public/global.d.ts:65-80`）：`name / mes / is_user / is_system / send_date / force_avatar / original_avatar / swipes / swipe_id / extra`（`extra` 可塞扩展私有字段；`force_avatar` 用法见 script.js:5726-5728）——正是镜像署名消息所需。

## 中继侧配套（M2.5，已就绪）

资产通道为 HTTP（与 WS 同端口）：
- 上传 `POST {relayHttpBase}/rooms/{roomId}/assets?kind=card|avatar[&ttlSeconds=N]`，请求头 `x-relay-client-id` + `x-relay-session-token`（auth.hello 颁发的凭据），body 为图片二进制；卡片仅房主、必须 image/png；头像成员均可、png/jpeg/webp；≤5MB，魔数校验，限频（每客户端 10 次/分、每房 30 次/分、每房最多 16 个存活资产）。
- 下载 `GET .../assets/{assetId}`，同样凭据鉴权，仅房间成员可取；TTL 到期或房间关闭即不可取。
- 错误为 JSON `{error, code}`，code 见两侧 protocol 的 `ErrorCode`（`UNAUTHORIZED / FORBIDDEN / ASSET_NOT_FOUND / ASSET_TOO_LARGE / UNSUPPORTED_ASSET_TYPE / RATE_LIMITED`）。

## 版本风险

以上行号基于 SillyTavern 1.16.0；`manifest.json` 的 `minimum_client_version` 须据此维护（P2 版本护栏探测 getContext 成员是否齐全）。`emitAndWait`（不 await 的同步 emit，eventemitter.js:160）在部分内部路径使用，勿依赖其完成时序。
