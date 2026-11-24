# 08 chat/stream 接力流联调 — 问题清单

> 记录人：caoyike
> 日期：2026-09-01
> 范围：联调 `aisoc-docs/07-chat-stream-adaptive-relay.md` 设计实现后的全链路
> 环境：3000 serve_frontend.py / 6657 大脑 / 8786 pentest 部件 / 8788 logaudit / 8789 intel

---

## TL;DR — 验证结果

| 链路 | 状态 | 备注 |
|---|---|---|
| `/api/chat` 普通对话（DeepSeek 流式 delta） | ✅ 通 | T1: 22 帧 delta + done |
| `/api/chat/stream` 任务意图识别 | ✅ 通 | T2: delta + task_created（路由对了） |
| `/api/chat/stream` 接力部件 8786 流式内容 | ✅ 通 | T2: 865 帧含 thinking/tool_call/answer |
| `/api/tasks` 创建 + 部件执行 | ✅ 通 | pentest 完成，real_threat, 15 findings |
| `/api/stream` 全局事件流 | ✅ 通 | task_created → verdict → report_ready → status_completed |
| **前端 `/aisoc-intel/api/*` 路由** | ❌ **500 / SPA 吞** | serve_frontend.py 缺这条 |
| **threatintel / incident 域** | ❌ **500** | 大脑侧部件注册表已删 |

**核心接力流功能已打通**，但前端↔大脑之间存在 **3 处命名不一致** 和 **2 处路由缺失**，导致 3 域前端请求被拒。

---

## ISSUE-001【已修复·2026-09-01】前端域名与后端部件名不一致

**状态**：已修复（详见变更记录 v1.1）
**修复方式**：前端 `threatintel → intel` 全面重命名，但保留 `threatintel` 兼容条目。

**现象**（原始）
- 前端 `desktop/frontend/src/lib/aisoc-api.ts:17` 类型定义：
  ```ts
  export type TaskDomain = 'pentest' | 'logaudit' | 'threatintel' | 'incident';
  ```
- 前端 `domainProxies` 和 `DOMAIN_PORTS` 使用 `threatintel`。
- 但大脑侧 `/api/registry` 注册的部件名是 **`intel`**（host=127.0.0.1 port=8789）。

**修复后验证**
```bash
$ curl /aisoc-intel/api/tasks -d '{"task":"...","domain":"intel","target":"127.0.0.1"}'
  → {"task_id":"T20260901-075150113","status":"pending","domain":"intel"} ✓

$ curl /aisoc-intel/api/chat/stream -d '{"message":"查 127.0.0.1 的威胁情报","domain":"intel"}'
  → delta: "已创建任务 T...（intel，目标 127.0.0.1），正在执行。"
  → task_id + domain: intel
  → [接力 intel 部件 8789]
```

**修改清单**（全部完成）：
- ✅ `desktop/frontend/src/lib/aisoc-api.ts:19`（`TaskDomain` 添加 `intel`，保留 `threatintel`）
- ✅ `desktop/frontend/src/lib/aisoc-api.ts:524`（`domainProxies.intel = '/aisoc-intel/api'`，保留 threatintel 同值兼容）
- ✅ `desktop/frontend/src/lib/aisoc-api.ts:560`（`DOMAIN_LABELS.intel`）
- ✅ `desktop/frontend/src/lib/aisoc-api.ts:570`（`DOMAIN_COLORS.intel`）
- ✅ `desktop/frontend/src/lib/aisoc-api.ts:580`（`DOMAIN_DESCRIPTIONS.intel`）
- ✅ `desktop/frontend/src/lib/aisoc-api.ts:590`（`DOMAIN_PORTS.intel`）
- ✅ `desktop/frontend/src/lib/aisoc-api.ts:648`（pipeline stage `{domain:'intel',...}`）
- ✅ `desktop/frontend/src/components/AisocDashboard.tsx:69`（`ALL_DOMAINS`）
- ✅ `desktop/frontend/src/components/RealtimePanel.tsx:86`（`domainDisplayNames.intel`）

