# 10 chat/stream 原模原样透传契约

> 起草人：前端方（caoyike）
> 日期：2026-09-02
> 范围：浏览器 ↔ 大脑 6657 chat/stream 接力流的"原模原样展示"模式
> 关联：[07 chat/stream 自适应接力流设计](07-chat-stream-adaptive-relay.md)（简化模式，9 帧）｜[08 chat/stream 联调 issue](08-chat-stream-联调-issue.md)（已知问题）

---

## 0. 为什么需要这份文档

07 协议定义了 9 种"前端友好的简化帧"（delta/thinking/tool_call/tool_result/stage_*/task_created/answer/report_ready/error）。**大脑在适配层和前端之间做了一次"翻译简化"**，导致后端 reasonix 的真实事件流在前端丢失大量信息。

### 当前链路

```
浏览器(3000)
  ↓ fetch /api/chat/stream
大脑(6657) — _forward_subevent — 只识别 tool_call，其他 kind 丢弃
  ↓ GET /events (SSE)
适配层(8786) — 完整透传 reasonix /events
  ↓ GET /events (SSE)
reasonix serve(4523) — 真实事件流 10+ 种 kind
```

### 丢失的事件 kind（实测）

reasonix 真实事件流至少包含 10+ 种 kind。当前大脑 `_forward_subevent` 只识别 `tool_call`（即 mock_part 风格的），其余 reasonix 真实事件被丢弃，前端 `flush()` 又只解 9 种字段：

| reasonix 真实 kind | 07 协议映射 | 当前前端能收到？ |
|---|---|---|
| `turn_started` | ❌ 无 | ❌ 丢弃 |
| `memory_compiler_stats` | ❌ 无 | ❌ 丢弃 |
| `reasoning` | → `thinking` | ✅ 已兼容 |
| `text` | → `delta` | ✅ 已兼容 |
| **`tool_dispatch`** | → `tool_call` | ⚠️ 兼容，但字段简化（丢 id/readOnly/durationMs） |
| **`tool_progress`** | → `tool_result` partial=true | ⚠️ 兼容，但 partial 标记被吞 |
| `tool_result` | → `tool_result` | ✅ 已兼容 |
| `message` | ❌ 无 | ❌ 丢弃 |
| `usage` | ❌ 无 | ❌ 丢弃 |
| `turn_done` | ❌ 无 | ❌ 丢弃 |

**用户问的原模原样**：上面"丢弃"列的 5 种 + "字段简化"的 2 种 = 7 处损失。

---

## 1. 目标

新增"透传模式"（`pass_through`），让 reasonix 真实事件流**一字不改**地推到前端。前端能展示 turn_started / usage / tool_progress 等当前看不到的帧，并能拿到 tool 对象的完整结构（含 `id` / `readOnly` / `durationMs`）。

**不破坏** 07 协议的简化模式 —— 现有调用方继续可用。

---

## 2. 接口设计

### 2.1 新增请求参数

