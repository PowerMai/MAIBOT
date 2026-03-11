# 聊天发送路径与「不执行」问题全面分析

## 1. 现象与可能原因

| 现象 | 可能原因 |
|------|----------|
| **一条都不执行** | ① 界面一直显示「运行中」（Send 被隐藏，只显示入队/停止），用户点的是入队，消息进队列后从未被 drain；② 首包前就报错/挂起（initialize、getThreadState、网络）；③ 后端 4xx/5xx 导致 run_error，但前端未正确结束 run，thread 的 running 未清除。 |
| **第一条执行、第二条不执行** | ① 第一条结束后 thread 的 `status.type` 仍为 `"running"`（SDK/React 更新滞后），Composer 仍显示入队/停止，第二次点击变成入队；② 队列 drain 仅在「runtime running 由 true→false」时触发，若 store 未更新则永不 drain；③ run_error 时只 break switch 未 break for-await，流未结束，sendMessage 不 resolve，isRunning 一直 true。 |

## 2. 发送链路（从点击到 stream 返回）

```
用户点击 Composer 内按钮
  → 由 ThreadPrimitive.If running 决定显示哪颗按钮：
     - running=true：显示「入队」或「停止」
     - running=false：显示 ComposerPrimitive.Send（真正发送）
  → 用户点击 Send → ComposerPrimitive.Send 触发 runtime 的 send
  → useLangGraphRuntime 的 handleSendMessage(messages, config)
  → setIsRunning(true) → await sendMessage(messages, config)
  → useLangGraphMessages 的 sendMessage：
     - await stream(messages, config) 得到 AsyncGenerator
     - for await (const chunk of response) 消费流
  → 我们的 stream()（MyRuntimeProvider）被调用
  → isStreamingRef.current = true → task_running(true) → initialize() → 线程创建/校验 → sendMessageWithRetry → for await (event of generator)
  → 收到 run_error / stream_paused：break EVENT_LOOP → generator.return() → finally → return
  → stream() 返回 → for await 结束 → sendMessage resolve → handleSendMessage finally → setIsRunning(false)
  → thread store 的 running 更新为 false → ThreadPrimitive 显示 Send 按钮
```

- **谁控制「显示 Send 还是 入队/停止」**：`ThreadPrimitive.If running`，数据来自 **thread store 的 status**，即 SDK 的 `isRunning`（handleSendMessage 的 setState）。与父组件传入的 `isStreaming` 无关（Composer 内未用 isStreaming 做分支）。
- **队列何时被消费**：原逻辑仅在「runtime running 从 true 变为 false」时 drain 队首。若 thread 一直未进入 running（例如首屏误显 running、用户点了入队），则永远不会触发「true→false」，排队消息会一直不发送。

## 2.1 Composer 发送键业务逻辑

- **按钮形态唯一数据源**：Composer 内 Send/入队/停止 的显示仅依赖 **thread store 的 running**（`useThread` → `status.type === "running"`）。`runSummary.running`、`task_running` 事件用于状态栏、showRunStrip、队列 drain 双保险等，不参与 Composer 按钮分支。
- **三态分支**（cursor-style-composer.tsx）：
  - `running === true` 且 `hasInputForQueue && onEnqueue` → 显示**入队**（ArrowUp）：点击后 `onEnqueue(content)`、清空输入、`composerRuntime.setText("")`、toast。
  - `running === true` 且否则 → 显示**停止**（Square）：`ComposerPrimitive.Cancel` + `handleCancel` → `cancelRun()`。
  - `running === false` → 显示**发送**（ArrowUp）：`ComposerPrimitive.Send`，先执行 `pushInputHistory`，再由 SDK 提交 composer 内容 → `stream()`。
- **sendDisabled**：`hasUploadingContext || (!inputText.trim() && !hasContext)`。即：有附件正在上传，或（无文字且无任何成功上下文）时禁用；仅无文字但有成功上下文时仍可发送（如「只发文件/上下文」）。
- **入队 → 队列 → drain**：入队写入 thread 的 `messageQueue`。drain 条件：① 主触发：`useEffect([runtimeRunning])`，当 `!runtimeRunning && messageQueueRef.current.length > 0` 时取队首、`setMessageQueue(rest)`、`sendMessageRef.current([...])`；② 双保险：`useEffect([taskRunningFromEvent])`，当 `taskRunningFromEvent === false` 且队列非空时 400ms 后再 drain 一次，应对 thread store 的 running 未及时更新。每次 drain 先更新队列状态，不会对同一条消息重复发送。

