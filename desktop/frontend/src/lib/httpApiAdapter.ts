/**
 * HTTP API适配器
 * 用于在浏览器环境中连接到reasonix HTTP服务，替代mock数据
 *
 * 当reasonix serve运行时，前端可以通过HTTP API连接到真实服务
 * 而不是使用mock数据
 */

import type {
  HistoryMessage,
  Meta,
  ContextInfo,
  BalanceInfo,
  ModelInfo,
  SettingsView,
  CapabilitiesView,
  SessionMeta,
  WireEvent,
} from './types';

// HTTP API端点配置
// 浏览器模式通过 3000 代理访问 reasonix，相对路径走 serve_frontend.py 路由：
//   /aisoc-pentest/api/* → proxy strip → 8787/* (reasonix 原生无前缀路由)
// Wails 桌面端优先走 Go 绑定，此适配器仅作为 HTTP 降级兜底。
const HTTP_API_BASE_URL = '/aisoc-pentest/api';
const API_TIMEOUT = 30000; // 30秒超时

/**
 * HTTP API客户端类
 * 实现与reasonix HTTP服务的通信
 */
class HttpApiClient {
  private baseUrl: string;
  private authToken: string | null = null;
  private eventSource: EventSource | null = null;

  constructor(baseUrl: string = HTTP_API_BASE_URL) {
    this.baseUrl = baseUrl;
    // 尝试从localStorage获取auth token
    this.authToken = localStorage.getItem('reasonix_auth_token');
  }

  /**
   * 设置认证token
   */
  setAuthToken(token: string): void {
    this.authToken = token;
    localStorage.setItem('reasonix_auth_token', token);
  }

  /**
   * 清除认证token
   */
  clearAuthToken(): void {
    this.authToken = null;
    localStorage.removeItem('reasonix_auth_token');
  }

  /**
   * 通用HTTP请求方法
   */
  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>,
    };

    // 添加认证头
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(API_TIMEOUT),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      return response.json();
    } catch (error) {
      console.error('HTTP API request failed:', error);
      throw error;
    }
  }

  /**
   * 提交用户输入
   */
  async submit(input: string): Promise<void> {
    return this.request('/submit', {
      method: 'POST',
      body: JSON.stringify({ input }),
    });
  }

  /**
   * 取消当前任务
   */
  async cancel(): Promise<void> {
    return this.request('/cancel', {
      method: 'POST',
    });
  }

  /**
   * 批准工具调用
   */
  async approve(id: string, allow: boolean): Promise<void> {
    return this.request('/approve', {
      method: 'POST',
      body: JSON.stringify({ id, allow }),
    });
  }

  /**
   * 获取历史消息
   */
  async history(): Promise<HistoryMessage[]> {
    return this.request<HistoryMessage[]>('/history');
  }

  /**
   * 获取元数据
   */
  async meta(): Promise<Meta> {
    return this.request<Meta>('/meta');
  }

  /**
   * 获取上下文使用情况
   */
  async contextUsage(): Promise<ContextInfo> {
    return this.request<ContextInfo>('/context');
  }

  /**
   * 获取余额信息
   */
  async balance(): Promise<BalanceInfo> {
    return this.request<BalanceInfo>('/balance');
  }

  /**
   * 获取模型信息
   */
  async models(): Promise<ModelInfo[]> {
    return this.request<ModelInfo[]>('/models');
  }

  /**
   * 获取设置
   */
  async settings(): Promise<SettingsView> {
    return this.request<SettingsView>('/settings');
  }

  /**
   * 获取能力信息
   */
  async capabilities(): Promise<CapabilitiesView> {
    return this.request<CapabilitiesView>('/capabilities');
  }

  /**
   * 获取会话列表
   */
  async sessions(): Promise<SessionMeta[]> {
    return this.request<SessionMeta[]>('/sessions');
  }

  /**
   * 连接到事件流
   */
  connectEventStream(onEvent: (event: WireEvent) => void, onError?: (error: Event) => void): EventSource {
    if (this.eventSource) {
      this.eventSource.close();
    }

    const eventUrl = `${this.baseUrl}/events`;
    this.eventSource = new EventSource(eventUrl);

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onEvent(data as WireEvent);
      } catch (error) {
        console.error('Failed to parse SSE event:', error);
      }
    };

    if (onError) {
      this.eventSource.onerror = onError;
    }

    return this.eventSource;
  }

  /**
   * 断开事件流
   */
  disconnectEventStream(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<{ status: string; version: string }> {
    return this.request('/health');
  }

  /**
   * 检查服务是否可用
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.healthCheck();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 创建HTTP API适配器的单例实例
 */
let httpApiClient: HttpApiClient | null = null;

export function getHttpClient(): HttpApiClient | null {
  if (!httpApiClient) {
    httpApiClient = new HttpApiClient();
  }
  return httpApiClient;
}

export function setHttpClient(client: HttpApiClient): void {
  httpApiClient = client;
}

export function clearHttpClient(): void {
  if (httpApiClient) {
    httpApiClient.disconnectEventStream();
    httpApiClient = null;
  }
}

/**
 * 检查HTTP服务是否可用
 */
export async function checkHttpServiceAvailable(): Promise<boolean> {
  try {
    const client = getHttpClient();
    if (!client) return false;
    return await client.isAvailable();
  } catch {
    return false;
  }
}

export default HttpApiClient;