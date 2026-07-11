# SillyTavern Multiplayer Plugin — V1 执行计划（插件侧）

> 里程碑顺序与验收的**总权威**是 `../sillytavern-multiplayer-relay/docs/V1-PLAN.md`（下称"总计划"）。
> 本文档细化插件侧的模块任务，阶段编号 P0–P2 与总计划的 M 里程碑对应。
> 决定日期：2026-07-11

## 1. 现状盘点（脚手架已有）

| 模块 | 已有 | 缺失 |
|---|---|---|
| `index.js` | `getContext()` 接入、设置初始化（`sillytavernMultiplayer` 键）、模块装配 | 版本护栏 |
| `src/protocol.js` | 协议版本、命令名常量、`createCommand()`（含 requestId/opId） | 提案审核、副聊天、离房/踢人命令 |
| `src/relay-client.js` | 连接/断开、状态机、消息事件分发 | 自动重连退避、心跳、请求-响应关联 |
| `src/room-store.js` | seq 去重、快照应用、变更通知 | 按事件类型归约到 members/proposals/timeline/sidechat |
| `src/ui.js` | 设置抽屉（Relay 地址、昵称、连接按钮、状态显示） | 房间面板全部（入房、时间线、提案、审核、副聊天） |
| `src/host-bridge.js` | `getBinding()` 骨架 | `publishAcceptedAction()`、`generateReply()` |

## 2. 协议词汇表（两仓库唯一权威）

以现有 `src/protocol.js` 的命名风格为准，relay 的 `src/core/protocol.ts` 必须与本表逐字一致。任何一侧改动命令名，必须同一次提交更新两边和本表。

| 命令 | 发起方 | 说明 |
|---|---|---|
| `relay.ping` | 所有人 | 传输层心跳/连通性检测（客户端心跳与冒烟测试使用） |
| `auth.hello` | 所有人 | 连接后自报协议版本、昵称、恢复凭据 |
| `room.create` | 房主 | 建房 |
| `room.join` | 客人 | 凭邀请码入房 |
| `room.resume` | 所有人 | 断线重连：携带 `lastAppliedSeq`，服务端回快照+增量 |
| `room.leave` | 所有人 | 离房（**新增**） |
| `room.kick` | 房主 | 踢人（**新增**） |
| `proposal.submit` | 客人 | 提交行动提案 |
| `proposal.withdraw` | 客人 | 撤回自己的提案 |
| `proposal.accept` | 房主 | 接受提案（**新增**） |
| `proposal.reject` | 房主 | 拒绝提案（**新增**） |
| `story.message.publish` | 房主 | 向共享时间线发布故事消息 |
| `sidechat.message.post` | 所有人 | 副聊天发言（**新增**） |
| `generation.start` / `generation.progress` / `generation.finish` | 房主 | AI 生成状态广播，供客人端显示"生成中" |

### 2.1 事件词汇表（中继 → 客户端，M1 起）

事件信封为 `{v, kind:'event', type, eventId, roomId, seq, payload}`，`seq` 在房间内单调递增（插件 `RoomStore.applyEvent()` 直接读顶层 `seq` 去重）。两侧 protocol 文件中的 `EventType` 必须与本表一致。`generation.*` 为**瞬态事件**：无 `seq`、不入房间日志，只对在线成员广播；重连后以 `room.resume` 应答中的 `generating` 标志恢复状态。

| 事件 | payload | 说明 |
|---|---|---|
| `room.member.joined` | `{ member: {clientId, displayName, role, joinedAt} }` | 成员加入（含房主建房时的自身加入，作为 seq 1） |
| `room.member.left` | `{ clientId, reason: 'left' \| 'kicked' }` | 成员离开或被踢（踢人事件先广播后移除，被踢者能收到） |
| `room.member.online` | `{ clientId }` | 成员断线重连（`auth.hello` 携带恢复凭据） |
| `room.member.offline` | `{ clientId }` | 成员掉线（连接断开但保留席位） |
| `room.closed` | `{ reason: 'host_left' \| 'expired' }` | 房间关闭（房主离房即关房，V1 决定） |
| `proposal.submitted` | `{ proposal: {proposalId, authorClientId, authorDisplayName, text, submittedAt} }` | 客人提交提案（状态隐含 pending） |
| `proposal.withdrawn` | `{ proposalId, clientId }` | 作者撤回自己的提案 |
| `proposal.accepted` | `{ proposalId }` | 房主接受（时间线推进由随后的 `story.message.published` 承载） |
| `proposal.rejected` | `{ proposalId, reason? }` | 房主拒绝（可附理由，≤500 字符） |
| `story.message.published` | `{ message: {messageId, authorName, role: 'user'\|'assistant', text, proposalId?, publishedAt} }` | 房主向共享时间线发布消息；`proposalId` 回链来源提案 |
| `sidechat.message.posted` | `{ message: {messageId, authorClientId, authorDisplayName, text, postedAt} }` | 副聊天发言（文本 ≤2000 字符；故事/提案文本 ≤8000） |
| `generation.started` / `generation.progressed` / `generation.finished` | `{}` / `{ charCount? }` / `{ ok }` | 瞬态生成状态广播（无 seq） |

