/**
 * Web版API代理
 * 为网页版提供直接调用DeepSeek API的代理服务
 * 实现完整的AppBindings接口
 */

import type {
  HistoryMessage,
  Meta,
  ContextInfo,
  BalanceInfo,
  ModelInfo,
  WireEvent,
  TabMeta,
  SessionMeta,
  SettingsView,
  CapabilitiesView,
  ServerView,
  PluginView,
  QuestionAnswer,
  CommandInfo,
  WorkspaceView,
  ProjectNode,
  TopicMeta,
  ContextPanelInfo,
  EffortInfo,
  MemoryView,
  MemorySuggestionsView,
  MemorySuggestion,
  SkillSuggestion,
  FilePreview,
  DirEntry,
  DroppedItem,
  DesktopStartupSettingsView,
  HooksSettingsView,
  HookConfigView,
  ProviderView,
  NetworkView,
  BotSettingsView,
  BotInstallStartResult,
  BotInstallPollResult,
  BotRuntimeStatusView,
  BotConnectionDiagnostic,
  UpdateInfo,
  UpdateDownloadResult,
  PromptHistoryResult,
  SlashArgsResult,
  HistoryPage,
  CheckpointMeta,
  AutoResearchStatusView,
  AutoResearchFindingView,
  AutoResearchEvidenceView,
  MCPToolView,
  MCPServerInput,
  MCPTrustInspectionView,
  MCPCatalogRefreshView,
  SkillsSettingsView,
  CapabilityDiagnosticsReport,
  PluginInstallOptions,
  SubagentProfileInput,
  WorkspaceChangesView,
  GitCommitView,
  GitCommitDetailView,
  ExternalOpenersView,
  JobView,
  WireUsage,
  MemoryDoc,
  MemoryFact,
  MemoryArchive,
} from './types';
import type { InvocationRequest } from './invocationDisplay';
// AiSOC 集成：安全运营大脑 API 客户端（严格对齐 docs/frontend-api.md）
import {
  aisocApi,
  generateTaskId,
  generateFindingId,
  createDomainApiClient,
  type CreateTaskInput,
  type TaskDetail,
  type TaskInfo,
  type Finding,
  type ReportDoc,
  type RegistryPart,
  type AgentsStatus,
  type Alarm,
  type AlarmsSummary,
} from './aisoc-api';

// DeepSeek API 配置
// - 浏览器侧：使用同源相对路径 `/deepseek-api/*`，由 Vite dev proxy（开发期）
//   或 Nginx reverse proxy（生产期）转发到 https://api.deepseek.com，绕开 CORS。
// - API Key 和模型名由每个用户在设置面板自行输入，存到 localStorage。
//   服务器侧不保存任何用户的 API Key（多用户共享同一台 VPS 时各自独立）。
const DEEPSEEK_API_BASE = '/deepseek-api';
const DEEPSEEK_API_KEY_FALLBACK = ''; // 不再硬编码到源码；用户必须在前端设置面板输入
const DEEPSEEK_MODEL_DEFAULT = 'deepseek-v4-flash';
const LS_KEY_APIKEY = 'reasonix:web:deepseek_api_key';
const LS_KEY_MODEL = 'reasonix:web:deepseek_model';

/** 工具：从 localStorage 读字符串（SSR / 无 localStorage 环境返回 fallback） */
function readLS(key: string, fallback: string): string {
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const v = localStorage.getItem(key);
    return v && v.length > 0 ? v : fallback;
  } catch { return fallback; }
}

/** 工具：写 localStorage（异常时静默） */
function writeLS(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

/**
 * DeepSeek API 直接调用类
 * - apiKey / model 在每次请求时从 localStorage 读，方便用户随时切换
 */
class DeepSeekDirectApi {
  private baseUrl: string;

  constructor(baseUrl: string = DEEPSEEK_API_BASE) {
    this.baseUrl = baseUrl;
  }

  /** 当前用户配置的 API Key（来自 localStorage） */
  getApiKey(): string { return readLS(LS_KEY_APIKEY, DEEPSEEK_API_KEY_FALLBACK); }
  /** 设置 API Key（前端设置面板调用） */
  setApiKey(key: string): void { writeLS(LS_KEY_APIKEY, key.trim()); }
  /** 是否已配置 API Key */
  hasApiKey(): boolean { return this.getApiKey().length > 0; }

  /** 当前选择的模型 ID（来自 localStorage） */
  getModel(): string { return readLS(LS_KEY_MODEL, DEEPSEEK_MODEL_DEFAULT); }
  /** 设置模型 ID（前端设置面板调用） */
  setModel(model: string): void { writeLS(LS_KEY_MODEL, model.trim() || DEEPSEEK_MODEL_DEFAULT); }

  async chatCompletion(messages: Array<{ role: string; content: string }>) {
    // 推理模型 (deepseek-v4-flash / deepseek-reasoner) 允许最多 5 分钟
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300_000);

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getApiKey()}`,
        },
        body: JSON.stringify({
          model: this.getModel(),
          messages,
          temperature: 0.0,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = '';
        try {
          const errBody = await response.text();
          detail = errBody.slice(0, 500);
        } catch { /* ignore */ }
        throw new Error(`DeepSeek API error: ${response.status}${detail ? ` — ${detail}` : ''}`);
      }

      return response.json();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('DeepSeek API request timed out (5 min). The model may be overloaded — please try again.');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Streaming SSE 版本的 chatCompletion（打字机效果）。
   * 对每个收到的 SSE 数据块：
   *   - delta.reasoning_content → onReasoning 增量回调
   *   - delta.content           → onText 增量回调
   * 返回最终拼接的 { reasoning, content } 字符串用于落 history。
   */
  async chatCompletionStream(
    messages: Array<{ role: string; content: string }>,
    onReasoning?: (delta: string) => void,
    onText?: (delta: string) => void,
  ): Promise<{ reasoning: string; content: string; usage?: WireUsage }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600_000);
    let reasoning = '';
    let content = '';
    let usage: WireUsage | undefined;

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getApiKey()}`,
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify({
          model: this.getModel(),
          messages,
          temperature: 0.0,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        let detail = '';
        try {
          const errBody = await response.text();
          detail = errBody.slice(0, 500);
        } catch { /* ignore */ }
        throw new Error(`DeepSeek API error: ${response.status}${detail ? ` — ${detail}` : ''}`);
      }

      if (!response.body) {
        throw new Error('DeepSeek API returned no response body (streaming unavailable)');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE lines are separated by \n\n
        let sepIdx: number;
        while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
          const rawChunk = buffer.slice(0, sepIdx);
          buffer = buffer.slice(sepIdx + 2);
          const lines = rawChunk.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            try {
              const evt = JSON.parse(jsonStr);
              const choice = evt?.choices?.[0];
              const delta = choice?.delta ?? {};

              if (evt.usage) {
                usage = {
                  promptTokens: evt.usage.prompt_tokens ?? 0,
                  completionTokens: evt.usage.completion_tokens ?? 0,
                  totalTokens: evt.usage.total_tokens ?? 0,
                  cacheHitTokens: evt.usage.prompt_cache_hit_tokens ?? 0,
                  cacheMissTokens: evt.usage.prompt_cache_miss_tokens ?? 0,
                  reasoningTokens: evt.usage.reasoning_tokens ?? 0,
                  sessionCacheHitTokens: evt.usage.prompt_cache_hit_tokens ?? 0,
                  sessionCacheMissTokens: evt.usage.prompt_cache_miss_tokens ?? 0,
                };
              }

              if (delta.reasoning_content && typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                reasoning += delta.reasoning_content;
                try { onReasoning?.(delta.reasoning_content); } catch { /* ignore */ }
              }
              if (delta.content && typeof delta.content === 'string' && delta.content) {
                content += delta.content;
                try { onText?.(delta.content); } catch { /* ignore */ }
              }
            } catch {
              // malformed SSE JSON — skip single chunk, don't fail entire stream
            }
          }
        }
      }
      return { reasoning, content, usage };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('DeepSeek API request timed out (10 min). The model may be overloaded — please try again.');
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    const currentModel = this.getModel();
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: { 'Authorization': `Bearer ${this.getApiKey()}` },
      });

      if (!response.ok) {
        throw new Error(`DeepSeek API error: ${response.status}`);
      }

      const data = await response.json();
      return data.data.map((model: any) => ({
        ref: `deepseek/${model.id}`,
        provider: 'deepseek',
        model: model.id,
        current: model.id === currentModel,
      }));
    } catch {
      // API 不可用时返回一份默认列表，方便用户在前端切换
      const defaults = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'];
      return defaults.map(id => ({
        ref: `deepseek/${id}`,
        provider: 'deepseek',
        model: id,
        current: id === currentModel,
      }));
    }
  }
}

/**
 * 完整的Web API代理类
 * 实现所有AppBindings接口方法
 */
export class WebApiProxy {
  private deepSeekApi: DeepSeekDirectApi;
  // 每个 tab 独立维护会话历史，切换/新建 tab 不会清空其他 tab 的历史。
  private histories: Map<string, HistoryMessage[]> = new Map();
  private activeTabId: string = 'web-tab-1';
  private eventListeners: Set<(e: WireEvent) => void> = new Set();
  private tabs: TabMeta[] = [{
    id: 'web-tab-1',
    scope: 'global',
    workspaceRoot: '/',
    workspaceName: 'Web',
    topicId: 'web-topic-1',
    topicTitle: 'Web Chat',
    label: 'Web Chat',
    ready: true,
    running: false,
    mode: 'normal',
    active: true,
    cwd: '/',
  }];
  private settings: SettingsView;
  private nextAttachmentId: number = 1;
  private attachments: Map<string, { name: string; dataUrl: string; bytes?: Uint8Array }> = new Map();

  // 手动记忆（MemoryView.facts + docs），localStorage 持久化
  private memoryState: { docs: MemoryDoc[]; facts: MemoryFact[]; archives: MemoryArchive[] } = {
    docs: [],
    facts: [],
    archives: [],
  };