## 3. 已做修改（本次与历史）

1. **run_error / stream_paused 时跳出事件循环**  
   `break` 改为 `break EVENT_LOOP`，确保 for-await 结束，stream() 返回，sendMessage 的 Promise resolve，SDK 的 setIsRunning(false) 执行。

2. **run_error 时先 yield `error` 再 break**  
   让 @assistant-ui/react-langgraph 的 for-await 能处理到 error 事件并更新最后一条 AI 消息状态，再正常结束迭代。

3. **流结束单点化（整改）**  
   stream_end 与 task_running(false)、清 isStreamingRef 等统一在 stream() 的 **finally** 中执行；run_error / stream_paused 分支内仅 break EVENT_LOOP，不再重复派发。正常结束也会在 finally 中发 stream_end，保证 runSummary.running 在正常结束时变为 false。

4. **队列 drain 条件放宽**  
   原：仅当 `wasRunning && !runtimeRunning` 时 drain 队首。  
   现：只要 `!runtimeRunning && messageQueueRef.current.length > 0` 就 drain 队首并发送。这样即使用户在「误显运行中」时点了入队，只要当前未在运行，排队消息也会被发送，避免「一条都不执行」。

5. **isStreaming 传参**  
   曾改为 `runtimeRunning && taskRunningFromEvent !== false`，后已还原为 `runtimeRunning`，因 Composer 内部未使用 isStreaming 控制 Send/入队，且避免引入额外状态影响首条发送。

## 4. 仍可能阻塞的点（排查顺序）

| 环节 | 说明 | 建议排查 |
|------|------|----------|
| 首屏 running 状态 | 若 thread 初始或持久化导致 status.type === "running"，会一直显示入队/停止，用户无法点 Send | 查 thread store 初始值、是否有持久化 running |
| initialize() | 无 externalId、或 adapter 未就绪，会卡在 initialize | 看控制台「initialize 完成」是否出现 |
| getThreadState() | 超时 15s 或后端不可达，会抛错并走重建线程 | 看「getThreadState 开始/完成」与网络 |
| 后端 run_error | 400/502 等会发 run_error，前端应 break EVENT_LOOP 并 finally | 看「run_error → break EVENT_LOOP」「EVENT_LOOP 已退出」「stream() finally 执行」 |
| SDK isRunning 未清 | sendMessage 未 resolve 或 finally 未跑，thread 的 running 不会变 false | 确认 stream() 确实 return，无未 catch 的异常 |
| 首请求前后端未就绪 | 无现有 thread 时直接 createThread 可能失败，表现为「第一条就不执行」 | 实施首请求前健康检查后：getCurrentThread 在创建新线程前先 checkHealth(true)，若 unhealthy 再 waitForBackend(3, 2000)，再 createThread，可减少此类误判 |

## 5. 调试日志（DEV）与调试日志文件

- **MyRuntimeProvider.tsx**（DEV）：`stream() 进入`、`initialize 完成`、`getThreadState 开始/完成`、`线程就绪，准备发送`、`创建 generator 开始流式请求`、`run_error → break EVENT_LOOP`、`EVENT_LOOP 已退出`、`stream() finally 执行`。
- **.cursor/debug-b9e101.log**（若 ingest 服务开启）：run_error、after_event_loop、stream_finally 的 NDJSON，可对照时间戳确认是否正常退出。

## 6. 运行状态三源与 stream_end 触发点（整改后）

### 6.1 三路「运行中」来源与对应关系

| 来源 | 更新时机 | 消费方 | 权威性（整改后） |
|------|----------|--------|------------------|
| **SDK isRunning** | handleSendMessage 内 setIsRunning(true) / finally 里 setIsRunning(false) | thread store → ThreadPrimitive.If running（Send/入队/停止） | **唯一** 控制 Send/入队/停止 |
| **runSummary.running** | RUN_STATUS_EVENT_START（stream_start）→ true；RUN_STATUS_EVENT_END（stream_end）→ false | 状态栏、recovery、runSummary 写入 | 仅由事件驱动，与流结束一致 |
| **task_running 事件** | stream() 的 finally 中统一派发 running: false（含 150ms 二次派发） | taskRunningFromEvent、showRunStrip 等 | 补偿用，与 finally 单点一致 |

