# 22 · 前端联调需求清单（收件人 @linyuxuan）

> 配套文档：`00-统一接口契约-v1.1.md`（唯一事实来源）、`02-caoyike-前端交互.md`（前端执行说明）。
> 本文只回答一件事：**前端已经做完的部分在等大脑补什么**。
> 结论先行：前端 v1.1 的消费侧已全部落地并可独立运行（后端不提供时自动降级、不报错）。
> **2026-10-30 已收到 @linyuxuan 的第一轮实现与 Q1–Q8 拍板**，第 4.1 节为结论记录，第 4.2 节为仍未交付的缺口。

- 提出人：@caoyike（前端）
- 收件人：@linyuxuan（AiSOC 大脑：队列 / 总线 / 任务 API / 提问中转 / 自主编排）
- 日期：2026-10-30
- 前端代码基线：`desktop/frontend/src`（commit 见联调群同步）

---

## 0. 前端状态一览（先看这张表）

| 能力 | 前端状态 | 依赖大脑的什么 |
|---|---|---|
| `queued` / `waiting_input` 状态徽标、排队位显示 | 已完成 | `TaskInfo.queue_position` / `queue.position` |
| 队列概览（总深度 / 各域深度 / 运行中） | 已完成 | `GET /api/queue` |
| 问答卡片（AskCard 复用，强制等待，不自动作答） | 已完成 | 任务 `pending_ask` + `POST /api/tasks/{id}/answer` |
| 任务取消按钮（queued / running / waiting_input） | 已完成 | `DELETE /api/tasks/{id}` |
| 429 队列满 + `retry_after_s` 倒计时 | 已完成 | 错误体带 `code` + `retry_after_s` |
| 错误码文案（`NOT_TASK_OWNER` 等） | 已完成 | 错误体带 `code` |
| 新 SSE 帧解析与渲染（两条通道） | 已完成 | 大脑真的发这些帧 |
| SSE 断线对账（拉任务 + 队列） | 已完成 | `GET /api/tasks/{id}`、`GET /api/queue` 可用 |
| Agent 状态墙队列/等待回答字段 | 已完成 | `GET /api/agents/status` 扩展字段 |
| 计划时间线（阶段 D） | **已完成**：步骤/动作/域/状态/task_id + 完成判定 + verdict，只读 | `plan` 快照 + `plan_*` 帧（已就绪） |
| 聊天态 `ask` 回传（非任务问答） | **已完成**（Q3 结论后补）：`POST /api/chat/answer` | `POST /api/chat/answer` 上线 |
| 聊天态取消（关闭 SSE，无 task 不发部件 `/cancel`） | **已完成**（Q3 结论后补） | 无（纯前端 abort） |
| EventSource 鉴权（Q5 过渡方案） | **已完成**：有 Bearer 时自动附 `?token=` | `/api/stream` 接受 `token` 查询参数 |

---

## 1. 前端已完成（纯前端，不需要你配合）

这一节只是让你知道“哪些不是后端问题”，联调时不用排查。