  // ==== localStorage keys ====
  private static readonly LS_KEY_HISTORIES = 'reasonix:web:histories';
  private static readonly LS_KEY_TABS = 'reasonix:web:tabs';
  private static readonly LS_KEY_ACTIVE = 'reasonix:web:tab:active';
  private static readonly LS_KEY_MEMORY = 'reasonix:web:memory';

  constructor() {
    this.deepSeekApi = new DeepSeekDirectApi();
    this.restoreFromStorage();
    if (!this.histories.has(this.activeTabId)) {
      this.histories.set(this.activeTabId, []);
    }
    this.settings = {
      defaultModel: 'deepseek/deepseek-v4-flash',
      plannerModel: '',
      subagentModel: '',
      subagentEffort: 'auto',
      autoPlan: 'off',
      providers: [],
      officialProviders: [],
      providerPresets: [],
      permissions: { mode: 'auto', allow: [], ask: [], deny: [] } as any,
      sandbox: { bash: 'off', network: false, workspaceRoot: '', allowWrite: [], shell: 'auto' } as any,
      network: { httpProxy: '', httpsProxy: '', noProxy: '' } as any,
      agent: { temperature: 0, maxSteps: 0, plannerMaxSteps: 0, systemPrompt: '' } as any,
      bot: {} as any,
      desktopLanguage: '',
      desktopLayoutStyle: 'classic',
      desktopTheme: 'dark',
      desktopThemeStyle: 'default',
      closeBehavior: 'quit',
      displayMode: 'standard',
      statusBarStyle: 'icon',
      statusBarItems: [],
      defaultToolApprovalMode: 'auto',
      checkUpdates: false,
      telemetry: false,
      metrics: false,
      memoryCompilerEnabled: false,
      configPath: '',
      providerKinds: ['openai'],
      autoApproveTools: true,
      bypass: false,
    };
  }

  // ==================== 持久化（localStorage）====================

