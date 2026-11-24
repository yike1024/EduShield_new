# 07 chat/stream 自适应接力流设计

> 版本 v0.1 ｜ 2026-09-01
> 补充 02-通信协议规范.md §5（SSE 事件流）+ 03-大脑设计.md
> 解决"前端聊天窗口拿不到 reasonix 智能体流式输出"的问题

---

## 1. 背景与问题

### 1.1 当前行为（实测）

前端通过 `POST /api/chat/stream` 与大脑对话。大脑侧行为分两段：

1. **普通对话**：流式返回 DeepSeek 文本（`data: {"delta": "..."}`）
2. **任务意图**："自动转成任务" → 返回**一句简短确认**即关闭流

实测证据（2026-09-01）：

```bash
$ curl -X POST http://127.0.0.1:6657/api/chat/stream \
       -d '{"message":"扫一下本机 80 端口"}'
data: {"delta":"已创建任务 T20260901-064151831（pentest，目标 127.0.0.1），正在执行。"}
data: [DONE]
```

任务创建后**reasonix 部件（8786）的 thinking / tool_call / tool_result / answer 等流式内容没有任何通道透传给前端**。

### 1.2 接口缺口

| 接口 | 用途 | 是否含 reasonix 流 |
|---|---|---|
| `POST /api/chat` | 大脑对话（非流式） | ❌ |
| `POST /api/chat/stream` | 大脑对话（SSE） | ❌ 仅大脑自己 delta |
| `GET /api/stream` | 任务 lifecycle（task_created / status_running / stage_start …） | ❌ 仅任务骨架 |
| `GET /events`（部件） | **reasonix 部件的完整流**（thinking / tool_call / tool_result / answer / stage_finished） | ✅ 但需 Bearer token，前端拿不到 |
| `GET /api/tasks/{task_id}/stream` | **不存在** | ❌ 需新增 |

**前端想要"聊天就能看到渗透测试智能体怎么做的"，目前做不到。**

### 1.3 根本原因

- 大脑 `/api/registry` 把部件 token **脱敏成 `"***..."`** 返回给前端，前端**无法直接连部件 `/events`**
- 大脑**没有把部件 `/events` 的事件透传出来**

---

## 2. 目标

**前端只发一个 `POST /api/chat/stream` 请求，就能看到完整链路：**

```
大脑智能体（reasonix brain agent）
  → 渗透测试智能体（reasonix pentest agent）
     → 工具调用、思考过程、最终结论
```

整个过程**对前端透明**，前端代码不需要知道部件是否存在、不需要自己管 task_id、不需要单独开第二条 SSE 连接。

---

## 3. 设计原则

| 原则 | 说明 |
|---|---|
| **单连接** | 前端只发 `chat/stream` 一个连接，大脑自适应接力；不允许前端自己拼 `task/{id}/stream` 第二连接 |
| **事件类型扩展** | 在现有 `delta` 之外新增 `thinking` / `tool_call` / `tool_result` / `stage_*` / `task_created` 等结构化事件帧 |
| **向后兼容** | 现有"普通对话"客户端（只读 `delta`）继续工作；新增事件帧前端可以选择性渲染 |
| **SSE 协议保持** | 继续 `text/event-stream` + `data: {...}` 帧格式，不引入新协议 |
| **鉴权不下放** | token 始终在大脑侧，前端不接触部件鉴权 |

---

## 4. 接口契约（OpenAPI 草案）

### 4.1 修改：`POST /api/chat/stream`

```yaml
POST /api/chat/stream
  summary:  自适应接力流（大脑对话 + 任务透传）
  description: |
    1. 大脑智能体先以 delta 形式返回自己的回应（可能为空）
    2. 若 message 是任务意图：创建 task 后**继续接力**输出该任务在 reasonix 部件上的完整流
    3. 若非任务意图：仅返回大脑自己的 delta 后关闭
  requestBody:
    required: true
    content:
      application/json:
        schema:
          type: object
          required: [message]
          properties:
            message:
              type: string
              description: 用户输入
            domain:
              type: string
              enum: [brain, pentest, logaudit, threatintel, incident]
              description: 可选；大脑可用它判断走哪个部件
            session_id:
              type: string
              description: 可选；会话 ID 用于上下文续接
  responses:
    '200':
      description: SSE 流
      content:
        text/event-stream:
          schema:
            type: object
            description: 每帧是以下事件类型之一（见 §5）
```

### 4.2 行为矩阵