| 项 | 位置 |
|---|---|
| 状态枚举补 `queued` / `waiting_input` | `src/lib/aisoc-api.ts#L32` |
| `TaskInfo` / `TaskDetail` 增加可选 `queue`、`queue_position`、`pending_ask`、`plan`、`error`、`code` | `src/lib/aisoc-api.ts#L187` |
| `QueueInfo` / `PendingAsk` / `PlanInfo` / `QueueSnapshot` / `CreateTaskResult` 等类型 | `src/lib/aisoc-api.ts#L119-186` |
| `StreamEventName` 新增 11 个事件、`StreamEvent` 增 `seq`/`ts` | `src/lib/aisoc-api.ts#L440` |
| `ChatStreamFrame` 新增 11 个 kind（字段全可选） | `src/lib/aisoc-api.ts#L474` |
| `AisocApiError` 增 `code` / `retryAfterS`，`request()` 从错误体解析 | `src/lib/aisoc-api.ts#L658`、`#L778` |
| 新方法 `getQueue` / `answerTask` / `cancelTask` | `src/lib/aisoc-api.ts#L821`、`#L829`、`#L840` |
| 入口改同源 `/aisoc-brain/api`（Wails 桌面端仍直连回退） | `src/lib/aisoc-api.ts#L13-25` |
| `TASK_STATUS_META` 增 `queued` / `waiting_input` | `src/lib/aisoc-api.ts#L1849` |
| chat/stream 新增 kind 解析（`ask` 原样保留 `{id,questions}`） | `src/lib/aisoc-api.ts#L1426-1520` |
| `applyStreamEvent` 增加 11 个分支（排队/提问/计划留痕，去重） | `src/lib/aisocStreamItems.ts#L205-342` |
| `webApiProxy` onFrame 接线（两条通道同名事件） | `src/lib/webApiProxy.ts#L1426` |
| 任务列表排队位 / 等待回答 / 失败码 / 取消按钮 | `src/components/AisocDashboard.tsx#L685` |
| 队列概览条 | `src/components/AisocDashboard.tsx#L711` |
| 问答卡片（AskCard 浮层，不自动选择、不自动提交） | `src/components/AisocDashboard.tsx#L2690` |
| `answerTask` / `cancelTask` 调用与错误码文案 | `src/components/AisocDashboard.tsx#L1845`、`#L1865` |
| 创建任务透传 `tools` / `clarify`（`scopeTools` 之前被丢弃，已修） | `src/components/AisocDashboard.tsx#L2098-2149` |
| 429 倒计时禁用提交 | `src/components/AisocDashboard.tsx#L1691-1707` |
| 详情 `pending_ask` → 问答卡片恢复（刷新/重连） | `src/components/AisocDashboard.tsx#L1808-1815` |
| SSE 断线通知父组件对账 | `src/components/RealtimePanel.tsx#L597-632` |
| Agent 状态墙新字段展示 | `src/components/RealtimePanel.tsx#L200-260`、`#L657-695` |
| 计划时间线（只读：步骤/动作/域/状态/task_id + 完成判定） | `src/components/AisocDashboard.tsx#L727-790`、`#L2797-2800` |
| 计划快照 + `plan_*` 增量合并（空 steps 不清空） | `src/lib/aisocPlan.ts` |
| 计划视图单测（15 项） | `src/__tests__/aisoc-plan.test.ts` |
| 聊天态回答 `POST /api/chat/answer` | `src/lib/aisoc-api.ts#L849`、`src/lib/webApiProxy.ts#L2463` |
| 聊天态取消（abort 当前 tab 的 chat/stream） | `src/lib/webApiProxy.ts#L2447` |
| SSE 鉴权过渡：Bearer → `?token=` | `src/lib/aisoc-api.ts#L1122-1128` |
| 单测：新帧解析 / reducer 映射 | `src/__tests__/aisoc-chat-stream-kind-frames.test.ts`、`aisoc-stream-items.test.ts` |

降级约定（契约 §3.3）：以上所有新字段都按“可选”读取；端点不存在（404）或字段缺失时，前端保持旧行为，不报错、不阻塞页面。

---

## 2. 需要大脑提供：端点（P0）

### 2.0 后端交付状态（2026-11-01 拉取 `76adaa2`，含 `517690b` + `d88cfd8` 实测）