```
POST /api/chat/stream
Content-Type: application/json

{
  "message": "扫一下本机 80 端口",
  "pass_through": true,        // ← 新增：请求透传模式
  "system": "..."               // 可选
}
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `message` | string | — | 用户消息（必填） |
| `system` | string | 默认提示 | 系统提示 |
| `pass_through` | boolean | `false` | `true` 时大脑走透传模式，原样推 reasonix 帧 |

### 2.2 响应帧格式（不变）

仍然是 SSE：`data: { ... }\n\n`，结束 `data: [DONE]`。

**关键区别**：帧内**字段名按 reasonix 原样**，而不是 07 协议的简化结构。

### 2.3 行为矩阵

| `pass_through` | 输入 message | 行为 |
|---|---|---|
| `false`（默认） | "你好" | 07 协议 delta 流 → `[DONE]` |
| `false`（默认） | "扫一下本机 80" | 07 协议 9 帧（简化版） |
| **`true`** | **任意** | **reasonix 原样帧透传（详见 §3）** |

---

## 3. reasonix 真实事件枚举（透传模式）

下面是从 `/tmp/long-pentest/multi-fixed.raw` 实测的 reasonix 真实事件 kind 列表。每个 kind 的字段结构以 reasonix serve 实际输出为准。

### 3.1 kind 清单

| kind | 必含字段 | 触发时机 |
|---|---|---|
| `turn_started` | — | 一个 turn 开始（reasonix 内部计数器 1/2/3…） |
| `memory_compiler_stats` | `memoryCompiler: {...}` | 记忆编译器统计（injected/usefulIR/compiledTokens…） |
| `reasoning` | `text: string` | 模型的隐藏思考链（增量） |
| `text` | `text: string` | 模型最终输出的文本（增量） |
| `tool_dispatch` | `tool: {id, name, args, partial}` | 决定调用哪个工具 + 参数；`partial=true` 表示 args 未填完 |
| `tool_progress` | `tool: {id, name, output, partial}` | 工具执行的中间进度，`partial=true` |
| `tool_result` | `tool: {id, name, output, exit_code, durationMs, partial}` | 工具完成，`partial=false` |
| `message` | `text: string, reasoning?: string` | 一轮 turn 结束时的合并消息 |
| `usage` | `usage: {promptTokens, completionTokens, cost, ...}` | token 用量统计 |
| `turn_done` | — | turn 全部结束 |

### 3.2 一帧示例（透传模式）

下面是从 `multi-fixed.raw` line 277 实测的真实帧结构（大脑**当前没推到 hub**，因为 `_forward_subevent` 只识别 `tool_call`）：

```json
{
  "task_id": "T20260902-063625450",
  "tool_result": {
    "tool": {
      "id": "call_00_m4egSpnIUYNG6S62JccS6722",
      "name": "bash",
      "args": "{\"command\":\"echo ...\"}",
      "output": "...",
      "readOnly": false,
      "durationMs": 11861
    },
    "output": "",
    "exit_code": 0
  }
}
```

**对比 07 协议简化版**：
```json
{
  "tool_result": {"tool": "bash", "output": "...", "exit_code": 0},
  "task_id": "T20260902-063625450"
}
```

**差异**：
- 透传：`tool` 是 dict（含 id/name/args/output/readOnly/durationMs）
- 简化：`tool` 是 string（仅 name），嵌套结构被压平

---

## 4. JSON Schema（透传模式顶层 union）

```json
{
  "oneOf": [
    { "type": "object", "required": ["turn_started"] },
    { "type": "object", "required": ["memory_compiler_stats"],
      "properties": {"memoryCompiler": {"type": "object"}} },
    { "type": "object", "required": ["reasoning"],
      "properties": {"text": {"type": "string"}, "task_id": {"type": "string"}} },
    { "type": "object", "required": ["text"],
      "properties": {"text": {"type": "string"}, "task_id": {"type": "string"}} },
    { "type": "object", "required": ["tool_dispatch"],
      "properties": {
        "tool": {"type": "object", "required": ["name"],
            "properties": {"id": {"type": "string"}, "name": {"type": "string"},
                          "args": {}, "partial": {"type": "boolean"}}},
        "task_id": {"type": "string"}
      }},
    { "type": "object", "required": ["tool_progress"],
      "properties": {
        "tool": {"type": "object", "properties": {"id": {"type": "string"},
                  "name": {"type": "string"}, "output": {"type": "string"},
                  "partial": {"type": "boolean"}}},
        "task_id": {"type": "string"}
      }},
    { "type": "object", "required": ["tool_result"],
      "properties": {
        "tool": {"type": "object", "required": ["name"],
            "properties": {"id": {"type": "string"}, "name": {"type": "string"},
                          "args": {}, "output": {"type": "string"},
                          "readOnly": {"type": "boolean"},
                          "durationMs": {"type": "integer"},
                          "partial": {"type": "boolean"}}},
        "output": {"type": "string"},
        "exit_code": {"type": "integer"},
        "task_id": {"type": "string"}
      }},
    { "type": "object", "required": ["message"],
      "properties": {"text": {"type": "string"},
                     "reasoning": {"type": "string"},
                     "task_id": {"type": "string"}} },
    { "type": "object", "required": ["usage"],
      "properties": {"usage": {"type": "object"},
                     "task_id": {"type": "string"}} },
    { "type": "object", "required": ["turn_done"],
      "properties": {"task_id": {"type": "string"}} }
  ]
}
```

---

## 5. 前端 flush() 期望行为（给前端开发者参考）

前端 `aisoc-api.ts` 的 `flush()` 函数应当：

1. 收到 `pass_through=true` 请求时，**按 kind 名派发原始字段**，不做简化。
2. 收到 `pass_through=false`（默认）时，**走现有 9 帧兼容逻辑**。

**新增的 kind 派发**（在 `flush()` 里加判别分支）：
- `turn_started` → `onFrame({kind:'turn_started', task_id})`
- `memory_compiler_stats` → `onFrame({kind:'memory_compiler_stats', memoryCompiler: evt.memory_compiler_stats.memoryCompiler, task_id})`
- `reasoning`（已是 thinking 同义，按现有逻辑派 thinking）
- `text`（已是 delta 同义，按现有逻辑派 delta）
- `tool_dispatch` → `onFrame({kind:'tool_dispatch', tool: evt.tool_dispatch.tool, task_id})`
- `tool_progress` → `onFrame({kind:'tool_progress', tool: evt.tool_progress.tool, output: ..., partial:true, task_id})`
- `message` → `onFrame({kind:'message', text: evt.message.text, reasoning: evt.message.reasoning, task_id})`
- `usage` → `onFrame({kind:'usage', usage: evt.usage, task_id})`
- `turn_done` → `onFrame({kind:'turn_done', task_id})`

**前端代码改动范围**（仅前端，待大脑方实现后再做）：
- `desktop/frontend/src/lib/aisoc-api.ts` `ChatStreamFrame` 类型扩展 9 个新 kind
- `desktop/frontend/src/lib/aisoc-api.ts` `flush()` 加判别分支
- `desktop/frontend/src/lib/aisoc-api.ts` `chatStream()` 请求体加 `pass_through: true`（按 UI 选择）
- 视情况加 UI 组件展示新帧（usage 计数器、memory stats 面板等）

---

## 6. 后端实现位置（给大脑方）

### 6.1 需要修改的文件

| 文件 | 行号（搜索关键字） | 改动 |
|---|---|---|
| `backend-src/aisoc-brain-lyx/api/__init__.py` | `chat_stream_endpoint` / `_chat_or_task`（待补） | 新增 `POST /api/chat/stream` 的真实实现（07 文档里设计过但实测不存在，见 08 ISSUE-001/004） |
| `backend-src/aisoc-brain-lyx/orchestrator/__init__.py` | `_forward_subevent` | 在 `pass_through=True` 分支下，原样 `hub.publish(task_id, task_domain, kind, ev)` 透传 |
| `backend-src/aisoc-brain-lyx/api/main.py` | `uvicorn api.main:app` | 不需要改 |

### 6.2 `_forward_subevent` 期望行为

```python
# 现有代码（伪）：
elif kind == "tool_call":
    hub.publish(task_id, task_domain, "tool_call", {"tool": ..., "args": ...})