| 输入 message | 行为 |
|---|---|
| "你好" | 流式 delta：大脑寒暄回复 → `[DONE]` |
| "扫一下本机 80 端口" | ① delta："好的，我来扫一下" → ② `task_created` → ③ 部件 `/events` 接力 → ④ `[DONE]` |
| 带 `domain=pentest` + 任务意图 | 强制路由 pentest 部件，接力同 #2 |

---

## 5. 事件帧类型定义

所有帧格式：`data: { ... }` + `\n\n`（SSE 标准）。

### 5.1 帧类型枚举

| 帧 | schema | 何时发出 |
|---|---|---|
| `delta` | `{delta: string}` | 大脑智能体（reasonix brain agent）自己生成的文本增量 |
| `thinking` | `{thinking: string, task_id?: string}` | 部件 reasonix agent 的思考链（hidden thinking） |
| `tool_call` | `{tool: string, args: object, task_id: string}` | 部件要调用工具 |
| `tool_result` | `{tool: string, output: string, exit_code?: number, task_id: string}` | 工具调用结果 |
| `stage_start` | `{stage: string, task_id: string}` | 一个 stage 开始（如 pentest / logaudit / verdict） |
| `stage_finished` | `{stage: string, task_id: string, ok: boolean}` | stage 结束 |
| `task_created` | `{task_id: string, domain: string}` | 大脑识别任务后创建成功 |
| `answer` | `{text: string, task_id: string}` | 部件 reasonix 的最终回答 |
| `report_ready` | `{task_id: string, report_url: string}` | 报告可下载 |
| `error` | `{code: string, message: string, task_id?: string}` | 任意环节报错 |
| `[DONE]` | — | 流结束 |

### 5.2 示例序列（用户发"扫一下本机 80 端口"）

```text
data: {"delta": "好的，我来扫一下本机的 80 端口。"}

data: {"task_id": "T20260901-064151831", "domain": "pentest"}

data: {"stage_start": "pentest", "task_id": "T20260901-064151831"}

data: {"thinking": "我先用 nmap 看一下开放的服务", "task_id": "T20260901-064151831"}

data: {"tool_call": {"tool": "bash", "args": {"cmd": "nmap -p 80 127.0.0.1"}, "task_id": "T20260901-064151831"}}

data: {"tool_result": {"tool": "bash", "output": "80/tcp open http nginx 1.18.0", "exit_code": 0, "task_id": "T20260901-064151831"}}

data: {"thinking": "Nginx 1.18.0 有几个已知 CVE，我再 curl 看看版本细节", "task_id": "T20260901-064151831"}

data: {"tool_call": {"tool": "bash", "args": {"cmd": "curl -sI 127.0.0.1 | head -5"}, "task_id": "T20260901-064151831"}}

data: {"tool_result": {"tool": "bash", "output": "HTTP/1.1 200 OK\\nServer: nginx/1.18.0", "task_id": "T20260901-064151831"}}

data: {"answer": {"text": "### 扫描结果\\n\\n- 目标：127.0.0.1\\n- 80 端口开放 nginx 1.18.0\\n- ...", "task_id": "T20260901-064151831"}}

data: {"stage_finished": {"stage": "pentest", "task_id": "T20260901-064151831", "ok": true}}

data: {"report_ready": {"task_id": "T20260901-064151831", "report_url": "/api/tasks/T20260901-064151831/export"}}

data: [DONE]
```

### 5.3 JSON Schema（事件帧顶层 union）

```json
{
  "oneOf": [
    { "type": "object", "required":": ["delta"],      "properties": {"delta": {"type": "string"}}},
    { "type": "object", "required":": ["thinking"],   "properties": {"thinking": {"type": "string"}, "task_id": {"type": "string"}}},
    { "type": "object", "required":": ["tool_call"],  "properties": {
        "tool_call": {
          "type": "object",
          "required": ": ["tool", "args"],
          "properties": {"tool": {"type": "string"}, "args": {"type": "object"}}
        },
        "task_id": {"type": "string"}
    }},
    { "type": "object", "required":": ["tool_result"], "properties": {
        "tool_result": {
          "type": "object",
          "required": ": ["tool", "output"],
          "properties": {"tool": {"type": "string"}, "output": {"type": "string"}, "exit_code": {"type": "integer"}}
        },
        "task_id": {"type": "string"}
    }},
    { "type": "object", "required":": ["stage_start"],    "properties": {"stage_start": {"type": "string"}, "task_id": {"type": "string"}}},
    { "type": "object", "required":": ["stage_finished"], "properties": {"stage_finished": {"type": "object", "properties": {"stage": {"type": "string"}, "ok": {"type": "boolean"}}}, "task_id": {"type": "string"}}},
    { "type": "object", "required":": ["task_created"],   "properties": {"task_id": {"type": "string"}, "domain": {"type": "string"}}},
    { "type": "object", "required":": ["answer"],         "properties": {"answer": {"type": "object", "properties": {"text": {"type": "string"}}}, "task_id": {"type": "string"}}},
    { "type": "object", "required":": ["report_ready"],   "properties": {"task_id": {"type": "string"}, "report_url": {"type": "string"}}},
    { "type": "object", "required":": ["error"],          "properties": {"code": {"type": "string"}, "message": {"type": "string"}, "task_id": {"type": "string"}}}
  ]
}
```