| 项 | 状态 | 代码证据 |
|---|---|---|
| 2.1 `GET /api/queue` | ✅ | `depth/running/by_domain/workers`，`api/__init__.py#L1373` |
| 2.2 `POST /tasks/{id}/answer` | ✅ | owner/状态/`ask_id` 校验，404/409 原样映射 |
| 2.3 `DELETE /tasks/{id}` | ✅ | 返回 `cancelled`，运行中通知部件 `/cancel` |
| 2.4 详情扩展 | ✅ | `queue` / `pending_ask`（完整 questions）/ `plan` / `queue_position` / `error` / `code`；`#L1410-1434` |
| 2.5 列表字段 | ✅ | `SELECT *` 自带 `queue_position`；`_decorate_task_row` 补 `pending_ask` + `code`；`#L1049`、`#L1345` |
| 2.6 agents/status | ✅ | `queue_depth` / `running_task_id` / `pending_ask=get_pending_ask(rid)`；`#L1452` |
| 2.7 `clarify` | ✅ | `_create_waiting_task` + `_target_questions`，三条入口均接；`#L1143`、`#L1283/1307/1858` |
| 2.8 `/plans/{id}` | ✅ | `#L1354`，返回 plans + steps[] |
| 2.9 `POST /api/chat/answer` | ✅ | `#L1533`（Q3） |

> 说明：上一轮文档的 4 项“缺口”是看的 `d88cfd8` 之前代码，已由 `517690b` 补齐，本文相应更正。

### 2.1 `GET /api/queue`（新增）

- 前端调用：`AisocDashboard.loadTasks` 每 8s 与任务列表一起拉；返回 null 时队列概览条自动隐藏。
- 位置：`src/lib/aisoc-api.ts#L821`、`src/components/AisocDashboard.tsx#L1745`
- 响应（契约 §2.4，`by_domain` 可为空数组）：

```json
{"depth":3,"running":1,"by_domain":[{"domain":"pentest","depth":2,"running":1}],"updated_at":"2026-10-30T04:00:00Z"}
```

- 验收：10 个并发任务时 `depth` 与列表里 `queued` 条数一致；`running` 每域 ≤ 1。
- 未上线时：404 → 前端隐藏概览，不影响其他功能。

### 2.2 `POST /api/tasks/{task_id}/answer`（新增）

- 前端调用：问答卡片提交。`ask_id` 直接取 `WireAsk.id`（不重命名、不包装）。
- 位置：`src/lib/aisoc-api.ts#L829`、`src/components/AisocDashboard.tsx#L1845`
- 请求：

```json
{"ask_id":"ask-1","answers":[{"questionId":"q1","selected":["<选项>"]}]}
```

- 响应：

```json
{"task_id":"T20261030-040000123","ask_id":"ask-1","status":"running"}
```

- 错误：`403 NOT_TASK_OWNER` / `404 TASK_NOT_FOUND` / `409 INVALID_STATE` / `409 ASK_NOT_FOUND` / `400 ASK_ANSWER_INVALID`，**错误体必须带 `code`**（前端按 code 显示不同文案）。
- 验收：不回答时任务一直 `waiting_input`；回答后任务回 `running`，墙钟补回暂停时长；同域后续任务仍 `queued`。

### 2.3 `DELETE /api/tasks/{task_id}`（新增）

- 前端调用：任务列表行内“取消”、问答卡片“停止任务”。
- 位置：`src/lib/aisoc-api.ts#L840`、`src/components/AisocDashboard.tsx#L1865`
- 响应 `{"task_id":"...","status":"cancelled"}`；允许从 `queued` / `running` / `waiting_input` 取消。
- 验收：取消后 `GET /api/tasks/{id}` 为 `cancelled`；未回答的问题作废；同域槽位释放，下一个 `queued` 转 `running`。

### 2.4 `GET /api/tasks/{task_id}` 扩展字段（改）

前端在三个场景读它：选中任务详情、SSE 断线对账、刷新页面恢复问答卡片。

必须保证以下字段存在（哪怕为 `null`）：

```json
{
  "status": "queued",
  "queue": {"state":"queued","position":2,"depth":2,"enqueued_at":"...","started_at":null},
  "queue_position": 2,
  "pending_ask": null,
  "plan": null,
  "error": null,
  "code": null
}
```

`waiting_input` 时 `pending_ask` 必须是：

```json
{"ask_id":"ask-1","domain":"pentest","questions":[{"id":"q1","header":"目标","prompt":"...","options":[],"multi":false}],"created_at":"..."}
```

