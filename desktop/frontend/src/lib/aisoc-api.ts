/**
 * AiSOC API Client
 * 严格按照 docs/frontend-api.md（大脑 FastAPI 6657）实现的前端客户端。
 * 前端呈现什么 = 大脑有什么。
 */

// 基础URL配置 - 直连大脑 FastAPI（6657）
// frontend-api.md 明确：CORS 已全开，前端任意端口直连即可。
// Wails 生产环境（8082）没有 Vite dev 代理，相对路径 /aisoc-brain/api 会 404，
// 导致任务无法发送；故默认直连 127.0.0.1:6657。
// 仍可用 VITE_BRAIN_API_URL 覆盖（如部署到 cpolar/nginx 暴露的对外地址）。
const BRAIN_API_BASE = (import.meta.env.VITE_BRAIN_API_URL as string) || 'http://127.0.0.1:6657/api';

/** 域标识（文档 §4.1：logaudit / pentest；前端保留四部件展示） */
export type TaskDomain = 'pentest' | 'logaudit' | 'threatintel' | 'incident';
/** 任务状态枚举（文档 §4.2） */
export type TaskStatus = 'pending' | 'running' | 'approval' | 'completed' | 'failed' | 'cancelled' | 'archived';
/** 判定枚举（文档 §4.2） */
export type Verdict = 'real_threat' | 'false_positive' | 'pending_review';
/** 严重级别枚举（文档 §4.3） */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
/** 阶段枚举（文档 §4.2） */
export type StageName = 'logaudit' | 'pentest' | 'verdict' | 'tir' | 'report';

/**
 * 下发任务请求体（文档 §4.1）
 */
export interface CreateTaskInput {
  task: string;                    // 自然语言任务描述（必填）
  domain: TaskDomain;              // logaudit / pentest（必填）
  target: string;                  // 目标，必须在授权白名单内，否则 403（必填）
  pipeline?: string;               // 目前支持 data_leak
  params?: Record<string, unknown>;// 透传给部件的参数
  tools?: string[];                // 工具白名单，缺省 = 部件全部
}

/** 兼容别名：UI 曾用 TaskMessage 名，现在指下发任务请求 */
export type TaskMessage = CreateTaskInput;

/**
 * 证据（Finding）— 文档 §4.3
 */
export interface Finding {
  id: string;                // F-<task_id>-<seq>
  task_id: string;           // 来源任务
  domain: string;            // 产出部件
  target: string;            // 目标
  tool: string;              // 产出工具名
  severity: Severity;
  cve?: string | null;
  cwe?: string | null;
  cvss?: number | null;
  title: string;             // 人读摘要
  description: string;       // 详情
  evidence: string;          // 支撑证据片段
  remediation?: string;      // 修复建议
  confidence: number;        // 0~1
  mitre?: string[];
  ts: string;                // ISO8601 UTC（文档字段名）
  timestamp?: string;        // 兼容别名
}

/**
 * 阶段进度（文档 §4.2 stages 数组元素）
 */
export interface TaskStage {
  id: number;
  task_id: string;
  stage: StageName;
  status: TaskStatus;
  started_at?: string;
  finished_at?: string;
  findings_count: number;
  error?: string;
}

/**
 * 思维链条目（文档 §4.2 thought_chain）
 */
export interface ThoughtChainEntry {
  id: number;
  task_id: string;
  ts: string;
  actor: string;             // 如 "brain"
  action: string;            // 如 "task_created" / "status_completed"
  detail?: Record<string, unknown>;
}

/**
 * 任务列表项（文档 §4.1b）
 */
export interface TaskInfo {
  id: string;                // 任务ID
  task_id?: string;          // 兼容别名（= id）
  domain: TaskDomain;
  target: string;
  status: TaskStatus;
  verdict?: Verdict;
  confidence?: number;
  created_at: string;
  updated_at: string;
  findings_count?: number;
  current_stage?: string;
  stages?: TaskStage[];
}

/**
 * 任务详情（文档 §4.2）
 */
export interface TaskDetail extends TaskInfo {
  error?: string;
  thought_chain?: ThoughtChainEntry[];
}

/**
 * 报告（文档 §4.4）— report 为 Markdown 字符串
 */
export interface ReportDoc {
  task_id: string;
  report: string;            // Markdown 字符串
}

/**
 * 部件注册表项（文档 §4.6）— token 脱敏，前端不展示
 */