错误帧携带机器可读的 `payload.code`（两侧 protocol 的 `ErrorCode`，如 `INVITE_INVALID`、`FORBIDDEN`、`PROPOSAL_NOT_PENDING`），UI 据此映射中文文案；`payload.message` 为英文日志文案，不面向用户展示。

**重连序列（M2 定稿）**：断线重连后依次发 ① `auth.hello`（携带首次 hello 颁发的 `clientId` + `sessionToken`，应答含 `room: {roomId, role, generating} | null`）→ ② `room.resume`（携带本地 `lastAppliedSeq`，应答含 `members`、`generating`、`lastSeq` 与增量事件数组，逐条喂给 `RoomStore.applyEvent()` 即可追平）。`relay-client.js` 的 `resumeProvider` 钩子须在返回 resume 载荷前自行完成 ①。内容类命令（提案/故事/副聊天）重试时**复用原 `opId`** 即可幂等：中继按房间缓存 opId → ack 结果，重发只回放 ack、不重复产生事件。

## 3. 阶段任务

### P0 — 协议与连接层（✅ 完成于 2026-07-11）

- [x] `protocol.js`：补齐上表标"新增"的命令常量（含 `relay.ping`）；新增邀请码编解码工具 `parseInviteCode()` / `createInviteCode()`，格式 `{v, relayUrl, roomId, token}` 的 base64url JSON（Unicode 安全）。
- [x] `relay-client.js`：
  - [x] `request(command)` 返回 Promise，按 `requestId` 关联 ack/error，带超时；error 帧转为 reject；
  - [x] 自动重连：指数退避（1s 起、上限 30s、带抖动，`settings.reconnect` 开关接入 UI 复选框），重连成功后经 `resumeProvider` 钩子自动发 `room.resume`；连接建立失败单独兜底（部分 WebSocket 实现被拒时只发 error 不发 close）+ 8s 连接超时；
  - [x] 心跳（`relay.ping`，25s 间隔 / 5s 超时）与死连接检测（超时强制断开进入重连路径）。
- [x] **验收**：`scripts/smoke-client.mjs` 通过——邀请码往返/非法拒绝、连接、请求关联、中继被杀后自动重连并恢复 ping。`room.resume` 完整闭环待 M2 服务端实现后复验（客户端钩子已就位）。

### P1 — 控制中心与镜像技术验证（对应总计划 M3；2026-07-11 改版：直接走镜像模式）

> 改版决定：不再做"聊天气泡式独立时间线面板"，客人的故事主界面直接由 P3 镜像聊天承担。P1 只做**控制中心**与数据层，并把镜像模式的本地技术验证前置到本阶段开头，让全盘押注的风险最早暴露。
> 回退方案：任一验证不过 → 镜像降级 V2，本阶段追加"简易时间线升级为气泡式渲染（借用 `getContext()` 的酒馆 markdown 工具）"，即恢复原独立面板方案（原文见本仓库 git 历史 f428586）。

- [x] **镜像技术验证（本阶段第一件事，四项本地项）**——源码级验证已于 2026-07-11 完成，四项全部可行，结论与行号证据见 `docs/MIRROR-FEASIBILITY.md`（基于 SillyTavern 1.16.0）；运行时抽查随 P1/P3 实现进行，实测冲突则回写该文档：
  1. 消息截获——`MESSAGE_SENT` 在入数组后、落盘前触发且 handler 被 await，可安全移除（需处理幽灵 DOM，见文档坑位）；
  2. 生成拦截——manifest `generate_interceptor` + `abort(true)` 官方机制，可按 chatId 定向拦截；
  3. 编辑回滚——`MESSAGE_EDITED` 可无闪烁回滚；删除需自维护影子副本（事件不带被删消息）；swipe 可回滚；
  4. 卡片导入/导出——`processDroppedFiles` / `/api/characters/export` 零人工、PNG 含定义。
  第 5 项（资产通道端到端）中继侧已就绪（M2.5 完成），插件接入后在 P3 开头补验。
- [ ] `room-store.js`：按事件类型归约出 `members`、`proposals`（含状态 pending/accepted/rejected/withdrawn）、`timeline`、`sidechat` 四个投影；乱序/缺 seq 事件触发一次 `room.resume` 兜底。
- [ ] `ui.js` 控制中心：设置抽屉里只保留连接配置；入房后为**可拖动、可调大小的浮动窗口**，但不做气泡式故事时间线（原生观感由 P3 镜像聊天承担）：
  - [ ] 未入房：粘贴邀请码入房 / 房主建房 + 生成邀请码（一键复制）；
  - [ ] 已入房（所有人）：成员列表（含在线状态）、副聊天、"生成中"指示；
  - [ ] 客人：提案编辑器（提交/撤回、显示自己提案的审核状态）——P3 镜像可用后输入改走原生输入框，此编辑器保留为备用入口；
  - [ ] 房主：提案审核队列（接受/拒绝按钮）；
  - [ ] 简易文本时间线（默认折叠；调试与降级回退用，不做观感打磨）。
  - 注：客人自有的原生聊天永不被触碰；联机写入仅限 P3 的插件托管镜像聊天。