⚠️ `pending_ask.questions` 必须是完整 `questions` 数组（前端直接喂给 AskCard）；只有 `ask_id` 不够。

### 2.5 `GET /api/tasks?limit=` 列表字段（改）

任务列表页不逐条拉详情，所以列表项必须带：`status`（含 `queued`/`waiting_input`）、`queue_position`（或 `queue.position`）、`pending_ask`（可为 null）、失败任务的 `code` + `error`。

### 2.6 `GET /api/agents/status` 扩展（改）

每个 part 增加（可选但推荐全给）：

```json
{"domain":"pentest","busy":true,"queue_depth":2,"running_task_id":"T2026...","pending_ask":{"ask_id":"ask-1","questions":[...]}}
```

前端用它渲染状态墙的“排队 N 个 / 等待用户回答”。

### 2.7 `POST /api/tasks` 的 `clarify`（改）

前端创建任务目前**不直接调用** `POST /api/tasks`（见 Q1），而是走 `POST /api/chat/stream` 并透传 `domain` / `target` / `tools` / `clarify: true`。
请确认 chat/stream 也接受这四个字段，并按 §2.1 语义处理：缺 target → 创建任务 + `waiting_input` + `questions`。

### 2.8 `GET /api/plans/{plan_id}`（阶段 D，新增）

任务详情已内嵌 `plan`，前端暂不单独调；阶段 D 前可低优先级，但请先把返回结构定下来（见 Q6）。

### 2.9 `POST /api/chat/answer`（Q3 新增，聊天态专用）

- 前端调用：聊天 transcript 的 AskCard 提交（`useController.answerQuestion` → `webApiProxy.AnswerQuestionForTab`）。
- 位置：`src/lib/aisoc-api.ts#L849`、`src/lib/webApiProxy.ts#L2463`
- 请求：

```json
{"ask_id":"ask-1","answers":[{"questionId":"q1","selected":["只做只读验证"]}],"conversation_id":"7ec4b602-..."}
```

- `conversation_id` 为可选（前端有会话绑定时才带，用于后端定位仍在等待的那条会话）。
- 响应：`{"ok":true,"ask_id":"ask-1"}` 即可；失败请带 `code`（前端会把错误回填到问答卡片，`useController` 已有 catch）。
- 与 `/tasks/{id}/answer` 的差异：**不要求 task 归属校验**（聊天可能没有 task_id），但必须校验 `ask_id` 属于该会话，否则任意 `ask_id` 都能注入。
- 验收：网页版聊天出现 AskCard → 点提交 → Network 看到 `/aisoc-brain/api/chat/answer`（同源代理）→ 后端返回 200 → 对话继续；不再出现“点了没反应”。

---

## 3. 需要大脑提供：SSE 帧

### 3.1 两条通道，字段名不同（不要混用）

| 通道 | 外层字段 | 前端解析位置 |
|---|---|---|
| `GET /api/stream`（实时面板） | `event` | `RealtimePanel.handleRealtimeEvent` |
| `POST /api/chat/stream`（对话接力） | `kind` | `aisoc-api.chatStream` flush |

两条通道**帧名与 payload 必须完全一致**，只有外层字段不同（契约 §3.1）。

### 3.2 必须发出的 11 个帧

> 2026-11-01 实测：11 个帧**全部已发**。
> `task_queued`/`ask`/`ask_answered`/`task_cancelled`（阶段 B/C）、
> `queue_position`/`task_started`（`orchestrator/worker.py#L83-87`）、
> `queue_full`、`plan_created`/`plan_step`/`completion_check`/`plan_finished`（`orchestrator/executor.py#L64/98/104/197-199`）。
> 仅剩 P2：无单调 `seq`、`ask` 未按 `ask_id` 去重（前端已幂等，不阻塞）。