  /** 构造时恢复 tabs/histories/memory。localStorage 不可用时静默回退内存存储 */
  private restoreFromStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
      const h = localStorage.getItem(WebApiProxy.LS_KEY_HISTORIES);
      if (h) {
        const parsed = JSON.parse(h) as Array<[string, HistoryMessage[]]>;
        this.histories = new Map(parsed);
      }
      const t = localStorage.getItem(WebApiProxy.LS_KEY_TABS);
      if (t) {
        const parsed = JSON.parse(t) as TabMeta[];
        if (parsed.length > 0) this.tabs = parsed;
      }
      const a = localStorage.getItem(WebApiProxy.LS_KEY_ACTIVE);
      if (a && this.tabs.some(tab => tab.id === a)) {
        this.activeTabId = a;
      } else if (this.tabs.length > 0) {
        this.activeTabId = this.tabs.find(tab => tab.active)?.id ?? this.tabs[0].id;
      }
      const m = localStorage.getItem(WebApiProxy.LS_KEY_MEMORY);
      if (m) {
        this.memoryState = JSON.parse(m);
      }
    } catch (e) {
      console.warn('[WebApiProxy] restoreFromStorage failed:', e);
    }
  }

  /** 把 tabs + histories + activeTabId + memory 写入 localStorage。限频 + ignore 异常 */
  private saveToStorage() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(WebApiProxy.LS_KEY_HISTORIES, JSON.stringify([...this.histories.entries()]));
      localStorage.setItem(WebApiProxy.LS_KEY_TABS, JSON.stringify(this.tabs));
      localStorage.setItem(WebApiProxy.LS_KEY_ACTIVE, this.activeTabId);
      localStorage.setItem(WebApiProxy.LS_KEY_MEMORY, JSON.stringify(this.memoryState));
    } catch (e) {
      console.warn('[WebApiProxy] saveToStorage failed:', e);
    }
  }

  private saveMemoryOnly() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(WebApiProxy.LS_KEY_MEMORY, JSON.stringify(this.memoryState));
    } catch (e) {
      console.warn('[WebApiProxy] saveMemoryOnly failed:', e);
    }
  }

  // ==================== 文件引用展开 ====================

  /**
   * 解析用户输入中的 @文件引用，读取本地文件内容并内联展开。
   * 支持格式：
   *   @路径    — workspace引用（Composer生成的 refs 格式）
   *   @[显示名](路径) — attachment显示引用（Composer生成的 displayRefs 格式）
   */
  private async expandFileReferences(input: string): Promise<string> {
    // 1. 先提取 @[name](path) 形式，替换为 @path 占位，统一处理
    const displayRefRe = /@\[([^\]]*)\]\(([^)]+)\)/g;
    const normalized = input.replace(displayRefRe, (_m, _name, path) => `@${path}`);

    // 2. 解析所有 @路径 引用（路径可含空格/中文，直到遇到空白或行尾）
    const refRe = /@([^\s@"']+)/g;
    const refs: Array<{ full: string; path: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(normalized)) !== null) {
      refs.push({ full: m[0], path: m[1] });
    }
    if (refs.length === 0) return input;

    // 3. 逐个展开：内存附件（web-attachment://）从 Map 读取；工作区路径通过 Vite dev server
    //    中间件 /__workspace_file__?path=xxx 读取（由 vite.config.ts workspaceFileServer() 提供，
    //    直接读文件系统，绕过 SPA fallback）
    const chunks: string[] = [];
    for (const ref of refs) {
      let body = "";
      let truncated = false;
      let isBinary = false;
      const displayName = ref.path;
      try {
        const memAtt = this.attachments.get(ref.path);
        if (memAtt) {
          // 从内存附件取字节 -> UTF-8 文本
          if (memAtt.bytes && memAtt.bytes.length > 0) {
            const MAX_BYTES = 200_000;
            const slice = memAtt.bytes.length > MAX_BYTES ? memAtt.bytes.subarray(0, MAX_BYTES) : memAtt.bytes;
            try {
              body = new TextDecoder("utf-8", { fatal: false }).decode(slice);
            } catch {
              body = "";
              isBinary = true;
            }
            if (memAtt.bytes.length > MAX_BYTES) truncated = true;
          } else if (memAtt.dataUrl.startsWith("data:")) {
            // 没有 bytes 时回退：从 dataUrl 解码
            try {
              const comma = memAtt.dataUrl.indexOf(",");
              const head = comma === -1 ? memAtt.dataUrl : memAtt.dataUrl.slice(0, comma);
              const bodyPart = comma === -1 ? "" : memAtt.dataUrl.slice(comma + 1);
              if (/base64/i.test(head)) {
                const bin = atob(bodyPart);
                const MAX_BYTES = 200_000;
                const decoded = bin.length > MAX_BYTES ? bin.slice(0, MAX_BYTES) : bin;
                const buf = new Uint8Array(decoded.length);
                for (let i = 0; i < decoded.length; i++) buf[i] = decoded.charCodeAt(i);
                body = new TextDecoder("utf-8", { fatal: false }).decode(buf);
                if (bin.length > MAX_BYTES) truncated = true;
              } else {
                body = decodeURIComponent(bodyPart);
              }
              if (/^data:(image|video|audio|application\/(pdf|octet|zip|gzip|msdownload)|font)/i.test(head)) {
                isBinary = true;
              }
            } catch {
              body = "";
              isBinary = true;
            }
          }
          if (!body && !isBinary) isBinary = true;
        } else {
          const cleanPath = ref.path.replace(/\\/g, "/");
          const endpoint = `/__workspace_file__?path=${encodeURIComponent(cleanPath)}`;
          const resp = await fetch(endpoint, { method: "GET" });
          if (resp.ok) {
            const contentType = resp.headers.get("content-type") || "";
            const text = await resp.text();
            const MAX_BYTES = 200_000;
            if (text.length > MAX_BYTES) {
              body = text.slice(0, MAX_BYTES);
              truncated = true;
            } else {
              body = text;
            }
            isBinary = /^(image|video|audio|application\/(pdf|octet|zip|gzip|msdownload)|font)/i.test(contentType);
          } else {
            body = `[文件无法读取：${ref.path}（HTTP ${resp.status}）${resp.status === 404 ? "；文件不存在于工作区根目录" : ""}]`;
          }
        }
      } catch (e) {
        body = `[文件读取失败：${e instanceof Error ? e.message : String(e)}]`;
      }

      // 对内容做代码块包裹；二进制/图片类直接跳过展开，保留引用
      if (isBinary || body.length === 0) {
        chunks.push(`\n\n--- 文件: ${displayName} (二进制/不支持内联) ---\n`);
      } else {
        const ext = displayName.split(".").pop()?.toLowerCase() ?? "";
        const fenceLang = /^(md|markdown|txt|json|yaml|yml|csv|xml|html|css|js|ts|tsx|jsx|py|go|rs|java|c|cpp|h|sh|bash|sql|proto|toml|ini|conf)$/i.test(ext) ? ext : "";
        const warn = truncated ? `\n[注意：文件过大，仅展示前 ${body.length} 字符]\n` : "";
        chunks.push(`\n\n--- 文件: ${displayName} ---\n\`\`\`${fenceLang}\n${body}\n\`\`\`${warn}\n`);
      }
    }

    // 4. 拼接：保留原始输入（去掉 displayRef 包装），在末尾追加展开的文件内容
    // 这样模型既能看到用户原本的问题描述，也能看到文件正文
    const userPrompt = normalized.replace(refRe, "").trim() || input.trim();
    return `${userPrompt}\n\n以下是引用的文件内容：${chunks.join("")}`;
  }

  // ==================== 核心API方法 ====================

  async Submit(input: string): Promise<void> {
    return this.submitForTab(this.activeTabId, input);
  }

  private async submitForTab(tabId: string, input: string): Promise<void> {
    console.log(`🌐 Web API: Submit to tab=${tabId}, input length=${input.length}`);

    // 用户消息：先落事件，再立即写 history + localStorage（避免网络中断丢用户输入）
    this.emitEvent({ kind: 'text', text: input, tabId });

    // 为 UI 思考动画 + 打字机效果发射事件序列
    this.emitEvent({ kind: 'turn_started', tabId });

    // API Key 预检：未配置时立即返回友好提示，不发请求
    if (!this.deepSeekApi.hasApiKey()) {
      this.emitEvent({
        kind: 'text',
        text: '⚠️ 尚未配置 DeepSeek API Key。\n\n请点击右上角设置 → Provider / API Key，粘贴你的 DeepSeek API Key 后保存。\n\n获取地址：https://platform.deepseek.com/apiKeys',
        level: 'warn',
        tabId,
      });
      this.emitEvent({ kind: 'turn_done', tabId });
      return;
    }

    const expandedInput = await this.expandFileReferences(input);
      if (expandedInput !== input) {
        console.log('🌐 Web API: Expanded file references, new length:', expandedInput.length);
      }

      const history = this.histories.get(tabId) ?? [];
      const turnBase = history.length;
      // 用户消息先立即落库（避免长时间推理失败丢消息）
      history.push({ role: 'user', content: input, createdAt: Date.now(), checkpointTurn: turnBase + 1 });
      this.histories.set(tabId, history);
      this.saveToStorage();

      const messages = [
        { role: 'system', content: 'You are a helpful AI assistant for security analysis. When the user provides file contents within markdown code fences prefixed with "--- 文件: <path> ---", treat them as the actual file body and do not ask the user to re-upload them.' },
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: expandedInput },
      ];

      console.log('🌐 Calling DeepSeek API (stream)...');

      // 打字机人工节流：把 SSE 返回的大块 delta 切成 1-3 个字符小份，逐份 emit
      // 视觉上更接近真·打字机；如果用户取消或下一轮 submit 立即中止（runningTimers clear）
      const typewriterId = `tw-${tabId}-${Date.now()}`;
      const pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();
      (this as any)._typewriterTimers = (this as any)._typewriterTimers ?? new Map();
      (this as any)._typewriterTimers.set(typewriterId, pendingTimers);

      const scheduleTypewriter = (chunk: string, type: 'text' | 'reasoning', runningReasoningRef?: { value: string }) => {
        if (!chunk) return;
        let pos = 0;
        const emitOne = () => {
          if ((this as any)._typewriterTimers?.get(typewriterId) !== pendingTimers) return; // cancelled
          const step = 1 + (Math.random() < 0.4 ? 1 : 0) + (Math.random() < 0.15 ? 1 : 0); // 1~3 chars
          const slice = chunk.slice(pos, pos + step);
          if (!slice) return;
          pos += step;
          if (type === 'text') {
            this.emitEvent({ kind: 'text', detail: slice, text: '', tabId });
          } else {
            runningReasoningRef!.value += slice;
            this.emitEvent({ kind: 'reasoning', reasoning: runningReasoningRef!.value, tabId });
          }
          if (pos < chunk.length) {
            const delay = 8 + Math.floor(Math.random() * 8); // 8~15 ms
            const t = setTimeout(emitOne, delay);
            pendingTimers.add(t);
          }
        };
        const t = setTimeout(emitOne, 1);
        pendingTimers.add(t);
      };

      const stopTypewriter = () => {
        const timers: Set<number> | undefined = (this as any)._typewriterTimers?.get(typewriterId);
        if (timers) timers.forEach(t => clearTimeout(t));
        (this as any)._typewriterTimers?.delete(typewriterId);
      };

      let hadAnyOutput = false;
      const runningReasoning = { value: '' };
      let turnDoneEmitted = false;
      const emitTurnDoneSafe = () => {
        if (!turnDoneEmitted) {
          turnDoneEmitted = true;
          this.emitEvent({ kind: 'turn_done', tabId });
        }
      };
      let finalText = '';

      try {
        const result = await this.deepSeekApi.chatCompletionStream(
          messages,
          (delta) => {
            hadAnyOutput = true;
            scheduleTypewriter(delta, 'reasoning', runningReasoning);
          },
          (delta) => {
            hadAnyOutput = true;
            scheduleTypewriter(delta, 'text');
          },
        );

        // 等待所有 pending 打字机 tick 跑完（最多 5s 保护），然后再发完整 text/turn_done
        await new Promise<void>((resolve) => {
          const startTs = Date.now();
          const check = () => {
            const timers: Set<number> | undefined = (this as any)._typewriterTimers?.get(typewriterId);
            if (!timers || timers.size === 0 || Date.now() - startTs > 5000) resolve();
            else setTimeout(check, 30);
          };
          check();
        });

        if (!hadAnyOutput && !result.content && !result.reasoning) {
          throw new Error('DeepSeek streaming returned empty content');
        }

        finalText = result.content || '';
        history.push({
          role: 'assistant',
          content: finalText,
          createdAt: Date.now(),
          checkpointTurn: turnBase + 2,
          reasoning: result.reasoning || runningReasoning.value || undefined,
        });
        this.histories.set(tabId, history);

        if (result.usage) {
          this.emitEvent({ kind: 'usage', usage: result.usage, tabId });
        }

        // 最终完整文本（UI reducer 通常会依据它替换/拼接）
        if (finalText) {
          this.emitEvent({ kind: 'text', text: finalText, tabId });
        }

        emitTurnDoneSafe();
        this.saveToStorage();
        console.log('✅ Web API: AI response streamed, final length:', finalText.length);
      } catch (error) {
        stopTypewriter();
        console.error('❌ Web API: Error calling DeepSeek:', error);
        this.emitEvent({
          kind: 'text',
          text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease check your DeepSeek API key configuration.`,
          level: 'warn',
          tabId,
        });
        emitTurnDoneSafe();
      } finally {
        stopTypewriter();
      }
  }

  async History(): Promise<HistoryMessage[]> {
    return this.histories.get(this.activeTabId) ?? [];
  }

  private historyPageForTab(tabID: string, beforeTurn: number, limit: number): HistoryPage {
    const all = this.histories.get(tabID) ?? [];
    const totalTurns = all.length;
    // beforeTurn = 0 表示从最新开始；> 0 表示加载 checkpointTurn < beforeTurn 的更早消息
    const startIndex = beforeTurn > 0
      ? Math.max(0, all.findIndex(m => (m.checkpointTurn ?? 0) >= beforeTurn))
      : 0;
    // 倒序取 limit 条，再正序返回
    const slice = all.slice(startIndex, startIndex + limit);
    const endTurn = slice.length > 0 ? (slice[slice.length - 1].checkpointTurn ?? slice.length) : 0;
    const startTurn = slice.length > 0 ? (slice[0].checkpointTurn ?? 1) : 0;
    return {
      messages: slice,
      startTurn,
      endTurn,
      totalTurns,
      hasOlder: startIndex + slice.length < totalTurns,
    };
  }

  async Meta(): Promise<Meta> {
    return {
      label: this.deepSeekApi.getModel(),
      ready: this.deepSeekApi.hasApiKey(),
      eventChannel: 'agent:event',
      cwd: '/',
      workspaceName: 'Web Chat',
      collaborationMode: 'normal',
      toolApprovalMode: 'auto',
      tokenMode: 'full',
      autoApproveTools: true,
      imageInputEnabled: false,
    };
  }

  async Models(): Promise<ModelInfo[]> {
    return await this.deepSeekApi.getModels();
  }

  async Balance(): Promise<BalanceInfo> {
    return {
      available: true,
      display: 'Web mode (no billing)',
    };
  }

  async ContextUsage(): Promise<ContextInfo> {
    const used = (this.histories.get(this.activeTabId) ?? []).length * 1000;
    return {
      used,
      window: 128000,
      sessionTokens: used,
    };
  }

  async Commands(): Promise<CommandInfo[]> {
    return [
      {
        name: 'help',
        description: 'Show available commands',
        kind: 'builtin',
      },
      {
        name: 'clear',
        description: 'Clear the current session',
        kind: 'builtin',
      },
    ];
  }

  async Capabilities(): Promise<CapabilitiesView> {
    return {
      servers: [],
      skills: [],
      skillRoots: [],
      plugins: [],
    };
  }

  async Settings(): Promise<SettingsView> {
    return this.settings;
  }

  // ==================== 平台和窗口方法 ====================

  async Platform(): Promise<string> {
    return navigator.platform || 'web';
  }

  async MinimiseMainWindow(): Promise<void> {
    console.log('Minimise not supported in web');
  }

  async ToggleMaximiseMainWindow(): Promise<void> {
    console.log('Maximise not supported in web');
  }

  async IsMainWindowMaximised(): Promise<boolean> {
    return false;
  }

  async CloseMainWindow(): Promise<void> {
    console.log('Close not supported in web');
  }

  // ==================== 标签页管理方法 ====================

  async ListTabs(): Promise<TabMeta[]> {
    return this.tabs;
  }

  async OpenProjectTab(workspaceRoot: string, topicID: string): Promise<TabMeta> {
    const newTab: TabMeta = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      scope: 'project',
      workspaceRoot,
      workspaceName: workspaceRoot.split('/').filter(Boolean).pop() ?? workspaceRoot,
      topicId: topicID,
      topicTitle: `Project: ${workspaceRoot}`,
      label: `Project: ${workspaceRoot}`,
      ready: true,
      running: false,
      mode: 'normal',
      active: true,
      cwd: workspaceRoot,
    };
    this.tabs.push(newTab);
    this.histories.set(newTab.id, []);
    this.activeTabId = newTab.id;
    this.saveToStorage();
    return newTab;
  }

  async OpenGlobalTab(topicID: string): Promise<TabMeta> {
    const newTab: TabMeta = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      scope: 'global',
      workspaceRoot: '/',
      workspaceName: 'Web',
      topicId: topicID,
      topicTitle: `Topic: ${topicID}`,
      label: `Topic: ${topicID}`,
      ready: true,
      running: false,
      mode: 'normal',
      active: true,
      cwd: '/',
    };
    this.tabs.push(newTab);
    this.histories.set(newTab.id, []);
    this.activeTabId = newTab.id;
    this.saveToStorage();
    return newTab;
  }

  async SetActiveTab(tabID: string): Promise<void> {
    this.tabs = this.tabs.map(tab => ({ ...tab, active: tab.id === tabID }));
    this.activeTabId = tabID;
    this.saveToStorage();
  }

  async CloseTab(tabID: string): Promise<void> {
    this.tabs = this.tabs.filter(tab => tab.id !== tabID);
    this.histories.delete(tabID);
    if (this.activeTabId === tabID) {
      this.activeTabId = this.tabs[0]?.id ?? 'web-tab-1';
      if (this.tabs.length === 0) {
        const defaultTab: TabMeta = {
          id: 'web-tab-1',
          scope: 'global',
          workspaceRoot: '/',
          workspaceName: 'Web',
          topicId: `topic-${Date.now()}`,
          topicTitle: 'Web Chat',
          label: 'Web Chat',
          ready: true,
          running: false,
          mode: 'normal',
          active: true,
          cwd: '/',
        };
        this.tabs.push(defaultTab);
        this.histories.set(defaultTab.id, []);
        this.activeTabId = defaultTab.id;
      }
    }
    this.saveToStorage();
  }

  async ReorderTabs(tabIDs: string[]): Promise<void> {
    const tabMap = new Map(this.tabs.map(tab => [tab.id, tab]));
    this.tabs = tabIDs.map(id => tabMap.get(id)).filter(Boolean) as TabMeta[];
    this.saveToStorage();
  }

  // ==================== 会话管理方法 ====================

  async NewSession(): Promise<void> {
    this.histories.set(this.activeTabId, []);
    this.saveToStorage();
    this.emitEvent({ kind: 'text', text: 'New session created' });
  }

  async ClearSession(): Promise<void> {
    this.histories.set(this.activeTabId, []);
    this.saveToStorage();
    this.emitEvent({ kind: 'text', text: 'Session cleared' });
  }

  async ListSessions(): Promise<SessionMeta[]> {
    const now = Date.now();
    const activeHistory = this.histories.get(this.activeTabId) ?? [];
    return [
      {
        path: 'current',
        preview: 'Current Session',
        title: 'Current Session',
        turns: activeHistory.length,
        createdAt: now,
        lastActivityAt: now,
        modTime: now,
        current: true,
        open: true,
      },
    ];
  }

  // ==================== 工作区和项目管理方法 ====================

  async ListWorkspaces(): Promise<WorkspaceView[]> {
    return [];
  }

  async ListProjectTree(): Promise<ProjectNode[]> {
    return [];
  }

  async ContextPanel(tabID: string): Promise<ContextPanelInfo> {
    const used = (this.histories.get(tabID) ?? []).length * 1000;
    return {
      usedTokens: used,
      windowTokens: 128000,
      promptTokens: used,
      completionTokens: 0,
      totalTokens: used,
      reasoningTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: used,
      sessionCacheHitTokens: 0,
      sessionCacheMissTokens: used,
      sessionCompletionTokens: 0,
      readFiles: [],
      changedFiles: [],
    };
  }

  // ==================== MCP和插件管理方法 ====================

  async MCPServers(): Promise<ServerView[]> {
    return [];
  }

  async Plugins(): Promise<PluginView[]> {
    return [];
  }

  // ==================== 心跳方法 ====================

  async HeartbeatListTasks(): Promise<unknown> {
    return [];
  }

  async HeartbeatReloadTasks(): Promise<unknown> {
    return [];
  }

  async HeartbeatSaveTasks(tasks: unknown): Promise<void> {
    console.log('Heartbeat tasks saved:', tasks);
  }

  async HeartbeatTriggerNow(id: string): Promise<void> {
    console.log('Heartbeat triggered:', id);
  }

  async HeartbeatGenerateID(): Promise<string> {
    return `heartbeat-${Date.now()}`;
  }

  // ==================== 模型和设置方法 ====================

  async SetModel(name: string): Promise<void> {
    // 兼容 Reasonix 桌面端的 ref 格式 "deepseek/deepseek-v4-flash"，
    // 提取最后一段作为 DeepSeek API 的 model id
    const modelId = name.includes('/') ? name.split('/').pop()! : name;
    this.deepSeekApi.setModel(modelId);
    this.settings.defaultModel = name;
  }

  /**
   * 设置 DeepSeek API Key（前端设置面板调用）。
   * Key 只写入当前浏览器的 localStorage，不上传到服务器，
   * 多用户共享同一台 VPS 时各自独立。
   */
  async SetApiKey(key: string): Promise<void> {
    this.deepSeekApi.setApiKey(key);
  }

  /** 返回当前 API Key 是否已配置（不返回明文，避免泄露到 UI 日志） */
  async HasApiKey(): Promise<boolean> {
    return this.deepSeekApi.hasApiKey();
  }

  /** 返回 API Key 的掩码字符串（前 6 位 + **** + 后 4 位），用于 UI 展示 */
  async GetApiKeyMasked(): Promise<string> {
    const k = this.deepSeekApi.getApiKey();
    if (!k) return '';
    if (k.length <= 12) return '****';
    return `${k.slice(0, 6)}****${k.slice(-4)}`;
  }

  /** 返回当前选中的模型 id（前端设置面板用） */
  async GetCurrentModel(): Promise<string> {
    return this.deepSeekApi.getModel();
  }

  async Effort(): Promise<EffortInfo> {
    return {
      supported: true,
      current: 'auto',
      default: 'auto',
      levels: ['auto', 'low', 'medium', 'high'],
    };
  }

  async SetEffort(level: string): Promise<void> {
    console.log('Effort set to:', level);
  }

  async Memory(): Promise<MemoryView> {
    return {
      docs: this.memoryState.docs,
      facts: this.memoryState.facts,
      archives: this.memoryState.archives,
      scopes: [
        { scope: 'user', path: 'web://memory/user' },
        { scope: 'project', path: 'web://memory/project' },
      ],
      storeDir: 'web://memory',
      available: true,
    };
  }

  async MemorySuggestions(): Promise<MemorySuggestionsView> {
    const memories: MemorySuggestion[] = this.memoryState.facts.map((f, i) => ({
      id: `mem-suggest-${Date.now()}-${i}`,
      name: f.name,
      title: f.title ?? f.name,
      description: f.description,
      type: f.type,
      body: f.body,
      reason: '已保存的记忆项',
      evidence: [],
    }));
    return {
      memories,
      skills: [],
      generatedAt: new Date().toISOString(),
      available: true,
      source: 'web',
    };
  }

  // ==================== 控制方法 ====================

  async Cancel(): Promise<void> {
    this.emitEvent({
      kind: 'text',
      text: 'Request cancelled',
    });
  }

  async Approve(id: string, allow: boolean, _session: boolean = false, _persist: boolean = false): Promise<void> {
    console.log(`Approval ${id}: ${allow ? 'approved' : 'rejected'}`);
  }

  async AnswerQuestion(id: string, answers: QuestionAnswer[]): Promise<void> {
    console.log(`Question ${id} answered:`, answers);
  }

  async ReplayPendingPrompts(): Promise<void> {
    console.log('Replaying pending prompts');
  }

  async SetPlanMode(on: boolean): Promise<void> {
    console.log(`Plan mode: ${on ? 'enabled' : 'disabled'}`);
  }

  async SetMode(mode: string): Promise<void> {
    console.log('Mode set to:', mode);
  }

  async SetAutoApproveTools(on: boolean): Promise<void> {
    this.settings.autoApproveTools = on;
  }

  // ==================== 通用占位方法 ====================

  private async placeholderMethod(methodName: string, ...args: unknown[]): Promise<any> {
    console.log(`🌐 Web API: ${methodName} called with args:`, args);
    return undefined;
  }

  // 为所有其他方法提供占位符实现
  async SubmitToTab(tabID: string, input: string): Promise<void> { return this.submitForTab(tabID, input); }
  async SubmitDisplay(_display: string, input: string): Promise<void> { return this.placeholderMethod('SubmitDisplay', _display, input); }
  async SubmitDisplayToTab(tabID: string, _display: string, input: string): Promise<void> { return this.submitForTab(tabID, input); }
  async SubmitDeliveryRecoveryToTab(tabID: string, _display: string, input: string): Promise<void> { return this.placeholderMethod('SubmitDeliveryRecoveryToTab', tabID, _display, input); }
  async SubmitInvocationsToTab(tabID: string, display: string, input: string, invocations: InvocationRequest[]): Promise<void> { return this.placeholderMethod('SubmitInvocationsToTab', tabID, display, input, invocations); }
  async SubmitEditedDisplayToTab(tabID: string, display: string, input: string, original: string): Promise<void> { return this.placeholderMethod('SubmitEditedDisplayToTab', tabID, display, input, original); }
  async RunShell(command: string): Promise<void> { return this.placeholderMethod('RunShell', command); }
  async RunShellForTab(tabID: string, command: string): Promise<void> { return this.placeholderMethod('RunShellForTab', tabID, command); }
  async Steer(text: string): Promise<void> { return this.placeholderMethod('Steer', text); }
  async SteerForTab(tabID: string, text: string): Promise<void> { return this.placeholderMethod('SteerForTab', tabID, text); }
  async CancelTab(tabID: string): Promise<void> { return this.placeholderMethod('CancelTab', tabID); }
  async ApproveTab(tabID: string, id: string, allow: boolean, session: boolean, persist: boolean): Promise<void> { return this.placeholderMethod('ApproveTab', tabID, id, allow, session, persist); }
  async AnswerQuestionForTab(tabID: string, id: string, answers: QuestionAnswer[]): Promise<void> { return this.placeholderMethod('AnswerQuestionForTab', tabID, id, answers); }
  async SetModeForTab(tabID: string, mode: string): Promise<string[] | void> { return this.placeholderMethod('SetModeForTab', tabID, mode); }
  async SetCollaborationMode(mode: string): Promise<void> { return this.placeholderMethod('SetCollaborationMode', mode); }
  async SetCollaborationModeForTab(tabID: string, mode: string): Promise<void> { return this.placeholderMethod('SetCollaborationModeForTab', tabID, mode); }
  async SetToolApprovalMode(mode: string): Promise<void> { return this.placeholderMethod('SetToolApprovalMode', mode); }
  async SetToolApprovalModeForTab(tabID: string, mode: string): Promise<string[] | void> { return this.placeholderMethod('SetToolApprovalModeForTab', tabID, mode); }
  async SetGoal(goal: string): Promise<void> { return this.placeholderMethod('SetGoal', goal); }
  async SetGoalForTab(tabID: string, goal: string): Promise<void> { return this.placeholderMethod('SetGoalForTab', tabID, goal); }
  async ResumeGoalForTab(tabID: string): Promise<boolean> { return this.placeholderMethod('ResumeGoalForTab', tabID); }
  async ClearGoal(): Promise<void> { return this.placeholderMethod('ClearGoal'); }
  async ClearGoalForTab(tabID: string): Promise<void> { return this.placeholderMethod('ClearGoalForTab', tabID); }
  async Compact(): Promise<void> { return this.placeholderMethod('Compact'); }
  async CompactForTab(tabID: string): Promise<void> { return this.placeholderMethod('CompactForTab', tabID); }
  async NewSessionForTab(tabID: string): Promise<void> {
    this.histories.set(tabID, []);
    this.activeTabId = tabID;
    this.saveToStorage();
  }
  async ClearSessionForTab(tabID: string): Promise<void> {
    this.histories.set(tabID, []);
    this.saveToStorage();
  }
  async HistoryForTab(tabID: string): Promise<HistoryMessage[]> {
    return this.histories.get(tabID) ?? [];
  }
  async HistoryPage(beforeTurn: number, limit: number): Promise<HistoryPage> {
    return this.historyPageForTab(this.activeTabId, beforeTurn, limit);
  }
  async HistoryPageForTab(tabID: string, beforeTurn: number, limit: number): Promise<HistoryPage> {
    return this.historyPageForTab(tabID, beforeTurn, limit);
  }
  async HistoryCheckpointTurnsForTab(tabID: string): Promise<number[]> { return this.placeholderMethod('HistoryCheckpointTurnsForTab', tabID); }
  async Checkpoints(): Promise<CheckpointMeta[]> { return this.placeholderMethod('Checkpoints'); }
  async CheckpointsForTab(tabID: string): Promise<CheckpointMeta[]> { return this.placeholderMethod('CheckpointsForTab', tabID); }
  async Rewind(turn: number, scope: string): Promise<void> { return this.placeholderMethod('Rewind', turn, scope); }
  async RewindForTab(tabID: string, turn: number, scope: string): Promise<void> { return this.placeholderMethod('RewindForTab', tabID, turn, scope); }
  async Fork(turn: number): Promise<TabMeta> { return this.placeholderMethod('Fork', turn); }
  async ForkForTab(tabID: string, turn: number): Promise<TabMeta> { return this.placeholderMethod('ForkForTab', tabID, turn); }
  async SummarizeFrom(turn: number): Promise<void> { return this.placeholderMethod('SummarizeFrom', turn); }
  async SummarizeFromForTab(tabID: string, turn: number): Promise<void> { return this.placeholderMethod('SummarizeFromForTab', tabID, turn); }
  async SummarizeUpTo(turn: number): Promise<void> { return this.placeholderMethod('SummarizeUpTo', turn); }
  async SummarizeUpToForTab(tabID: string, turn: number): Promise<void> { return this.placeholderMethod('SummarizeUpToForTab', tabID, turn); }
  async ListTrashedSessions(): Promise<SessionMeta[]> { return this.placeholderMethod('ListTrashedSessions'); }
  async ResumeSession(path: string): Promise<HistoryMessage[]> { return this.placeholderMethod('ResumeSession', path); }
  async ResumeSessionForTab(tabID: string, path: string): Promise<HistoryMessage[]> { return this.placeholderMethod('ResumeSessionForTab', tabID, path); }
  async ResumeSessionPage(path: string, limit: number): Promise<HistoryPage> { return this.placeholderMethod('ResumeSessionPage', path, limit); }
  async ResumeSessionPageForTab(tabID: string, path: string, limit: number): Promise<HistoryPage> { return this.placeholderMethod('ResumeSessionPageForTab', tabID, path, limit); }
  async OpenChannelSessionForTab(tabID: string, path: string): Promise<HistoryMessage[]> { return this.placeholderMethod('OpenChannelSessionForTab', tabID, path); }
  async OpenChannelSessionPageForTab(tabID: string, path: string, limit: number): Promise<HistoryPage> { return this.placeholderMethod('OpenChannelSessionPageForTab', tabID, path, limit); }
  async PreviewSession(path: string): Promise<HistoryMessage[]> { return this.placeholderMethod('PreviewSession', path); }
  async DeleteSession(path: string): Promise<void> { return this.placeholderMethod('DeleteSession', path); }
  async DeleteRecoveryCopy(path: string): Promise<void> { return this.placeholderMethod('DeleteRecoveryCopy', path); }
  async RestoreSession(path: string): Promise<void> { return this.placeholderMethod('RestoreSession', path); }
  async PurgeTrashedSession(path: string): Promise<void> { return this.placeholderMethod('PurgeTrashedSession', path); }
  async PurgeRecoveryCopy(path: string): Promise<void> { return this.placeholderMethod('PurgeRecoveryCopy', path); }
  async RenameSession(path: string, title: string): Promise<void> { return this.placeholderMethod('RenameSession', path, title); }
  async ScanPromptHistory(nonce: string): Promise<PromptHistoryResult> { return this.placeholderMethod('ScanPromptHistory', nonce); }
  async PickWorkspace(): Promise<string> { return this.placeholderMethod('PickWorkspace'); }
  async SwitchWorkspace(path: string): Promise<string> { return this.placeholderMethod('SwitchWorkspace', path); }
  async RemoveWorkspace(path: string): Promise<void> { return this.placeholderMethod('RemoveWorkspace', path); }
  async ContextUsageForTab(_tabID: string): Promise<ContextInfo> { return this.ContextUsage(); }
  async BalanceForTab(_tabID: string): Promise<BalanceInfo> { return this.Balance(); }
  async Jobs(): Promise<JobView[]> { return this.placeholderMethod('Jobs'); }
  async JobsForTab(tabID: string): Promise<JobView[]> { return this.placeholderMethod('JobsForTab', tabID); }
  async ToolResultForTab(tabID: string, toolID: string): Promise<{ args: string; output: string } | null> { return this.placeholderMethod('ToolResultForTab', tabID, toolID); }
  async MetaForTab(_tabID: string): Promise<Meta> { return this.Meta(); }
  async AutoResearchCurrent(): Promise<AutoResearchStatusView> { return this.placeholderMethod('AutoResearchCurrent'); }
  async AutoResearchStatus(tabID: string): Promise<AutoResearchStatusView> { return this.placeholderMethod('AutoResearchStatus', tabID); }
  async AutoResearchList(tabID: string): Promise<AutoResearchStatusView[]> { return this.placeholderMethod('AutoResearchList', tabID); }
  async AutoResearchFindings(tabID: string, limit: number): Promise<AutoResearchFindingView[]> { return this.placeholderMethod('AutoResearchFindings', tabID, limit); }
  async AutoResearchOpenTask(tabID: string): Promise<void> { return this.placeholderMethod('AutoResearchOpenTask', tabID); }
  async AutoResearchRecordEvidence(tabID: string, criterionID: string, input: AutoResearchEvidenceView): Promise<void> { return this.placeholderMethod('AutoResearchRecordEvidence', tabID, criterionID, input); }
  async InspectMCPTrust(name: string): Promise<MCPTrustInspectionView> { return this.placeholderMethod('InspectMCPTrust', name); }
  async SetMCPTrust(name: string, decision: "session" | "workspace" | "revoke"): Promise<void> { return this.placeholderMethod('SetMCPTrust', name, decision); }
  async RefreshMCPCatalog(): Promise<MCPCatalogRefreshView> { return this.placeholderMethod('RefreshMCPCatalog'); }
  async SkillsSettings(): Promise<SkillsSettingsView> { return this.placeholderMethod('SkillsSettings'); }
  async CapabilityDiagnostics(includeSessionRuntime: boolean): Promise<CapabilityDiagnosticsReport> { return this.placeholderMethod('CapabilityDiagnostics', includeSessionRuntime); }
  async PlanPluginInstall(source: string, options: PluginInstallOptions): Promise<string> { return this.placeholderMethod('PlanPluginInstall', source, options); }
  async InstallPlugin(source: string, options: PluginInstallOptions): Promise<string> { return this.placeholderMethod('InstallPlugin', source, options); }
  async RemovePlugin(name: string): Promise<void> { return this.placeholderMethod('RemovePlugin', name); }
  async SetPluginEnabled(name: string, enabled: boolean): Promise<void> { return this.placeholderMethod('SetPluginEnabled', name, enabled); }
  async UpdatePlugin(name: string): Promise<string> { return this.placeholderMethod('UpdatePlugin', name); }
  async PluginDoctor(name: string): Promise<PluginView> { return this.placeholderMethod('PluginDoctor', name); }
  async AddMCPServer(input: MCPServerInput): Promise<number> { return this.placeholderMethod('AddMCPServer', input); }
  async UpdateMCPServer(name: string, input: MCPServerInput): Promise<void> { return this.placeholderMethod('UpdateMCPServer', name, input); }
  async RemoveMCPServer(name: string): Promise<void> { return this.placeholderMethod('RemoveMCPServer', name); }
  async ReconnectMCPServer(name: string): Promise<void> { return this.placeholderMethod('ReconnectMCPServer', name); }
  async ClearMCPServerAuthentication(name: string): Promise<void> { return this.placeholderMethod('ClearMCPServerAuthentication', name); }
  async PickSkillFolder(): Promise<string> { return this.placeholderMethod('PickSkillFolder'); }
  async PickPluginFolder(): Promise<string> { return this.placeholderMethod('PickPluginFolder'); }
  async AddSkillPath(path: string): Promise<void> { return this.placeholderMethod('AddSkillPath', path); }
  async RemoveSkillPath(path: string): Promise<void> { return this.placeholderMethod('RemoveSkillPath', path); }
  async RefreshSkills(): Promise<void> { return this.placeholderMethod('RefreshSkills'); }
  async ReloadCommands(): Promise<void> { return this.placeholderMethod('ReloadCommands'); }
  async SetSkillEnabled(name: string, enabled: boolean): Promise<void> { return this.placeholderMethod('SetSkillEnabled', name, enabled); }
  async AvailableSubagentTools(): Promise<MCPToolView[]> { return this.placeholderMethod('AvailableSubagentTools'); }
  async CreateSubagentProfile(input: SubagentProfileInput): Promise<string> { return this.placeholderMethod('CreateSubagentProfile', input); }
  async UpdateSubagentProfile(name: string, scope: string, input: SubagentProfileInput): Promise<void> { return this.placeholderMethod('UpdateSubagentProfile', name, scope, input); }
  async DeleteSubagentProfile(name: string, scope: string): Promise<void> { return this.placeholderMethod('DeleteSubagentProfile', name, scope); }
  async SetSubagentProfileModel(name: string, ref: string): Promise<void> { return this.placeholderMethod('SetSubagentProfileModel', name, ref); }
  async SetSubagentProfileEffort(name: string, level: string): Promise<void> { return this.placeholderMethod('SetSubagentProfileEffort', name, level); }
  async TrySubagentProfile(input: SubagentProfileInput, task: string): Promise<string> { return this.placeholderMethod('TrySubagentProfile', input, task); }
  async CancelTrySubagentProfile(): Promise<void> { return this.placeholderMethod('CancelTrySubagentProfile'); }
  async SetMCPServerEnabled(name: string, enabled: boolean): Promise<void> { return this.placeholderMethod('SetMCPServerEnabled', name, enabled); }
  async SetMCPServerTier(name: string, tier: string): Promise<void> { return this.placeholderMethod('SetMCPServerTier', name, tier); }
  async SlashArgs(input: string): Promise<SlashArgsResult> { return this.placeholderMethod('SlashArgs', input); }
  async ListDir(rel: string): Promise<DirEntry[]> { return this.placeholderMethod('ListDir', rel); }
  async ListDirForTab(tabID: string, rel: string): Promise<DirEntry[]> { return this.placeholderMethod('ListDirForTab', tabID, rel); }
  async SearchFileRefs(query: string): Promise<DirEntry[]> { return this.placeholderMethod('SearchFileRefs', query); }
  async SearchFileRefsForTab(tabID: string, query: string): Promise<DirEntry[]> { return this.placeholderMethod('SearchFileRefsForTab', tabID, query); }
  async ReadFile(rel: string): Promise<FilePreview> { return this.placeholderMethod('ReadFile', rel); }
  async ReadFileForTab(tabID: string, rel: string): Promise<FilePreview> { return this.placeholderMethod('ReadFileForTab', tabID, rel); }
  async WorkspaceChanges(tabID: string): Promise<WorkspaceChangesView> { return this.placeholderMethod('WorkspaceChanges', tabID); }
  async GitBranches(): Promise<string[]> { return this.placeholderMethod('GitBranches'); }
  async GitCheckout(branch: string): Promise<void> { return this.placeholderMethod('GitCheckout', branch); }
  async WorkspaceGitHistory(tabID: string, path: string): Promise<GitCommitView[]> { return this.placeholderMethod('WorkspaceGitHistory', tabID, path); }
  async WorkspaceGitCommitDetail(tabID: string, hash: string, path: string): Promise<GitCommitDetailView> { return this.placeholderMethod('WorkspaceGitCommitDetail', tabID, hash, path); }
  async OpenWorkspacePath(rel: string): Promise<void> { return this.placeholderMethod('OpenWorkspacePath', rel); }
  async OpenWorkspacePathForTab(tabID: string, rel: string): Promise<void> { return this.placeholderMethod('OpenWorkspacePathForTab', tabID, rel); }
  async ExternalOpeners(): Promise<ExternalOpenersView> { return this.placeholderMethod('ExternalOpeners'); }
  async SetPreferredExternalOpener(id: string): Promise<void> { return this.placeholderMethod('SetPreferredExternalOpener', id); }
  async OpenWorkspaceInExternalOpener(id: string): Promise<void> { return this.placeholderMethod('OpenWorkspaceInExternalOpener', id); }
  async OpenWorkspaceInExternalOpenerForTab(tabID: string, id: string): Promise<void> { return this.placeholderMethod('OpenWorkspaceInExternalOpenerForTab', tabID, id); }
  async RevealWorkspacePath(rel: string): Promise<void> { return this.placeholderMethod('RevealWorkspacePath', rel); }
  async RevealWorkspacePathForTab(tabID: string, rel: string): Promise<void> { return this.placeholderMethod('RevealWorkspacePathForTab', tabID, rel); }
  async RevealPath(path: string): Promise<void> { return this.placeholderMethod('RevealPath', path); }
  async SavePastedImage(dataUrl: string): Promise<string> {
    const id = this.nextAttachmentId++;
    const path = `web-attachment://img-${id}.png`;
    this.attachments.set(path, { name: `pasted-${id}.png`, dataUrl });
    return path;
  }

  async SaveClipboardImage(): Promise<string> {
    // 纯 Web 环境无法从系统剪贴板直接取图像字节；返回占位符路径，保证 Composer 流程不崩溃
    const id = this.nextAttachmentId++;
    const path = `web-attachment://clipboard-${id}.png`;
    const placeholder =
      'data:image/svg+xml;utf8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    this.attachments.set(path, { name: `clipboard-${id}.png`, dataUrl: placeholder });
    return path;
  }

  async SavePastedFile(name: string, dataUrl: string): Promise<string> {
    const id = this.nextAttachmentId++;
    const safeName = name.replace(/[\\/:*?"<>|]/g, '_');
    const path = `web-attachment://file-${id}/${safeName}`;
    let bytes: Uint8Array | undefined;
    try {
      const comma = dataUrl.indexOf(',');
      if (comma !== -1) {
        const base64 = dataUrl.slice(comma + 1);
        const bin = atob(base64);
        const buf = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
        bytes = buf;
      }
    } catch { /* ignore decoding failures */ }
    this.attachments.set(path, { name: safeName, dataUrl, bytes });
    return path;
  }

  async PickExportFile(defaultFilename: string, mimeType: string): Promise<string> { return this.placeholderMethod('PickExportFile', defaultFilename, mimeType); }
  async SaveExportFile(path: string, payload: string, base64Encoded: boolean): Promise<void> { return this.placeholderMethod('SaveExportFile', path, payload, base64Encoded); }

  async AttachDropped(path: string): Promise<DroppedItem> {
    // Web 环境没有 OS 级别的拖放路径；但如果是浏览器上传的文件也不会走这里。
    // 此处如果传入的路径恰好是内存附件 key，直接返回 attachment。
    if (this.attachments.has(path)) {
      const att = this.attachments.get(path)!;
      return {
        kind: 'attachment',
        path,
        previewUrl: att.dataUrl,
      };
    }
    // 否则当成 workspace 引用，交给 expandFileReferences 读取真实文件
    return {
      kind: 'workspace',
      path,
      displayPath: path,
    };
  }

  async AttachmentDataURL(path: string): Promise<string> {
    const att = this.attachments.get(path);
    if (att) return att.dataUrl;
    // workspace 引用：没预览图就返回空字符串，UI 会降级为普通文件卡片
    return '';
  }
  async DeleteMemory(kind: string, pathOrName: string): Promise<void> {
    if (kind === 'doc' || kind === 'docs') {
      this.memoryState.docs = this.memoryState.docs.filter(d => d.path !== pathOrName);
    } else if (kind === 'archive' || kind === 'archives') {
      this.memoryState.archives = this.memoryState.archives.filter(a => a.path !== pathOrName);
    } else {
      this.memoryState.facts = this.memoryState.facts.filter(f => f.name !== pathOrName);
    }
    this.saveMemoryOnly();
  }
  async WriteMemory(kind: string, pathOrName: string, body: string, description?: string): Promise<void> {
    if (kind === 'doc' || kind === 'docs') {
      const scope = pathOrName.startsWith('project:') ? 'project' : 'user';
      this.memoryState.docs = this.memoryState.docs.filter(d => d.path !== pathOrName);
      this.memoryState.docs.push({ path: pathOrName, scope, body });
    } else if (kind === 'archive' || kind === 'archives') {
      this.memoryState.archives = this.memoryState.archives.filter(a => a.path !== pathOrName);
      this.memoryState.archives.push({
        path: pathOrName,
        name: pathOrName,
        title: description || pathOrName,
        description: description || '',
        type: 'archive',
        body,
        archivedAt: new Date().toISOString(),
      });
    } else {
      const type = /^(user|project|local|feedback|reference)$/.test(kind ?? '') ? kind : 'user';
      this.memoryState.facts = this.memoryState.facts.filter(f => f.name !== pathOrName);
      this.memoryState.facts.push({
        name: pathOrName,
        title: description || pathOrName,
        description: description || body.slice(0, 120),
        type,
        body,
      });
    }
    this.saveMemoryOnly();
  }
  async MarkMemoryUsed(_kind: string, _pathOrName: string): Promise<void> { /* Web 端不跟踪使用热度，空实现 */ }
  async MemoryUpsertMany(items: Array<{ kind: string; key: string; body?: string }>): Promise<void> {
    for (const it of items) {
      if (typeof it.body === 'string') await this.WriteMemory(it.kind, it.key, it.body);
    }
  }

  async ModelsForTab(_tabID: string): Promise<ModelInfo[]> { return this.Models(); }
  async SetModelForTab(tabID: string, name: string): Promise<void> { return this.placeholderMethod('SetModelForTab', tabID, name); }
  async EffortForTab(_tabID: string): Promise<EffortInfo> { return this.Effort(); }
  async SetEffortForTab(tabID: string, level: string): Promise<void> { return this.placeholderMethod('SetEffortForTab', tabID, level); }
  async SetTokenMode(mode: string): Promise<void> { return this.placeholderMethod('SetTokenMode', mode); }
  async SetTokenModeForTab(tabID: string, mode: string): Promise<void> { return this.placeholderMethod('SetTokenModeForTab', tabID, mode); }
  async MemoryForTab(_tabID: string): Promise<MemoryView> { return this.Memory(); }
  async MemorySuggestionsForTab(_tabID: string): Promise<MemorySuggestionsView> { return this.MemorySuggestions(); }
  async AcceptMemorySuggestion(suggestion: MemorySuggestion): Promise<string> {
    return this.Remember(
      suggestion.type === 'project' ? 'project' : 'user',
      suggestion.body,
      suggestion.name,
      suggestion.title,
      suggestion.description,
    );
  }
  async AcceptSkillSuggestion(suggestion: SkillSuggestion): Promise<string> { return this.placeholderMethod('AcceptSkillSuggestion', suggestion); }
  async AcceptMemorySuggestionForTab(_tabID: string, suggestion: MemorySuggestion): Promise<string> { return this.AcceptMemorySuggestion(suggestion); }
  async AcceptSkillSuggestionForTab(tabID: string, suggestion: SkillSuggestion): Promise<string> { return this.placeholderMethod('AcceptSkillSuggestionForTab', tabID, suggestion); }
  async Remember(scope: string, note: string, name?: string, title?: string, description?: string): Promise<string> {
    const safeScope = /^(user|project|local)$/.test(scope ?? '') ? scope! : 'user';
    const factName = name?.trim() || `note-${Date.now()}`;
    const fact: MemoryFact = {
      name: factName,
      title: title?.trim() || factName,
      description: description?.trim() || note.slice(0, 120),
      type: safeScope,
      body: note,
    };
    this.memoryState.facts = this.memoryState.facts.filter(f => f.name !== fact.name);
    this.memoryState.facts.push(fact);
    this.saveMemoryOnly();
    return fact.name;
  }
  async RememberForTab(_tabID: string, scope: string, note: string): Promise<string> { return this.Remember(scope, note); }
  async Forget(name: string): Promise<void> {
    this.memoryState.facts = this.memoryState.facts.filter(f => f.name !== name);
    this.memoryState.docs = this.memoryState.docs.filter(d => d.path !== name);
    this.saveMemoryOnly();
  }
  async ForgetForTab(_tabID: string, name: string): Promise<void> { return this.Forget(name); }
  async SaveDoc(path: string, body: string): Promise<string> {
    const scope = path.startsWith('project:') ? 'project' : 'user';
    this.memoryState.docs = this.memoryState.docs.filter(d => d.path !== path);
    this.memoryState.docs.push({ path, scope, body });
    this.saveMemoryOnly();
    return path;
  }
  async SaveDocForTab(_tabID: string, path: string, body: string): Promise<string> { return this.SaveDoc(path, body); }
  async DesktopStartupSettings(): Promise<DesktopStartupSettingsView> { return this.placeholderMethod('DesktopStartupSettings'); }
  async HooksSettings(scope: string): Promise<HooksSettingsView> { return this.placeholderMethod('HooksSettings', scope); }
  async SaveHooksSettings(scope: string, hooks: HookConfigView[]): Promise<void> { return this.placeholderMethod('SaveHooksSettings', scope, hooks); }
  async SaveHooksSettingsForRoot(scope: string, projectRoot: string, hooks: HookConfigView[]): Promise<void> { return this.placeholderMethod('SaveHooksSettingsForRoot', scope, projectRoot, hooks); }
  async TrustProjectHooks(): Promise<void> { return this.placeholderMethod('TrustProjectHooks'); }
  async TrustProjectHooksForRoot(projectRoot: string): Promise<void> { return this.placeholderMethod('TrustProjectHooksForRoot', projectRoot); }
  async SetDefaultModel(ref: string): Promise<void> { return this.placeholderMethod('SetDefaultModel', ref); }
  async SetPlannerModel(ref: string): Promise<void> { return this.placeholderMethod('SetPlannerModel', ref); }
  async SetSubagentModel(ref: string): Promise<void> { return this.placeholderMethod('SetSubagentModel', ref); }
  async SetSubagentEffort(level: string): Promise<void> { return this.placeholderMethod('SetSubagentEffort', level); }
  async SetMaxSubagentDepth(depth: number): Promise<void> { return this.placeholderMethod('SetMaxSubagentDepth', depth); }
  async SetAutoPlan(mode: string): Promise<void> { return this.placeholderMethod('SetAutoPlan', mode); }
  async SetDefaultToolApprovalMode(mode: string): Promise<void> { return this.placeholderMethod('SetDefaultToolApprovalMode', mode); }
  async SaveProvider(p: ProviderView): Promise<void> { return this.placeholderMethod('SaveProvider', p); }
  async SaveProviderWithKey(p: ProviderView, key: string): Promise<string> { return this.placeholderMethod('SaveProviderWithKey', p, key); }
  async AddOfficialProviderAccess(kind: string, key: string): Promise<string> { return this.placeholderMethod('AddOfficialProviderAccess', kind, key); }
  async AddProviderPresetAccess(id: string, key: string): Promise<string> { return this.placeholderMethod('AddProviderPresetAccess', id, key); }
  async ResetProviderPresetAccess(id: string): Promise<void> { return this.placeholderMethod('ResetProviderPresetAccess', id); }
  async FetchProviderModels(p: ProviderView): Promise<string[]> { return this.placeholderMethod('FetchProviderModels', p); }
  async DeleteProvider(name: string): Promise<void> { return this.placeholderMethod('DeleteProvider', name); }
  async RemoveProviderAccess(name: string): Promise<void> { return this.placeholderMethod('RemoveProviderAccess', name); }
  async SaveProviderKey(apiKeyEnv: string, value: string): Promise<string> { return this.placeholderMethod('SaveProviderKey', apiKeyEnv, value); }
  async SetProviderKey(apiKeyEnv: string, value: string): Promise<string> { return this.placeholderMethod('SetProviderKey', apiKeyEnv, value); }
  async ClearProviderKey(apiKeyEnv: string): Promise<void> { return this.placeholderMethod('ClearProviderKey', apiKeyEnv); }
  async SetPermissionMode(mode: string): Promise<void> { return this.placeholderMethod('SetPermissionMode', mode); }
  async AddPermissionRule(list: string, rule: string): Promise<void> { return this.placeholderMethod('AddPermissionRule', list, rule); }
  async RemovePermissionRule(list: string, rule: string): Promise<void> { return this.placeholderMethod('RemovePermissionRule', list, rule); }
  async ReloadSettings(): Promise<void> { return this.placeholderMethod('ReloadSettings'); }
  async SetSandbox(bash: string, network: boolean, workspaceRoot: string, allowWrite: string[], shell: string): Promise<void> { return this.placeholderMethod('SetSandbox', bash, network, workspaceRoot, allowWrite, shell); }
  async SetNetwork(n: NetworkView): Promise<void> { return this.placeholderMethod('SetNetwork', n); }
  async SetBotSettings(b: BotSettingsView): Promise<void> { return this.placeholderMethod('SetBotSettings', b); }
  async SetBotConnectionToolApprovalMode(connID: string, mode: string): Promise<void> { return this.placeholderMethod('SetBotConnectionToolApprovalMode', connID, mode); }
  async SetBotSecret(envName: string, value: string): Promise<void> { return this.placeholderMethod('SetBotSecret', envName, value); }
  async ClearBotSecret(envName: string): Promise<void> { return this.placeholderMethod('ClearBotSecret', envName); }
  async StartBotConnectionInstall(provider: string, domain: string): Promise<BotInstallStartResult> { return this.placeholderMethod('StartBotConnectionInstall', provider, domain); }
  async PollBotConnectionInstall(installID: string): Promise<BotInstallPollResult> { return this.placeholderMethod('PollBotConnectionInstall', installID); }
  async BotRuntimeStatus(): Promise<BotRuntimeStatusView> { return this.placeholderMethod('BotRuntimeStatus'); }
  async DiagnoseBotConnection(id: string): Promise<BotConnectionDiagnostic> { return this.placeholderMethod('DiagnoseBotConnection', id); }
  async TestBotConnection(id: string, target?: string): Promise<BotConnectionDiagnostic> { return this.placeholderMethod('TestBotConnection', id, target); }
  async SetCloseBehavior(mode: string): Promise<void> { return this.placeholderMethod('SetCloseBehavior', mode); }
  async SetDisplayMode(mode: string): Promise<void> { return this.placeholderMethod('SetDisplayMode', mode); }
  async SetStatusBarStyle(style: string): Promise<void> { return this.placeholderMethod('SetStatusBarStyle', style); }
  async SetStatusBarItems(items: string[]): Promise<void> { return this.placeholderMethod('SetStatusBarItems', items); }
  async SetDesktopLanguage(lang: string): Promise<void> { return this.placeholderMethod('SetDesktopLanguage', lang); }
  async SetDesktopAppearance(theme: string, style: string): Promise<void> { return this.placeholderMethod('SetDesktopAppearance', theme, style); }
  async SetDesktopLayoutStyle(style: string): Promise<void> { return this.placeholderMethod('SetDesktopLayoutStyle', style); }
  async SetDesktopZoomFactor(factor: number): Promise<void> { return this.placeholderMethod('SetDesktopZoomFactor', factor); }
  async GetDesktopZoomFactor(): Promise<number> { return this.placeholderMethod('GetDesktopZoomFactor'); }
  async RestartApplication(): Promise<void> { return this.placeholderMethod('RestartApplication'); }
  async SetDesktopCheckUpdates(enabled: boolean): Promise<void> { return this.placeholderMethod('SetDesktopCheckUpdates', enabled); }
  async SetDesktopTelemetry(enabled: boolean): Promise<void> { return this.placeholderMethod('SetDesktopTelemetry', enabled); }
  async SetDesktopMetrics(enabled: boolean): Promise<void> { return this.placeholderMethod('SetDesktopMetrics', enabled); }
  async SetMemoryCompilerEnabled(enabled: boolean): Promise<void> { return this.placeholderMethod('SetMemoryCompilerEnabled', enabled); }
  async SetExpandThinking(on: boolean): Promise<void> { return this.placeholderMethod('SetExpandThinking', on); }
  async MigrateDesktopPreferences(language: string, theme: string, style: string): Promise<void> { return this.placeholderMethod('MigrateDesktopPreferences', language, theme, style); }
  async SetAgentParams(temperature: number, maxSteps: number, plannerMaxSteps: number, systemPrompt: string): Promise<void> { return this.placeholderMethod('SetAgentParams', temperature, maxSteps, plannerMaxSteps, systemPrompt); }
  async SetColdResumePrune(enabled: boolean): Promise<void> { return this.placeholderMethod('SetColdResumePrune', enabled); }
  async SetReasoningLanguage(lang: string): Promise<void> { return this.placeholderMethod('SetReasoningLanguage', lang); }
  async SetTrayLocale(locale: "en" | "zh" | "zh-TW"): Promise<void> { return this.placeholderMethod('SetTrayLocale', locale); }
  async SetBypass(on: boolean): Promise<void> { return this.placeholderMethod('SetBypass', on); }
  async Version(): Promise<string> { return this.placeholderMethod('Version'); }
  async CheckUpdate(): Promise<UpdateInfo | null> { return this.placeholderMethod('CheckUpdate'); }
  async DownloadUpdate(): Promise<UpdateDownloadResult | null> { return this.placeholderMethod('DownloadUpdate'); }
  async InstallUpdate(): Promise<void> { return this.placeholderMethod('InstallUpdate'); }
  async ApplyUpdate(): Promise<void> { return this.placeholderMethod('ApplyUpdate'); }
  async OpenDownloadPage(): Promise<void> { return this.placeholderMethod('OpenDownloadPage'); }
  async NeedsOnboarding(): Promise<boolean> { return this.placeholderMethod('NeedsOnboarding'); }
  async ConnectKey(apiKey: string): Promise<string> { return this.placeholderMethod('ConnectKey', apiKey); }
  async ReportCrash(kind: string, detail: string): Promise<void> { return this.placeholderMethod('ReportCrash', kind, detail); }
  async OpenTopicSession(scope: string, workspaceRoot: string, topicID: string, sessionPath: string): Promise<TabMeta> {
    const tab = scope === 'project'
      ? await this.OpenProjectTab(workspaceRoot, topicID)
      : await this.OpenGlobalTab(topicID);
    if (sessionPath) tab.sessionPath = sessionPath;
    return tab;
  }

  async EnsureBlankTab(scope: string, workspaceRoot: string): Promise<TabMeta> {
    // 创建一个新的空白 tab（独立历史，不影响其他 tab）
    const topicID = `topic-${Date.now()}`;
    const tab = scope === 'project'
      ? await this.OpenProjectTab(workspaceRoot || '/', topicID)
      : await this.OpenGlobalTab(topicID);
    // OpenProjectTab/OpenGlobalTab 已经为新 tab 分配了空历史数组
    return tab;
  }

  async ActivateTopic(scope: string, workspaceRoot: string, topicID: string, sessionPath: string): Promise<TabMeta> {
    const tab = scope === 'project'
      ? await this.OpenProjectTab(workspaceRoot, topicID)
      : await this.OpenGlobalTab(topicID);
    if (sessionPath) tab.sessionPath = sessionPath;
    return tab;
  }

  async EnsureBlankSurface(scope: string, workspaceRoot: string): Promise<TabMeta> {
    // singleSurfaceLayout 模式下用此方法：清空所有 tab，只保留一个新的。
    // 注意：这里"清空 tab"对应桌面版关闭所有会话窗格，所以 tab 的历史会丢失是预期行为。
    this.tabs = [];
    this.histories.clear();
    return this.EnsureBlankTab(scope, workspaceRoot);
  }
  async RenameProject(workspaceRoot: string, title: string): Promise<void> { return this.placeholderMethod('RenameProject', workspaceRoot, title); }
  async SetProjectColor(workspaceRoot: string, color: string): Promise<void> { return this.placeholderMethod('SetProjectColor', workspaceRoot, color); }
  async SetProjectPinned(workspaceRoot: string, pinned: boolean): Promise<void> { return this.placeholderMethod('SetProjectPinned', workspaceRoot, pinned); }
  async ReorderProjects(workspaceRoots: string[]): Promise<void> { return this.placeholderMethod('ReorderProjects', workspaceRoots); }
  async CreateTopic(scope: string, workspaceRoot: string, title: string): Promise<TopicMeta> { return this.placeholderMethod('CreateTopic', scope, workspaceRoot, title); }
  async RenameTopic(topicID: string, title: string): Promise<void> { return this.placeholderMethod('RenameTopic', topicID, title); }
  async DeleteTopic(topicID: string): Promise<void> { return this.placeholderMethod('DeleteTopic', topicID); }
  async TrashTopic(topicID: string): Promise<void> { return this.placeholderMethod('TrashTopic', topicID); }
  async SetTopicPinned(topicID: string, pinned: boolean): Promise<void> { return this.placeholderMethod('SetTopicPinned', topicID, pinned); }
  async DeliveryWorktreeAvailability(workspaceRoot: string): Promise<any> { return this.placeholderMethod('DeliveryWorktreeAvailability', workspaceRoot); }
  async CreateDeliveryWorktree(workspaceRoot: string): Promise<any> { return this.placeholderMethod('CreateDeliveryWorktree', workspaceRoot); }

  // ==================== AiSOC 安全运营大脑桥接 ====================
  // 直接代理 aisoc-api.ts 中的方法（严格对齐 docs/frontend-api.md），
  // 供前端组件通过 app 绑定调用。若某些方法前端直接 import aisocApi 使用也完全可以。

  /** 设置 AiSOC 认证 token（存在内存，刷新丢失；若需持久化可存 localStorage） */
  async AisocSetAuthToken(token: string): Promise<void> {
    aisocApi.setAuthToken(token);
  }

  /** AiSOC 健康检查（GET /api/health） */
  async AisocHealthCheck(): Promise<{ status: string; service: string }> {
    return aisocApi.healthCheck();
  }

  /** 创建 AiSOC 任务（POST /api/tasks，单 POST 下发） */
  async AisocCreateTask(task: CreateTaskInput): Promise<{ task_id: string; status: string; domain: string }> {
    return aisocApi.createTask(task);
  }

  /** 获取 AiSOC 任务详情（GET /api/tasks/{id}，含阶段进度 + 思维链 + 判定） */
  async AisocGetTask(taskId: string): Promise<TaskDetail> {
    return aisocApi.getTask(taskId);
  }

  /** 导出 AiSOC 审计 JSON（GET /api/tasks/{id}/export） */
  async AisocExportTask(taskId: string): Promise<Record<string, unknown>> {
    return aisocApi.exportTask(taskId);
  }

  /** 列出 AiSOC 最近任务（GET /api/tasks?limit=） */
  async AisocListTasks(limit: number = 50): Promise<{ tasks: TaskInfo[] }> {
    return aisocApi.listTasks(limit);
  }

  /** 查询 AiSOC 证据（GET /api/findings?task_id=） */
  async AisocGetFindings(taskId: string): Promise<Finding[]> {
    return aisocApi.getFindings(taskId);
  }

  /** 获取 AiSOC 报告（GET /api/reports/{task_id}，report 为 Markdown 字符串） */
  async AisocGetReport(taskId: string): Promise<ReportDoc> {
    return aisocApi.getReport(taskId);
  }

  /** 审批 AiSOC 工具调用（POST /api/approve） */
  async AisocApproveTool(
    taskId: string,
    action: string,
    decision: 'approved' | 'denied',
  ): Promise<void> {
    return aisocApi.approveTool(taskId, action, decision);
  }

  /** AiSOC 部件注册表（GET /api/registry，token 已脱敏不渲染） */
  async AisocGetRegistry(): Promise<RegistryPart[]> {
    return aisocApi.getRegistry();
  }

  /** AiSOC 各 Agent 忙闲状态（GET /api/agents/status，状态墙） */
  async AisocGetAgentsStatus(): Promise<AgentsStatus> {
    return aisocApi.getAgentsStatus();
  }

  /** AiSOC XDR 告警样例（GET /api/data/alarms） */
  async AisocGetAlarms(limit: number = 10): Promise<{ source?: string; count?: number; alarms: Alarm[] }> {
    return aisocApi.getAlarms(limit);
  }

  /** AiSOC 告警统计（GET /api/data/alarms/summary） */
  async AisocGetAlarmsSummary(): Promise<AlarmsSummary> {
    return aisocApi.getAlarmsSummary();
  }

  /** 生成 AiSOC 任务 ID（T+YYYYMMDD-HHMMSSxxxx） */
  AisocGenerateTaskId(): string {
    return generateTaskId();
  }

  /** 生成 AiSOC Finding ID（F-<task_id>-<seq>） */
  AisocGenerateFindingId(taskId: string, sequence: number): string {
    return generateFindingId(taskId, sequence);
  }

  /** 创建特定域的 AiSOC API 客户端 */
  AisocCreateDomainClient(domain: string, authToken?: string) {
    return createDomainApiClient(domain, authToken);
  }

  /**
   * 发送事件给订阅者
   */
  private emitEvent(event: WireEvent) {
    this.eventListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        console.error('Event listener error:', error);
      }
    });
  }

  /**
   * 订阅事件流
   */
  onEvent(cb: (e: WireEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => {
      this.eventListeners.delete(cb);
    };
  }
}

/**
 * Web API单例实例
 */
let webApiInstance: WebApiProxy | null = null;

export function getWebApi(): WebApiProxy {
  if (!webApiInstance) {
    webApiInstance = new WebApiProxy();
  }
  return webApiInstance;
}

/**
 * 检查是否应该使用Web API（用于网页版）
 */
export function shouldUseWebApi(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.go?.main?.App) return false;
  return true;
}

export default WebApiProxy;