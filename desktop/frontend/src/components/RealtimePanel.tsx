/**
 * 实时面板组件
 * 按 docs/frontend-api.md §4.8（SSE）与 §4.1c（Agent 状态墙）实现
 * 显示Agent状态墙 + 流式输出区
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { RefreshCw, AlertCircle, CheckCircle2, Clock, Play, Pause, Eye, Activity } from 'lucide-react';
import { aisocApi, type StreamEvent, type Finding } from '../lib/aisoc-api';

/**
 * Agent状态
 */
interface AgentStatus {
  domain: string;           // 部件域名
  displayName: string;      // 显示名称
  status: 'idle' | 'running' | 'error' | 'waiting_approval';
  currentTask?: string;     // 当前任务ID
  currentPhase?: string;    // 当前阶段
  activeTools: ToolStatus[]; // 活跃工具列表
  lastUpdate: string;       // 最后更新时间
  busy?: boolean;           // 忙闲（来自 GET /api/agents/status）
  enabled?: boolean;        // 是否启用（来自 GET /api/agents/status）
}

/**
 * 工具状态
 */
interface ToolStatus {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed' | 'pending_approval';
  startTime: string;
  duration?: number;
  result?: string;
  error?: string;
}

/**
 * 任务输出
 */
interface TaskOutput {
  task_id: string;
  messages: Array<{
    timestamp: string;
    type: 'text' | 'reasoning' | 'tool_result' | 'error' | 'info';
    content: string;
  }>;
}

/**
 * 实时面板属性
 */
interface RealtimePanelProps {
  authToken?: string;        // 认证token
  autoConnect?: boolean;     // 是否自动连接
  maxMessages?: number;      // 每个任务最大消息数
  showTimestamp?: boolean;   // 是否显示时间戳
  onTaskClick?: (taskId: string) => void; // 任务点击回调
  onFindingClick?: (finding: Finding) => void; // 证据点击回调
}

