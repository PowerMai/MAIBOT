/**
 * MCP Server 管理组件
 * 
 * 功能：
 * 1. 显示 MCP Server 状态
 * 2. 启动/停止 MCP Server
 * 3. 配置 MCP Server 参数
 * 
 * 设计原则（Claude 风格）：
 * - MCP 是后端能力扩展，用户无需了解细节
 * - 简洁的状态显示，一键启动/停止
 * - 高级配置折叠显示
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Switch } from './ui/switch';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './ui/collapsible';
import {
  Server,
  Play,
  Square,
  RefreshCw,
  ChevronDown,
  Database,
  Globe,
  FolderOpen,
  AlertCircle,
  CheckCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { isElectronEnv } from '../lib/services/electronService';
import { getApiBase } from '../lib/api/langserveChat';
import { t } from '../lib/i18n';
import { safeParseResponseJson, isParseError } from '../lib/utils/api-helpers';

// ============================================================
// 类型定义
// ============================================================

interface MCPServerStatus {
  name: string;
  type: string;
  running: boolean;
  pid?: number;
  transport?: string;
  url?: string;
}

interface MCPServerConfig {
  type: 'filesystem' | 'puppeteer' | 'sqlite' | 'postgres' | 'custom';
  name: string;
  description: string;
  enabled: boolean;
  config?: Record<string, string>;
}

interface MCPTemplate {
  id: string;
  label: string;
  description: string;
  serverNames: string[];
  defaults: Record<string, Record<string, string>>;
}

/** 后端 MCP 状态（LangGraph Server 侧已连接的 MCP） */
interface BackendMCPStatus {
  success: boolean;
  connected_servers?: string[];
  tools_count?: number;
  error?: string;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_SERVERS: MCPServerConfig[] = [
  {
    type: 'filesystem',
    name: 'filesystem',
    description: '本地文件系统操作 (read, write, edit, ls, glob, grep)',
    enabled: false,
    config: {
      workspacePath: '',
    },
  },
  {
    type: 'sqlite',
    name: 'sqlite',
    description: 'SQLite 数据库操作 (query, execute)',
    enabled: false,
    config: {
      dbPath: ':memory:',
    },
  },
  {
    type: 'puppeteer',
    name: 'puppeteer',
    description: '浏览器自动化 (navigate, screenshot, click, type)',
    enabled: false,
  },
];

const MCP_TEMPLATES: MCPTemplate[] = [
  {
    id: 'macos-automation',
    label: 'macOS 自动化模板',
    description: '文件系统 + 浏览器自动化 + 本地 SQLite，适合桌面自动化与网页流程联动。',
    serverNames: ['filesystem', 'puppeteer', 'sqlite'],
    defaults: {
      filesystem: { workspacePath: '.' },
      sqlite: { dbPath: './data/mcp.db' },
    },
  },
];

// ============================================================
// 组件
// ============================================================

export function MCPManager() {
  const [servers, setServers] = useState<MCPServerConfig[]>(DEFAULT_SERVERS);
  const [statuses, setStatuses] = useState<MCPServerStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [backendMCP, setBackendMCP] = useState<BackendMCPStatus | null>(null);
  const mountedRef = useRef(true);

  const isElectron = isElectronEnv();
  const isMac = isElectron && window.electron?.platform === 'darwin';

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 获取后端 MCP 状态（LangGraph Server 侧）
  const fetchBackendMCP = useCallback(async () => {
    try {
      const base = getApiBase();
      const res = await fetch(`${base}/mcp/status`, { method: 'GET' });
      const data = await safeParseResponseJson(res);
      if (!mountedRef.current) return;
      if (isParseError(data)) {
        toast.error(t('composer.responseParseFailed'));
        setBackendMCP({ success: false, error: t('composer.responseParseFailed') });
        return;
      }
      const payload = data as BackendMCPStatus;
      setBackendMCP({
        success: payload.success ?? false,
        connected_servers: payload.connected_servers,
        tools_count: payload.tools_count,
        error: payload.error,
      });
    } catch (e) {
      if (mountedRef.current) {
        setBackendMCP({ success: false, error: String(e) });
        toast.error(t('editor.mcpListLoadError'), { description: e instanceof Error ? e.message : String(e) });
      }
    }
  }, []);

  // 获取状态
  const fetchStatus = useCallback(async () => {
    if (!isElectron) return;
    try {
      const result = await window.electron!.mcpGetStatus();
      if (mountedRef.current && result.success) {
        setStatuses(result.servers || []);
      }
    } catch (error) {
      console.error('[MCP] 获取状态失败:', error);
    }
  }, [isElectron]);

  // 初始加载
  useEffect(() => {
    fetchStatus();
    fetchBackendMCP();
    const interval = setInterval(fetchStatus, 5000);
    const backendInterval = setInterval(fetchBackendMCP, 10000);
    return () => {
      clearInterval(interval);
      clearInterval(backendInterval);
    };
  }, [fetchStatus, fetchBackendMCP]);

  // 启动服务器
  const startServer = async (server: MCPServerConfig) => {
    if (!isElectron) {
      toast.error('MCP Server 只能在 Electron 桌面应用中启动');
      return;
    }
    if (mountedRef.current) setLoading(true);
    try {
      const result = await window.electron!.mcpStartServer({
        type: server.type,
        name: server.name,
        config: server.config || {},
      });
      if (!mountedRef.current) return;
      if (result.success) {
        toast.success(`${server.name} 服务器已启动`);
        await fetchStatus();
        if (mountedRef.current) {
          setServers(prev =>
            prev.map(s =>
              s.name === server.name ? { ...s, enabled: true } : s
            )
          );
        }
      } else {
        toast.error(`启动失败: ${result.error}`);
      }
    } catch (error) {
      if (mountedRef.current) toast.error(`启动失败: ${error}`);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  // 停止服务器
  const stopServer = async (name: string) => {
    if (!isElectron) return;
    if (mountedRef.current) setLoading(true);
    try {
      const result = await window.electron!.mcpStopServer({ name });
      if (!mountedRef.current) return;
      if (result.success) {
        toast.success(`${name} 服务器已停止`);
        await fetchStatus();
        if (mountedRef.current) {
          setServers(prev =>
            prev.map(s =>
              s.name === name ? { ...s, enabled: false } : s
            )
          );
        }
      } else {
        toast.error(`停止失败: ${result.error}`);
      }
    } catch (error) {
      if (mountedRef.current) toast.error(`停止失败: ${error}`);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  // 停止所有
  const stopAll = async () => {
    if (!isElectron) return;
    if (mountedRef.current) setLoading(true);
    try {
      await window.electron!.mcpStopAll();
      if (!mountedRef.current) return;
      toast.success('所有 MCP 服务器已停止');
      await fetchStatus();
      if (mountedRef.current) {
        setServers(prev =>
          prev.map(s => ({ ...s, enabled: false }))
        );
      }
    } catch (error) {
      if (mountedRef.current) toast.error(`停止失败: ${error}`);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const applyTemplate = (template: MCPTemplate) => {
    setServers(prev =>
      prev.map(server => {
        if (!template.serverNames.includes(server.name)) {
          return server;
        }
        const templateConfig = template.defaults[server.name] || {};
        return {
          ...server,
          enabled: true,
          config: { ...(server.config || {}), ...templateConfig },
        };
      })
    );
    toast.success(`已应用模板：${template.label}`);
  };

  const startTemplate = async (template: MCPTemplate) => {
    if (!isElectron) {
      toast.error('MCP Server 只能在 Electron 桌面应用中启动');
      return;
    }
    if (mountedRef.current) setLoading(true);
    try {
      const currentServers = servers;
      for (const name of template.serverNames) {
        const server = currentServers.find(s => s.name === name);
        if (!server) continue;
        const mergedServer: MCPServerConfig = {
          ...server,
          enabled: true,
          config: { ...(server.config || {}), ...(template.defaults[name] || {}) },
        };
        const result = await window.electron!.mcpStartServer({
          type: mergedServer.type,
          name: mergedServer.name,
          config: mergedServer.config || {},
        });
        if (!result.success) {
          throw new Error(result.error || `${mergedServer.name} 启动失败`);
        }
      }
      if (!mountedRef.current) return;
      setServers(prev =>
        prev.map(s =>
          template.serverNames.includes(s.name)
            ? { ...s, enabled: true, config: { ...(s.config || {}), ...(template.defaults[s.name] || {}) } }
            : s
        )
      );
      await fetchStatus();
      if (mountedRef.current) toast.success(`模板已启动：${template.label}`);
    } catch (error) {
      if (mountedRef.current) toast.error(`模板启动失败: ${error}`);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  // 获取服务器图标
  const getServerIcon = (type: string) => {
    switch (type) {
      case 'filesystem':
        return <FolderOpen className="h-4 w-4" />;
      case 'sqlite':
      case 'postgres':
        return <Database className="h-4 w-4" />;
      case 'puppeteer':
        return <Globe className="h-4 w-4" />;
      default:
        return <Server className="h-4 w-4" />;
    }
  };

  // 获取服务器状态
  const getServerStatus = (name: string): MCPServerStatus | undefined => {
    return statuses.find(s => s.name === name);
  };

  // 非 Electron 环境提示
  if (!isElectron) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Server className="h-5 w-5" />
            MCP Server 管理
          </CardTitle>
          <CardDescription>
            MCP (Model Context Protocol) 服务器提供扩展能力
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-muted-foreground">
            <AlertCircle className="h-4 w-4" />
            <span>MCP Server 管理仅在 Electron 桌面应用中可用</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Server className="h-5 w-5" />
              MCP Server 管理
            </CardTitle>
            <CardDescription>
              MCP (Model Context Protocol) 服务器提供扩展能力。需要账号/密码或 API Key 的服务器请在 <code className="text-[11px] bg-muted px-1 rounded">backend/config/mcp_servers.json</code> 的 <code className="text-[11px] bg-muted px-1 rounded">env</code> 中使用 <code className="text-[11px] bg-muted px-1 rounded">{'{'}env:环境变量名{'}'}</code>，敏感值通过环境变量或系统密钥链配置，勿写明文。
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={fetchStatus}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
            {statuses.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={stopAll}
                disabled={loading}
              >
                停止全部
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 后端 MCP 状态（LangGraph Server 侧） */}
        <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">后端 MCP (LangGraph Server)</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { fetchBackendMCP(); }}
              disabled={loading}
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
          {backendMCP === null ? (
            <p className="text-xs text-muted-foreground">加载中...</p>
          ) : backendMCP.success ? (
            <div className="text-xs text-muted-foreground space-y-1">
              <p>已连接: {Array.isArray(backendMCP.connected_servers) ? backendMCP.connected_servers.length : 0} 个服务器</p>
              {typeof backendMCP.tools_count === 'number' && (
                <p>工具数: {backendMCP.tools_count}</p>
              )}
              {Array.isArray(backendMCP.connected_servers) && backendMCP.connected_servers.length > 0 && (
                <p className="truncate" title={backendMCP.connected_servers.join(', ')}>
                  {backendMCP.connected_servers.join(', ')}
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              {backendMCP.error || '后端 MCP 不可用'}
            </p>
          )}
        </div>

        {/* 服务器列表 */}
        {servers.map((server) => {
          const status = getServerStatus(server.name);
          const isRunning = status?.running ?? false;

          return (
            <div
              key={server.name}
              className="flex items-center justify-between p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                {getServerIcon(server.type)}
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{server.name}</span>
                    {isRunning ? (
                      <Badge variant="default" className="bg-green-500">
                        <CheckCircle className="h-3 w-3 mr-1" />
                        运行中
                      </Badge>
                    ) : (
                      <Badge variant="secondary">已停止</Badge>
                    )}
                    {status?.pid && (
                      <span className="text-xs text-muted-foreground">
                        PID: {status.pid}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {server.description}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isRunning ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => stopServer(server.name)}
                    disabled={loading}
                  >
                    <Square className="h-4 w-4 mr-1" />
                    停止
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => startServer(server)}
                    disabled={loading}
                  >
                    <Play className="h-4 w-4 mr-1" />
                    启动
                  </Button>
                )}
              </div>
            </div>
          );
        })}

        {/* 高级配置 */}
        <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-between">
              <span>高级配置</span>
              <ChevronDown
                className={`h-4 w-4 transition-transform ${
                  isAdvancedOpen ? 'rotate-180' : ''
                }`}
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="space-y-4 pt-4">
            <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
              <p className="text-sm font-medium">推荐模板</p>
              {MCP_TEMPLATES.map((template) => (
                <div key={template.id} className="rounded-md border bg-background p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium">{template.label}</p>
                      <p className="text-xs text-muted-foreground">{template.description}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => applyTemplate(template)}
                        disabled={loading}
                      >
                        应用模板
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => startTemplate(template)}
                        disabled={loading || (template.id === 'macos-automation' && !isMac)}
                      >
                        一键启动
                      </Button>
                    </div>
                  </div>
                  {template.id === 'macos-automation' && !isMac && (
                    <p className="text-xs text-muted-foreground">
                      该模板为 macOS 优化，当前系统将禁用一键启动。
                    </p>
                  )}
                </div>
              ))}
            </div>
            <div className="text-sm text-muted-foreground">
              <p className="mb-2">MCP Server 使用说明：</p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <strong>filesystem</strong>: 提供文件系统操作，需要指定工作区路径
                </li>
                <li>
                  <strong>sqlite</strong>: 提供 SQLite 数据库操作，可用于本地数据存储
                </li>
                <li>
                  <strong>puppeteer</strong>: 提供浏览器自动化，可用于网页抓取
                </li>
              </ul>
              <p className="mt-2">
                安装命令：
                <code className="ml-2 px-2 py-1 bg-muted rounded text-xs">
                  npm install -g @modelcontextprotocol/server-filesystem
                </code>
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

export default MCPManager;
