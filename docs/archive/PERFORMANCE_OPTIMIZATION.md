# 性能优化指南

## 当前配置 (优化后)

| 参数 | 值 | 说明 |
|------|-----|------|
| 模型 | qwen/qwen3-coder-30b (Q4) | 30B 参数，Q4 量化 |
| MAX_TOKENS | 32768 | 窗口大小，本地模型建议 16K-32K |
| TEMPERATURE | 0.4 | 降低可减少生成 token，提高速度 |
| MAX_PARALLEL | 1 | 本地模型建议 1，避免资源竞争 |
| MAX_ROUNDS | 5 | 限制轮次避免无限循环 |
| read_file_default_limit | 1000 | 减少默认读取行数 |

## 信息复用机制 (避免重复读取)

```
用户消息 (含文件路径)
    ↓
Orchestrator 提取文件路径
    ↓
Planning-agent 读取文件 → 提取 key_info (包含所有关键数据)
    ↓
Orchestrator 将 key_info 传递给 Executor
    ↓
Executor-agent 使用 key_info (不重新读取文件)
```

**关键点：**
- Planning 提取的 key_info 必须足够详细
- Executor 优先使用 key_info，只在必要时读取文件
- state["files"] 缓存已读取的文件内容

## DeepAgent 记忆机制

### 1. 文件内容存储 (`state["files"]`)

```
FilesystemMiddleware:
- tool_token_limit_before_evict: 20000 tokens (默认)
- 读取的文件内容存入 state["files"]
- 超过 20000 tokens 的内容会被截断
- state["files"] 跨 SubAgent 共享
```

**影响：**
- ✅ 同一文件不需要重复从磁盘读取
- ⚠️ 但每次 read_file 调用的结果会进入 messages
- ⚠️ 多次读取同一文件会在 messages 中重复

### 2. 消息历史压缩 (`SummarizationMiddleware`)

```
当前配置 (MAX_TOKENS=32768):
- trigger: ("fraction", 0.85) → 约 27853 tokens 时触发
- keep: ("fraction", 0.10) → 保留约 3277 tokens
```

**工作流程：**
```
消息累积 → 达到 85% 窗口 → 自动压缩
    ↓
旧消息被摘要替代 → 保留最近 10% 消息
```

### 3. 避免上下文膨胀的策略

| 策略 | 说明 |
|------|------|
| **key_info 传递** | Planning 提取信息，Executor 直接使用 |
| **避免重复 read_file** | 检查 key_info 是否已有所需信息 |
| **分块读取** | 大文件使用 offset/limit，只读需要的部分 |
| **自动压缩** | SummarizationMiddleware 自动处理 |

### 4. 上下文使用估算

```
单次任务上下文消耗（估算）：
- System Prompt: ~2300 tokens (Orchestrator)
- 用户消息: ~100 tokens
- 文件内容: ~2000-5000 tokens (取决于文件大小)
- 工具调用结果: ~500-2000 tokens
- SubAgent 交互: ~1000-3000 tokens

总计: ~6000-12000 tokens / 任务

窗口容量: 32768 tokens
可处理: 2-5 个复杂任务后触发压缩
```

## 性能瓶颈分析

### 1. LLM 调用次数 (主要瓶颈)
```
用户消息 → Orchestrator (调用1)
    → Planning-agent (调用2)
        → think_tool (调用3, 可选)
    → Executor-agent (调用4)
        → think_tool (调用5, 可选)
    → 综合报告 (调用6)
```

**优化建议：**
- 减少 think_tool 使用（已优化提示词）
- 使用并行执行独立步骤
- 传递 key_info/for_next_step 避免重复读取

### 2. 提示词大小
| Agent | 优化前 | 优化后 | 节省 |
|-------|--------|--------|------|
| Orchestrator | ~2460 tokens | ~2317 tokens | 143 |
| Planning | ~1053 tokens | ~1053 tokens | 0 |
| Executor | ~1143 tokens | ~1143 tokens | 0 |
| Knowledge | ~599 tokens | ~599 tokens | 0 |
| **Total** | ~5256 tokens | ~5113 tokens | **143** |

### 3. 窗口大小 vs 响应速度
| 窗口大小 | 适用场景 | 响应速度 |
|----------|----------|----------|
| 16384 | 简单任务，快速响应 | 最快 |
| 32768 | 平衡模式（推荐） | 较快 |
| 65536 | 复杂文档分析 | 较慢 |
| 131072 | 超大文档，云端部署 | 慢 |

## 环境变量配置

```bash
# 快速模式 (简单任务)
export LLM_MAX_TOKENS=16384
export LLM_TEMPERATURE=0.3
export MAX_PARALLEL_AGENTS=1

# 平衡模式 (推荐)
export LLM_MAX_TOKENS=32768
export LLM_TEMPERATURE=0.4
export MAX_PARALLEL_AGENTS=1

# 质量模式 (复杂任务)
export LLM_MAX_TOKENS=65536
export LLM_TEMPERATURE=0.5
export MAX_PARALLEL_AGENTS=1
```

## 其他优化建议

### 1. LM Studio 设置
- **GPU Offload**: 尽可能多的层卸载到 GPU
- **Context Length**: 与 MAX_TOKENS 保持一致
- **Batch Size**: 根据显存调整
- **Threads**: 设置为 CPU 核心数

### 2. 模型选择
| 模型 | 参数量 | 速度 | 质量 |
|------|--------|------|------|
| qwen3-coder-8b | 8B | 快 | 一般 |
| qwen3-coder-14b | 14B | 中 | 良好 |
| qwen3-coder-30b | 30B | 慢 | 优秀 |

### 3. 减少 LLM 调用
- **信息链传递**: key_info → for_next_step
- **避免重复读取**: Planning 提取的信息传给 Executor
- **并行执行**: 独立步骤同时执行
- **减少 think_tool**: 只在真正需要时使用

### 4. 文件读取优化
- **分块读取**: 大文件使用 offset/limit
- **按需读取**: 只读取相关部分
- **信息提取**: Planning 提取 key_info 供下游使用

## 监控指标

```bash
# 查看 LM Studio 资源使用
# - GPU 使用率
# - 显存占用
# - 推理速度 (tokens/s)

# 查看后端日志
tail -f /path/to/terminals/12.txt | grep -E "LLM|token|time"
```

## 故障排除

### 响应很慢
1. 检查 GPU 是否被正确使用
2. 降低 MAX_TOKENS
3. 降低 TEMPERATURE
4. 使用更小的模型

### 内存不足
1. 减少 MAX_TOKENS
2. 减少 GPU 层卸载
3. 使用量化模型 (Q4/Q5)

### 上下文溢出
1. 增加 MAX_TOKENS
2. 检查 SummarizationMiddleware 是否正常工作
3. 减少单次读取的文件内容
