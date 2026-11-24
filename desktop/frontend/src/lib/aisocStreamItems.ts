import type { Item } from "./useController";
import type { WireEvent } from "./types";

/** 判定工具是否为 shell/bash 类（控制 ToolCard 默认展开与渲染方式）。 */
const SHELL_TOOLS = new Set(["bash", "bash_output", "wait", "waitJob", "kill_shell"]);
function isShellTool(name: string | undefined): boolean {
  return !!name && SHELL_TOOLS.has(name);
}

/**
 * AisocDashboard.applyWireEvent 的 items 级 reducer（纯函数，便于单测）。
 *
 * 从 components/AisocDashboard.tsx 提取，行为保持一致：
 * - 每个被消费的 case 都会产生一次版本更新（由调用方 bump）；
 * - 未识别的 kind（default）返回 null，调用方应保持原 state 不变（不 bump）。
 * - items 必须是拷贝后传入（函数内部不会再拷贝，直接操作）。
 *
 * 关于"answer 帧增量+全量"的去重说明（2026-09-03 实测）：
 * reasonix 输出一段文字时会先发 N 个增量帧、再发 1 帧全量帧（全量 = N 帧拼接）。
 * 曾在 webApiProxy 用"上一帧 text 完全相同则跳过"的 Map 去重，抓流证实增量帧与
 * 全量帧必然不同（全量 = 增量拼接），该条件永不触发，属死代码已移除。
 * answer 帧在本 reducer 是覆盖式：case 'message' 只更新最后一条 assistant 的 text
 * （`{ ...last, text }`），文本不会累积，最终只保留全量帧的完整结论。
 * 真正会"同一句出现两次"的是 tool_result.output 与 assistant.text 相同内容，
 * 由 case 'tool_result' / case 'message' 的双向倒查清理（见下方 v2 注释）。
 */
