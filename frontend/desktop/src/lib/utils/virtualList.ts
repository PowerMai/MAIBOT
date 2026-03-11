/**
 * 虚拟滚动工具 - 用于大列表性能优化
 * 
 * 功能：
 * 1. 只渲染可见区域的项目
 * 2. 动态计算滚动位置
 * 3. 支持变高度项目
 */

// ============================================================
// 类型定义
// ============================================================

export interface VirtualListOptions {
  /** 容器高度 */
  containerHeight: number;
  /** 项目高度（固定高度）或高度计算函数 */
  itemHeight: number | ((index: number) => number);
  /** 总项目数 */
  itemCount: number;
  /** 预渲染的项目数（上下各多渲染几个） */
  overscan?: number;
}

export interface VirtualListState {
  /** 可见区域的起始索引 */
  startIndex: number;
  /** 可见区域的结束索引 */
  endIndex: number;
  /** 顶部填充高度 */
  paddingTop: number;
  /** 底部填充高度 */
  paddingBottom: number;
  /** 总高度 */
  totalHeight: number;
  /** 可见项目的索引列表 */
  visibleIndexes: number[];
}

// ============================================================
// 虚拟滚动计算
// ============================================================

/**
 * 计算虚拟列表状态
 */
export function calculateVirtualList(
  scrollTop: number,
  options: VirtualListOptions
): VirtualListState {
  const {
    containerHeight,
    itemHeight,
    itemCount,
    overscan = 3,
  } = options;
  
  if (itemCount === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      paddingTop: 0,
      paddingBottom: 0,
      totalHeight: 0,
      visibleIndexes: [],
    };
  }
  
  // 固定高度模式
  if (typeof itemHeight === 'number') {
    return calculateFixedHeight(scrollTop, containerHeight, itemHeight, itemCount, overscan);
  }
  
  // 变高度模式
  return calculateVariableHeight(scrollTop, containerHeight, itemHeight, itemCount, overscan);
}

/**
 * 固定高度计算（O(1)）
 */
function calculateFixedHeight(
  scrollTop: number,
  containerHeight: number,
  itemHeight: number,
  itemCount: number,
  overscan: number
): VirtualListState {
  const totalHeight = itemCount * itemHeight;
  
  // 计算可见范围
  let startIndex = Math.floor(scrollTop / itemHeight);
  let endIndex = Math.ceil((scrollTop + containerHeight) / itemHeight);
  
  // 添加 overscan
  startIndex = Math.max(0, startIndex - overscan);
  endIndex = Math.min(itemCount, endIndex + overscan);
  
  // 计算填充
  const paddingTop = startIndex * itemHeight;
  const paddingBottom = (itemCount - endIndex) * itemHeight;
  
  // 生成可见索引列表
  const visibleIndexes: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    visibleIndexes.push(i);
  }
  
  return {
    startIndex,
    endIndex,
    paddingTop,
    paddingBottom,
    totalHeight,
    visibleIndexes,
  };
}

/**
 * 变高度计算（需要缓存高度）
 */
function calculateVariableHeight(
  scrollTop: number,
  containerHeight: number,
  getItemHeight: (index: number) => number,
  itemCount: number,
  overscan: number
): VirtualListState {
  // 计算所有项目的位置（可以优化为二分查找）
  const positions: { top: number; height: number }[] = [];
  let totalHeight = 0;
  
  for (let i = 0; i < itemCount; i++) {
    const height = getItemHeight(i);
    positions.push({ top: totalHeight, height });
    totalHeight += height;
  }
  
  // 找到起始索引（二分查找）
  let startIndex = binarySearch(positions, scrollTop);
  
  // 找到结束索引
  let endIndex = startIndex;
  let accumulatedHeight = 0;
  while (endIndex < itemCount && accumulatedHeight < containerHeight) {
    accumulatedHeight += positions[endIndex].height;
    endIndex++;
  }
  
  // 添加 overscan
  startIndex = Math.max(0, startIndex - overscan);
  endIndex = Math.min(itemCount, endIndex + overscan);
  
  // 计算填充
  const paddingTop = startIndex > 0 ? positions[startIndex].top : 0;
  const lastVisibleBottom = endIndex > 0 
    ? positions[endIndex - 1].top + positions[endIndex - 1].height 
    : 0;
  const paddingBottom = totalHeight - lastVisibleBottom;
  
  // 生成可见索引列表
  const visibleIndexes: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    visibleIndexes.push(i);
  }
  
  return {
    startIndex,
    endIndex,
    paddingTop,
    paddingBottom,
    totalHeight,
    visibleIndexes,
  };
}