### 6.2 stream_end 触发点（单点）

- **唯一触发点**：`stream()` 的 **finally** 块（与版本匹配时）。
- **覆盖场景**：正常结束（generator 耗尽）、run_error 退出、stream_paused 退出、超时/废弃退出，均经同一 finally，故 **每次 run 结束都会发一次 stream_end**，runSummary.running 与真实 run 状态一致。
- **run_error / stream_paused**：分支内仅做 break EVENT_LOOP，不再重复发 stream_end 或 task_running，避免重复与不同步。
- **LangGraph error 事件**：当后端推送 `event.event === 'error'` 时，前端在 yield 占位/error 后设置 `streamDone = true` 并 `break EVENT_LOOP`，由同一 finally 统一发 stream_end 与 task_running(false)，与 run_error/stream_paused 一致；便于排查「后端 error 事件导致界面仍显示运行中」类问题。

### 6.3 正常结束 vs 异常结束

| 结束类型 | 路径 | stream_end | task_running(false) | isStreamingRef 等 |
|----------|------|------------|---------------------|-------------------|
| 正常结束 | generator 耗尽 → 退出 for-await → finally | ✅ finally 内统一发 | ✅ finally 内统一发 | ✅ finally 内统一清 |
| run_error | yield error → break EVENT_LOOP → finally | ✅ 同上 | ✅ 同上 | ✅ 同上 |
| stream_paused | break EVENT_LOOP → finally | ✅ 同上 | ✅ 同上 | ✅ 同上 |
| 取消 run | handleCancel 内单独发 stream_end | ✅ cancel 分支内 | 不在此路径 | cancel 分支内清 |

## 7. 建议验证步骤

1. 清空控制台，发第一条消息，看是否依次出现：stream() 进入 → initialize 完成 → getThreadState（若有）→ 线程就绪 → 创建 generator → 首包/run_error → EVENT_LOOP 已退出 → stream() finally 执行。
2. 若第一条正常结束，再发第二条，确认仍出现上述序列且第二条有请求发出；正常结束后 runSummary.running 应变为 false（因 finally 已发 stream_end）。
3. 若界面一直只显示「入队/停止」、从未显示 Send，说明 thread 的 running 一直为 true，需查 store 初始值或 SDK 的 setIsRunning(false) 是否被调用。

## 8. 流程约定（避免拧麻花）

### 8.1 提前 return 约定

凡在派发 `task_running(true)`（约 L957）之后、进入 EVENT_LOOP 之前 return 的路径，若已派发过 `task_running(true)`，必须在 return 前派发 `task_running(false)`（例如 `!isMountedRef.current`、模型不支持图片等）。这些路径未发送 `stream_start`，故不需要发 `stream_end`。

### 8.2 双点清理

- **文档单点**：`stream_end` / `isStreamingRef` 等清理的**唯一文档单点**为 `stream()` 的 **finally**。
- **handleCancel**：用户点击「停止」时，handleCancel 内会立即执行相同清理以便 UI 即时反馈；随后 `stream()` 因 abort 退出，finally 会再次执行相同逻辑。二者幂等，单点说明不变。
- **用户 Abort**：在 inner/outer catch 中 `isUserAbort` 后 `return` 的路径不会经过 finally，因此在 return 前必须执行与 finally 相同的清理（通过 `runStreamCleanup(myStreamVersion)`：含 stream_end、task_running(false)、串行锁 resolve 等），保证下次发送不被挂起且状态一致。

### 8.3 运行状态两源

- **SDK isRunning**（thread store）：控制 Send/入队/停止的**唯一**依据；由 sendMessage 的 resolve/finally 驱动。
- **runSummary.running**：仅由 `stream_start` / `stream_end` 驱动，用于状态栏、recovery 等。
- **task_running 事件**：补偿用，与 finally 单点一致；thread 用其与 runtimeRunning 取 AND 做 showRunStrip、队列 drain 双保险。

### 8.4 队列 drain

- **主触发**：`!runtimeRunning && messageQueueRef.current.length > 0` 时立即 drain 队首并发送。
- **双保险**：`taskRunningFromEvent === false` 且队列非空时，400ms 延迟后再 drain 一次，应对 thread store 的 running 未及时更新导致队列永不消费。