---

## 6. 实现要点

### 6.1 大脑侧伪代码

```python
@app.post("/api/chat/stream")
async def chat_stream(message: str, domain: str = None):
    async def event_gen():
        # 1) 大脑智能体自己先说话
        async for delta in brain_agent.think_stream(message):
            yield {"delta": delta}

        # 2) 判断任务意图
        intent = await brain_agent.classify_intent(message, domain)
        if not intent.is_task:
            return  # 流自然结束

        # 3) 创建任务
        task = await create_task(
            task=message, domain=intent.domain, target=intent.target
        )
        yield {"task_id": task.id, "domain": task.domain}

        # 4) ★接力：订阅部件 /events（用真 token）
        part = registry.get_part(task.domain)
        async with part.events_stream(task_id=task.id) as upstream:
            async for raw_event in upstream:
                mapped = map_part_event_to_chat_frame(raw_event, task.id)
                if mapped is not None:
                    yield mapped

        # 5) 收尾
        yield {"report_ready": {"task_id": task.id,
                                "report_url": f"/api/tasks/{task.id}/export"}}

    return StreamingResponse(event_gen(), media_type="text/event-stream")
```

### 6.2 部件事件 → chat 帧的映射

reasonix 部件 `/events` 的原生事件是大写的（如 `THINKING`、`TOOL_CALL`、`TOOL_RESULT`、`TEXT`、`STAGE_*`），需要做名称 + schema 映射：

| reasonix 原生 | chat 帧 |
|---|---|
| `THINKING` | `{thinking, task_id}` |
| `TOOL_CALL` | `{tool_call: {tool, args}, task_id}` |
| `TOOL_RESULT` | `{tool_result: {tool, output, exit_code?}, task_id}` |
| `TEXT` (final) | `{answer: {text}, task_id}` |
| `STAGE_START` | `{stage_start, task_id}` |
| `STAGE_END` | `{stage_finished: {stage, ok}, task_id}` |
| 其他（`SESSION_*` / `HEARTBEAT` / `STATUS`） | 丢弃（不向前端透传） |

### 6.3 鉴权透传

大脑侧：
- 配置中存部件 token（与 02-通信协议规范.md §6 一致）
- 注册表接口 `/api/registry` 继续返回脱敏 token `"***..."` 给前端
- **新增**：部件 `/events` 调用由大脑完成，前端永远不接触 token

### 6.4 任务识别

`is_task_intent` 判断逻辑：
- 用户 message 含明确动作词（"扫"、"查"、"审计"、"扫描"、"检测"、"分析"） → 任务意图
- 用户 message 含 `domain` 字段 → 强制走该域
- 否则 → 普通对话

**简化为**：保留 03-大脑设计.md 已有的"任务意图自动转成任务"判断，**不改变语义**，仅扩展"创建任务后**不立刻关流**"。

### 6.5 错误降级

| 失败点 | 降级行为 |
|---|---|
| 大脑 think_stream 失败 | `{"error": {"code": "brain_think_failed", "message": "..."}}` → `[DONE]` |
| 任务创建失败（白名单拒绝 / 部件离线） | `{"error": {"code": "task_create_failed", ...}}` → `[DONE]` |
| 部件 `/events` 连接失败 | 重试 1 次（5s 后）；仍失败 → `{"error": {"code": "part_unreachable"}}` + 任务标记 `failed` |
| 部件流非正常关闭 | 大脑侧兜底关闭 SSE 连接 + 写 task `error` 状态 |
| 单帧发送失败（前端断连） | 大脑侧订阅部件的流一并取消（防止泄漏） |

---

## 7. 兼容性