---

## ISSUE-002【已修复·2026-09-01】serve_frontend.py 缺 `/aisoc-intel/api` 路由

**状态**：已修复（详见变更记录 v1.1）
**修复方式**：新增 `/aisoc-intel/api` 主路由 + 保留 `/aisoc-threatintel/api` 兼容路由。

**修复后验证**
```bash
$ curl -o /dev/null -w "%{http_code}\n" /aisoc-intel/api/health
200   ✓

$ curl -o /dev/null -w "%{http_code}\n" /aisoc-threatintel/api/health
200   ✓ (兼容保留)

$ curl /aisoc-intel/api/tasks -d '{"task":"...","domain":"intel","target":"127.0.0.1"}'
{"task_id":"T20260901-075150113","status":"pending","domain":"intel"}  ✓
```

**修改清单**：
- ✅ `serve_frontend.py:29`（新增 `/aisoc-intel/api` 主路由）
- ✅ `serve_frontend.py:30`（保留 `/aisoc-threatintel/api` 兼容路由）
- ✅ `serve_frontend.py:7-8`（docstring 更新）
- ✅ `serve_frontend.py:23-24`（注释说明主/兼容关系）
- ✅ `desktop/frontend/vite.config.ts:323`（新增 `/aisoc-intel` Vite 代理）
- ✅ `desktop/frontend/vite.config.ts:331`（保留 `/aisoc-threatintel` Vite 代理兼容）

**现象**（原始）
`serve_frontend.py:22-29` 原始路由表（修复前）：
```python
ROUTES = [
    ("/aisoc-brain/api",         "http://127.0.0.1:6657/api",  True),
    ("/aisoc-pentest/api",       "http://127.0.0.1:6657/api",  True),
    ("/aisoc-logaudit/api",      "http://127.0.0.1:6657/api",  True),
    ("/aisoc-threatintel/api",   "http://127.0.0.1:6657/api",  True),
    ("/aisoc-incident/api",      "http://127.0.0.1:6657/api",  True),
    ("/api",                     "http://127.0.0.1:6657",      False),
]
```
**没有 `/aisoc-intel/api`**。

**修复后路由表**（v1.1）
```python
ROUTES = [
    ("/aisoc-brain/api",         "http://127.0.0.1:6657/api",  True),
    ("/aisoc-pentest/api",       "http://127.0.0.1:6657/api",  True),
    ("/aisoc-logaudit/api",      "http://127.0.0.1:6657/api",  True),
    ("/aisoc-intel/api",         "http://127.0.0.1:6657/api",  True),  # ← 新增
    ("/aisoc-threatintel/api",   "http://127.0.0.1:6657/api",  True),  # 兼容保留
    ("/aisoc-incident/api",      "http://127.0.0.1:6657/api",  True),
    ("/api",                     "http://127.0.0.1:6657",      False),
]
```

**原影响**：前端威胁情报页面所有 API 调用 → 拿到 HTML → React 解析失败 → 页面空白。已通过新增路由解决。

**实测**（原始）
```bash
$ curl /aisoc-intel/api/tasks -d '{"domain":"intel"}'
<!doctype html>
<html lang="en" data-theme="dark" data-theme-style="morandi" translate="no">
  <head>
    ...
    <title>EduShield</title>
    <script type="module" src="./assets/index-CnCCSonP.js"></script>
    ...
  </head>
  <body class="notranslate"><div id="root" class="notranslate"></div></body>
</html>
```
路径未匹配任何 `aisoc-*/api` 路由，被 `_serve_static()` 当 SPA 路由处理，返回 `index.html`。

**影响**：原前端 `/aisoc-intel/*` 走 SPA 路由返回 HTML，React 解析失败 → 页面空白。已通过新增路由解决。

---

## ISSUE-003【P1】incident 域前后端不一致 — 需要决策

