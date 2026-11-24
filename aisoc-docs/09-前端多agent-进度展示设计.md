# 09 前端多 Agent 流式进度展示 — 设计

> 版本 v1.0 ｜ 2026-09-01
> 范围：前端聊天窗口 + 任务面板 双端改造
> 关联：[07 chat-stream 自适应接力流设计](07-chat-stream-adaptive-relay.md) / [08 chat-stream 联调 issue](08-chat-stream-联调-issue.md) / [frontend-api.md](../docs/frontend-api.md)
> 不动后端

---

## 1. 问题与目标

### 1.1 当前现状

后端大脑已经实现"自适应接力流"——`POST /api/chat/stream` 识别为任务意图后，会持续接力部件 `thinking`/`tool_call`/`tool_result`/`answer` 帧直到部件完成（07 文档 §6.1；08 文档 T2 实测 865 帧）。

但前端 `desktop/frontend/src/lib/aisoc-api.ts:491` 只解 `delta` 字段，其他 8 种帧被静默丢弃。`webApiProxy.ts:714` 的 `onDelta` 回调只喂 typewriter 切字。

**结果**：用户从聊天窗口发"扫一下 127.0.0.1"，前端只看到大脑自己说的"已创建任务 T...，正在执行"那一句话，渗透测试 agent 的 thinking/工具调用/answer **完全看不到**。

### 1.2 设计目标

1. **聊天窗口能看完整推理链**：用户问 → 大脑识别 → 部件思考 → 调工具 → 出答案 全程可观察
2. **任务详情能看完整推理**：任务面板"证据&报告"页增加"实时推理过程"
3. **复杂 pipeline 友好展示**：data_leak = logaudit→pentest→verdict→report 4 段可视化
4. **向后兼容**：现有只读 `delta` 的客户端继续工作
5. **不动后端**：复用现有 07 文档实现 + `/api/stream` lifecycle

---

## 2. 后端约定（不变）

| 流 | 帧类型 | 来源 |
|---|---|---|
| `POST /api/chat/stream` | 9 帧（07 §5.1）：delta / thinking / tool_call / tool_result / stage_start / stage_finished / task_created / answer / report_ready | 已有 |
| `GET /api/stream` | 9 帧（frontend-api.md §4.8）：task_created / status_running / stage_start / stage_finished / findings_stored / verdict / report_ready / status_completed / status_failed | 已有 |

帧 schema 见 07 §5.3。

---

## 3. 前端实现策略

### 3.1 核心思路：复用现有 reducer 事件类型

`desktop/frontend/src/lib/useController.ts` 的 reducer 已经能处理 `reasoning` / `tool_dispatch` / `tool_result` / `message` / `phase` / `notice` 等事件，Composer 也能正确渲染它们。

**不创建新事件类型**——把 chat/stream 接力流帧一对一映射到现有 reducer 事件：

| chat/stream 帧 | reducer 事件 | 映射逻辑 |
|---|---|---|
| `delta` | 保留原 typewriter 流程 | 不变 |
| `thinking` | `reasoning` | `e.reasoning = frame.thinking` |
| `tool_call` | `tool_dispatch` | `e.tool = {id, name:tool, args:JSON.stringify(args), readOnly:false}` |
| `tool_result` | `tool_result` | `e.tool = {id, name:tool, output:output, err:exit_code !== 0 ? String(exit_code) : undefined}` |
| `stage_start` | `phase` | `e.text = `[stage] {stage} 开始`` |
| `stage_finished` | `phase` | `e.text = `[stage] {stage} 完成`` |
| `task_created` | `notice` | `level:info, text:任务 {taskId} 已下发到 {domain} 子智能体…` |
| `answer` | `message` | `e.text = frame.answer.text` |
| `report_ready` | `notice` | `level:info, text:报告已生成，可下载` |

### 3.2 id 稳定性

`tool_call` 帧本身不带 id，需要在 webApiProxy 层生成稳定 id。规则：

```
id = `aisoc-tool-${tabId}-${taskId}-${counter}`
```

- `counter` 自增，每个 `tool_call` 帧递增 1
- 同一个 `tool_call` 帧 → `tool_result` 帧共享 id（reducer 按 id 合并）
- 不同 task 互不干扰

### 3.3 协议层改造：`aisoc-api.ts` chatStream

`chatStream` 加 `onFrame` 回调，**保留 onDelta 向后兼容**：

```typescript
export type ChatStreamFrame =
  | { kind: 'delta';           delta: string; task_id?: string }
  | { kind: 'thinking';        thinking: string; task_id?: string }
  | { kind: 'tool_call';       tool: string; args: unknown; task_id?: string }
  | { kind: 'tool_result';     tool: string; output: string; exit_code?: number; task_id?: string }
  | { kind: 'stage_start';     stage: string; task_id?: string }
  | { kind: 'stage_finished';  stage: string; ok: boolean; task_id?: string }
  | { kind: 'task_created';    task_id: string; domain: string }
  | { kind: 'answer';          text: string; task_id?: string }
  | { kind: 'report_ready';    task_id: string; report_url: string };

async chatStream(
  message: string,
  options: {
    system?: string;
    signal?: AbortSignal;
    onDelta?: (delta: string) => void;          // 兼容旧调用
    onFrame?: (frame: ChatStreamFrame) => void;  // 新增
  }
): Promise<string>
```

