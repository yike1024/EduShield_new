# 11 chat/stream 透传模式 实测差距报告（前端方 → 大脑方）

> 起草人：前端方
> 日期：2026-09-02
> 范围：浏览器 ↔ 大脑 6657 /api/chat/stream 透传模式（pass_through=true）
> 触发条件：实测发现大脑侧已新增 /api/chat/stream 端点，但 pass_through 分支**未实施**，9 个 kind 透传字段全部不出现
> 关联：[10-chat-stream-原模原样透传.md](10-chat-stream-原模原样透传.md)（接口契约，本报告与之一致）

---

## 1. 实测方法

```bash
# 测试 1（短输入）
curl -sN --max-time 90 -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"一句话介绍你自己，不调任何工具","pass_through":true}' \
  http://127.0.0.1:6657/api/chat/stream

# 测试 2（长输入）
curl -sN --max-time 90 -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"解释 Ajax 与传统表单提交的区别","pass_through":true}' \
  http://127.0.0.1:6657/api/chat/stream
```

**实测产出**：两次都返回 100% `{"delta": "..."}` 简化流，未出现任何 10 协议透传字段。

---

## 2. 期望 vs 现状对照表

按 10-chat-stream-原模原样透传.md §3 reasonix 真实事件枚举：

| # | kind（10 协议约定） | 字段触发时机 | 期望（pass_through=true 时） | 现状 |
|---|---|---|---|---|
| 1 | `turn_started` | 一轮 turn 开始 | 大脑**应该转发**第一帧 | ❌ **0 次出现** |
| 2 | `memory_compiler_stats` | 记忆编译器生成统计 | 应该转发 | ❌ **0 次出现** |
| 3 | `reasoning` | 大模型思考链 | 应该转发 | ❌ **0 次出现** |
| 4 | `text` | 大模型文本增量 | 应该转发（顶替 07 的 delta） | ❌ **0 次出现**（仍输出 delta） |
| 5 | `tool_dispatch` | 工具调用开始 | 应该转发完整 dict（含 id/name/args） | ❌ **0 次出现** |
| 6 | `tool_progress` | 工具流式结果（含 partial） | 应该转发 | ❌ **0 次出现** |
| 7 | `message` | 一轮 turn 结束时的合并消息 | 应该转发 | ❌ **0 次出现** |
| 8 | `usage` | 本轮 token 消耗 | 应该转发 | ❌ **0 次出现** |
| 9 | `turn_done` | 一轮 turn 结束 | 应该转发末帧 | ❌ **0 次出现** |

**结论**：9/9 全部未连通。大脑侧 chat/stream 端点**目前固定走 07 简化流（mock_part fast-path）**，没有按 `pass_through:true` 切换到透传分支。

---

## 3. 期望行为（pass_through=true 时大脑侧必须做）

### 3.1 入口判断（chat_stream_endpoint）

读取请求体 `{message, system?, pass_through?}`：
- `pass_through=false` 或字段缺失：**保持当前 07 模式**（输出 delta / thinking / tool_call / tool_result / stage_* / task_created / answer / report_ready 9 种）
- **`pass_through=true`：**透传模式，所有 reasonix /events 输出原样推到 SSE 流

### 3.2 透传模式 required 行为

| 操作 | 期望 |
|---|---|
| reasonix SSE 连接 | 不再"翻译简化"，**整流过 `_forward_subevent`**（或等价转发层）原样推到前端 |
| 字段命名 | **reasonix 真实字段名**：`turn_started` / `memory_compiler_stats` / `reasoning` / `text` / `tool_dispatch` / `tool_progress` / `message` / `usage` / `turn_done`，**不要重命名** |
| tool 字段格式 | `tool_dispatch` 和 `tool_progress` 的 `tool` 字段**保留原始 dict**（含 id/name/args/readOnly），不要提取 name 字符串 |
| SSE 帧格式 | `data: {<原始字段>}<LF><LF>`（每帧由单个换行隔开） |
| 结束帧 | `data: [DONE]<LF><LF>` |

### 3.3 引用实现位置（10 协议 §6 指定）