**现象**
- 前端 `aisoc-api.ts` 仍有 `incident` 类型 + `domainProxies.incident` + `DOMAIN_PORTS.incident`。
- 前端 `serve_frontend.py` 仍有 `/aisoc-incident/api` 路由。
- **但大脑 `/api/registry` 已经不注册 incident 部件**（实测注册表只剩 pentest/logaudit/intel 3 个）。

**实测**
```bash
$ curl 127.0.0.1:6657/api/registry
  注册部件: 3 个
    domain=pentest    host=127.0.0.1 port=8786 enabled=True
    domain=logaudit   host=127.0.0.1 port=8788 enabled=True
    domain=intel      host=127.0.0.1 port=8789 enabled=True

$ curl /aisoc-incident/api/tasks -d '{"domain":"incident"}'   # → 500
```

**影响**：前端如果有"应急响应"页面，所有请求都 500。

**修复建议**（必须二选一）：
- **方案 A**：incident 部件会重启。前端保留 incident 域，等待部件上线。
- **方案 B**：incident 功能下线。前端删除 incident 相关代码：
  - `aisoc-api.ts:17`（类型）
  - `aisoc-api.ts:524`（proxy）
  - `aisoc-api.ts:586`（port）
  - `serve_frontend.py:27`（路由）
  - 任何前端页面 / UI 组件里的 `incident` 字符串
  - **建议补充 PR description 注明此功能下线时间与原因**

---

## ISSUE-004【P2】07 文档设计的 `/api/tasks/{task_id}/stream` 未实现

**现象**
`aisoc-docs/07-chat-stream-adaptive-relay.md §4.2` 设计了任务级接力流接口：
```
GET /api/tasks/{task_id}/stream
```
前端可订阅单个任务的完整流。

**实测**
```bash
$ curl /openapi.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['paths']))"
18
```
总共 18 个接口，**没有 `/api/tasks/{task_id}/stream`**。当前聊天流的接力是通过 `POST /api/chat/stream` 在识别为任务时**当场接力**实现的，但前端如果错过了 chat/stream 的初始响应（例如刷新页面），就无法再"重连"看这个任务的实时进度。

**影响**：前端"任务详情面板"如果要做实时刷新，目前只能订阅 `/api/stream`（全局事件流）或轮询 `/api/tasks/{id}`，前者噪音多，后者慢。

**修复建议**
- 优先级 P2（不是阻塞）。
- 实现 `GET /api/tasks/{task_id}/stream`：
  - 内部订阅该 task_id 的事件源
  - SSE 帧格式沿用 `/api/stream` 的 `{event, payload, task_id}` 结构
  - 客户端断开连接时清理订阅
- 与现有 `/api/stream` 全局流并存，前端按需选择。

---

## ISSUE-005【P2】任务 ID 字段命名不一致

**现象**
不同接口对任务 ID 的字段命名不统一：

| 接口 | 路径 | 任务 ID 字段 |
|---|---|---|
| 创建任务 | `POST /api/tasks` | 返回 `task_id` |
| 列表 | `GET /api/tasks` | 字段名 `id`（不是 `task_id`） |
| 详情 | `GET /api/tasks/{task_id}` | 路径参数 `task_id` |
| 全局事件流 | `GET /api/stream` | SSE 帧内 `task_id` |
| 聊天接力流 | `POST /api/chat/stream` | SSE 帧内 `task_id` |
| 导出 | `GET /api/tasks/{task_id}/export` | 路径参数 `task_id` |

**实测**
```bash
$ curl /api/tasks | jq '.[0] | keys'
[
  "id", "domain", "target", "status", "verdict", "confidence",
  "error", "created_at", "updated_at", "findings_count",
  "stages", "current_stage"
]
```
列表里任务 ID 字段叫 `id`，其他全是 `task_id`。

**影响**：前端写代码时容易踩坑（之前列表里取 `task_id` 拿到 `None`）。

**修复建议**
- 二选一：
  - **方案 A（推荐）**：列表返回 `task_id`（与创建返回对齐）。
  - **方案 B**：创建返回改成 `id`（与列表对齐，但会破坏现有前端）。
