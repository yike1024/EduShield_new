# FastAPI 大脑（6657）附件上传端点工程方案

**需求方**：caoyike（前端） / **实施方**：linyuxuan（大脑）
**状态**：待 linyuxuan 实施（前端配套已就绪，端点 404 时自动回退，可独立上线）

---

## 1. 一页纸结论

在 FastAPI 大脑（6657）新增 `POST /api/save-attachment`：接收 base64 dataURL 附件，落盘 `.reasonix/attachments/`，返回相对路径。前端已按契约实现"内存内联为主、服务端镜像为辅"的双轨链路——**端点未部署时前端行为与现状完全一致，部署后即获得服务端副本路径**，部件工具可按路径读取原始字节（日志审计等大文件场景不再依赖全文内联）。

## 2. 背景与现状

### 2.1 现行链路（已验证可用）

Web 模式附件纯前端内存实现（`webApiProxy.ts`）：

1. Composer 选文件 → `SavePastedFile(name, dataUrl)` → 字节存内存 Map，键为 `web-attachment://file-N/name`；
2. 提交时 `expandFileReferences` 把附件 UTF-8 解码内联进消息文本（默认上限 200KB，可调）发给大脑；
3. 端到端已实证：大脑思考流能完整收到文件内容。

### 2.2 痛点

| 痛点 | 影响 |
|---|---|
| 附件字节只在浏览器内存 | 刷新即丢；部件工具无法按路径读取原始文件 |
| 大文件靠全文内联 | 超上限截断；日志审计场景应该由部件按路径分段读盘 |
| 图片/二进制不内联 | 模型只知道"有个文件"，没有获取字节的任何途径 |

### 2.3 与 13 号方案的关系

`aisoc-docs/13-大脑新增附件上传端点.md` 是为旧 Go 大脑（reasonix `internal/serve/serve.go`）设计的，需求至今有效但实施对象已换成 FastAPI 大脑（6657）。本文档是该契约在 FastAPI 侧的落地版，请求/响应契约保持一致。

## 3. 接口契约

### POST /api/save-attachment

- **鉴权**：`Authorization: Bearer <token>`（与其他 /api/* 一致；未授权返回 401）
- **请求**（`application/json`）：

```json
{
  "name": "access.log",
  "dataUrl": "data:text/plain;base64,aGVsbG8gd29ybGQ="
}
```

- **响应 200**：

```json
{ "path": ".reasonix/attachments/20261012-153000-a1b2-access.log" }
```

- **错误**：
  - 400：`name`/`dataUrl` 缺失、dataUrl 非 base64 格式
  - 401：未携带或无效 token
  - 413：超过大小上限（25MB，解码前 base64 文本约 33MB）
  - 5xx：落盘失败

### 实现要点（FastAPI）

1. **解析**：正则 `^data:([^;,]+)?;base64,(.+)$` 提取 mime 与 base64 体，`base64.b64decode(validate=True)`。
2. **安全文件名**：扩展名白名单 `[a-z0-9]{1,12}`，不在白名单写 `.bin`；文件名主体只保留 `[a-zA-Z0-9._-]`，其余替换 `_`，防路径穿越。
3. **落盘**：`<workspace>/.reasonix/attachments/<时间戳>-<6位随机>-<安全文件名>`；**按用户隔离**——路径或元数据需关联 Bearer 用户（如 `.reasonix/attachments/<userId>/...`），避免跨用户可读。
4. **返回**：仓库相对路径（不带绝对路径前缀）。
5. **幂等/去重（可选 P1）**：同用户同内容 hash 可复用已有文件。

## 4. 前端配套（已就绪，本仓库）

| 改动 | 文件 | 行为 |
|---|---|---|
| 镜像上传 | `webApiProxy.SavePastedFile` | 附件内存存储后 fire-and-forget 调 `POST /api/save-attachment`（60s 超时）；404/未登录/网络失败静默忽略，主链路不受影响 |
| 副本路径透传 | `webApiProxy.expandFileReferences` | 镜像成功的附件，内联头部追加 `[服务端副本: <path>，部件工具可按此路径读取原始字节]`，大脑/部件协议可消费 |
| 内联上限可调 | `getAttachmentInlineMaxBytes()` | localStorage `reasonix:web:attachment_inline_max_bytes` 覆盖默认 200KB |
| 图片显式标注 | 同上 | 图片附件提交时标注"当前 Web 模式不支持图像理解"，防模型幻觉 |

**端点未部署时前端行为 = 现状**（纯内存内联），因此前后端可按任意顺序上线。

## 5. 验收用例

```bash
# 1. 未授权 → 401
curl -X POST http://127.0.0.1:6657/api/save-attachment \
  -H 'Content-Type: application/json' \
  -d '{"name":"a.txt","dataUrl":"data:text/plain;base64,aGVsbG8="}'

# 2. 正常上传 → 200 + path，文件真实落盘且内容一致
curl -X POST http://127.0.0.1:6657/api/save-attachment \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"probe.log","dataUrl":"data:text/plain;base64,bG9uZyBsb2cgYnl0ZXM="}'

# 3. 超限 → 413（构造 >25MB base64）

# 4. 路径穿越 → 安全文件名（name="../../etc/passwd" 不应逃出 attachments 目录）

# 5. 跨用户隔离：A 的 token 上传后，B 的 token 不应能访问 A 的附件路径
```

## 6. 后续路线（不在本期）

- **视觉链路**：聊天请求体支持多模态 content parts，图像字节直达视觉模型（需大脑协议扩展 + 视觉模型配置，单独立项）。
- **RAG 大文件**：超大文件入语料库按相关性检索片段内联，替代全文内联。
