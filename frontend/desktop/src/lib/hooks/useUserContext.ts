/**
 * 用户上下文 Hook
 * 
 * 提供用户 ID 和团队 ID
 * 
 * 目前使用简单的本地存储，未来可以集成真实的认证系统
 */

import { useState, useEffect } from 'react';

export interface UserContext {
  userId: string;
  teamId?: string;
  userName?: string;
  teamName?: string;
}

const DEFAULT_USER: UserContext = {
  userId: 'demo-user',
  teamId: 'demo-team',
  userName: '演示用户',
  teamName: '演示团队',
};

const STORAGE_KEY = 'app_user_context';

/**
 * 获取当前用户上下文
 */
export function useUserContext(): UserContext {
  const [userContext, setUserContext] = useState<UserContext>(() => {
    // 从 localStorage 读取
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        try {
          return JSON.parse(stored);
        } catch (e) {
          console.warn('无法解析用户上下文:', e);
        }
      }
    }
    return DEFAULT_USER;
  });

  // 监听外部 setUserContext 派发的事件，同步状态
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<UserContext>).detail;
      if (detail && typeof detail === 'object') {
        setUserContext({ ...DEFAULT_USER, ...detail });
      }
    };
    window.addEventListener('user-context-changed', handler);
    return () => window.removeEventListener('user-context-changed', handler);
  }, []);

  // 监听变化并持久化
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userContext));
    }
  }, [userContext]);

  return userContext;
}

/**
 * 设置用户上下文
 */
export function setUserContext(context: Partial<UserContext>): void {
  if (typeof window !== 'undefined') {
    let currentContext: UserContext = DEFAULT_USER;
    try {
      const current = localStorage.getItem(STORAGE_KEY);
      currentContext = current ? JSON.parse(current) : DEFAULT_USER;
      if (!currentContext || typeof currentContext !== 'object') currentContext = DEFAULT_USER;
    } catch {
      currentContext = DEFAULT_USER;
    }
    const newContext = { ...currentContext, ...context };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newContext));
    
    // 触发自定义事件，通知所有使用该 hook 的组件
    window.dispatchEvent(new CustomEvent('user-context-changed', { 
      detail: newContext 
    }));
  }
}

/**
 * 获取用户上下文（非 Hook 版本，用于非 React 组件）
 */
export function getUserContext(): UserContext {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (e) {
        console.warn('无法解析用户上下文:', e);
      }
    }
  }
  return DEFAULT_USER;
}