| 帧名 | payload | 前端表现 |
|---|---|---|
| `task_queued` | `{position, domain, queue_depth}` | 列表行变“排队中 · 第 N 位” + 流内 phase |
| `queue_position` | `{position}` | 就地更新排队位（不刷屏） |
| `task_started` | `{domain, worker}` | 列表行变“运行中” + 状态墙忙 |
| `ask` | `{ask:{id,questions}}` | 弹出 AskCard（强制等待） |
| `ask_answered` | `{ask_id}` | 收起卡片 + 留痕 |
| `task_cancelled` | `{reason}` | 行变“已取消” + 卡片关闭 |
| `queue_full` | `{code:"QUEUE_FULL", retry_after_s}` | 倒计时提示 |
| `plan_created` | `{plan_id, goal, steps}` | 计划开始留痕 |
| `plan_step` | `{seq, action, domain, status, task_id}` | 步骤就地更新 |
| `completion_check` | `{done, reason, missing, confidence}` | 完成判定提示 |
| `plan_finished` | `{plan_id, verdict}` | 计划结束提示 |

### 3.3 硬性约束（不满足前端就会“看起来没反应”）

1. **每一帧都必须带 `task_id`**。前端靠它把帧路由到对应任务行；缺 `task_id` 的帧会被丢弃或错误归到 tabId 上。
2. `chat/stream` 的第一帧就要能让前端拿到 `task_id`（现在 `webApiProxy` 会记录任意帧的 `task_id`，见 `getBrainTaskIdForStreamTab`）。若 `task_queued` 先于 `task_created` 到达，也可以，只要带 `task_id`。
3. `ask` 帧只发一次；重连后靠 `GET /api/tasks/{id}` 的 `pending_ask` 恢复，不要重复推同一 `ask.id`。
4. `seq` 按任务单调递增；旧事件可以没有 `seq`（前端不报错）。
5. `waiting_input` 是**长时间挂起**：期间 15s 心跳 `: ping` 必须继续；不要因为“长时间无业务帧”主动断开 chat/stream（前端空闲超时是 1 小时，见 `webApiProxy` IDLE_TIMEOUT_MS）。
6. `ask` 的 `questions.options` 目前只有 `label/description`，没有 id —— 见 Q2，答案格式必须和它统一。

---

## 4. 契约歧义：结论已拍板（2026-10-30）

### 4.1 结论记录

| 问题 | 结论 | 前端动作 |
|---|---|---|
| Q1 建任务路径 | **选 A**：chat/stream 隐式建任务后必发 `task_queued`（带 `task_id`+`queue_position`+`queue_depth`） | 无需改链路，已按帧解析 |
| Q2 `selected` 格式 | **选 A**：后端接受 label 字符串，不改 `options` 结构 | 无需改 AskCard |
| Q3 聊天态 ask / 取消 | 新增 `POST /api/chat/answer {ask_id, answers}`；聊天态取消 = 关闭 SSE，无 task 不发部件 `/cancel` | **已实现**（`answerChatQuestion` + `CancelTab`） |
| Q4 等待期连接 | 保持连接 + 15s 心跳；`ask` 只推一次，重连靠 `pending_ask` 对账 | 已按此实现（重连对账） |
| Q5 EventSource 鉴权 | 首选 Nginx 同源 Cookie（阶段 E）；过渡期后端支持 `?token=` | **已实现**：有 Bearer 时自动附 `token` 查询参数 |
| Q6 `plan_created.steps[]` | 与 `plan_step` 同构：`{seq, action, domain, status, task_id}`，全可选（实测 `plan_created.steps` 恒为 `[]`，步骤走 `plan_step` + 详情快照） | 已按此解析，空 steps 不清空增量 |
| Q7 重启补发 | 做：`queued`→重发 `task_queued`；`waiting_input`→重发 `ask`（同 `ask_id`）；`running`→重发 `task_started` | 前端幂等，可接受重复帧 |
| Q8 `queue_full` | 两条都保留：提交时 HTTP 429；排队中被拒走 SSE 帧 | HTTP 与 SSE 两条路径均已处理 |

### 4.2 交付结论与残留