- 同步更新 `aisoc-docs/02-通信协议规范.md` 字段表。

---

## ISSUE-006【P2】部件离线时大脑返回 500 而非 503 + 友好错误

**现象**
```bash
$ curl /api/tasks -d '{"domain":"intel","task":"..."}'
{"task_id":"...","status":"pending","domain":"intel"}
HTTP 202  # 创建成功

# 1 秒后任务失败
$ curl /api/tasks/<id>
{
  "id":"...","domain":"intel","status":"failed",
  "error":"[Errno 111] Connection refused",   # ← 原始 errno
  ...
}
```

问题：
1. **创建任务时**大脑不验证部件在线（直接 202），任务 pending 1 秒后 fail，用户体验差。
2. **失败原因暴露底层 errno** `[Errno 111] Connection refused` —— 应翻译成"部件 intel(8789) 未监听，请联系运维"。
3. 错误信息没区分：
   - 部件未注册 → "未注册的 domain"
   - 部件未启动 → "部件 intel 未监听"
   - 部件鉴权失败 → "部件 token 校验失败"
   - 部件超时 → "部件执行超时"

**修复建议**
- 创建任务前先 `ping` 部件 `/health`：
  - 不通 → 直接 503 + `{error:"part_unreachable", part:"intel", port:8789, hint:"部件 intel 端口 8789 未监听"}`
- `error` 字段统一格式：`{code, message, detail}` 三段式。
- 在 `aisoc-docs/02-通信协议规范.md` §6.2 加错误码表。

---

## ISSUE-007【P3】接力流每帧重复推送 task_id（带宽浪费）

**现象**
T2 实测 865 帧里，**几乎每帧都带 `task_id`** 字段：

```
[719] task_id='"T20260901-073929862"'
[720] answer='{...}'
[721] task_id='"T20260901-073929862"'
[722] answer='{...}'
...
```

**估算**：865 帧 × 30 字节 task_id ≈ 26 KB 冗余（占总量约 30%）。

**影响**：SSE 长连接下：
- 带宽浪费
- 前端解析成本升高（每个 JSON 都要读 task_id）
- 没有真正价值——同一连接里的 task_id 应该全程相同，前端只需要记第一次。

**修复建议**
- 大脑侧 SSE 帧结构改为"事件头 + 数据"分离，例如：
  ```
  event: task_id
  data: "T20260901-073929862"
  
  event: stage_start
  data: {"domain":"pentest"}
  
  event: thinking
  data: {"text":"..."}
  
  event: thinking
  data: {"text":"..."}
  ```
- 或在 chat/stream 首次推送后省略 task_id，前端从第一帧缓存。
- 在 `aisoc-docs/02-通信协议规范.md` §5 明确帧格式。

---

## ISSUE-008【P3】前端 aisoc-api.ts 4 域与后端 3 域不一致

**现象**
- `aisoc-api.ts:17` 类型 4 域：`pentest | logaudit | threatintel | incident`
- `aisoc-api.ts:523` 路由代理 5 个（含 brain）
- 后端注册表 3 域：`pentest / logaudit / intel`（无 threatintel、incident）

**实测**：TypeScript 编译时无法发现（因为 `domain: string` 类型断言），运行时才发现。

**修复建议**
- TypeScript 类型从后端 OpenAPI 自动生成（`openapi-typescript`）。
- 加 CI：`pnpm typecheck` + `pnpm test:e2e` 必须包含 4 域 → 3 域的端到端测试。

---

## 验证证据汇总

### ✅ T1 chat/stream 普通对话（22 帧）
```
data: {"delta": "你好"}
data: {"delta": "！"}
data: {"delta": "我是"}
data: {"delta": " Ai"}
data: {"delta": "SOC"}
...
data: {"delta": "？"}
data: [DONE]
```