export interface RegistryPart {
  domain: TaskDomain;
  host: string;
  port: number;
  token?: string;            // 仅标记存在，绝不在 UI 渲染
  auth?: string;
  enabled: boolean;
}

/**
 * Agent 忙闲状态（文档 §4.1c 状态墙）
 */
export interface AgentStatusItem {
  domain: TaskDomain;
  host?: string;
  port?: number;
  auth?: string;
  enabled?: boolean;
  busy: boolean;
}

/** 各 Agent 忙闲状态（文档 §4.1c） */
export interface AgentsStatus {
  brain: { status: string; service: string };
  parts: AgentStatusItem[];
  /** 各 REST 服务（应急响应 TIR 等）的端口与在线状态 */
  services?: Record<string, { name?: string; port?: number; status?: string }>;
}

/**
 * XDR 告警样例（文档 §4.7）
 */
export interface Alarm {
  id?: string;
  severity: Severity;
  title?: string;
  description?: string;
  src_ip?: string;
  dst_ip?: string;
  rule?: string;
  ts?: string;
  [key: string]: unknown;
}

/** 告警统计（文档 §4.7） */
export interface AlarmsSummary {
  total: number;
  by_severity: Record<string, number>;
  by_verdict_hint?: Record<string, number>;
}

/**
 * 实时事件流（文档 §4.8 SSE）— 每帧 data: {task_id, domain, event, payload}
 */
export type StreamEventName =
  | 'task_created' | 'status_running' | 'stage_start' | 'stage_finished'
  | 'stage_failed' | 'findings_stored' | 'verdict' | 'report_ready'
  | 'status_completed' | 'status_failed';

export interface StreamEvent {
  task_id: string;
  domain: string;
  event: StreamEventName;
  payload: Record<string, unknown>;
}

/**
 * API错误响应
 */
export interface ApiError {
  error: string;
  detail?: string;
  code?: string;
}

/**
 * AiSOC 请求错误：携带 HTTP 状态码与「服务是否不可达」标记，
 * 便于上层做优雅降级（大脑离线时展示友好提示而非原始 502）。
 */
export class AisocApiError extends Error {
  readonly status: number;
  readonly isUnreachable: boolean;
  constructor(message: string, status = 0, isUnreachable = false) {
    super(message);
    this.name = 'AisocApiError';
    this.status = status;
    this.isUnreachable = isUnreachable;
  }
}

/**
 * AiSOC API客户端类
 */