/**
 * 二分查找：找到第一个 top >= scrollTop 的项目
 */
function binarySearch(
  positions: { top: number; height: number }[],
  scrollTop: number
): number {
  let left = 0;
  let right = positions.length - 1;
  
  while (left < right) {
    const mid = Math.floor((left + right) / 2);
    const pos = positions[mid];
    
    if (pos.top + pos.height <= scrollTop) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  
  return left;
}

// ============================================================
// React Hook
// ============================================================

import { useState, useCallback, useRef, useEffect } from 'react';

export interface UseVirtualListResult {
  /** 虚拟列表状态 */
  virtualState: VirtualListState;
  /** 滚动处理函数 */
  handleScroll: (e: React.UIEvent<HTMLElement>) => void;
  /** 容器 ref */
  containerRef: React.RefObject<HTMLDivElement>;
  /** 滚动到指定索引 */
  scrollToIndex: (index: number, align?: 'start' | 'center' | 'end') => void;
}

/**
 * 虚拟滚动 Hook
 */
export function useVirtualList(
  options: Omit<VirtualListOptions, 'containerHeight'> & {
    containerHeight?: number;
  }
): UseVirtualListResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(options.containerHeight || 400);
  
  // 监听容器大小变化
  useEffect(() => {
    if (!containerRef.current) return;
    
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    
    observer.observe(containerRef.current);
    
    return () => observer.disconnect();
  }, []);
  
  // 计算虚拟状态
  const virtualState = calculateVirtualList(scrollTop, {
    ...options,
    containerHeight,
  });
  
  // 滚动处理
  const handleScroll = useCallback((e: React.UIEvent<HTMLElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);
  
  // 滚动到指定索引
  const scrollToIndex = useCallback((index: number, align: 'start' | 'center' | 'end' = 'start') => {
    if (!containerRef.current) return;
    
    const itemHeight = typeof options.itemHeight === 'number' 
      ? options.itemHeight 
      : options.itemHeight(index);
    
    let targetTop = index * (typeof options.itemHeight === 'number' ? options.itemHeight : 0);
    
    // 变高度需要计算
    if (typeof options.itemHeight === 'function') {
      targetTop = 0;
      for (let i = 0; i < index; i++) {
        targetTop += options.itemHeight(i);
      }
    }
    
    // 根据对齐方式调整
    if (align === 'center') {
      targetTop -= (containerHeight - itemHeight) / 2;
    } else if (align === 'end') {
      targetTop -= containerHeight - itemHeight;
    }
    
    containerRef.current.scrollTop = Math.max(0, targetTop);
  }, [options.itemHeight, options.itemCount, containerHeight]);
  
  return {
    virtualState,
    handleScroll,
    containerRef,
    scrollToIndex,
  };
}

// ============================================================
// 工具函数
// ============================================================

/**
 * 扁平化树结构为列表（用于虚拟滚动）
 */
export interface TreeNode {
  id: string;
  children?: TreeNode[];
  [key: string]: any;
}

export interface FlattenedNode {
  node: TreeNode;
  depth: number;
  isExpanded: boolean;
  hasChildren: boolean;
  parentId: string | null;
}

export function flattenTree(
  nodes: TreeNode[],
  expandedIds: Set<string>,
  depth = 0,
  parentId: string | null = null
): FlattenedNode[] {
  const result: FlattenedNode[] = [];
  
  for (const node of nodes) {
    const hasChildren = !!(node.children && node.children.length > 0);
    const isExpanded = expandedIds.has(node.id);
    
    result.push({
      node,
      depth,
      isExpanded,
      hasChildren,
      parentId,
    });
    
    // 如果展开且有子节点，递归添加
    if (isExpanded && hasChildren) {
      result.push(...flattenTree(node.children!, expandedIds, depth + 1, node.id));
    }
  }
  
  return result;
}

export default {
  calculateVirtualList,
  useVirtualList,
  flattenTree,
};
