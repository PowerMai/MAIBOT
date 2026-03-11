/**
 * MCP Server 管理器 - 使用官方 MCP 服务器
 * 
 * 使用官方 @modelcontextprotocol/server-filesystem 而非自定义实现
 * 
 * 架构说明：
 * - 本地 MCP Server 使用官方实现
 * - 云端 DeepAgent 通过 langchain-mcp-adapters 调用
 * - 用户文件始终在本地，不上传云端
 * 
 * 官方 MCP 服务器：
 * - @modelcontextprotocol/server-filesystem: 文件系统操作
 * - @modelcontextprotocol/server-puppeteer: 浏览器自动化
 * - @modelcontextprotocol/server-postgres: PostgreSQL 数据库
 * - @modelcontextprotocol/server-sqlite: SQLite 数据库
 * 
 * 注意：此文件在 Electron 主进程中运行
 */

/// <reference types="node" />

// @ts-ignore - Node.js modules available in Electron main process
import { spawn, ChildProcess } from 'child_process';
// @ts-ignore
import * as path from 'path';
// @ts-ignore
import * as fs from 'fs';

// ============================================================================
// 类型定义
// ============================================================================

export interface MCPServerConfig {
  /** 服务器类型 */
  type: 'filesystem' | 'puppeteer' | 'sqlite' | 'postgres' | 'custom';
  /** 服务器名称 */
  name: string;
  /** 工作区根目录 (filesystem) */
  workspacePath?: string;
  /** 数据库路径 (sqlite) */
  dbPath?: string;
  /** 连接字符串 (postgres) */
  connectionString?: string;
  /** 自定义命令 (custom) */
  command?: string;
  /** 自定义参数 (custom) */
  args?: string[];
  /** 端口 (HTTP transport) */
  port?: number;
  /** 传输方式 */
  transport?: 'stdio' | 'http';
}

export interface MCPServerStatus {
  name: string;
  type: string;
  running: boolean;
  pid?: number;
  transport?: string;
  url?: string;
}

// ============================================================================
// MCP Server 管理器
// ============================================================================

export class MCPManager {
  private servers: Map<string, ChildProcess> = new Map();
  private configs: Map<string, MCPServerConfig> = new Map();
  
  /**
   * 启动官方 MCP 服务器
   * 
   * 使用 npx 运行官方 MCP 服务器包
   */
  async startServer(config: MCPServerConfig): Promise<MCPServerStatus> {
    const { name, type } = config;
    
    if (this.servers.has(name)) {
      console.log(`[MCP] Server ${name} already running`);
      return this.getStatus(name)!;
    }
    
    let command: string;
    let args: string[];
    
    switch (type) {
      case 'filesystem':
        // 使用官方 @modelcontextprotocol/server-filesystem
        command = 'npx';
        args = [
          '-y',
          '@modelcontextprotocol/server-filesystem',
          config.workspacePath || '.',
        ];
        break;
        
      case 'puppeteer':
        // 使用官方 @modelcontextprotocol/server-puppeteer
        command = 'npx';
        args = ['-y', '@modelcontextprotocol/server-puppeteer'];
        break;
        
      case 'sqlite':
        // 使用官方 @modelcontextprotocol/server-sqlite
        command = 'npx';
        args = [
          '-y',
          '@modelcontextprotocol/server-sqlite',
          '--db-path',
          config.dbPath || ':memory:',
        ];
        break;
        
      case 'postgres':
        // 使用官方 @modelcontextprotocol/server-postgres
        command = 'npx';
        args = [
          '-y',
          '@modelcontextprotocol/server-postgres',
          config.connectionString || '',
        ];
        break;
        
      case 'custom':
        command = config.command || 'echo';
        args = config.args || [];
        break;
        
      default:
        throw new Error(`Unknown MCP server type: ${type}`);
    }
    
    console.log(`[MCP] Starting ${type} server: ${name}`);
    console.log(`[MCP] Command: ${command} ${args.join(' ')}`);
    
    const process = spawn(command, args, {
      stdio: config.transport === 'http' ? 'inherit' : 'pipe',
      shell: true,
    });
    
    this.servers.set(name, process);
    this.configs.set(name, config);
    
    process.on('error', (error) => {
      console.error(`[MCP] Server ${name} error:`, error);
    });
    
    process.on('exit', (code) => {
      console.log(`[MCP] Server ${name} exited with code ${code}`);
      this.servers.delete(name);
    });
    
    // 等待服务器启动
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    return {
      name,
      type,
      running: true,
      pid: process.pid,
      transport: config.transport || 'stdio',
    };
  }
  
  /**
   * 停止服务器
   */
  stopServer(name: string): void {
    const process = this.servers.get(name);
    if (process) {
      console.log(`[MCP] Stopping server: ${name}`);
      process.kill('SIGTERM');
      this.servers.delete(name);
      this.configs.delete(name);
    }
  }
  
  /**
   * 停止所有服务器
   */
  stopAll(): void {
    for (const name of this.servers.keys()) {
      this.stopServer(name);
    }
  }
  
  /**
   * 获取服务器状态
   */
  getStatus(name: string): MCPServerStatus | null {
    const process = this.servers.get(name);
    const config = this.configs.get(name);
    
    if (!process || !config) {
      return null;
    }
    
    return {
      name,
      type: config.type,
      running: !process.killed,
      pid: process.pid,
      transport: config.transport || 'stdio',
    };
  }
  
  /**
   * 获取所有服务器状态
   */
  getAllStatus(): MCPServerStatus[] {
    const statuses: MCPServerStatus[] = [];
    for (const name of this.servers.keys()) {
      const status = this.getStatus(name);
      if (status) {
        statuses.push(status);
      }
    }
    return statuses;
  }
  
  /**
   * 获取服务器进程 (用于 stdio transport)
   */
  getProcess(name: string): ChildProcess | null {
    return this.servers.get(name) || null;
  }
}

// ============================================================================
// 导出单例
// ============================================================================

export const mcpManager = new MCPManager();

export default mcpManager;