**原 4 项缺口（2.5 / queue_position 帧 / clarify / code）已全部交付**，对应 F1/F3 不再被后端阻塞。
阶段 D（`d88cfd8`）的 plan 帧、`steps[]`、`GET /api/plans/{id}` 也已就绪，前端计划时间线已接入。

| 优先级 | 残留 | 前端影响 | 建议 |
|---|---|---|---|
| P2 | 3.3 无单调递增 `seq` | 前端不报错；乱序/重复靠 `ask.id`、步骤 `seq` 幂等兜底 | 可随下一次改动补 |
| P2 | 3.3 `ask` 未按 `ask_id` 去重 | 重连可能重复推同一 `ask`；前端已幂等，不会重复弹窗 | 建议后端去重，减少无效帧 |
| 备注 | `ORCHESTRATOR_MODE=auto` 已切 | 所有任务走自主编排，计划时间线都会出现；只想测单域直派时需临时切回 `legacy` | 联调前和 @linyuxuan / 队长确认 |

> 另外 `plan_created.steps` 后端恒为 `[]`（`orchestrator/executor.py#L64`），步骤靠 `plan_step` 增量 + 详情 `plan.steps[]`；前端已按此处理，不算缺口。

### 4.3 原始问题记录（背景，已结论）

#### Q1（P0，已结论 A）建任务到底走哪条路径？

**现状**：前端 AI SOC 面板创建任务**不调用** `POST /api/tasks`，而是 `POST /api/chat/stream`（`pass_through=true`），由大脑识别意图后隐式建任务；`POST /api/tasks` 目前只有示例代码在用（`aisoc-integration.ts`）。
**问题**：契约 §2.1 规定 `POST /api/tasks` 返回 `202 {status:"queued", queue_position}`；但前端走 chat/stream 拿不到这个 HTTP 响应，只能靠 `task_queued` 帧。
**请你确认二选一**：

- A. chat/stream 隐式建任务后，**必须**下发 `task_queued`（带 `task_id` + `queue_position` + `queue_depth`）；前端据此显示排队位。（推荐，前端已按此实现）
- B. 改成前端显式调 `POST /api/tasks` 建任务，chat/stream 只负责后续接力。这样需要改前端提交链路，请提前说，我改。

### Q2（P0，会导致答案非法）`answers.selected` 用 label 还是 option id？

契约 §2.3 示例是 `"selected":["opt-1"]`，但契约 §3.2 的 `questions.options` 只有 `{label, description}`，**没有 id**。
**现状**：前端 AskCard 回传的是 **label 字符串**（`src/components/AskCard.tsx#L69-76`）。
**请你确认**：

- A. 后端接受 label 字符串（前端零改动，推荐，选项 label 在单题内唯一）；
- B. options 增加 `id` 字段，前端改成回传 id。

若选 B，请同步改 `00` 契约的 `questions.options` 结构，我这边再改 AskCard。

### Q3（P1，现有缺陷）普通聊天（非任务）的 ask 回答端点

**现状**：浏览器版 `webApiProxy.AnswerQuestionForTab` 是空实现（`src/lib/webApiProxy.ts#L2437` → `placeholderMethod` 直接 resolve），`CancelTab` 同样为空（`#L2435`）。也就是说：**聊天态 AskCard 点“提交”目前根本没有请求到后端**，只是本地清掉了卡片。
**请你确认**：

- 聊天态（没有 task_id）的 `ask` 需要哪个端点？建议统一成 `POST /api/chat/answer {ask_id, answers}` 或复用 `/api/tasks/{id}/answer`（需允许 chat 场景的宿主 id）。
- 聊天态取消（`CancelTab`）对应哪个端点？是否就是“关闭当前 SSE 连接”？

确认后我补 `webApiProxy` 这两个方法（属前后端联调项，不在纯前端范围）。

### Q4（P1）`waiting_input` 期间 chat/stream 连接保持还是断开？

若断开，前端只能靠 `GET /api/tasks/{id}` 轮询恢复；请明确“断开时是否发 `ask` 帧 + 是否保留下游 SSE 由前端重连”。

