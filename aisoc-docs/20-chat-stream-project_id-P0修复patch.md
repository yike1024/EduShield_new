# chat/stream 未写入 project_id — P0 修复 Patch

**状态**：待 linyuxuan 应用（caoyike 无后端源码写权限）
**测试日期**：2026-10-13
**对应方案**：[17-评估项目功能前后端工程方案.md](./17-评估项目功能前后端工程方案.md) §5.8 / §5.9
**前置条件**：projects 表与 conversations.project_id 列已上线（已确认：POST /api/conversations 已支持 project_id）

---

## 1. 根因（OpenAPI 反推实证）

通过 `GET /openapi.json` 看到 `ChatRequest` schema 的字段清单：

```
message, system, pass_through, session_id, conversation_id, use_rag, use_memory, use_profile
```

**没有 `project_id` 字段**。Pydantic 默认对未声明字段是"容忍丢弃"（不会 422），所以前端传 `project_id` 进来后被静默忽略，chat/stream 建会话时拿不到这个值，自然写入 `NULL`。

同时对比 `ConversationCreateRequest`（POST /api/conversations 用的）——它**已经声明了 `project_id` / `projectId`**，证明 conversations 表的列已就绪、CRUD 层也接好了，问题只在 chat/stream 这条链路没把 project_id 透传给会话创建逻辑。

---

## 2. 修复点（3 处，全在 chat/stream 链路）

### 修复点 A — ChatRequest 模型加字段

**文件**：`api/.../chat.py` 或 `api/.../schemas/chat.py`（按实际目录结构定位，定义 `ChatRequest` 的那个文件）

```python
# 现有 ChatRequest 定义里追加：
class ChatRequest(BaseModel):
    message: str
    system: str = "你是 AiSOC 校园安全运营助手，回答简洁专业。"
    pass_through: bool = False
    session_id: str | None = None
    conversation_id: str | None = None
    use_rag: bool = True
    use_memory: bool = True
    use_profile: bool = True
    # —— 新增 ——
    project_id: str | None = None   # UUID 字符串；合法则建会话时写入 conversations.project_id
```

### 修复点 B — 建会话分支写入 project_id

**文件**：`api/.../chat.py` 里处理 `chat_stream` 的函数（通常叫 `chat_stream` / `stream_chat`）

定位点：在"无 `conversation_id` → 新建会话"的分支，调用 conversations 创建函数时把 `project_id` 透传进去。

```python
# 伪代码 — 按现有调用方式调整
if not req.conversation_id:
    # 新建会话
    conv = await conversations.create(
        user_id=user.id,
        title=derived_title,           # 现有逻辑
        project_id=req.project_id,    # —— 新增：透传 ——
    )
    conversation_id = conv.id
else:
    # 续接会话：以会话现有 project_id 为准，不覆盖（17 号 §5.8 规则 3）
    conversation_id = req.conversation_id
```

**校验**（可选但推荐）：如果传了 `project_id`，确认它属于当前用户（SELECT 1 FROM projects WHERE id=? AND user_id=?），不属于则**忽略置 NULL**（17 号 §5.8 规则 1："建议宽容忽略，避免 422 阻断对话"）。**不得 500**。

```python
if req.project_id:
    owned = await db.execute(
        text("SELECT 1 FROM projects WHERE id=:id AND user_id=:uid"),
        {"id": req.project_id, "uid": str(user.id)},
    )
    if not owned.first():
        req.project_id = None  # 宽容忽略
```

### 修复点 C — SSE conversation_bound 帧补 projectId

**文件**：同 chat_stream 函数内，发 `conversation_bound` 帧的位置

```python
# 现有：
yield sse({"kind": "conversation_bound", "conversationId": conversation_id})

# 改为：
project_id_for_frame = None
if not req.conversation_id:
    project_id_for_frame = req.project_id   # 新建会话：用请求里的
else:
    # 续接会话：从 DB 读会话当前 project_id
    row = await db.execute(
        text("SELECT project_id FROM conversations WHERE id=:id AND user_id=:uid"),
        {"id": conversation_id, "uid": str(user.id)},
    )
    r = row.first()
    project_id_for_frame = r.project_id if r else None

yield sse({
    "kind": "conversation_bound",
    "conversationId": conversation_id,
    "projectId": str(project_id_for_frame) if project_id_for_frame else None,
})
```