export function applyStreamEvent(items: Item[], ev: WireEvent, taskId: string): Item[] | null {
  switch (ev.kind) {
    case "text": {
      const lastIdx = items.length - 1;
      const last = items[lastIdx];
      if (last && last.kind === "assistant" && last.streaming) {
        items[lastIdx] = { ...last, text: last.text + (ev.text ?? "") };
      } else {
        items.push({
          kind: "assistant",
          id: `assistant-${taskId}-${Date.now()}`,
          text: ev.text ?? "",
          reasoning: "",
          streaming: true,
        });
      }
      return items;
    }
    case "reasoning": {
      const lastIdx = items.length - 1;
      const last = items[lastIdx];
      if (last && last.kind === "assistant" && last.streaming) {
        items[lastIdx] = { ...last, reasoning: ev.reasoning ?? "" };
      }
      return items;
    }
    case "tool_dispatch": {
      const t = ev.tool;
      if (t) {
        // 透传模式下同一工具调用会按相同 id 推送多个 dispatch 帧（抓流实证）：
        //   partial（仅 name，无 args）→ full（含 args）→ 偶发 refreshed（再次含 args）。
        // 必须按 id upsert 合并为同一张卡；直接 push 会产生重复卡片，
        // 且 partial 那张永远停留在空 args / running，表现为"一个 {} 空卡"。
        const id = t.id || `tool-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const idx = t.id ? items.findIndex((i) => i.kind === "tool" && i.id === t.id) : -1;
        const incomingArgs = typeof t.args === "string" ? t.args : t.args == null ? "" : (() => {
          try { return JSON.stringify(t.args); } catch { return String(t.args); }
        })();
        const incomingName = t.name || "unknown";
        if (idx >= 0) {
          const existing = items[idx];
          if (existing.kind === "tool") {
            items[idx] = {
              ...existing,
              // 空 name / 空 args 的早到帧不覆盖已有内容
              name: t.name ? incomingName : existing.name,
              args: incomingArgs || existing.args,
              readOnly: t.readOnly ?? existing.readOnly,
              isShell: existing.isShell || isShellTool(t.name),
              argChars: t.argChars && t.argChars > 0 ? t.argChars : existing.argChars,
            };
          }
        } else {
          items.push({
            kind: "tool",
            id,
            name: incomingName,
            args: incomingArgs,
            readOnly: t.readOnly ?? false,
            status: "running",
            isShell: isShellTool(t.name),
            argChars: t.argChars && t.argChars > 0 ? t.argChars : undefined,
          });
        }
      }
      return items;
    }
    case "tool_result": {
      const t = ev.tool;
      if (!t) return items;
      // 修复【bash 输出空白】：原代码 `if (t && t.id)` 在 id 缺失时直接丢弃整条 tool_result。
      // webApiProxy 在 task_id 缺失或无匹配 tool_call 时会发出 id=undefined 的 tool_result。
      // 现在改为：先按 id 精确匹配，再按"同名 + running 状态"兜底匹配，确保输出永不丢失。
      let idx = t.id ? items.findIndex((i) => i.kind === "tool" && i.id === t.id) : -1;
      if (idx < 0) {
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool" && it.status === "running" && (!t.name || it.name === t.name)) {
            idx = i;
            break;
          }
        }
      }
      const name = t.name ?? "unknown";
      const output = t.output ?? "";
      const isError = !!t.err;
      const isPartial = t.partial === true; // tool_progress 转来的增量帧，命令仍在跑
      const existing = idx >= 0 && items[idx].kind === "tool" ? (items[idx] as Extract<Item, { kind: "tool" }>) : null;
      // result 帧可能携带 args（无 dispatch 的调用：progress+result），已有 args 时不覆盖
      const resolvedArgs = (typeof t.args === "string" && t.args) ? t.args : (existing?.args ?? "");
      const tool: Item = {
        kind: "tool",
        id: t.id || existing?.id || `tool-${taskId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        // 保留已有 args（tool_result 帧通常不带 args，不要清空）
        args: resolvedArgs,
        readOnly: t.readOnly ?? existing?.readOnly ?? false,
        // partial 帧（tool_progress）保持 running 状态，最终帧才标 done
        status: isError ? "error" : isPartial ? "running" : "done",
        output,
        error: t.err,
        truncated: t.truncated ?? false,
        isShell: isShellTool(name) || existing?.isShell || false,
      };
      if (idx >= 0) items[idx] = tool;
      else items.push(tool);

      // 修复 Bug【tool_result.output + assistant.text 跨组件重复渲染】v2:
      if (tool.output) {
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.id === tool.id) continue;
          if (it.kind === "assistant" && it.text === tool.output) {
            items.splice(i, 1);
            break;
          }
          if (it.kind === "assistant") break;
        }
      }
      return items;
    }
    case "phase": {
      items.push({
        kind: "phase",
        id: `phase-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: ev.text ?? "",
      });
      return items;
    }
    case "notice": {
      items.push({
        kind: "notice",
        id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        level: ev.level ?? "info",
        text: ev.text ?? "",
      });
      return items;
    }
    case "message": {
      // 修复 Bug【tool_result.output + assistant.text 重复渲染】:
      // brain 有时把同一段内容既当 tool_result.output 推，又当 message.text 推；
      // ToolCard(item.output)=raw + AssistantMessage(item.text)=Markdown，两端各画一次 → 用户看到“同一句话出现两次（pure + converted）”。
      // 去重：若新 message.text 与最近一个 tool 的 output 完全相同，跳过 message（让 tool 卡独享这段文本）。
      const text = ev.text ?? "";
      if (text) {
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool") {
            if (it.output && it.output === text) {
              return items; // 跳过 message（tool 卡独享）
            }
            break; // 只看最近一个 tool
          }
        }
      }
      const lastIdx = items.length - 1;
      const last = items[lastIdx];
      if (last && last.kind === "assistant") {
        items[lastIdx] = { ...last, text, streaming: false };
      } else if (text) {
        items.push({
          kind: "assistant",
          id: `assistant-${taskId}-${Date.now()}`,
          text,
          reasoning: "",
          streaming: false,
        });
      }
      return items;
    }
    case "turn_done": {
      const lastIdx = items.length - 1;
      const last = items[lastIdx];
      if (last && last.kind === "assistant" && last.streaming) {
        items[lastIdx] = { ...last, streaming: false, reasoningComplete: true };
      }
      return items;
    }
    // === v1.1（契约 §3.2）：队列 / 提问 / 计划帧 → 流式输出区的系统提示 ===
    // 说明：交互式的 AskCard 由 AisocDashboard 单独维护（reducer 只负责留痕），
    // 这里只把事件转成可读的 phase/notice，刷新后仍能看到"当时被问过什么"。
    case "task_queued": {
      const p = ev.payload ?? {};
      const pos = typeof p.position === "number" ? p.position : undefined;
      const depth = typeof p.queue_depth === "number" ? p.queue_depth : undefined;
      items.push({
        kind: "phase",
        id: `queue-${taskId}`,
        text: `⏳ 已入队${pos != null ? ` · 第 ${pos} 位` : ""}${depth != null ? `（队列深度 ${depth}）` : ""}`,
      });
      return items;
    }
    case "queue_position": {
      const p = ev.payload ?? {};
      const pos = typeof p.position === "number" ? p.position : undefined;
      const id = `queue-${taskId}`;
      const idx = items.findIndex((i) => i.id === id);
      const text = `⏳ 排队位置${pos != null ? ` · 第 ${pos} 位` : "已更新"}`;
      if (idx >= 0) items[idx] = { ...items[idx], text } as Item;
      else items.push({ kind: "phase", id, text });
      return items;
    }
    case "task_started": {
      const p = ev.payload ?? {};
      const domain = typeof p.domain === "string" ? p.domain : "";
      const worker = typeof p.worker === "string" ? p.worker : "";
      items.push({
        kind: "phase",
        id: `started-${taskId}`,
        text: `▶ 开始执行${domain ? ` · ${domain}` : ""}${worker ? `（${worker}）` : ""}`,
      });
      return items;
    }
    case "ask": {
      const ask = ev.ask;
      if (!ask) return items;
      const id = `ask-${ask.id}`;
      if (items.some((i) => i.id === id)) return items; // 同一 ask 只留一条痕迹
      const summary = ask.questions
        .map((q, i) => `${i + 1}. ${q.prompt}`)
        .join(" / ");
      items.push({
        kind: "notice",
        id,
        level: "warn",
        text: `❓ 智能体需要你回答：${summary || "(无问题文本)"}`,
      });
      return items;
    }
    case "ask_answered": {
      const p = ev.payload ?? {};
      const askId = typeof p.ask_id === "string" ? p.ask_id : "";
      items.push({
        kind: "notice",
        id: `ask-answered-${askId || Date.now()}`,
        level: "info",
        text: `✅ 回答已提交${askId ? `（${askId}）` : ""}，任务继续执行`,
      });
      return items;
    }
    case "task_cancelled": {
      const p = ev.payload ?? {};
      const reason = typeof p.reason === "string" ? p.reason : "";
      items.push({
        kind: "notice",
        id: `cancelled-${taskId}`,
        level: "warn",
        text: `⛔ 任务已取消${reason ? `：${reason}` : ""}`,
      });
      return items;
    }
    case "queue_full": {
      const p = ev.payload ?? {};
      const retry = typeof p.retry_after_s === "number" ? p.retry_after_s : undefined;
      items.push({
        kind: "notice",
        id: `queue-full-${Date.now()}`,
        level: "warn",
        text: `队列已满${retry != null ? `，请 ${retry} 秒后重试` : "，请稍后重试"}`,
      });
      return items;
    }
    case "plan_created": {
      const p = ev.payload ?? {};
      const planId = typeof p.plan_id === "string" ? p.plan_id : "";
      const goal = typeof p.goal === "string" ? p.goal : "";
      items.push({
        kind: "phase",
        id: `plan-${planId || taskId}`,
        text: `🧭 计划已生成${goal ? `：${goal}` : ""}`,
      });
      return items;
    }
    case "plan_step": {
      const p = ev.payload ?? {};
      const seq = typeof p.seq === "number" ? p.seq : undefined;
      const action = typeof p.action === "string" ? p.action : "";
      const domain = typeof p.domain === "string" ? p.domain : "";
      const status = typeof p.status === "string" ? p.status : "";
      const id = `plan-step-${seq ?? Date.now()}`;
      const text = `• 步骤${seq != null ? ` ${seq}` : ""}${action ? ` ${action}` : ""}`
        + `${domain ? ` → ${domain}` : ""}${status ? `（${status}）` : ""}`;
      const idx = items.findIndex((i) => i.id === id);
      if (idx >= 0) items[idx] = { ...items[idx], text } as Item;
      else items.push({ kind: "phase", id, text });
      return items;
    }
    case "completion_check": {
      const p = ev.payload ?? {};
      const done = typeof p.done === "boolean" ? p.done : undefined;
      const reason = typeof p.reason === "string" ? p.reason : "";
      const missing = Array.isArray(p.missing) ? p.missing.filter((m): m is string => typeof m === "string") : [];
      const confidence = typeof p.confidence === "number" ? p.confidence : undefined;
      const text = `完成判定：${done === true ? "已达目标" : done === false ? "未达目标" : "判定中"}`
        + `${reason ? ` · ${reason}` : ""}`
        + `${missing.length > 0 ? ` · 缺 ${missing.join("、")}` : ""}`
        + `${confidence != null ? ` · 置信度 ${Math.round(confidence * 100)}%` : ""}`;
      items.push({
        kind: "notice",
        id: `completion-${taskId}-${Date.now()}`,
        level: done === false ? "warn" : "info",
        text,
      });
      return items;
    }
    case "plan_finished": {
      const p = ev.payload ?? {};
      const verdict = typeof p.verdict === "string" ? p.verdict : "";
      items.push({
        kind: "notice",
        id: `plan-finished-${taskId}`,
        level: "info",
        text: `🏁 计划结束${verdict ? ` · ${verdict}` : ""}`,
      });
      return items;
    }
    default:
      return null;
  }
}
