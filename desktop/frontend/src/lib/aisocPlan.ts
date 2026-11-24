/**
 * 自主编排计划视图（阶段 D，契约 §2.7 / §3.2 plan_* 帧）
 *
 * 数据来源有两份，前端合并展示：
 * 1. `GET /api/tasks/{id}` 的 `plan`（plans + plan_steps，权威快照，刷新/重连后恢复）；
 * 2. SSE `plan_created` / `plan_step` / `completion_check` / `plan_finished`（实时增量）。
 *
 * 纯函数、只读：前端不允许修改计划（02 文档 §10）。所有字段按可选读取，
 * 后端缺字段时不抛错、不猜值（契约 §3.3）。
 */
import type { PlanInfo, PlanStep } from './aisoc-api';

/** 完成判定（completion_check payload） */
export interface PlanJudge {
  done?: boolean;
  reason?: string;
  missing?: string[];
  confidence?: number;
}

/** 计划视图（前端只读模型） */
export interface PlanView {
  planId: string;
  goal: string;
  status: 'running' | 'finished' | 'failed' | '';
  verdict?: string;
  reason?: string;
  judge?: PlanJudge;
  steps: PlanStep[];
}

const PLAN_EVENT_KINDS = new Set(['plan_created', 'plan_step', 'completion_check', 'plan_finished']);

export function isPlanEventKind(kind: string): boolean {
  return PLAN_EVENT_KINDS.has(kind);
}

/** 任务详情里的 plan（plans 表 + steps[]）→ 前端视图；无计划返回 null */
export function normalizePlan(plan: PlanInfo | null | undefined): PlanView | null {
  if (!plan || typeof plan.plan_id !== 'string' || !plan.plan_id) return null;
  const steps = Array.isArray(plan.steps)
    ? [...plan.steps].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    : [];
  return {
    planId: plan.plan_id,
    goal: typeof plan.goal === 'string' ? plan.goal : '',
    status: (plan.status as PlanView['status']) ?? 'running',
    verdict: typeof plan.verdict === 'string' && plan.verdict ? plan.verdict : undefined,
    steps,
  };
}

/**
 * 增量合并一帧 plan 事件。
 * - 不认识 / 缺关键字段的帧原样返回 current（不制造幽灵计划）；
 * - `plan_created.steps` 后端目前恒为 []，不得用它清空已有步骤；
 * - `plan_step` 按 seq upsert，同一步骤的状态变化就地更新。
 */
export function applyPlanEvent(
  current: PlanView | null,
  kind: string,
  payload: Record<string, unknown> | undefined,
): PlanView | null {
  if (!payload) return current;
  const p = payload;

  if (kind === 'plan_created') {
    const planId = typeof p.plan_id === 'string' ? p.plan_id : current?.planId ?? '';
    if (!planId) return current;
    const incoming = Array.isArray(p.steps) ? (p.steps as PlanStep[]) : [];
    // 后端 plan_created 的 steps 目前是空数组：只有非空时才覆盖（防止把 plan_step 增量清掉）
    const steps = incoming.length > 0
      ? [...incoming].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      : (current?.steps ?? []);
    return {
      planId,
      goal: typeof p.goal === 'string' ? p.goal : (current?.goal ?? ''),
      status: 'running',
      verdict: current?.verdict,
      reason: current?.reason,
      judge: current?.judge,
      steps,
    };
  }

  if (kind === 'plan_step') {
    const seq = typeof p.seq === 'number' ? p.seq : undefined;
    if (seq == null) return current;
    const base: PlanView = current ?? { planId: '', goal: '', status: 'running', steps: [] };
    const idx = base.steps.findIndex((s) => s.seq === seq);
    const incoming: PlanStep = {
      seq,
      action: typeof p.action === 'string' ? p.action : undefined,
      domain: typeof p.domain === 'string' ? p.domain : undefined,
      status: typeof p.status === 'string' ? p.status : undefined,
      task_id: typeof p.task_id === 'string' ? p.task_id : undefined,
    };
    const steps = [...base.steps];
    if (idx >= 0) {
      const prev = steps[idx];
      // 空字段不覆盖已有值（plan_step 首帧只带部分字段）
      steps[idx] = {
        ...prev,
        seq,
        action: incoming.action ?? prev.action,
        domain: incoming.domain ?? prev.domain,
        status: incoming.status ?? prev.status,
        task_id: incoming.task_id ?? prev.task_id,
      };
    } else {
      steps.push(incoming);
    }
    steps.sort((a, b) => a.seq - b.seq);
    return { ...base, steps };
  }

  if (kind === 'completion_check') {
    const base: PlanView = current ?? { planId: '', goal: '', status: 'running', steps: [] };
    const judge: PlanJudge = {
      done: typeof p.done === 'boolean' ? p.done : undefined,
      reason: typeof p.reason === 'string' ? p.reason : undefined,
      missing: Array.isArray(p.missing)
        ? p.missing.filter((m): m is string => typeof m === 'string')
        : undefined,
      confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
    };
    return { ...base, judge };
  }

  if (kind !== 'plan_finished') return current; // 未识别 kind：不制造计划

  // plan_finished
  const planId = typeof p.plan_id === 'string' ? p.plan_id : current?.planId ?? '';
  const base: PlanView = current ?? { planId, goal: '', status: 'running', steps: [] };
  return {
    ...base,
    planId: planId || base.planId,
    status: 'finished',
    verdict: typeof p.verdict === 'string' ? p.verdict : base.verdict,
  };
}