`flush()` 函数按 JSON key 判别帧类型，调用 `onFrame`。

### 3.4 事件总线层：`webApiProxy.ts`

`submitForTab` 在 chatStream 处加 `onFrame` 回调，按帧 kind 转换为 reducer 事件并 `emitEvent`。

为了避免影响 typewriter 流程，`onDelta` 仍然只走 typewriter，`onFrame` 走 reducer 事件分发。

### 3.5 渲染层：Composer / AisocDashboard

**Composer（聊天窗口）**：
- `reasoning` 帧 → 现有 reasoning 显示区（折叠）
- `tool_dispatch` 帧 → 现有 tool card（`{kind:'tool', name, args, status:'running'}`）
- `tool_result` 帧 → 现有 tool card 自动合并（reducer tool_result case 按 id 合并）
- `phase` 帧 → 现有 phase item
- `notice` 帧 → 现有 notice item
- `message` 帧 → 现有 message item（替代 typewriter 切字）

**AisocDashboard（任务面板）**：
- 详情页"证据 & 报告"Tab 增加"实时推理过程"section
- 用 Effect Hook + chatStream 重连 / 或直接读 useController 当前 tab 的 items
- 任务面板的 tab 可能与 chat 的 tab 不同——AisocDashboard 任务面板走独立 chatStream

### 3.6 不动后端的边界

- 07 文档的 chat/stream 帧格式可能与实测有差异（如 `stage_start: "turn"` / `"working"`），`flush()` 对未知 key 静默忽略
- 后端 chat/stream 不支持重连（08 ISSUE-004），任务详情页刷新后断流 → 降级到 `/api/stream` 兜底
- pipeline 真并行能力不在本次范围

---

## 4. UI 草图

### 4.1 聊天窗口（Composer 推理链）

```
┌─ 用户："扫一下 127.0.0.1 的 80 端口" ──────────────┐
│                                                       │
│  💭 AI 思考：用户要求扫描本机 80 端口…                │
│  ⚙ 调用 nmap: {cmd: "nmap -p 80 127.0.0.1"}         │
│  📥 80/tcp open http nginx 1.18.0                     │
│  💭 Nginx 1.18 有 CVE-2021-23017…                    │
│  ⚙ 调用 curl: {cmd: "curl -sI 127.0.0.1"}            │
│  📥 HTTP/1.1 200 OK, Server: nginx/1.18.0            │
│  💭 综合判定：real_threat                             │
│                                                       │
│  ┌─────────────────────────────────────────────────┐  │
│  │ 阶段：pentest ✓ 已完成（5 步 / 3 工具）         │  │
│  │ 报告已生成 [下载]                                │  │
│  └─────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────┘
```

### 4.2 任务详情页（pipeline 多阶段）

```
┌─ T20260901-... 数据泄露调查 (data_leak) ──────────────┐
│  [logaudit ✓ 7min] → [pentest ● 0:23] → [verdict] → [report] │
│                                                            │
│  ▾ logaudit (completed) — 23 步 / 5 工具                   │
│      💭 先解析日志…                                        │
│      ⚙ log_ingest …                                        │
│  ▾ pentest (running) 0:23                                  │
│      💭 先用 nmap 看开放端口                               │
│      ⚙ nmap -p 80 127.0.0.1                                │
│      📥 80/tcp open …                                      │
└────────────────────────────────────────────────────────────┘
```

---

## 5. 风险与降级

| 风险 | 概率 | 缓解 |
|---|---|---|
| 后端帧 key 与 07 §5.1 不一致（实测有 `stage_start: "turn"`） | 高 | `flush()` 对未知 key 静默忽略 |
| 后端 chat/stream 不支持重连 | 中 | 任务详情页降级到 `/api/stream` + task_id 过滤 |
| 后端 9 帧不是同时存在（旧版本只有 delta） | 低 | `onFrame` 是可选回调，未触发时 UI 静默 |
| 多 tool_call 帧 id 冲突 | 低 | id 加 counter 自增 |
| chat/stream 接力流错位 / 丢帧 | 中 | chatStream 读 doneSse 后立即 break，不再等 EOF |

---

## 6. 后续议题（不在本次范围）

| 议题 | 来源 | 优先级 |
|---|---|---|
| 后端实现 `GET /api/tasks/{task_id}/stream`（重连） | 08 ISSUE-004 | P2 |
| 后端增加 `tool_invoked` lifecycle 事件 | 本方案 | P2 |
| TypeScript 类型从 OpenAPI 自动生成 | 08 ISSUE-008 | P3 |
| pipeline 真并行（单任务多部件） | 需求 | P3 |

---

**状态**：v1.0 设计稿，待实施