export class AisocApi {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(baseUrl: string = BRAIN_API_BASE, authToken?: string) {
    this.baseUrl = baseUrl;
    this.headers = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      this.headers['Authorization'] = `Bearer ${authToken}`;
    }
  }

  /**
   * 设置认证token
   */
  setAuthToken(token: string): void {
    this.headers['Authorization'] = `Bearer ${token}`;
  }

  /**
   * 通用请求方法
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers: {
          ...this.headers,
          ...options.headers,
        },
      });
    } catch {
      throw new AisocApiError('无法连接大脑服务，请确认服务已启动', 0, true);
    }

    if (!response.ok) {
      // 502/503/504 多为上游（大脑/子部件）未启动或网关超时，做友好降级
      if (response.status === 502 || response.status === 503 || response.status === 504) {
        throw new AisocApiError(
          `大脑服务不可用（HTTP ${response.status}），请先启动大脑服务`,
          response.status,
          true,
        );
      }
      let message = `HTTP ${response.status}`;
      let detail: string | undefined;
      try {
        const parsed = (await response.json()) as Partial<ApiError>;
        message = parsed.error || message;
        detail = parsed.detail;
      } catch {
        // 非 JSON 响应体（如 HTML 网关错误），保留状态码即可
      }
      throw new AisocApiError(detail ? `${message} - ${detail}` : message, response.status);
    }

    return response.json() as Promise<T>;
  }

  /**
   * 下发任务（文档 §4.1）
   * POST /api/tasks — 单域任务或多阶段管道（pipeline 目前支持 data_leak）
   * 任务异步执行：返回 202 + pending 状态，后续用 SSE 或轮询刷新。
   */
  async createTask(task: CreateTaskInput): Promise<{ task_id: string; status: string; domain: string }> {
    return this.request('/tasks', {
      method: 'POST',
      body: JSON.stringify(task),
    });
  }

  /**
   * 任务状态 + 阶段进度 + 思维链（文档 §4.2）
   * GET /api/tasks/{task_id}
   */
  async getTask(taskId: string): Promise<TaskDetail> {
    return this.request(`/tasks/${taskId}`);
  }

  /**
   * 审计导出（文档 §4.5）
   * GET /api/tasks/{task_id}/export
   * 返回完整 JSON：任务 + findings + ledger + report。
   */
  async exportTask(taskId: string): Promise<Record<string, unknown>> {
    return this.request(`/tasks/${taskId}/export`);
  }

  /**
   * 查询证据（文档 §4.3）
   * GET /api/findings?task_id=
   * 响应包在 {task_id, findings} 中，这里解包出数组。
   */
  async getFindings(taskId: string): Promise<Finding[]> {
    const data = await this.request<{ task_id: string; findings: Finding[] }>(
      `/findings?task_id=${encodeURIComponent(taskId)}`,
    );
    return data.findings ?? [];
  }

  /**
   * 审批应答（文档 §4.9）
   * POST /api/approve — 当前仅记录审计，后续接入处置门控。
   */
  async approveTool(
    taskId: string,
    action: string,
    decision: 'approved' | 'denied'
  ): Promise<void> {
    return this.request('/approve', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, action, decision }),
    });
  }

  /**
   * 查询报告（文档 §4.4）
   * GET /api/reports/{task_id} — report 为 Markdown 字符串。
   */
  async getReport(taskId: string): Promise<ReportDoc> {
    return this.request(`/reports/${taskId}`);
  }

  /**
   * 部件注册表（文档 §4.6）
   * GET /api/registry — 返回 {parts: [...]}，token 已脱敏，前端不要渲染 token。
   */
  async getRegistry(): Promise<RegistryPart[]> {
    const data = await this.request<{ parts: RegistryPart[] }>('/registry');
    return data.parts ?? [];
  }

  /**
   * 各 Agent 忙闲状态（文档 §4.1c 状态墙）
   * GET /api/agents/status
   */
  async getAgentsStatus(): Promise<AgentsStatus> {
    return this.request('/agents/status');
  }

  /**
   * XDR 告警样例（文档 §4.7）
   * GET /api/data/alarms?limit=
   */
  async getAlarms(limit: number = 10): Promise<{ source?: string; count?: number; alarms: Alarm[] }> {
    return this.request(`/data/alarms?limit=${limit}`);
  }

  /**
   * 告警统计（文档 §4.7）
   * GET /api/data/alarms/summary
   */
  async getAlarmsSummary(): Promise<AlarmsSummary> {
    return this.request('/data/alarms/summary');
  }

  /**
   * 健康检查（文档 §4.10）
   * GET /api/health
   */
  async healthCheck(): Promise<{ status: string; service: string }> {
    return this.request('/health');
  }

  /**
   * 实时事件流（文档 §4.8）
   * GET /api/stream (SSE)
   * 每帧 data: {task_id, domain, event, payload}；15 秒心跳帧由 EventSource 自动忽略。
   */
  connectRealtimeStream(
    onEvent: (event: StreamEvent) => void,
    onError?: (error: Event) => void,
    taskId?: string,
    domain?: string
  ): EventSource {
    const params = new URLSearchParams();
    if (taskId) params.append('task_id', taskId);
    if (domain) params.append('domain', domain);

    const url = `${this.baseUrl}/stream${params.toString() ? `?${params.toString()}` : ''}`;
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as StreamEvent;
        onEvent(data);
      } catch (error) {
        console.error('Failed to parse SSE event:', error);
      }
    };

    if (onError) {
      eventSource.onerror = onError;
    }

    return eventSource;
  }

  /**
   * 最近任务列表（文档 §4.1b）
   * GET /api/tasks?limit=
   */
  async listTasks(limit: number = 50): Promise<{ tasks: TaskInfo[] }> {
    return this.request(`/tasks?limit=${limit}`);
  }
}

/**
 * 默认API客户端实例
 */
export const aisocApi = new AisocApi();

/**
 * 工厂函数：创建特定域的API客户端
 */
export function createDomainApiClient(domain: string, authToken?: string): AisocApi {
  // 通过 Vite 代理访问各部件端口，避免 CORS
  const domainProxies: Record<string, string> = {
    brain: '/aisoc-brain/api',
    pentest: '/aisoc-pentest/api',
    logaudit: '/aisoc-logaudit/api',
    threatintel: '/aisoc-threatintel/api',
    incident: '/aisoc-incident/api',
  };

  const baseUrl = domainProxies[domain] || domainProxies.brain;
  return new AisocApi(baseUrl, authToken);
}