### ✅ T2 chat/stream 任务意图（865 帧接力流）
```
data: {"delta": "已创建任务 T20260901-073929862（pentest，目标 127.0.0.1），正在执行。"}
data: {"task_id": "T20260901-073929862", "domain": "pentest"}
data: {"stage_start": "turn", "task_id": "T20260901-073929862"}
data: {"stage_start": "working", "task_id": "T20260901-073929862"}
data: {"thinking": "...", "task_id": "T20260901-073929862"}
... (800+ 帧 thinking/tool_call/answer)
data: [DONE]
```

### ✅ T9 /api/stream 全局事件流
```
data: {"task_id": "T20260901-074145106", "domain": "pentest", "event": "task_created", "payload": {"target": "127.0.0.1", "pipeline": "pentest"}}
data: {"task_id": "T20260901-074145106", "domain": "pentest", "event": "status_running", "payload": {}}
data: {"task_id": "T20260901-074145106", "domain": "pentest", "event": "stage_start", "payload": {"domain": "pentest"}}
data: {"task_id": "T20260901-074137842", "domain": "pentest", "event": "findings_stored", "payload": {"domain": "pentest", "count": 15}}
data: {"task_id": "T20260901-074137842", "domain": "pentest", "event": "verdict", "payload": {"verdict": "real_threat", "confidence": 0.93}}
data: {"task_id": "T20260901-074137842", "domain": "pentest", "event": "stage_finished", "payload": {"domain": "verdict", "count": 15}}
data: {"task_id": "T20260901-074137842", "domain": "pentest", "event": "stage_finished", "payload": {"domain": "tir", "count": 0}}
data: {"task_id": "T20260901-074137842", "domain": "pentest", "event": "report_ready", "payload": {}}
data: {"task_id": "T20260901-074137842", "domain": "pentest", "event": "stage_finished", "payload": {"domain": "report", "count": 15}}
data: {"task_id": "T20260901-074137842", "domain": "pentest", "event": "status_completed", "payload": {}}
```

### ✅ T12 任务详情
```json
{
  "id": "T20260901-074145106",
  "domain": "pentest",
  "target": "127.0.0.1",
  "status": "completed",
  "verdict": "real_threat",
  "findings_count": 15,
  "current_stage": "report"
}
```

### ❌ T7 threatintel/incident 直连大脑 500
```bash
$ curl 127.0.0.1:6657/api/tasks -d '{"domain":"threatintel"}'   # 500
$ curl 127.0.0.1:6657/api/tasks -d '{"domain":"incident"}'       # 500
```

### ❌ 缺 intel 路由（前端）
```bash
$ curl /aisoc-intel/api/tasks
<!doctype html>  ← SPA 路由吞掉
```

---

## 推荐处理顺序

1. **ISSUE-001 + ISSUE-002**（同根因，一起改）
2. **ISSUE-003**（需要产品决策）
3. **ISSUE-004 / 005 / 006**（P2，按团队排期）
4. **ISSUE-007 / 008**（P3，整理时顺手做）

---

## 关联文件清单

| 文件 | 行号 | 说明 |
|---|---|---|
| `serve_frontend.py` | 22-29 | ROUTES 缺 `/aisoc-intel/api` |
| `serve_frontend.py` | 27 | `/aisoc-incident/api` 待决策 |
| `desktop/frontend/src/lib/aisoc-api.ts` | 17 | `TaskDomain` 类型 |
| `desktop/frontend/src/lib/aisoc-api.ts` | 520-525 | `domainProxies` |
| `desktop/frontend/src/lib/aisoc-api.ts` | 581-587 | `DOMAIN_PORTS` |
| `aisoc-docs/02-通信协议规范.md` | §5 | SSE 帧格式 |
| `aisoc-docs/07-chat-stream-adaptive-relay.md` | §4.2 | 任务级接力流设计 |

---

变更记录：
- v1.0 (2026-09-01)：初版
- v1.1 (2026-09-01)：修复 ISSUE-001 / ISSUE-002（threatintel → intel 全面重命名 + 加 /aisoc-intel/api 路由 + 保留 /aisoc-threatintel/api 兼容）