| 现有客户端 | 影响 | 处理 |
|---|---|---|
| 仅渲染 `delta` 字段的旧前端 | 无影响，普通对话仍只返 delta | 不改前端 |
| 渲染 `delta` + 任务 lifecycle 的旧前端（监听 `/api/stream`） | 仍能工作，新增的 `thinking/tool_call/tool_result` 帧会被忽略 | 不改前端 |
| 新前端（要渲染 reasonix 完整流） | 受益 | 在 `chat/stream` 增加新的渲染分支即可 |

**协议版本**：本文不引入新版本号（沿用 `proto_ver: 1`，新事件帧为可选字段，旧客户端不识别即忽略）。

---

## 8. 测试用例

### 8.1 普通对话

```bash
$ curl -N -X POST http://127.0.0.1:6657/api/chat/stream -d '{"message":"你好"}'
data: {"delta":"你"}
data: {"delta":"好"}
data: {"delta":"！"}
data: [DONE]
```

期望：仅返回 delta，3DONE。

### 8.2 任务意图（pentest）

```bash
$ curl -N -X POST http://127.0.0.1:6657/api/chat/stream \
       -d '{"message":"扫一下 127.0.0.1 的 80 端口"}'
```

期望帧序列（顺序）：
1. ≥1 个 `delta`
2. `task_created`
3. `stage_start`
4. ≥1 组 `thinking` / `tool_call` / `tool_result`
5. `answer`
6. `stage_finished`
7. `report_ready`
8. `[DONE]`

### 8.3 任务意图但部件离线

```bash
$ curl -N -X POST http://127.0.0.1:6657/api/chat/stream \
       -d '{"message":"扫一下 127.0.0.1","domain":"logaudit"}'
```

期望（logaudit 部件 8788 未起）：
1. `delta`
2. `task_created`
3. 5~10 秒后 → `error: {code: "part_unreachable"}`
4. `[DONE]`

### 8.4 鉴权

```bash
$ curl -X POST http://127.0.0.1:6657/api/chat/stream \
       -H "Authorization: Bearer wrong-token" \
       -d '{"message":"hi"}'
```

期望：`401 Unauthorized`（与现有行为一致）。

---

## 9. 风险与降级

| 风险 | 概率 | 缓解 |
|---|---|---|
| 大脑→部件 `/events` 长连接数量翻倍（每 chat 都建一条） | 中 | 复用已订阅的部件 `/events` 流（02 §5 已要求大脑每部件常驻一条），仅在事件上做 `task_id` 过滤 |
| 部件流非常长（数百帧）撑爆前端 DOM | 低 | 前端按 `task_id` 缓冲 + 滚动容器即可；大脑侧不加限流 |
| 同一任务多人并发 → 帧互相错乱 | 低 | `task_created` 帧必带 `task_id`，前端按 task_id 路由；大脑侧 `/events` 是实例级广播（02 §5），按 task_id 过滤 |
| 大脑→部件 SSE 中途断连 | 中 | 见 §6.5 错误降级，重试 1 次 |
| 现有前端不识别新事件帧直接 crash | 低 | 新事件帧均为**可选字段**，旧客户端的 JSON.parse 不会出错（未识别 key 忽略） |

---

## 10. 参考

- 02-通信协议规范.md §5（SSE 事件流）
- 02-通信协议规范.md §6（reasonix 端点映射 + input 序列化约定）
- 03-大脑设计.md（大脑智能体职责）
- reasonix 部件 `/health` 返回的 endpoints 列表：`POST /submit`、`GET /events`、`POST /approve`、`GET /status`、`GET /history`
- reasonix `/events` 原生事件类型：`THINKING` / `TOOL_CALL` / `TOOL_RESULT` / `TEXT` / `STAGE_START` / `STAGE_END` / `SESSION_*` / `HEARTBEAT`

---

## 附录 A：改动点速查（大脑侧）

| 文件/模块 | 改动 |
|---|---|
| `api/main.py` 或路由文件 | `POST /api/chat/stream` 改为流式生成器（参考 §6.1） |
| `api/agents/stream_mapper.py`（新增） | reasonix 原生事件 → chat 帧映射（§6.2） |
| `api/agents/relay.py`（新增） | 复用部件 `/events` 订阅 + `task_id` 过滤（§9 风险1） |
| 现有 `brain_agent.think_stream` | **不改动**，仅在 chat/stream 里串联 |

> 改动集中在 `chat/stream` 一个端点的实现层，**不影响**其他接口、不需要升级协议版本号。

---

**文档状态**：待 linyuxuan 用户（大脑侧）确认 / 评审
**关联文档**：02-通信协议规范.md（§5/§6）、03-大脑设计.md
**讨论入口**：本目录 `aisoc-docs/`