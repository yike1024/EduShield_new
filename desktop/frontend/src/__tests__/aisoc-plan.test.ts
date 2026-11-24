// Run: tsx src/__tests__/aisoc-plan.test.ts
// 阶段 D 计划视图 reducer（src/lib/aisocPlan.ts）回归测试。
//
// 数据来源：
// - GET /api/tasks/{id} 的 plan（plans 表 + plan_steps 表，权威快照）
// - SSE plan_created / plan_step / completion_check / plan_finished（增量）
// 关键约束：plan_created.steps 后端恒为 []，不能用它清空已收到的步骤；
// plan_step 按 seq upsert；字段缺失不覆盖已有值。

import { applyPlanEvent, normalizePlan } from "../lib/aisocPlan";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.error(`  ❌ ${label}`); }
}

console.log("\naisoc plan — 计划快照 + plan_* 增量合并");

ok(normalizePlan(null) === null, "无计划（legacy / 单域直派）返回 null");

const fromDetail = normalizePlan({
  plan_id: "plan-abc12345",
  goal: "发现并验证数据泄露",
  status: "running",
  steps: [
    { seq: 2, action: "dispatch", domain: "pentest", status: "pending" },
    { seq: 1, action: "dispatch", domain: "logaudit", status: "done" },
  ],
});
ok(fromDetail?.steps.length === 2 && fromDetail.steps[0].seq === 1, "详情快照按 seq 升序");

// plan_created（后端 steps 恒为 []）不得清空已有步骤
let plan = applyPlanEvent(null, "plan_created", { plan_id: "plan-abc12345", goal: "g", steps: [] });
ok(plan?.planId === "plan-abc12345" && plan.steps.length === 0, "plan_created 建立空计划");
plan = applyPlanEvent(plan, "plan_step", { seq: 1, action: "dispatch", domain: "logaudit", status: "running", task_id: "T-sub-1" });
ok(plan?.steps.length === 1 && plan.steps[0].status === "running", "plan_step 首帧建立步骤");
plan = applyPlanEvent(plan, "plan_created", { plan_id: "plan-abc12345", goal: "g", steps: [] });
ok(plan?.steps.length === 1, "二次 plan_created（steps=[]）不清空已有步骤");

// 同 seq 状态变化就地更新，不新增
plan = applyPlanEvent(plan, "plan_step", { seq: 1, action: "dispatch", domain: "logaudit", status: "done", task_id: "T-sub-1" });
ok(plan?.steps.length === 1 && plan.steps[0].status === "done", "同 seq 的 plan_step 就地更新");

// 部分字段缺失不覆盖旧值
plan = applyPlanEvent(plan, "plan_step", { seq: 1, status: "failed" });
ok(plan?.steps[0].action === "dispatch" && plan?.steps[0].domain === "logaudit"
  && plan?.steps[0].status === "failed", "plan_step 缺字段时不覆盖已有 action/domain");

// 后续步骤按 seq 排序
plan = applyPlanEvent(plan, "plan_step", { seq: 3, action: "finish", status: "running" });
plan = applyPlanEvent(plan, "plan_step", { seq: 2, action: "ask", status: "running" });
ok(plan?.steps.map(s => s.seq).join(",") === "1,2,3", "步骤按 seq 升序排列");

// 完成判定
plan = applyPlanEvent(plan, "completion_check", { done: false, reason: "证据不足", missing: ["finding"], confidence: 0.4 });
ok(plan?.judge?.done === false && plan?.judge?.missing?.[0] === "finding", "completion_check 写入 judge");
ok(plan?.judge?.confidence === 0.4, "completion_check 保留 confidence");

// 计划结束
plan = applyPlanEvent(plan, "plan_finished", { plan_id: "plan-abc12345", verdict: "pending_review" });
ok(plan?.status === "finished" && plan?.verdict === "pending_review", "plan_finished 置 finished + verdict");
ok(plan?.steps.length === 3, "plan_finished 不清空步骤");

// 容错
const before = plan;
ok(applyPlanEvent(before, "plan_step", undefined) === before, "缺 payload 原样返回");
ok(applyPlanEvent(before, "plan_step", { action: "dispatch" }) === before, "缺 seq 的 plan_step 被忽略");
ok(applyPlanEvent(before, "unknown_kind", { seq: 9 }) === before, "未识别 kind 原样返回");

console.log(`\n结果: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
