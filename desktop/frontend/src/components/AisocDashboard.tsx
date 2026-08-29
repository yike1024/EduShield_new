/**
 * AiSOC 大脑平台仪表板
 * 按 docs/frontend-api.md（大脑 FastAPI :6657）实现。
 *
 * 布局：
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ 顶栏：大脑健康灯 + 4 子部件连接灯 + 创建任务按钮                       │
 *   ├──────────────┬───────────────────────────────────────────────────────┤
 *   │ 左列（架构视图）:                                                    │
 *   │  · 大脑中心卡片 + 四部件节点（注册表数组驱动）                       │
 *   │  · 任务创建表单（任务描述 × domain × pipeline × target × tools）     │
 *   ├──────────────┼───────────────────────────────────────────────────────┤
 *   │ 右列（三 Tab 可切换）:                                               │
 *   │  Tab1 任务列表：所有任务 + 状态徽标 + 点击选中                        │
 *   │  Tab2 实时面板：RealtimePanel（agent 状态墙 + SSE 流式输出）         │
 *   │  Tab3 详情：Finding 证据表 + Verdict 判定卡 + Markdown 报告          │
 *   └──────────────┴───────────────────────────────────────────────────────┘
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Database,
  Download,
  FileSearch,
  FileText,
  Gavel,
  Layers,
  Loader2,
  Network,
  Play,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';
import RealtimePanel from './RealtimePanel';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  aisocApi,
  DOMAIN_COLORS,
  DOMAIN_DESCRIPTIONS,
  DOMAIN_LABELS,
  DOMAIN_PORTS,
  SEVERITY_META,
  TASK_STATUS_META,
  VERDICT_META,
  type CreateTaskInput,
  type Finding,
  type RegistryPart,
  type ReportDoc,
  type TaskDetail,
  type TaskInfo,
  type AgentsStatus,
} from '../lib/aisoc-api';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const ALL_DOMAINS: CreateTaskInput['domain'][] = ['pentest', 'logaudit', 'threatintel', 'incident'];

/** 阶段名 → 中文显示（文档 §4.2 stages 元素） */
const STAGE_LABELS: Record<string, string> = {
  logaudit: '日志审计',
  pentest: '渗透测试',
  verdict: '威胁判定',
  tir: '威胁情报',
  report: '报告',
};

function fmtTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

function fmtAgo(iso: string): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff) || diff < 0) return '—';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}

// ---------------------------------------------------------------------------
// 架构拓扑：大脑居中 → 星型连线 → 四部件节点
// ---------------------------------------------------------------------------

type ConnectState = 'ok' | 'warn' | 'off' | 'loading';

function stateFromHealth(ok: boolean | null, running: boolean): ConnectState {
  if (ok === null) return running ? 'loading' : 'off';
  return ok ? 'ok' : 'warn';
}

const CONNECT_STYLE: Record<ConnectState, { dot: string; label: string; line: string }> = {
  ok:      { dot: 'bg-emerald-500', label: '在线',  line: 'bg-emerald-300' },
  warn:    { dot: 'bg-amber-500',   label: '告警',  line: 'bg-amber-300' },
  off:     { dot: 'bg-zinc-400',    label: '离线',  line: 'bg-zinc-200' },
  loading: { dot: 'bg-sky-500 animate-pulse', label: '检测中', line: 'bg-sky-300' },
};