- [ ] `style.css`：全部选择器带 `stmp-` 前缀，不污染酒馆全局样式；深浅主题下均可读。
- [ ] **验收**：四项技术验证全过且有记录；客人全流程（入房 → 提案 → 简易时间线见到接受与故事推进 → 副聊天）全程不触碰酒馆原生聊天；两个客人同时在线互相可见对方动作。

### P2 — 房主桥接（对应总计划 M4，最脆弱层）

- [ ] `host-bridge.js` 铁律：只通过 `SillyTavern.getContext()` 访问酒馆能力，禁止 import 酒馆内部模块路径。
- [ ] `getBinding()` 扩展为显式"绑定当前聊天"操作：房主选定后锁定 chatId，切换聊天时给出警告而不是静默跟随。
- [ ] `publishAcceptedAction(proposal)`：将已接受提案作为用户侧消息写入绑定聊天，成功后由房主端发 `story.message.publish` 镜像到时间线。
- [ ] `generateReply()`：触发酒馆生成，桥接 `generation.start/progress/finish` 广播；完成后把 AI 回复发布到时间线。
- [ ] 一致性：提供显式"重新同步时间线"按钮（房主编辑/删除/swipe 后手动触发，V1 不做自动监听）。
- [ ] `index.js` 版本护栏：启动时探测所需 `getContext()` API 是否齐全，缺失则在面板显示明确错误并禁用功能，而非静默失败；维护 `manifest.json` 的 `minimum_client_version`。
- [ ] **验收**：完整一局跑通（提案 → 接受 → 写入本地聊天 → AI 生成 → 全员看到回复与生成状态）；解绑聊天后所有写入操作被拒绝。

### P3 — 镜像聊天模式（客人故事主界面，V1 主路线；2026-07-11 改版）

> 目标：客人的故事主界面复用原生聊天渲染（头像气泡、主题、TTS/翻译等扩展全部生效），同时保留房主权威模型不变。前置条件：P1、P2 完成，中继 M2.5 资产通道可用，四项本地技术验证已在 P1 通过。

- [ ] **补验第 5 项（本阶段开工门槛）**：资产通道端到端（房主导出 → 中继 → 客人导入）。不过则镜像降级 V2，客人显示回退 P1 简易时间线并升级为气泡式渲染（见 P1 回退方案）。
- [ ] 镜像聊天：插件在客人端创建**专用**聊天（`chat_metadata` 打 multiplayer/roomId 标记），时间线事件写成署名消息（force_avatar 对齐各玩家头像），AI 回复写成角色消息；`seq` 错位时重写镜像尾部对齐权威顺序。
- [ ] 输入框接管：客人在镜像聊天中发送 → 截获转为 `proposal.submit` + "⏳ 待审核"占位 → 接受后替换为权威版本；拒绝则移除占位并提示。
- [ ] 只读保护：编辑/删除/swipe 一律回滚并提示"联机镜像为只读"；镜像内禁用生成触发。
- [ ] **卡片同步两档**：
  - 档位一（默认开）：房主同步角色名字 + 头像 → 客人端自动创建"皮肤卡"（定义为空），镜像挂其下——观感与本地卡一致，人设定义不离开房主机器；
  - 档位二（房主**每房间显式开启**，默认关）：完整卡 PNG 经资产通道传输，客人端导入为真卡；开启时确认框提示卡片分享责任；外部挂载的世界书不随卡走，提示"续玩效果可能与联机时不同"。
- [ ] 散场留存：房间结束后提供"解除镜像锁定"与"**复制为可玩副本**"（推荐后者——镜像本体保留以备房间重开续联，副本随便编辑/续玩）；档位二下副本 + 导入卡即可单机续玩。
- [ ] 协议增量：卡片分享所需的新命令/事件（如 `room.card.update`）在技术验证通过后补入第 2 节词汇表，并同一提交同步 relay `core/protocol.ts`。
- [ ] **验收**：客人在原生聊天界面完成一局全流程（发送 → 待审 → 接受 → AI 回复出现），观感与本地卡一致；档位二散场后单机续玩成功；客人自有聊天与角色数据全程零改动，删除镜像与皮肤卡后不留任何残余。

## 4. 插件侧约束（评审逐条检查）

1. 酒馆 API 只走 `getContext()`（P2 铁律，全模块适用）。
2. 永不触碰客人**自有**的聊天、角色与设置数据；联机写入仅限插件自建并托管的镜像聊天与皮肤卡/导入卡（P3），且全部可整体删除、不留残余。
3. 扩展设置里只存 `relayUrl`、`displayName`、`reconnect` 和恢复凭据；不存 API key、不缓存他人隐私内容。
4. UI 文案用户可见部分统一中文（现有风格），日志走 `[ST Multiplayer]` 前缀。
