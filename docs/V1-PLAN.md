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

## 3. 阶段任务

### P0 — 协议与连接层（与总计划 M1–M2 并行推进）

- [ ] `protocol.js`：补齐上表标"新增"的命令常量；新增邀请码编解码工具 `parseInviteCode()` / （房主侧）`createInviteCode()`，格式 `{v, relayUrl, roomId, token}` 的 base64url JSON。
- [ ] `relay-client.js`：
  - [ ] `request(command)` 返回 Promise，按 `requestId` 关联 ack/error，带超时；
  - [ ] 自动重连：指数退避（1s 起、上限 30s、可配置开关沿用 `settings.reconnect`），重连成功后自动发 `room.resume`；
  - [ ] 心跳（`relay.ping`）与死连接检测。
- [ ] **验收**：对着 relay 开发服务器，断网 10 秒后自动恢复连接并完成 resume，无需人工点击。

### P1 — 客人体验（对应总计划 M3）

- [ ] `room-store.js`：按事件类型归约出 `members`、`proposals`（含状态 pending/accepted/rejected/withdrawn）、`timeline`、`sidechat` 四个投影；乱序/缺 seq 事件触发一次 `room.resume` 兜底。
- [ ] `ui.js` 房间面板（在现有设置抽屉之下扩展）：
  - [ ] 未入房：粘贴邀请码入房 / 房主建房 + 生成邀请码（一键复制）；
  - [ ] 已入房（所有人）：成员列表（含在线状态）、故事时间线视图、副聊天、"生成中"指示；
  - [ ] 客人：提案编辑器（提交/撤回、显示自己提案的审核状态）；
  - [ ] 房主：提案审核队列（接受/拒绝按钮）。
- [ ] `style.css`：全部选择器带 `stmp-` 前缀，不污染酒馆全局样式；深浅主题下均可读。
- [ ] **验收**：客人全流程（入房 → 提案 → 见到接受与故事推进 → 副聊天）全程不触碰酒馆原生聊天；两个客人同时在线互相可见对方动作。

### P2 — 房主桥接（对应总计划 M4，最脆弱层）

- [ ] `host-bridge.js` 铁律：只通过 `SillyTavern.getContext()` 访问酒馆能力，禁止 import 酒馆内部模块路径。
- [ ] `getBinding()` 扩展为显式"绑定当前聊天"操作：房主选定后锁定 chatId，切换聊天时给出警告而不是静默跟随。
- [ ] `publishAcceptedAction(proposal)`：将已接受提案作为用户侧消息写入绑定聊天，成功后由房主端发 `story.message.publish` 镜像到时间线。
- [ ] `generateReply()`：触发酒馆生成，桥接 `generation.start/progress/finish` 广播；完成后把 AI 回复发布到时间线。
- [ ] 一致性：提供显式"重新同步时间线"按钮（房主编辑/删除/swipe 后手动触发，V1 不做自动监听）。
- [ ] `index.js` 版本护栏：启动时探测所需 `getContext()` API 是否齐全，缺失则在面板显示明确错误并禁用功能，而非静默失败；维护 `manifest.json` 的 `minimum_client_version`。
- [ ] **验收**：完整一局跑通（提案 → 接受 → 写入本地聊天 → AI 生成 → 全员看到回复与生成状态）；解绑聊天后所有写入操作被拒绝。

## 4. 插件侧约束（评审逐条检查）

1. 酒馆 API 只走 `getContext()`（P2 铁律，全模块适用）。
2. 永不写入客人的原生酒馆聊天；客人侧一切数据只存在于 RoomStore 投影和扩展设置。
3. 扩展设置里只存 `relayUrl`、`displayName`、`reconnect` 和恢复凭据；不存 API key、不缓存他人隐私内容。
4. UI 文案用户可见部分统一中文（现有风格），日志走 `[ST Multiplayer]` 前缀。