function DomainNode({
  domain, registry, state, onClick, portOverride,
}: {
  domain: string;
  registry?: RegistryPart;
  state: ConnectState;
  onClick: () => void;
  /** 优先级：registry.port > portOverride > DOMAIN_PORTS 默认值 */
  portOverride?: number;
}) {
  const color = DOMAIN_COLORS[domain] ?? DOMAIN_COLORS.brain;
  const style = CONNECT_STYLE[state];
  const port = registry?.port ?? portOverride ?? DOMAIN_PORTS[domain];
  return (
    <button
      type="button"
      onClick={onClick}
      className={`group w-full text-left rounded-xl border ring-1 ${color.ring} ${color.bg} p-3 hover:shadow-md transition-all`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-2.5 h-2.5 rounded-full ${style.dot}`} />
        <span className="font-semibold text-sm text-zinc-800">{DOMAIN_LABELS[domain] ?? domain}</span>
      </div>
      <div className="text-xs text-zinc-500 font-mono mb-1">
        {registry ? `${registry.host}:${registry.port}` : `(默认) 127.0.0.1:${port}`}
      </div>
      <div className="text-xs text-zinc-600 leading-snug mb-2">{DOMAIN_DESCRIPTIONS[domain]}</div>
      <div className="flex items-center justify-between text-xs">
        <span className={`px-1.5 py-0.5 rounded text-xs font-medium text-white ${style.dot}`}>
          {style.label}
        </span>
        <span className="text-zinc-400 group-hover:text-zinc-600 transition-colors">详情 →</span>
      </div>
    </button>
  );
}

function BrainCenterCard({ brainState, registryLoaded, registryCount }: {
  brainState: ConnectState; registryLoaded: boolean; registryCount: number;
}) {
  const color = DOMAIN_COLORS.brain;
  const style = CONNECT_STYLE[brainState];
  return (
    <div className={`relative rounded-2xl ring-2 ${color.ring} ${color.bg} border px-5 py-4 flex items-center gap-4`}>
      <div className={`w-14 h-14 rounded-full ${color.dot} flex items-center justify-center shadow-lg shadow-fuchsia-200/60 shrink-0`}>
        <Network className="w-7 h-7 text-white" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-bold text-lg text-zinc-800">AiSOC 大脑</h3>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${style.dot} text-white`}>{style.label}</span>
        </div>
        <div className="text-sm text-zinc-600 mt-0.5">{DOMAIN_DESCRIPTIONS.brain}</div>
        <div className="text-xs text-zinc-500 mt-1 font-mono">
          FastAPI / 127.0.0.1:{DOMAIN_PORTS.brain} · {registryLoaded ? `已注册部件 ${registryCount} 个` : '注册表加载中...'}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 任务创建表单（frontend-api.md §5 推荐结构）
// ---------------------------------------------------------------------------

function TaskCreateForm({
  taskDesc, setTaskDesc, domain, setDomain, pipeline, setPipeline,
  target, setTarget, scopeTools, setScopeTools,
  submitting, onSubmit, brainOk,
}: {
  taskDesc: string;
  setTaskDesc: (v: string) => void;
  domain: CreateTaskInput['domain'];
  setDomain: (d: CreateTaskInput['domain']) => void;
  pipeline: string;
  setPipeline: (v: string) => void;
  target: string;
  setTarget: (v: string) => void;
  scopeTools: string;
  setScopeTools: (v: string) => void;
  submitting: boolean;
  onSubmit: () => Promise<void> | void;
  brainOk: boolean | null;
}) {
  const targetPlaceholder = domain === 'logaudit'
    ? '示例：10.0.0.0/24 或 /var/log/access.log 或 host:edu.cn'
    : '示例：https://target.edu.cn 或 192.168.1.0/24 或 app.example.com';

  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold flex items-center gap-1.5">
          <Rocket className="w-4 h-4 text-fuchsia-600" />
          创建任务
        </h2>
        <span className={`text-xs px-2 py-0.5 rounded ${brainOk ? 'bg-emerald-50 text-emerald-700' : brainOk === false ? 'bg-red-50 text-red-700' : 'bg-zinc-100 text-zinc-600'}`}>
          大脑服务：{brainOk === null ? '检测中' : brainOk ? '可连通' : '未连通（可先配 target）'}
        </span>
      </div>

      <label className="block text-xs font-medium text-zinc-600 mb-1">1. 任务描述（自然语言，必填）</label>
      <textarea
        rows={2}
        className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm mb-3 focus:outline-none focus:ring-2 focus:ring-fuchsia-200 resize-none"
        value={taskDesc}
        onChange={(e) => setTaskDesc(e.target.value)}
        placeholder="例：对目标做基础侦察并输出发现 / 分析目标日志并输出发现"
      />

      <div className="grid grid-cols-2 gap-2 mb-3">
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1">2. 域 domain</label>
          <select
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-fuchsia-200"
            value={domain}
            onChange={(e) => setDomain(e.target.value as CreateTaskInput['domain'])}
          >
            <option value="logaudit">日志审计（logaudit）</option>
            <option value="pentest">渗透测试（pentest）</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1">3. 管道 pipeline</label>
          <select
            className="w-full rounded border border-zinc-300 bg-white px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-fuchsia-200"
            value={pipeline}
            onChange={(e) => setPipeline(e.target.value)}
          >
            <option value="">无（单域任务）</option>
            <option value="data_leak">data_leak（数据泄露调查：日志审计→渗透验证→判定→报告）</option>
          </select>
        </div>
      </div>

      <label className="block text-xs font-medium text-zinc-600 mb-1">4. 目标 target（IP/域名/URL — 必须在授权白名单内，否则 403）</label>
      <input
        className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm font-mono mb-3 focus:outline-none focus:ring-2 focus:ring-fuchsia-200"
        value={target}
        onChange={(e) => setTarget(e.target.value.trim())}
        placeholder={targetPlaceholder}
      />

      <div className="mb-3">
        <label className="block text-[11px] text-zinc-600 mb-0.5">工具白名单 tools（逗号分隔，留空=全部）</label>
        <input
          className="w-full rounded border border-zinc-300 px-2 py-1 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-fuchsia-200"
          value={scopeTools}
          onChange={e => setScopeTools(e.target.value)}
          placeholder="port_scan,dns_enum"
        />
      </div>

      <button
        type="button"
        onClick={() => void onSubmit()}
        disabled={submitting || !target || !taskDesc}
        className="w-full rounded-lg bg-fuchsia-600 text-white px-3 py-2 text-sm font-medium hover:bg-fuchsia-700 active:bg-fuchsia-800 disabled:bg-zinc-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        {submitting ? '正在通过大脑创建任务…' : '通过大脑下发任务'}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 任务列表 Tab
// ---------------------------------------------------------------------------

function TaskList({
  tasks, loading, selectedId, onSelect, onRefresh,
}: {
  tasks: TaskInfo[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (t: TaskInfo) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-4 py-2 border-b bg-white">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-zinc-500" />
          <span className="text-sm font-semibold">任务列表（{tasks.length}）</span>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="text-xs px-2 py-1 rounded border border-zinc-200 hover:bg-zinc-50 disabled:opacity-50 inline-flex items-center gap-1"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> 刷新
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-zinc-500 text-sm">加载任务中…</div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-zinc-500 text-sm">
            <FileSearch className="w-8 h-8 text-zinc-300" />
            还没有任何任务 — 从左侧创建一个
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-zinc-50 sticky top-0 z-10">
              <tr className="text-left text-zinc-600">
                <th className="px-3 py-2 font-medium">任务 ID</th>
                <th className="px-3 py-2 font-medium">域</th>
                <th className="px-3 py-2 font-medium">目标</th>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">判定</th>
                <th className="px-3 py-2 font-medium">更新</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map(t => {
                const stat = TASK_STATUS_META[t.status] ?? TASK_STATUS_META.pending;
                const v = t.verdict ? VERDICT_META[t.verdict] : null;
                const domainColor = DOMAIN_COLORS[t.domain] ?? DOMAIN_COLORS.brain;
                const active = selectedId === t.id;
                return (
                  <tr
                    key={t.id}
                    onClick={() => onSelect(t)}
                    className={`cursor-pointer border-b border-zinc-100 hover:bg-fuchsia-50/50 ${active ? 'bg-fuchsia-50' : ''}`}
                  >
                    <td className="px-3 py-2 font-mono text-[11px] text-zinc-700">{t.id}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${domainColor.bg} ${domainColor.ring} ring-1`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${domainColor.dot}`} />
                        {DOMAIN_LABELS[t.domain] ?? t.domain}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] max-w-[200px] truncate" title={t.target}>{t.target}</td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[11px] ${stat.cls}`}>{stat.label}</span>
                    </td>
                    <td className="px-3 py-2">
                      {v ? (
                        <span className={`px-1.5 py-0.5 rounded border text-[11px] ${v.cls}`}>{v.icon} {v.label}</span>
                      ) : (
                        <span className="text-zinc-400 text-[11px]">待判定</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-zinc-500 text-[11px] whitespace-nowrap" title={fmtTime(t.updated_at)}>{fmtAgo(t.updated_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finding 证据表 Tab 内部分
// ---------------------------------------------------------------------------

function FindingsView({ findings, loading, task }: {
  findings: Finding[];
  loading: boolean;
  task: TaskInfo | null;
}) {
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2 border-b bg-white flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-zinc-500" />
          <span className="text-sm font-semibold">
            证据 Findings {task && <span className="text-xs text-zinc-500 font-normal"> · {task.id}</span>}
          </span>
          {findings.length > 0 && <span className="text-xs text-zinc-500">（{findings.length} 条）</span>}
        </div>
        {findings.length > 0 && (
          <div className="flex gap-1 text-[11px]">
            {(['critical','high','medium','low','info'] as const).map(s => {
              const count = findings.filter(f => f.severity === s).length;
              if (count === 0) return null;
              const meta = SEVERITY_META[s];
              return (
                <span key={s} className={`px-1.5 py-0.5 rounded border ${meta.cls}`}>{meta.label} {count}</span>
              );
            })}
          </div>
        )}
      </div>
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-28 text-sm text-zinc-500">加载证据中…</div>
        ) : findings.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-28 text-sm text-zinc-500 gap-1">
            <ShieldCheck className="w-7 h-7 text-zinc-300" />
            暂无证据 — 选中一个已运行任务即可查看 Finding
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-zinc-50 sticky top-0 z-10">
              <tr className="text-left text-zinc-600">
                <th className="px-3 py-2 font-medium">ID</th>
                <th className="px-3 py-2 font-medium">级别</th>
                <th className="px-3 py-2 font-medium">部件</th>
                <th className="px-3 py-2 font-medium">工具</th>
                <th className="px-3 py-2 font-medium">标题</th>
                <th className="px-3 py-2 font-medium">CVE / CVSS</th>
                <th className="px-3 py-2 font-medium">置信度</th>
                <th className="px-3 py-2 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              {findings.map(f => {
                const sev = SEVERITY_META[f.severity] ?? SEVERITY_META.info;
                const dc = DOMAIN_COLORS[f.domain] ?? DOMAIN_COLORS.brain;
                const fts = f.ts ?? f.timestamp ?? '';
                return (
                  <tr key={f.id} className="border-b border-zinc-100 hover:bg-zinc-50">
                    <td className="px-3 py-2 font-mono text-[11px] text-zinc-600">{f.id}</td>
                    <td className="px-3 py-2"><span className={`px-1.5 py-0.5 rounded border text-[11px] ${sev.cls}`}>{sev.label}</span></td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${dc.bg} ${dc.ring} ring-1`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${dc.dot}`} />
                        {DOMAIN_LABELS[f.domain] ?? f.domain}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">{f.tool}</td>
                    <td className="px-3 py-2 max-w-[260px]">
                      <div className="font-medium text-zinc-800">{f.title}</div>
                      {f.description && <div className="text-[11px] text-zinc-500 leading-snug line-clamp-2">{f.description}</div>}
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px]">
                      <div>{f.cve ?? '—'}</div>
                      {f.cvss !== undefined && f.cvss !== null && (
                        <div className="text-zinc-500">CVSS {f.cvss.toFixed ? f.cvss.toFixed(1) : f.cvss}</div>
                      )}
                      {f.cwe && <div className="text-zinc-500">{f.cwe}</div>}
                    </td>
                    <td className="px-3 py-2 text-[11px]">
                      {typeof f.confidence === 'number' ? (
                        <div className="flex items-center gap-1">
                          <div className="w-12 h-1.5 bg-zinc-100 rounded">
                            <div className="h-full rounded bg-fuchsia-500" style={{ width: `${Math.round(f.confidence * 100)}%` }} />
                          </div>
                          <span className="font-mono text-zinc-600">{Math.round(f.confidence * 100)}%</span>
                        </div>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 text-[11px] text-zinc-500 whitespace-nowrap" title={fmtTime(fts)}>
                      {fmtAgo(fts)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 判定 + 报告卡（frontend-api.md §4.2 / §4.4 / §4.5）
// ---------------------------------------------------------------------------

function VerdictReportCard({ detail, report, loading, task, onExport }: {
  detail: TaskDetail | null;
  report: ReportDoc | null;
  loading: boolean;
  task: TaskInfo | null;
  onExport: () => void;
}) {
  const verdict = detail?.verdict ?? null;
  const v = verdict ? VERDICT_META[verdict] : null;
  const confidence = detail?.confidence ?? task?.confidence;
  const stages = detail?.stages ?? [];
  const thoughtChain = detail?.thought_chain ?? [];

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2 border-b bg-white flex items-center gap-2">
        <Layers className="w-4 h-4 text-zinc-500" />
        <span className="text-sm font-semibold">大脑判定 & 报告</span>
        {task && <span className="text-xs text-zinc-500"> · {task.id}</span>}
        <div className="flex-1" />
        {task && (
          <button
            type="button"
            onClick={onExport}
            className="text-[11px] px-2 py-1 rounded border border-zinc-200 hover:bg-zinc-50 inline-flex items-center gap-1"
            title="导出审计 JSON（任务 + findings + ledger + report）"
          >
            <Download className="w-3 h-3" /> 导出审计 JSON
          </button>
        )}
      </div>
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center h-24 text-sm text-zinc-500">加载判定 / 报告中…</div>
        ) : !task ? (
          <div className="flex flex-col items-center justify-center h-24 text-sm text-zinc-500 gap-1">
            <FileText className="w-7 h-7 text-zinc-300" />
            先在"任务列表"里选中一个任务
          </div>
        ) : (
          <>
            {/* Verdict 卡（文档 §4.2） */}
            {v ? (
              <div className={`rounded-xl border p-4 ${v.cls}`}>
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="text-xs uppercase tracking-wider opacity-70">威胁判定</div>
                    <div className="text-2xl font-bold mt-0.5">{v.icon} {v.label}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs opacity-70">综合置信度</div>
                    <div className="text-xl font-bold">{typeof confidence === 'number' ? `${Math.round(confidence * 100)}%` : '—'}</div>
                  </div>
                </div>
                <div className="text-xs opacity-80 mt-1">
                  当前阶段：{detail?.current_stage ?? '—'}
                  {detail?.error && <span className="ml-2 text-red-700">错误：{detail.error}</span>}
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-4 text-xs text-zinc-500 flex items-center gap-2">
                <Gavel className="w-4 h-4 text-zinc-300" />
                任务尚未完成判定 — 完成或运行中会在此展示 verdict / confidence。
              </div>
            )}

            {/* 阶段进度（文档 §4.2 stages） */}
            {stages.length > 0 && (
              <div className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="text-xs font-semibold text-zinc-700 mb-2">阶段进度</div>
                <div className="space-y-1.5">
                  {stages.map(st => {
                    const m = TASK_STATUS_META[st.status] ?? TASK_STATUS_META.pending;
                    return (
                      <div key={st.id} className="flex items-center gap-2 text-xs">
                        <span className={`px-1.5 py-0.5 rounded ${m.cls}`}>{m.label}</span>
                        <span className="font-medium text-zinc-700 w-20">{STAGE_LABELS[st.stage] ?? st.stage}</span>
                        <span className="text-zinc-500 font-mono">finding×{st.findings_count}</span>
                        {st.started_at && <span className="text-zinc-400 whitespace-nowrap" title={fmtTime(st.started_at)}>{fmtAgo(st.started_at)}</span>}
                        {st.error && <span className="text-red-600 truncate" title={st.error}>{st.error}</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 思维链 / 审计轨迹（文档 §4.2 thought_chain） */}
            {thoughtChain.length > 0 && (
              <div className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="text-xs font-semibold text-zinc-700 mb-2">思维链 / 审计轨迹</div>
                <div className="space-y-1 max-h-40 overflow-auto">
                  {thoughtChain.map(entry => (
                    <div key={entry.id} className="flex gap-2 text-[11px]">
                      <span className="font-mono text-zinc-400 shrink-0">{fmtTime(entry.ts)}</span>
                      <span className="font-medium text-fuchsia-700 shrink-0">{entry.actor}</span>
                      <span className="text-zinc-600 break-all">{entry.action}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 报告卡（文档 §4.4：Markdown 字符串） */}
            {report ? (
              <div className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <FileText className="w-4 h-4 text-fuchsia-600" />
                    <span className="font-semibold">综合报告（Markdown）</span>
                  </div>
                </div>
                <div className="text-sm leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{report.report}</ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-4 text-xs text-zinc-500 flex items-center gap-2">
                <FileText className="w-4 h-4 text-zinc-300" />
                任务未完成或大脑尚未产出报告 — 完成后会自动填充。
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 主组件
// ---------------------------------------------------------------------------

export function AisocDashboard({ onExit }: { onExit?: () => void }) {
  // 挂载守卫：防止异步请求在组件卸载 / StrictMode 双重挂载窗口内 resolve 后
  // 触发 setState，导致 React commit 阶段 removeChild 冲突（React 19 经典报错）。
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ---- 基础设施状态 ----
  const [brainState, setBrainState] = useState<boolean | null>(null);
  const [registry, setRegistry] = useState<RegistryPart[] | null>(null);
  const [registryLoading, setRegistryLoading] = useState(false);
  // 大脑 /api/agents/status 里的 services（应急响应 TIR 是独立 REST 服务，端口 8090，不归 reasonix 部件注册表管）
  const [agentsStatus, setAgentsStatus] = useState<AgentsStatus | null>(null);

  const healthCheck = useCallback(async () => {
    try {
      const r = await aisocApi.healthCheck();
      if (mountedRef.current) setBrainState(r.status === 'ok');
    } catch {
      if (mountedRef.current) setBrainState(false);
    }
    if (!mountedRef.current) return;
    setRegistryLoading(true);
    try {
      const reg = await aisocApi.getRegistry();
      if (mountedRef.current) setRegistry(reg);
    } catch {
      if (mountedRef.current) setRegistry(null);
    } finally {
      if (mountedRef.current) setRegistryLoading(false);
    }
    try {
      const st = await aisocApi.getAgentsStatus();
      if (mountedRef.current) setAgentsStatus(st);
    } catch {
      if (mountedRef.current) setAgentsStatus(null);
    }
  }, []);
  useEffect(() => { void healthCheck(); }, [healthCheck]);

  // ---- 任务创建表单状态（文档 §4.1 / §5） ----
  const [taskDesc, setTaskDesc] = useState('');
  const [domain, setDomain] = useState<CreateTaskInput['domain']>('logaudit');
  const [pipeline, setPipeline] = useState('');
  const [target, setTarget] = useState('');
  const [scopeTools, setScopeTools] = useState('');
  const [creating, setCreating] = useState(false);
  const [createHint, setCreateHint] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // ---- 任务列表 ----
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [selectedTask, setSelectedTask] = useState<TaskInfo | null>(null);

  const loadTasks = useCallback(async () => {
    if (mountedRef.current) setTasksLoading(true);
    try {
      const r = await aisocApi.listTasks(100);
      if (mountedRef.current) setTasks(r.tasks.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? '')));
    } catch {
      if (mountedRef.current) setTasks([]);
    } finally {
      if (mountedRef.current) setTasksLoading(false);
    }
  }, []);
  useEffect(() => { void loadTasks(); }, [loadTasks]);

  // ---- 选中任务详情：Finding / Detail / Report ----
  const [findings, setFindings] = useState<Finding[]>([]);
  const [findingsLoading, setFindingsLoading] = useState(false);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [report, setReport] = useState<ReportDoc | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const loadDetail = useCallback(async (taskId: string) => {
    if (mountedRef.current) setDetailLoading(true);
    if (mountedRef.current) setFindingsLoading(true);
    try {
      const [fs, dt, rp] = await Promise.all([
        aisocApi.getFindings(taskId).catch(() => [] as Finding[]),
        aisocApi.getTask(taskId).catch(() => null),
        aisocApi.getReport(taskId).catch(() => null),
      ]);
      if (mountedRef.current) {
        setFindings(fs.sort((a, b) => (b.ts ?? b.timestamp ?? '').localeCompare(a.ts ?? a.timestamp ?? '')));
        setDetail(dt);
        setReport(rp);
      }
    } finally {
      if (mountedRef.current) {
        setFindingsLoading(false);
        setDetailLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedTask) { setFindings([]); setDetail(null); setReport(null); return; }
    void loadDetail(selectedTask.id);
  }, [selectedTask, loadDetail]);

  // 每 8s 轮询一次（SSE 面板走 EventSource；任务详情这里兜底）。
  // 用 ref 持有当前选中任务，interval 只创建一次，避免选中切换时 teardown/recreate 造成的竞态。
  const pollRef = useRef<number | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => { selectedIdRef.current = selectedTask?.id ?? null; }, [selectedTask]);
  useEffect(() => {
    pollRef.current = window.setInterval(() => {
      void loadTasks();
      if (selectedIdRef.current) void loadDetail(selectedIdRef.current);
    }, 8000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [loadTasks, loadDetail]);

  // ---- 创建任务：单 POST /api/tasks（文档 §4.1） ----
  const submitTask = useCallback(async () => {
    if (!target || !taskDesc) return;
    setCreating(true);
    setCreateHint(null);
    try {
      const res = await aisocApi.createTask({
        task: taskDesc,
        domain,
        target,
        pipeline: pipeline || undefined,
        tools: scopeTools ? scopeTools.split(',').map(x => x.trim()).filter(Boolean) : undefined,
      });
      setCreateHint({
        kind: 'ok',
        text: `任务已下发（ID：${res.task_id}），大脑开始编排 → 已转至任务列表`,
      });
      setTaskDesc('');
      setScopeTools('');
      await loadTasks();
      // 自动高亮刚创建的任务
      const pick = tasks.find(t => t.id === res.task_id) ?? null;
      if (pick) setSelectedTask(pick);
      // 切到任务 Tab
      setRightTab('tasks');
    } catch (e) {
      setCreateHint({
        kind: 'err',
        text: `创建失败：${e instanceof Error ? e.message : String(e)}。检查大脑是否在 :${DOMAIN_PORTS.brain} 监听，或是否命中授权白名单。`,
      });
    } finally {
      setCreating(false);
    }
  }, [target, taskDesc, domain, pipeline, scopeTools, loadTasks, tasks]);

  // ---- 审计导出：GET /api/tasks/{id}/export（文档 §4.5） ----
  const exportTask = useCallback(async (taskId: string) => {
    try {
      const data = await aisocApi.exportTask(taskId);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aisoc-audit-${taskId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setCreateHint({ kind: 'err', text: `导出失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }, []);

  // ---- UI：右侧主 Tab ----
  const [rightTab, setRightTab] = useState<'tasks' | 'realtime' | 'detail'>('tasks');

  // ---- 计算：部件连接灯（注册表数组查找；应急响应 incident 走 /api/agents/status 的 services.tir） ----
  const domainStates: Record<string, ConnectState> = useMemo(() => {
    const out: Record<string, ConnectState> = {};
    for (const d of ALL_DOMAINS) {
      if (d === 'incident') {
        // 应急响应 TIR 是独立 REST 服务（:8090），状态以大脑 services.tir 为准，不进 reasonix 注册表
        const tir = agentsStatus?.services?.tir;
        if (!agentsStatus) out[d] = brainState === null ? 'loading' : (brainState ? 'off' : 'warn');
        else if (!tir) out[d] = 'off';
        else if (tir.status === 'online') out[d] = brainState ? 'ok' : 'warn';
        else if (tir.status === 'starting') out[d] = 'loading';
        else out[d] = 'off';
        continue;
      }
      if (registryLoading) out[d] = 'loading';
      else if (!registry) out[d] = brainState === null ? 'loading' : 'off';
      else if (registry.find(r => r.domain === d)) out[d] = brainState ? 'ok' : 'warn';
      else out[d] = 'off';
    }
    return out;
  }, [registry, registryLoading, brainState, agentsStatus]);

  const brainConnectState = stateFromHealth(brainState, registryLoading);

  return (
    <div className="aisoc-shell h-full w-full min-h-0 flex flex-col" style={{ fontFamily: 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' }}>
      {/* 顶栏 */}
      <header className="px-4 py-2 border-b aisoc-header text-white flex items-center gap-3">
        {onExit && (
          <button
            type="button"
            onClick={onExit}
            className="text-xs px-2 py-1 rounded bg-white/15 hover:bg-white/25 transition-colors inline-flex items-center gap-1 shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> 返回聊天
          </button>
        )}
        <div className="w-7 h-7 rounded-full bg-white/20 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4" />
        </div>
        <div>
          <div className="text-sm font-bold">校园智盾 AiSOC · 多 Agent 安全运营平台</div>
          <div className="text-[11px] opacity-80">DeepSeek 作动力源 · 大脑 FastAPI :{DOMAIN_PORTS.brain} 编排 · 统一 CreateTask / TaskInfo / Finding / Report 协议</div>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void healthCheck()}
          className="text-xs px-2 py-1 rounded bg-white/15 hover:bg-white/25 transition-colors inline-flex items-center gap-1"
        >
          <RefreshCw className="w-3 h-3" /> 健康检查
        </button>
        <button
          type="button"
          onClick={() => void loadTasks()}
          className="text-xs px-2 py-1 rounded bg-white/15 hover:bg-white/25 transition-colors inline-flex items-center gap-1"
        >
          <Zap className="w-3 h-3" /> 刷新任务
        </button>
      </header>

      {/* 大脑离线提示：优雅降级，不再暴露原始 502 */}
      {brainState === false && (
        <div className="mx-3 mt-3 px-3 py-2 rounded-lg border border-amber-300 bg-amber-50 text-amber-800 text-xs flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>
            大脑服务未运行（127.0.0.1:{DOMAIN_PORTS.brain}）。当前为离线预览模式：任务创建与实时监控暂不可用，请先启动大脑 FastAPI 服务后再试。
          </span>
        </div>
      )}

      {/* 主体两列 */}
      <div className="flex-1 min-h-0 grid grid-cols-12 gap-3 p-3">
        {/* 左列（架构 + 表单） */}
        <div className="col-span-4 min-h-0 flex flex-col gap-3 overflow-hidden">
          {/* 大脑中心卡 */}
          <BrainCenterCard
            brainState={brainConnectState}
            registryLoaded={registry !== null}
            registryCount={registry ? registry.length : 0}
          />

          {/* 子部件状态：2 列（上面渗透+审计，下面情报+应急） */}
          <div className="grid grid-cols-2 gap-2">
            {ALL_DOMAINS.map(d => (
              <DomainNode
                key={d}
                domain={d}
                registry={registry?.find(r => r.domain === d)}
                portOverride={d === 'incident' ? agentsStatus?.services?.tir?.port : undefined}
                state={domainStates[d] ?? 'off'}
                onClick={() => {
                  // 点击部件域 → 预填 domain（只有 pentest / logaudit 是大脑可直跑的单域）
                  if (d === 'pentest' || d === 'logaudit') {
                    setDomain(d);
                    setPipeline('');
                  }
                  setTarget(t => t || (d === 'logaudit' ? '10.0.0.0/24' : 'https://target.edu.cn'));
                }}
              />
            ))}
          </div>

          {/* 任务创建表单 */}
          <TaskCreateForm
            taskDesc={taskDesc}
            setTaskDesc={setTaskDesc}
            domain={domain}
            setDomain={setDomain}
            pipeline={pipeline}
            setPipeline={setPipeline}
            target={target}
            setTarget={setTarget}
            scopeTools={scopeTools}
            setScopeTools={setScopeTools}
            submitting={creating}
            onSubmit={submitTask}
            brainOk={brainState}
          />

          {createHint && (
            <div className={`rounded-lg border px-3 py-2 text-xs flex items-start gap-2 ${
              createHint.kind === 'ok' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 'bg-red-50 text-red-800 border-red-200'
            }`}>
              {createHint.kind === 'ok' ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />}
              <span>{createHint.text}</span>
            </div>
          )}

          {/* 星型拓扑示意（文本型） */}
          <div className="rounded-xl border border-dashed border-fuchsia-200 bg-fuchsia-50/40 p-3 text-[11px] text-zinc-600 leading-relaxed">
            <div className="font-semibold text-zinc-700 mb-1 flex items-center gap-1">
              <Network className="w-3.5 h-3.5" />
              架构提醒（星型拓扑）
            </div>
            <p>前端不直接访问子部件。<strong className="text-fuchsia-700">所有任务 → AiSOC 大脑 :{DOMAIN_PORTS.brain}</strong>（统一白名单校验 / 证据入库 / 交叉验证 / 判定 / 报告 / SSE / 思维链审计）。大脑再按阶段调度各部件端口（{DOMAIN_PORTS.pentest} / {DOMAIN_PORTS.logaudit} / …）。用户永远只和大脑交互。</p>
          </div>
        </div>

        {/* 右列：Tab 切换（任务列表 / 实时面板 / 详情） */}
        <div className="col-span-8 min-h-0 flex flex-col border border-zinc-200 rounded-xl bg-white overflow-hidden">
          <div className="flex items-center gap-1 px-2 py-1.5 border-b bg-zinc-50">
            <button
              type="button"
              onClick={() => setRightTab('tasks')}
              className={`px-3 py-1 text-xs font-medium rounded-t flex items-center gap-1 transition-colors ${
                rightTab === 'tasks' ? 'bg-white text-fuchsia-700 ring-1 ring-fuchsia-200' : 'text-zinc-600 hover:text-zinc-800 hover:bg-white'
              }`}
            >
              <Database className="w-3.5 h-3.5" /> 任务列表
            </button>
            <button
              type="button"
              onClick={() => setRightTab('realtime')}
              className={`px-3 py-1 text-xs font-medium rounded-t flex items-center gap-1 transition-colors ${
                rightTab === 'realtime' ? 'bg-white text-fuchsia-700 ring-1 ring-fuchsia-200' : 'text-zinc-600 hover:text-zinc-800 hover:bg-white'
              }`}
            >
              <Activity className="w-3.5 h-3.5" /> 实时 SSE 面板
            </button>
            <button
              type="button"
              onClick={() => setRightTab('detail')}
              className={`px-3 py-1 text-xs font-medium rounded-t flex items-center gap-1 transition-colors ${
                rightTab === 'detail' ? 'bg-white text-fuchsia-700 ring-1 ring-fuchsia-200' : 'text-zinc-600 hover:text-zinc-800 hover:bg-white'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" /> 证据 & 判定 & 报告
              {selectedTask && <span className="ml-1 font-mono text-[10px] text-zinc-500">{selectedTask.id}</span>}
            </button>
            <div className="flex-1" />
            {selectedTask && (
              <div className="text-[11px] text-zinc-500 flex items-center gap-1 mr-2">
                当前选中：<ChevronRight className="w-3 h-3" /> {selectedTask.id}
                <span className={`ml-1 px-1.5 py-0.5 rounded ${TASK_STATUS_META[selectedTask.status]?.cls ?? ''}`}>
                  {TASK_STATUS_META[selectedTask.status]?.label ?? selectedTask.status}
                </span>
              </div>
            )}
          </div>

          <div className="flex-1 min-h-0">
            {rightTab === 'tasks' && (
              <TaskList
                tasks={tasks}
                loading={tasksLoading}
                selectedId={selectedTask?.id ?? null}
                onSelect={setSelectedTask}
                onRefresh={() => void loadTasks()}
              />
            )}
            {rightTab === 'realtime' && (
              <div className="h-full min-h-0">
                <RealtimePanel
                  autoConnect={brainState !== false}
                  onTaskClick={(taskId) => {
                    const t = tasks.find(x => x.id === taskId) ?? null;
                    if (t) setSelectedTask(t);
                    setRightTab('detail');
                  }}
                />
              </div>
            )}
            {rightTab === 'detail' && (
              <div className="h-full min-h-0 grid grid-rows-2 gap-0">
                <div className="min-h-0 border-b">
                  <FindingsView findings={findings} loading={findingsLoading} task={selectedTask} />
                </div>
                <div className="min-h-0">
                  <VerdictReportCard
                    detail={detail}
                    report={report}
                    loading={detailLoading}
                    task={selectedTask}
                    onExport={() => { if (selectedTask) void exportTask(selectedTask.id); }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底栏状态条 */}
      <footer className="px-4 py-1.5 border-t bg-white text-[11px] text-zinc-500 flex items-center gap-3 flex-wrap">
        <span>统一接口：POST /api/tasks · GET /api/tasks · /findings · /reports · /stream（frontend-api.md）</span>
        <span>·</span>
        <span>状态机：pending → running → approval → completed / failed</span>
        <span>·</span>
        <span>报告为 Markdown · 审计可导出 JSON · token 脱敏不渲染</span>
      </footer>
    </div>
  );
}

export default AisocDashboard;