前端已兼容 `projectId` 缺省（旧后端不下发也不报错），所以补字段无需版本升级。

---

## 3. 应用步骤（linyuxuan 执行）

```bash
# 1. 进入后端目录
cd ~/aisoc-brain-lyx

# 2. 拉最新代码或备份
git pull   # 或 cp -r api api.bak.$(date +%s)

# 3. 按上述 3 处修复点改代码
#    - ChatRequest 加 project_id 字段
#    - chat_stream 新建会话分支透传 project_id
#    - conversation_bound 帧补 projectId

# 4. 重启服务（保持现有启动方式）
pkill -f "python -m api.main" || true
cd ~/aisoc-brain-lyx && setsid nohup ~/miniconda3/bin/python -m api.main >> brain.log 2>&1 &
```

---

## 4. 验收（caoyike 已写好 curl，直接跑）

```bash
BASE=http://127.0.0.1:6657/api
TOK=<登录 token>
PID=$(curl -sS -X POST "$BASE/projects" -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' -d '{"name":"P0验收"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# 1) chat/stream 带 project_id
timeout 30 curl -sN -X POST "$BASE/chat/stream" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"message\":\"你好\",\"pass_through\":true,\"project_id\":\"$PID\"}" 2>&1 | grep conversation_bound

# 期望：{"kind":"conversation_bound","conversationId":"...","projectId":"<PID>"}（非 null）

# 2) 会话列表带 projectId
curl -sS "$BASE/conversations?page_size=5" -H "Authorization: Bearer $TOK" \
  | python3 -c "import sys,json;[print(it['id'],'projectId=',it.get('projectId')) for it in json.load(sys.stdin)['items']]"

# 期望：刚建的会话 projectId=<PID>

# 3) 按 project_id 过滤返回该会话
curl -sS "$BASE/conversations?project_id=$PID" -H "Authorization: Bearer $TOK" \
  | python3 -c "import sys,json;print('total=',json.load(sys.stdin)['total'])"

# 期望：total=1

# 4) 项目聚合计数 conversationCount=1
curl -sS "$BASE/projects/$PID" -H "Authorization: Bearer $TOK" \
  | python3 -c "import sys,json;print('conversationCount=',json.load(sys.stdin)['conversationCount'])"

# 期望：conversationCount=1

# 5) 续接会话传不同 project_id → 不覆盖
CID=<上面拿到的会话 id>
timeout 30 curl -sN -X POST "$BASE/chat/stream" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "{\"message\":\"再问一句\",\"conversation_id\":\"$CID\",\"project_id\":\"00000000-0000-0000-0000-000000000000\"}" 2>&1 | grep conversation_bound

# 期望：projectId 仍为原 PID（不覆盖）
```

---

## 5. 未覆盖的关联问题（同批次修，但不阻断本 patch）

下列 P0/P1 在同次测试发现，建议同批修复，但本 patch 不强制包含：

| 关联问题 | 对应方案 | 说明 |
|---|---|---|
| DELETE 项目后 conversations.project_id 未 SET NULL | 17 号 §5.5 + §4.2 | 外键约束 `ON DELETE SET NULL` 未生效，会话仍指向已删项目 |
| PATCH `{"target":null}` 未清空 target | 17 号 §5.4 | None 被当作"不更新"处理，应区分"显式 null=清空" |
| 非法 color 未 422 | 17 号 §4.1 | 白名单未校验 |
| 非法 project_id UUID 未 422 | 17 号 §5.6 | 应返回 422 |
| DELETE 响应缺 `unboundConversations` | 17 号 §5.5 | 当前只返回 `{"ok":true}` |
| save-attachment 未做 401 鉴权 | 19 号 §3 | 未带 token 返回 200 |
| save-attachment 未按用户隔离路径 | 19 号 §3.3 | path 无 userId 区分 |
| save-attachment 丢弃用户原始文件名 | 19 号 §3.2 | 改为 clipboard-XXX |

---