/**
 * 任务生成器：生成符合格式的任务ID
 */
export function generateTaskId(): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
  const timeStr = now.toISOString().slice(11, 19).replace(/:/g, ''); // HHMMSS
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `T${dateStr}-${timeStr}${random}`;
}

/**
 * Finding ID生成器
 */
export function generateFindingId(taskId: string, sequence: number): string {
  return `F-${taskId}-${sequence.toString().padStart(3, '0')}`;
}

// ============================================================================
// 前端友好常量（按 03-大脑设计.md 配置）
// ============================================================================

/** 部件域 → 中文显示名称 */
export const DOMAIN_LABELS: Record<string, string> = {
  brain: '大脑 (AiSOC Brain)',
  pentest: '渗透测试 Agent',
  logaudit: '日志审计 Agent',
  threatintel: '威胁情报 Agent',
  incident: '应急响应 Agent',
};

/** 部件域 → 颜色（架构图/徽标配色） */
export const DOMAIN_COLORS: Record<string, { dot: string; bg: string; ring: string }> = {
  brain:       { dot: 'bg-fuchsia-500', bg: 'bg-fuchsia-50',  ring: 'ring-fuchsia-300' },
  pentest:     { dot: 'bg-rose-500',    bg: 'bg-rose-50',     ring: 'ring-rose-300' },
  logaudit:    { dot: 'bg-sky-500',     bg: 'bg-sky-50',      ring: 'ring-sky-300' },
  threatintel: { dot: 'bg-amber-500',   bg: 'bg-amber-50',    ring: 'ring-amber-300' },
  incident:    { dot: 'bg-emerald-500', bg: 'bg-emerald-50',  ring: 'ring-emerald-300' },
};

/** 部件域 → 描述（计划书 §3.2 身体部件公式） */
export const DOMAIN_DESCRIPTIONS: Record<string, string> = {
  brain:       '编排调度 · 威胁判定 · 知识库 · 报告合规 · 审计留档',
  pentest:     '渗透测试（端口扫描、漏洞探测、CVE 验证、利用）',
  logaudit:    '日志审计（异常检测、访问溯源、关联分析、攻击链重建）',
  threatintel: '威胁情报（IP/域名信誉、情报源聚合、OSINT 查询）',
  incident:    '应急响应（处置剧本、封禁工单、加固建议）',
};

/** 部件域 → 默认端口（注册表占位；运行时以大脑 /api/registry 为准；incident 应急响应 REST 服务为 8090，不归 reasonix 部件管） */
export const DOMAIN_PORTS: Record<string, number> = {
  brain: 6657,
  pentest: 8787,
  logaudit: 8788,
  threatintel: 8789,
  incident: 8090,
};