### Q5（P1，SSE 鉴权）`GET /api/stream` 用原生 EventSource，无法带 `Authorization` 头

**现状**：`connectRealtimeStream` 用 `new EventSource(url)`（`src/lib/aisoc-api.ts#L1093-1104`），浏览器不会发送自定义 Header。
**请你确认**鉴权方式：同源 Cookie（推荐，Nginx 同源 + 登录 Cookie）或 `?token=` 查询参数（需要后端支持且注意日志脱敏）。当前若 `/api/stream` 要求 Bearer，生产环境实时面板会 401。

### Q6（P1）`plan_created.steps` 元素结构未定义

契约只定义了 `plan_step` 事件的字段（`seq/action/domain/status/task_id`），没定义 `plan_created.steps[]` 的元素结构。前端已按 `{seq, action, domain, status, task_id}` 全可选处理；请把它写进 `00` 契约，避免阶段 D 各域各写一套。

### Q7（P2）重启恢复与终态补发（验收 A7/F6）

重启大脑后：`queued` 任务是否重新发 `task_queued`？`waiting_input` 任务是否重新发 `ask`（同一个 `ask_id`）？`running` 任务恢复后是否发 `task_started`？
前端已能靠 `GET /api/tasks` + `GET /api/queue` 对账，但**补发能让 UI 即时更新**，否则要等 8s 轮询。

### Q8（P2）`queue_full` 的两个出口

契约里既有 HTTP `429 {code:"QUEUE_FULL", retry_after_s}`，又有 SSE `queue_full` 帧。请确认：

- 前端提交时命中 429 → HTTP 错误体（前端已解析 `retry_after_s` 并挂在 `AisocApiError` 上）；
- 已在排队中的任务被拒 → SSE `queue_full` 帧。
两条都要，还是只保留 HTTP？

---

## 5. 错误码与前端表现（契约 §7 对齐）

| code | HTTP | 前端表现 |
|---|---|---|
| `QUEUE_FULL` | 429 | 表单禁用 + “N 秒后可重试”倒计时；SSE 帧则提示不阻塞 |
| `PART_BUSY` | 409 | 前端不判失败，等 `queued`/`task_started` |
| `PART_UNAVAILABLE` | 503 | 提示“目标智能体暂不可用，任务仍在排队” |
| `TASK_NOT_FOUND` | 404 | 任务不存在提示 |
| `NOT_TASK_OWNER` | 403 | 问答卡片上直接提示，不静默 |
| `INVALID_STATE` | 409 | “已不在等待回答状态” |
| `ASK_NOT_FOUND` | 404 | “问题已失效，请刷新” |
| `ASK_ANSWER_INVALID` | 400 | “答案格式不合法” |
| `INTERNAL_ERROR` | 500 | 原始 message 兜底提示 |

要求：**非 2xx 一律返回 `{"error":"...","code":"..."}`**，`code` 缺失时前端只能显示 HTTP 状态码。

---

## 6. 联调步骤（每步都能独立用 curl 验）

### 6.1 端点自测

```bash
# 队列
curl -s http://127.0.0.1:6657/api/queue | jq
# 任务详情（应含 queue / pending_ask / plan）
curl -s http://127.0.0.1:6657/api/tasks/T20261030-040000123 | jq '.status,.queue,.pending_ask'
# 回答
curl -s -X POST http://127.0.0.1:6657/api/tasks/T20261030-040000123/answer \
  -H 'Content-Type: application/json' \
  -d '{"ask_id":"ask-1","answers":[{"questionId":"q1","selected":["<选项>"]}]}' | jq
# 取消
curl -s -X DELETE http://127.0.0.1:6657/api/tasks/T20261030-040000123 | jq
# 聊天态回答（Q3）
curl -s -X POST http://127.0.0.1:6657/api/chat/answer \
  -H 'Content-Type: application/json' \
  -d '{"ask_id":"ask-1","answers":[{"questionId":"q1","selected":["只做只读验证"]}]}' | jq
# 状态墙
curl -s http://127.0.0.1:6657/api/agents/status | jq '.parts[]|{domain,busy,queue_depth,running_task_id,pending_ask}'
```