# 其他 kind 走默认 else 丢掉

# 期望新增 pass_through 分支：
elif pass_through:
    # 不做翻译，原样推
    hub.publish(task_id, task_domain, kind, ev)
```

### 6.3 chat_stream 端点期望行为

```python
# 期望新增：
@app.post("/api/chat/stream")
async def chat_stream(req: ChatRequest):
    # ... 任务识别、部件订阅同 07 协议
    # 但 _forward_subevent 接收一个 pass_through 参数
```

---

## 7. 兼容性

| 现有调用方 | 行为 |
|---|---|
| 不传 `pass_through`（默认 `false`） | 走 07 协议 9 帧简化版（不破坏） |
| 传 `pass_through: true` | 走透传模式（本文档） |
| 旧前端 `flush()` 收到透传帧 | 静默忽略（flush line 642 已有 `continue` 行为） |
| 新前端 `flush()` 收到简化帧 | 走现有判别分支 |

**过渡期策略**：
- 第 1 步（大脑方）：实现 `pass_through=True` 分支，与现有分支并存
- 第 2 步（前端）：扩展 `ChatStreamFrame` 类型 + `flush()` 判别
- 第 3 步（产品）：决定 UI 何时启用透传模式（默认 / 高手模式 / 调试模式）

---

## 8. 测试用例

### 8.1 T-pass-1：透传模式发渗透测试任务

```bash
curl -N -X POST http://127.0.0.1:6657/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"扫 8.215.92.252","pass_through":true}'
```

**期望**（SSE 流）：
```text
data: {"task_id":"T...","domain":"pentest"}

data: {"turn_started","task_id":"T..."}

data: {"memory_compiler_stats", memoryCompiler:{...}, "task_id":"T..."}

data: {"reasoning","text":"...","task_id":"T..."}

data: {"text","text":"...","task_id":"T..."}

data: {"tool_dispatch", "tool": {"id":"call_0","name":"bash","args":"{...}","partial":false}, "task_id":"T..."}

data: {"tool_progress", "tool": {"id":"call_0","name":"bash","output":"...","partial":true}, "task_id":"T..."}

data: {"tool_result", "tool": {"id":"call_0","name":"bash","output":"...","readOnly":false,"durationMs":11861,"partial":false}, "output":"","exit_code":0,"task_id":"T..."}

data: {"message", "text":"...","reasoning":"...","task_id":"T..."}

data: {"usage", "usage": {"promptTokens":...,"completionTokens":...,"cost":0.01}, "task_id":"T..."}

data: {"turn_done","task_id":"T..."}

data: [DONE]
```

### 8.2 T-pass-2：默认模式不破坏

```bash
curl -N -X POST http://127.0.0.1:6657/api/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"message":"你好"}'
```

**期望**：仍然走 delta 流（07 协议兼容）。

### 8.3 T-pass-3：旧前端 flush() 收到透传帧

```js
// 旧前端不识别 turn_started
flush(raw) {
  // 收到 {"turn_started": ...} 帧
  // 没有匹配的 if 分支 → 静默 continue（不报错）
}
```

---

## 9. 风险与降级

| 风险 | 应对 |
|---|---|
| 大脑透传后前端带宽增加（每帧多带 tool 完整结构） | 与 08 ISSUE-007 一并优化：单连接级 task_id 缓存 |
| reasonix 升级后事件结构变更 | 大脑方负责 schema 版本号，前端按 kind 字段判别，不写死嵌套 |
| pass_through 模式被滥用（每次都开） | 大脑方按 domain 灰度开放（pentest 默认开，logaudit 默认关） |

---

## 10. 关联

- [07 chat/stream 自适应接力流设计](07-chat-stream-adaptive-relay.md) — 简化模式（默认）
- [08 chat/stream 联调 issue](08-chat-stream-联调-issue.md) — ISSUE-004 提到 `/api/tasks/{task_id}/stream` 未实现，本文档可补完
- [09 前端多 agent 进度展示设计](09-前端多agent-进度展示设计.md) — 后续 UI 设计参考

---

变更记录：
- v1.0 (2026-09-02)：初版。前端方起草，待大脑方审阅实现位置与字段定义。