/** 严重级别 → 中文 + 样式尾词 */
export const SEVERITY_META: Record<string, { label: string; cls: string }> = {
  critical: { label: '严重', cls: 'bg-red-100 text-red-800 border-red-200' },
  high:     { label: '高危', cls: 'bg-orange-100 text-orange-800 border-orange-200' },
  medium:   { label: '中危', cls: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
  low:      { label: '低危', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  info:     { label: '信息', cls: 'bg-gray-100 text-gray-700 border-gray-200' },
};

/** 任务状态 → 中文 + 颜色徽标 */
export const TASK_STATUS_META: Record<string, { label: string; cls: string }> = {
  pending:   { label: '等待中',   cls: 'bg-gray-100 text-gray-700' },
  running:   { label: '运行中',   cls: 'bg-blue-100 text-blue-800 animate-pulse' },
  approval:  { label: '待审批',   cls: 'bg-amber-100 text-amber-800' },
  completed: { label: '已完成',   cls: 'bg-green-100 text-green-800' },
  failed:    { label: '失败',     cls: 'bg-red-100 text-red-800' },
  cancelled: { label: '已取消',   cls: 'bg-zinc-100 text-zinc-600' },
  archived:  { label: '已归档',   cls: 'bg-violet-50 text-violet-700' },
};

/** 判定结果 → 中文 + 样式 */
export const VERDICT_META: Record<string, { label: string; cls: string; icon: string }> = {
  real_threat:    { label: '真实威胁', cls: 'bg-red-50 border-red-200 text-red-800',  icon: '⚠️' },
  false_positive: { label: '误报排除', cls: 'bg-green-50 border-green-200 text-green-800', icon: '✅' },
  pending_review: { label: '待人工复核', cls: 'bg-yellow-50 border-yellow-200 text-yellow-800', icon: '🗂️' },
};

/**
 * 管道预设（计划书 §3.6 多 Agent 协作场景 + 03 大脑设计 §2.2 管道定义）
 * stage 顺序即编排顺序；含 "∥" 的标记在同一阶段内并行
 */
export type PipelineStage = {
  domain: TaskMessage['domain'];
  name: string;                  // 阶段名（中文显示）
  tools?: string[];              // 工具白名单（留空=全部）
  passFindings?: boolean;        // 是否把上阶段 Finding 摘要作为 context 注入（星型证据流转）
};
export type PipelinePreset = {
  id: string;
  name: string;                  // 中文短名
  description: string;           // 完整说明
  story: string;                 // 通俗说明（对应计划书"协作场景"条目）
  stages: PipelineStage[];
};

export const PIPELINE_PRESETS: PipelinePreset[] = [
  {
    id: 'data_leak_investigation',
    name: '疑似数据泄露调查（旗舰场景）',
    description: 'logaudit → pentest → [情报] → incident → 大脑交叉判定',
    story: '外部通报数据泄露 → ①日志审计定位可疑 IP+时间线 → ②渗透测试验证漏洞入口 → ③威胁情报溯源 → ④应急响应封禁加固 → 大脑交叉确认并出完整报告（计划书 §3.6 场景 1）',
    stages: [
      { domain: 'logaudit',    name: '日志审计：定位可疑 IP + 攻击时间线',          passFindings: false },
      { domain: 'pentest',     name: '渗透测试：验证漏洞入口',                        passFindings: true },
      { domain: 'threatintel', name: '威胁情报：IP 溯源',                             passFindings: true },
      { domain: 'incident',    name: '应急响应：封禁 + 加固',                          passFindings: true },
    ],
  },
  {
    id: 'attack_chain',
    name: '定向攻击链调查',
    description: 'logaudit → pentest → 判定 → 报告',
    story: '发现 webshell → 日志审计溯源入口攻击链 → 渗透测试复现/验证 → 大脑关联时间线输出攻击链图（计划书 §3.6 场景 2）',
    stages: [
      { domain: 'logaudit', name: '日志审计：溯源入口→横向→外联',                     passFindings: false },
      { domain: 'pentest',  name: '渗透测试：漏洞复现/验证',                           passFindings: true },
    ],
  },
  {
    id: 'new_system_assessment',
    name: '新系统上线评估（并行）',
    description: 'pentest ∥ logaudit → 合规 → 判定 → 报告',
    story: '渗透部件（新系统漏洞）与日志审计部件（历史攻击模式）并行 → 大脑交叉引用"新系统是否暴露历史攻击路径"→ 等保合规扫描（计划书 §3.6 场景 3）',
    stages: [
      { domain: 'pentest',  name: '渗透测试：漏洞面扫描',                              passFindings: false },
      { domain: 'logaudit', name: '日志审计：历史攻击模式匹配（并行）',                 passFindings: false },
    ],
  },
  {
    id: 'red_blue_drill',
    name: '攻防演练（红蓝并行）',
    description: 'pentest(红) ∥ logaudit(蓝) → 实时态势 → 报告',
    story: '红队（渗透部件）与蓝队（日志审计部件）并行 → 大脑实时汇总态势生成报告（计划书 §3.6 场景 4）',
    stages: [
      { domain: 'pentest',  name: '红队：主动进攻面利用',                              passFindings: false },
      { domain: 'logaudit', name: '蓝队：实时审计 + 异常检测（并行）',                  passFindings: false },
    ],
  },
  {
    id: 'pentest_only',
    name: '仅渗透测试',
    description: '单部件：渗透测试',
    story: '仅下发到渗透部件，产出渗透 Finding + 单域报告',
    stages: [
      { domain: 'pentest', name: '渗透测试', passFindings: false },
    ],
  },
  {
    id: 'logaudit_only',
    name: '仅日志审计',
    description: '单部件：日志审计',
    story: '仅下发到日志审计部件，查异常、攻击源、时间线',
    stages: [
      { domain: 'logaudit', name: '日志审计', passFindings: false },
    ],
  },
];

/** 默认任务参数 */
export const DEFAULT_TASK_PARAMS = {
  timeout_s: 1800,
  max_steps: 50,
};