### 6.2 建议顺序

1. `GET /api/queue` + 列表字段（前端队列概览先亮）
2. 任务详情 `queue` / `pending_ask`（列表排队位 + 问答卡片恢复）
3. `POST /answer` + `DELETE`（回答/取消闭环）
4. chat/stream 发 `task_queued` / `ask` / `ask_answered`（实时链路，不用等轮询）
5. `/api/stream` 同步发同名 event（实时面板）
6. `plan_*`（阶段 D）

### 6.3 前端侧校验点

- 浏览器 DevTools → Network：确认所有请求都打到同源 `/aisoc-brain/api/*`，**不允许**出现 `127.0.0.1:6657`（验收 F8）。
- 10 并发提交 → 列表 10 条 `queued`、位置正确、逐个转 `running/completed`（F1）。
- 提问后不回答 → 卡片一直在、任务一直 `waiting_input`；期间提交新任务显示排队位（F2/F3）。
- 刷新页面 → 卡片、排队位、状态全部恢复（F4）。
- 断掉 SSE（后端重启）→ 恢复后状态与后端一致，无幽灵任务（F6）。

---

## 7. 验收对照（02 文档 F1–F9）

| 编号 | 依赖你提供 | 通过标准 |
|---|---|---|
| F1 | `queue_position`（帧 + 列表字段） | 10 条 `queued`，位置正确，逐个转 `running/completed`（后端已交付，可验收） |
| F2 | `ask` 帧 / `pending_ask` + `/answer` | 卡片出现；不答一直 `waiting_input`；答后继续 |
| F3 | `queue_position` + 等待占槽提示 | 新任务显示排队位，提示“前面任务在等待用户回答”（前端横幅已加） |
| F4 | `GET /api/tasks/{id}` 的 `pending_ask`/`queue` | 刷新后全部恢复 |
| F5 | 429 + `retry_after_s` | 提示 + 倒计时 + 禁用提交（后端已支持） |
| F6 | `GET /api/queue`、`GET /api/tasks` 对账 | 断线重连后一致，无幽灵任务（两接口均已可用） |
| F7 | `plan_*` + `completion_check` + 详情 `plan` | 计划时间线步骤/状态/判定正确（阶段 D，已接入） |
| F8 | Nginx 同源 + SSE 鉴权（Q5） | 浏览器不访问 `127.0.0.1:6657` |
| F9 | 旧端点不变 | 单域任务、聊天、报告、审批、导出全部正常 |

---

## 8. 前端不变式（改后端时请勿破坏）

1. `ask.id` 就是 `ask_id`，前端不重命名、不包一层。
2. 新字段一律可选；删除字段/改语义必须升 `PROTO_VER=2`。
3. `waiting_input` 不会被前端展示成 `running`（状态徽标已分开）。
4. 前端不自动选第一个选项、不自动跳过提问。
5. 任务创建走 chat/stream 时，`target` 可能为空（此时必须有 `clarify` 行为，否则前端只能拿 400）。
6. `POST /api/tasks` 的 `status` 从 `pending` 改 `queued` 是行为变化，前端已按新值显示，无需回退。
7. 列表 `GET /api/tasks` 的排序仍按 `updated_at` 倒序（前端依赖）。

---

## 9. 变更流程

- 任何端点/字段/帧新增，先改 `00-统一接口契约-v1.1.md`，再改实现；前端 PR 会 @ 你 review。
- 本文第 4 节的 Q1–Q8 有结论后，我按结论一次性补齐前端剩余项（并回写 02 文档）。
- 联调期间如需临时开关：`QUEUE_ENABLED=false` 回退旧锁模型、`ASK_ENABLED=false` 回退旧提问路径；前端两条路径都能渲染（不依赖开关）。