export function RealtimePanel({
  authToken: _authToken,
  autoConnect = true,
  maxMessages = 1000,
  showTimestamp = true,
  onTaskClick,
  onFindingClick: _onFindingClick,
}: RealtimePanelProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<string, AgentStatus>>({});
  const [taskOutputs, setTaskOutputs] = useState<Record<string, TaskOutput>>({});
  const [mainTab, setMainTab] = useState<string>('agents'); // 主Tab：agents/outputs
  const [activeTaskFilter, setActiveTaskFilter] = useState<string>('all'); // 任务过滤

  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 部件显示名称映射
  const domainDisplayNames: Record<string, string> = {
    brain: '大脑',
    pentest: '渗透测试',
    logaudit: '日志审计',
    threatintel: '威胁情报',
    incident: '应急响应',
  };

  /**
   * 初始化部件状态
   */
  const initializeAgentStatus = useCallback((domain: string) => {
    if (!agentStatuses[domain]) {
      setAgentStatuses(prev => ({
        ...prev,
        [domain]: {
          domain,
          displayName: domainDisplayNames[domain] || domain,
          status: 'idle',
          activeTools: [],
          lastUpdate: new Date().toISOString(),
          busy: false,
        },
      }));
    }
  }, [agentStatuses]);

  /**
   * 更新Agent状态（文档 §4.8：10 种事件帧 {task_id, domain, event, payload}）
   */
  const updateAgentStatus = useCallback((event: StreamEvent) => {
    const { domain, task_id, event: eventName, payload } = event;

    if (!domain) return;

    initializeAgentStatus(domain);

    setAgentStatuses(prev => {
      const updated = { ...prev };
      const agent = { ...updated[domain] };

      agent.lastUpdate = new Date().toISOString();
      if (task_id) agent.currentTask = task_id;

      switch (eventName) {
        case 'task_created':
        case 'status_running':
          agent.status = 'running';
          break;
        case 'stage_start':
          agent.status = 'running';
          agent.currentPhase = typeof payload?.stage === 'string' ? payload.stage : 'unknown';
          break;
        case 'stage_finished':
          agent.status = 'running';
          agent.currentPhase = 'completed';
          break;
        case 'stage_failed':
          agent.status = 'error';
          agent.currentPhase = 'failed';
          break;
        case 'findings_stored':
          agent.status = 'running';
          if (payload?.tool) {
            const t = payload.tool as { name?: string } | string;
            const toolName = typeof t === 'string' ? t : t?.name;
            if (toolName) {
              const newTool: ToolStatus = {
                id: `${task_id}-${toolName}`,
                name: toolName,
                status: 'completed',
                startTime: new Date().toISOString(),
              };
              agent.activeTools = [...agent.activeTools.filter(x => x.id !== newTool.id), newTool];
            }
          }
          break;
        case 'verdict':
          agent.status = 'running';
          agent.currentPhase = 'verdict';
          break;
        case 'report_ready':
          agent.status = 'running';
          agent.currentPhase = 'report_ready';
          break;
        case 'status_completed':
          agent.status = 'idle';
          agent.currentPhase = 'completed';
          break;
        case 'status_failed':
          agent.status = 'error';
          agent.currentPhase = 'failed';
          break;
      }

      updated[domain] = agent;
      return updated;
    });
  }, [initializeAgentStatus]);

  /**
   * 添加任务输出（按新事件名转为可读文本）
   */
  const addTaskOutput = useCallback((event: StreamEvent) => {
    if (!event.task_id) return;

    const { event: eventName, payload, domain } = event;

    const messageTypes: Record<string, TaskOutput['messages'][number]['type']> = {
      task_created: 'info',
      status_running: 'info',
      stage_start: 'info',
      stage_finished: 'info',
      stage_failed: 'error',
      findings_stored: 'tool_result',
      verdict: 'text',
      report_ready: 'text',
      status_completed: 'info',
      status_failed: 'error',
    };
    const messageType = messageTypes[eventName] || 'info';

    let content = '';
    switch (eventName) {
      case 'task_created': content = `任务已创建（domain=${domain}）`; break;
      case 'status_running': content = '任务开始运行'; break;
      case 'stage_start': content = `阶段开始：${payload?.stage ?? '未知'}`; break;
      case 'stage_finished': content = `阶段完成：${payload?.stage ?? '未知'}`; break;
      case 'stage_failed': content = `阶段失败：${payload?.stage ?? '未知'}${payload?.error ? ` — ${payload.error}` : ''}`; break;
      case 'findings_stored': content = `新发现入库（domain=${domain}）${typeof payload?.count === 'number' ? ` ×${payload.count}` : ''}`; break;
      case 'verdict': content = `判定：${payload?.verdict ?? '未知'}${typeof payload?.confidence === 'number' ? `（置信度 ${Math.round(payload.confidence * 100)}%）` : ''}`; break;
      case 'report_ready': content = '报告已就绪'; break;
      case 'status_completed': content = '任务已完成'; break;
      case 'status_failed': content = `任务失败${payload?.error ? `：${payload.error}` : ''}`; break;
    }

    setTaskOutputs(prev => {
      const updated = { ...prev };
      if (!updated[event.task_id!]) {
        updated[event.task_id!] = {
          task_id: event.task_id!,
          messages: [],
        };
      }

      const taskOutput = updated[event.task_id!];
      taskOutput.messages.push({
        timestamp: new Date().toISOString(),
        type: messageType,
        content,
      });

      // 限制消息数量
      if (taskOutput.messages.length > maxMessages) {
        taskOutput.messages = taskOutput.messages.slice(-maxMessages);
      }

      return updated;
    });
  }, [maxMessages]);

  /**
   * 处理实时事件
   */
  const handleRealtimeEvent = useCallback((event: StreamEvent) => {
    console.log('Realtime event received:', event);

    // 更新Agent状态
    updateAgentStatus(event);

    // 添加任务输出
    addTaskOutput(event);
  }, [updateAgentStatus, addTaskOutput]);

  /**
   * 连接SSE流
   */
  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    try {
      const eventSource = aisocApi.connectRealtimeStream(
        handleRealtimeEvent,
        (error) => {
          console.error('SSE connection error:', error);
          setConnectionError('连接中断，正在重连...');
          setIsConnected(false);

          // 自动重连
          if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
          }
          reconnectTimeoutRef.current = setTimeout(() => {
            setConnectionError(null);
            connect();
          }, 5000);
        }
      );

      eventSourceRef.current = eventSource;
      setIsConnected(true);
      setConnectionError(null);
    } catch (error) {
      console.error('Failed to connect to SSE stream:', error);
      setConnectionError('连接失败');
      setIsConnected(false);
    }
  }, [handleRealtimeEvent]);

  /**
   * 断开连接
   */
  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    setIsConnected(false);
  }, []);

  /**
   * Agent 状态墙忙闲轮询（文档 §4.1c GET /api/agents/status）
   * 用 busy/enabled 覆盖各 domain 的 busy 与启用状态，SSE 事件继续驱动 running/error 等
   */
  const refreshAgentsStatus = useCallback(async () => {
    try {
      const data = await aisocApi.getAgentsStatus();
      if (!data?.parts?.length) return;
      setAgentStatuses(prev => {
        const next = { ...prev };
        for (const p of data.parts) {
          const d = p.domain;
          if (!next[d]) {
            next[d] = {
              domain: d,
              displayName: domainDisplayNames[d] || d,
              status: 'idle',
              activeTools: [],
              lastUpdate: new Date().toISOString(),
              busy: !!p.busy,
              enabled: p.enabled,
            };
          } else {
            next[d] = { ...next[d], busy: !!p.busy, enabled: p.enabled, lastUpdate: new Date().toISOString() };
          }
        }
        return next;
      });
    } catch {
      // 大脑离线时静默失败，由 SSE 重连与全局离线横幅提示
    }
  }, []);

  useEffect(() => {
    refreshAgentsStatus();
    const id = setInterval(refreshAgentsStatus, 5000);
    return () => clearInterval(id);
  }, [refreshAgentsStatus]);

  /**
   * 清理定时器和连接
   */
  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      disconnect();
    };
  }, [autoConnect, connect, disconnect]);

  /**
   * 获取工具状态图标
   */
  const getToolStatusIcon = (status: ToolStatus['status']) => {
    switch (status) {
      case 'running':
        return <Play className="h-3 w-3 text-blue-500" />;
      case 'completed':
        return <CheckCircle2 className="h-3 w-3 text-green-500" />;
      case 'failed':
        return <AlertCircle className="h-3 w-3 text-red-500" />;
      case 'pending_approval':
        return <Clock className="h-3 w-3 text-yellow-500" />;
    }
  };

  /**
   * 获取Agent状态颜色
   */
  const getAgentStatusColor = (status: AgentStatus['status']) => {
    switch (status) {
      case 'idle':
        return 'bg-gray-100 border-gray-300';
      case 'running':
        return 'bg-blue-50 border-blue-300';
      case 'error':
        return 'bg-red-50 border-red-300';
      case 'waiting_approval':
        return 'bg-yellow-50 border-yellow-300';
    }
  };

  /**
   * 格式化时间戳
   */
  const formatTimestamp = (timestamp: string) => {
    if (!showTimestamp) return '';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  /**
   * 渲染Agent状态卡片
   */
  const renderAgentCard = (domain: string, agent: AgentStatus) => (
    <div
      key={domain}
      className={`mb-3 border-l-4 ${getAgentStatusColor(agent.status)} bg-white rounded-lg shadow-sm hover:shadow-md transition-all p-4`}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-lg font-semibold">{agent.displayName}</div>
        <div className={`px-2 py-1 rounded text-xs font-medium ${
          agent.status === 'running' ? 'bg-blue-100 text-blue-800' :
          agent.status === 'error' ? 'bg-red-100 text-red-800' :
          agent.status === 'waiting_approval' ? 'bg-yellow-100 text-yellow-800' :
          'bg-gray-100 text-gray-800'
        }`}>
          {agent.status}
        </div>
      </div>
      {typeof agent.busy === 'boolean' && (
        <div className={`text-xs mb-2 ${agent.busy ? 'text-blue-600' : 'text-gray-500'}`}>
          {agent.busy ? '● 忙（有任务排队执行）' : '○ 空闲'}
          {typeof agent.enabled === 'boolean' && !agent.enabled && (
            <span className="ml-2 text-red-600">（部件未启用）</span>
          )}
        </div>
      )}
      {agent.currentTask && (
        <div className="text-sm text-gray-600 mb-2">
          任务: {agent.currentTask}
          {agent.currentPhase && ` | 阶段: ${agent.currentPhase}`}
        </div>
      )}
      <div className="mt-3">
        {agent.activeTools.length > 0 ? (
          <div className="space-y-2">
            {agent.activeTools.map(tool => (
              <div key={tool.id} className="flex items-center justify-between text-sm py-1">
                <div className="flex items-center gap-2">
                  {getToolStatusIcon(tool.status)}
                  <span className="font-medium">{tool.name}</span>
                  {tool.duration && <span className="text-gray-500">({tool.duration}ms)</span>}
                </div>
                {tool.error && (
                  <div className="px-2 py-1 bg-red-100 text-red-800 rounded text-xs">
                    {tool.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-gray-500 italic">无活跃工具</div>
        )}
      </div>
    </div>
  );

  /**
   * 渲染任务输出
   */
  const renderTaskOutput = (taskId: string, output: TaskOutput) => (
    <div key={taskId} className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-medium">任务 {taskId}</h4>
        {onTaskClick && (
          <button
            className="text-sm px-3 py-1 bg-blue-50 text-blue-700 rounded hover:bg-blue-100 transition-colors"
            onClick={() => onTaskClick(taskId)}
          >
            <div className="flex items-center gap-1">
              <Eye className="h-3 w-3" />
              查看详情
            </div>
          </button>
        )}
      </div>
      <div className="h-96 w-full rounded border overflow-y-auto">
        <div className="p-3 space-y-1">
          {output.messages.map((msg, index) => (
            <div
              key={index}
              className={`text-sm ${
                msg.type === 'error' ? 'text-red-600' :
                msg.type === 'reasoning' ? 'text-blue-600' :
                msg.type === 'tool_result' ? 'text-green-600' :
                'text-gray-700'
              }`}
            >
              <span className="text-xs text-gray-500 mr-2">
                {formatTimestamp(msg.timestamp)}
              </span>
              <span className={msg.type === 'reasoning' ? 'italic' : ''}>
                {msg.content}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const taskList = Object.keys(taskOutputs);
  const activeTaskOutputs = activeTaskFilter === 'all'
    ? taskOutputs
    : Object.fromEntries(
        Object.entries(taskOutputs).filter(([taskId]) => taskId === activeTaskFilter)
      );

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* 控制栏 */}
      <div className="flex items-center justify-between p-4 border-b bg-white">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Activity className="h-5 w-5" />
          实时监控面板
        </h2>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <div
              className={`w-2 h-2 rounded-full ${
                isConnected ? 'bg-green-500' : 'bg-red-500'
              }`}
            />
            <span className="text-sm text-gray-600">
              {isConnected ? '已连接' : '未连接'}
            </span>
          </div>
          {isConnected ? (
            <button
              className="text-sm px-3 py-1 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
              onClick={disconnect}
            >
              <div className="flex items-center gap-1">
                <Pause className="h-4 w-4" />
                断开
              </div>
            </button>
          ) : (
            <button
              className="text-sm px-3 py-1 border border-gray-300 rounded hover:bg-gray-50 transition-colors"
              onClick={connect}
            >
              <div className="flex items-center gap-1">
                <RefreshCw className="h-4 w-4" />
                连接
              </div>
            </button>
          )}
        </div>
      </div>

      {connectionError && (
        <div className="bg-yellow-50 border border-yellow-200 p-3 m-4 rounded">
          <div className="flex items-center gap-2 text-yellow-800">
            <AlertCircle className="h-4 w-4" />
            <span>{connectionError}</span>
          </div>
        </div>
      )}

      {/* 主要内容区域 */}
      <div className="flex-1 overflow-hidden flex flex-col">
        {/* 简单的Tab切换 */}
        <div className="border-b bg-white">
          <div className="flex">
            <button
              className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${
                mainTab === 'agents'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setMainTab('agents')}
            >
              Agent状态墙
            </button>
            <button
              className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${
                mainTab === 'outputs'
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
              onClick={() => setMainTab('outputs')}
            >
              流式输出区
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {mainTab === 'agents' ? (
            Object.keys(agentStatuses).length > 0 ? (
              Object.entries(agentStatuses).map(([domain, agent]) =>
                renderAgentCard(domain, agent)
              )
            ) : (
              <div className="text-center text-gray-500 py-8">
                暂无Agent活动
              </div>
            )
          ) : (
            taskList.length > 0 ? (
              <>
                {taskList.length > 1 && (
                  <div className="mb-4">
                    <div className="flex flex-wrap gap-2">
                      <button
                        className={`px-3 py-1 text-sm rounded transition-colors ${
                          activeTaskFilter === 'all'
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                        }`}
                        onClick={() => setActiveTaskFilter('all')}
                      >
                        全部任务
                      </button>
                      {taskList.map(taskId => (
                        <button
                          key={taskId}
                          className={`px-3 py-1 text-sm rounded transition-colors ${
                            activeTaskFilter === taskId
                              ? 'bg-blue-500 text-white'
                              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                          }`}
                          onClick={() => setActiveTaskFilter(taskId)}
                        >
                          {taskId}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {Object.entries(activeTaskOutputs).map(([taskId, output]) =>
                  renderTaskOutput(taskId, output)
                )}
              </>
            ) : (
              <div className="text-center text-gray-500 py-8">
                暂无任务输出
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

export default RealtimePanel;