| 需修改文件（大脑方） | 当前实现位置（推断） | 期望改动 |
|---|---|---|
| `backend-src/aisoc-brain-lyx/api/__init__.py` `chat_stream_endpoint`（约 line 407 起的 `chat` 端点） | 当前实现 | 加 `if pass_through:` 分支，路由到真实 reasonix /events，避免 mock_part 简化 |
| `backend-src/aisoc-brain-lyx/orchestrator/__init__.py` `_forward_subevent` | 当前实现 | 改为透传所有 10 协议 kind（不要丢弃 turn_started / memory_compiler_stats / usage 等） |

---

## 4. 前端代码状态（frontend 已经就绪）

前端已经完整实现 10 协议 9 个新 kind 的判别（已 build 通过），具体看
[`desktop/frontend/src/lib/aisoc-api.ts`](../../desktop/frontend/src/lib/aisoc-api.ts)：

- `ChatStreamFrame` 类型扩展（line 219-239）：9 个新 kind
- `chatStream()` options 加 `passThrough`（line 548）
- 请求体自动加 `pass_through:true`（line 555）
- `flush()` 判别分支（line 608-711）：9 个 kind 各有独立判别语句，含 dict/string 兼容
- tool_name 兜底：name 空时回退到 tool.id（reasonix 实际数据会偶发 name=''）

**前端不需要再改**。pass_through=true 模式下，前端能识别并正确显示 9 个新 kind。

---

## 5. 验收条件（大脑方实施完毕后）

### 5.1 自动验收

对以下两条 curl 命令，**每一帧 data:** 行都必须满足：

1. **pass_through:true 时**至少出现以下 kind（与 message 内容无关，只看 kind 集合）：
   - 至少 1 帧 `turn_started`
   - 至少 1 帧 `text`（文本增量）
   - 至少 1 帧 `message`
   - 至少 1 帧 `usage`
   - 至少 1 帧 `turn_done`
   - **不应该有 07 简化字段**：`delta` / `thinking` / `tool_call` / `tool_result` / `stage_*` / `task_created` / `answer` / `report_ready` 必须全部为 0

2. **pass_through 不传或 false 时**保持现有 07 行为（不破坏旧调用方）

### 5.2 字段格式验收（reasoning 帧示例）

```bash
# 期望首帧：
data: {"turn_started": {}, "task_id": "T..."}

# 期望文本帧：
data: {"text": "讲解 Ajax", "task_id": "T..."}

# 期望思考链：
data: {"reasoning": "用户问 Ajax 与传统表单区别", "task_id": "T..."}

# 期望 usage：
data: {"usage": {"prompt_tokens": 12, "completion_tokens": 50}, "task_id": "T..."}

# 期望末帧：
data: {"turn_done": {}, "task_id": "T..."}
```

### 5.3 验证脚本

```bash
# 抓 SSE 流到文件
curl -sN --max-time 90 -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"一句话介绍自己","pass_through":true}' \
  http://127.0.0.1:6657/api/chat/stream > /tmp/curlsse.txt

# 期望输出：9 种 kind 全部出现 1 次，0 个 delta/thinking/tool_call
grep -cE '"(turn_started|memory_compiler_stats|reasoning|text|tool_dispatch|tool_progress|message|usage|turn_done)"' /tmp/curlsse.txt
#   输出应该 = 9（最少数量）

grep -cE '"(delta|thinking|tool_call|tool_result|stage_|task_created|answer|report_ready)"' /tmp/curlsse.txt
#   输出应该 = 0
```

---

## 6. 当前文件位置

- 本报告：`aisoc-docs/11-chat-stream-透传-实测差距报告.md`
- 接口契约：`aisoc-docs/10-chat-stream-原模原样透传.md`（§3 字段枚举 + §6 后端实现位置）
- 前端实现：[`desktop/frontend/src/lib/aisoc-api.ts`](../../desktop/frontend/src/lib/aisoc-api.ts) line 219-239（类型）/548（options）/555（请求）/608-711（flush）

---

## 7. 备注

- 实测时间：2026-09-02 15:46~15:52
- 测试数据：纯文本问题（"不调任何工具"），目的是验证 chat/stream 端点对透传模式的最基本响应
- 大脑侧目前行为等价于：忽略 `pass_through` 字段，固定走 mock_part → delta 简化流
- 请实施完毕后回复本报告，本报告 5.1/5.3 验收脚本可作为回归测试
