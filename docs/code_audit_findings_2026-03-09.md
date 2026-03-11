# 代码走读与修复记录 2026-03-09

## 一、本次已修复项

| 项 | 位置 | 修改内容 |
|----|------|----------|
| 跨窗口事件 workspacePath 语义 | `frontend/desktop/src/lib/sessionState.ts` | 为 `shouldApplyCrossWindowEvent` 增加 JSDoc，明确「无 workspacePath 或空串 = 不按工作区过滤」；参数处理改用 `??` 与现有逻辑一致 |
| configurable 入口防护 | `backend/engine/core/main_graph.py` | `_resolve_model_id_with_route_prefix` 增加 `configurable or {}` 防护，类型标注为 `Dict[str, Any] \| None` |
| safeStorage 无效 key | `frontend/desktop/src/lib/safeStorage.ts` | `getItem`/`setItem`/`removeItem` 对 `key == null` 或空串做早期返回，避免误用 |
| 学习状态文件加载健壮性 | `backend/tools/base/learning_middleware.py` | `_load_from_file`：success_patterns/failure_patterns 仅当 `isinstance(raw, dict)` 时赋值；reasoning_paths 仅当 list 且每项 dict 时解析，单条 `from_dict` 异常跳过；failure_lessons 单条异常跳过 |
| 会话级 key 仅用服务端 UUID | `tool-fallback.tsx` / `thread.tsx` | `maibot_plan_confirmed_thread_*` 的 set/remove 仅当 `validServerThreadIdOrUndefined(threadId)` 有值时执行，避免占位 ID 污染存储 |
| 学习步骤 dict 防护 | `backend/tools/base/learning_middleware.py` | `_learn_from_task_finish` 中遍历 steps 提取 output 时仅处理 `isinstance(step, dict)`；`_build_reasoning_path` 仅将 `isinstance(s, dict)` 的步骤写入 steps_safe；`save_finetuning_dataset` 中 step 的 tool/action/description 仅当 `isinstance(step, dict)` 时用 .get，避免不可信数据 AttributeError |
| ReasoningPath.from_dict 防御性反序列化 | `backend/tools/base/learning_middleware.py` | `from_dict` 全部使用 `.get()` 与默认值，`steps` 非 list 时用 `[]`，日期字段 try/except 解析，避免不可信数据 KeyError/TypeError |
| 关键路径 JSON 解析失败可感知 | `frontend/desktop/src/components/ChatComponents/thread.tsx` | 保存到记忆、requestSystemInfo、checkPathNormalization 三处 `res.json().catch` 改为返回 `__parseError` 哨兵，解析失败时 `toast.error(t("composer.responseParseFailed"))` 并 return |
| 角色加载失败可感知 | `frontend/desktop/src/components/ChatComponents/AgentCapabilities.tsx` | listRoles 两处 `.catch` 内增加 `toast.error(t("dashboard.rolesLoadError"))` |
| FailureLesson.from_dict 日期解析防护 | `backend/tools/base/learning_middleware.py` | `created_at`/`last_updated` 用 try/except 包裹 fromisoformat，失败时回退 datetime.now() |
| boardApi 关键接口 JSON 解析失败 | `frontend/desktop/src/lib/api/boardApi.ts` | getScheduleState、getAutonomousTasks、getAutonomousWatcherConfig 三处 `res.json().catch` 改为 `__parseError` 哨兵，解析失败时返回 `{ ok: false, error: "响应解析失败" }` |
| 工作区配置拉取 JSON 解析失败 | `frontend/desktop/src/lib/hooks/useWorkspacePath.ts` | fetchBackendWorkspaceRoot 中 `res.json().catch` 改为 `__parseError` 哨兵，解析失败时 toast(t("composer.responseParseFailed")) 并 return "" |
| 记忆面板 JSON 解析失败可感知 | `frontend/desktop/src/components/MemoryPanel.tsx` | fetchEntries、handleDelete、handleAdd、handleUpdateEntry、handleCleanup 五处 `res.json().catch` 改为 `__parseError` 哨兵，解析失败时 toast「响应解析失败」并 return |
| 设置页网络节点 JSON 解析失败 | `frontend/desktop/src/components/SettingsView.tsx` | 网络 section 拉取 /network/nodes 时 `res.json().catch` 改为 `__parseError` 哨兵，解析失败时 setNetworkNodes([]) 且 toast(t("composer.responseParseFailed")) |
| MCP 后端状态解析失败可感知 | `frontend/desktop/src/components/MCPManager.tsx` | fetchBackendMCP 中 __parseError 时 toast.error(t("composer.responseParseFailed")) 并 setBackendMCP，并接入 i18n |
| 记忆面板解析失败与样式 | `frontend/desktop/src/components/MemoryPanel.tsx` | 五处「响应解析失败」统一为 t("composer.responseParseFailed")；profile.unsolved_intents 使用可选链避免 TS 未定义；[overflow-wrap:break-word] 改为 wrap-break-word |
| rolesApi 全量 JSON 解析失败 | `frontend/desktop/src/lib/api/rolesApi.ts` | listRoles、getRole、activateRole、reloadRoles 四处 `res.json().catch` 改为 `__parseError` 哨兵，解析失败时返回 `{ ok: false, ..., error: "响应解析失败" }` |
| workspace 文件接口 JSON 解析失败 | `frontend/desktop/src/lib/api/workspace.ts` | getFileTree、listFiles、readFile、writeFile 四处 `response.json()` 增加 `.catch(() => { throw new Error("响应解析失败") })` |
| CrystallizationToast 解析失败 | `frontend/desktop/src/components/CrystallizationToast.tsx` | fetch 后 `res.json().catch` 改为 `__parseError` 哨兵，解析失败时直接 return null |
| boardApi 更多接口 JSON 解析失败 | `frontend/desktop/src/lib/api/boardApi.ts` | getReliabilityMetrics、getLatestReleaseGateSummary、getSpawnRecords、consumeSpawnRequests、getCollaborationMetrics、getOrganizationResourceQuota、setOrganizationResourceQuota 七处增加 `__parseError` 哨兵并返回明确 error |
| systemApi 部分接口 JSON 解析失败 | `frontend/desktop/src/lib/api/systemApi.ts` | getSchedulingSliSummary、postUiStreamMetricsSample、getSensitiveFiles 三处 `res.json().catch` 改为 `__parseError` 哨兵，解析失败时返回 `{ ok: false, error: "响应解析失败" }` |
| boardApi 自治/竞标等接口 JSON 解析失败 | `frontend/desktop/src/lib/api/boardApi.ts` | updateAutonomousTask、triggerAutonomousTask、getAutonomousRunDetail、cancelAutonomousRun、getBids、submitBid、acceptBid、autoAssign、getOrganizationLearningRecent 九处增加 `__parseError` 哨兵并返回明确 error |
| systemApi 自治/升级/进化接口 JSON 解析失败 | `frontend/desktop/src/lib/api/systemApi.ts` | analyzeVisionImage、getAutonomousWatcherConfig、updateAutonomousWatcherConfig、resetAutonomousWatcherObservability、getAutonomyLevelConfig、updateAutonomyLevelConfig、getUpgradeStatus、checkUpgrade、getEvolutionStatus、createEvolutionProposal、runEvolutionPipeline 十一处增加 `__parseError` 哨兵并返回明确 error |
| systemApi 升级/洞察/简报接口 JSON 解析失败 | `frontend/desktop/src/lib/api/systemApi.ts` | triggerUpgrade、getUpgradeRuns、getSkillFeedbackStats、getDailyInsights、getDailyInsightContent、getInsightContentByFilename、getInsightsSummary、generateBriefing 八处增加 `__parseError` 哨兵并返回明确 error；**前端所有 raw fetch + res.json().catch(() => ({})) 已全部收敛为 __parseError 可感知** |

## 二、已走读模块与结论

### 后端

- **agent_prompts.py**：分层清晰，`_sanitize_prompt_value` 防注入，异常处多为 `logger.debug` 或安全回退，未发现新 bug。
- **model_manager.py**：configurable 已用 `isinstance(raw_cfg, dict)` 与 `raw_cfg = {}` 防护；单例与 HTTP 客户端生命周期正常。
- **learning_middleware.py**：已加固文件加载（见上）；configurable 使用处为构造 payload，无裸 None 风险。
- **configurable_check.py** / **editor_tool_node.py**：对 `config.get("configurable")` 均有类型判断或默认 dict。

### 前端

- **sessionState.ts**：跨窗口逻辑已注释明确；EVENTS 与 domain-model 一致。
- **safeStorage.ts**：已加 key 存在性检查。
- **FullEditorV2Enhanced.tsx**：状态栏模型/角色、ACTIVE_FILE_PATH_CHANGED、招投标向导与 Backlog 描述一致。
- **tool-fallback.tsx**：ToolFallback 与 getToolDisplayName/getPartKeyInfo 使用合理，可选链与 fallback 充分。
- **KnowledgeBasePanel.tsx**：无静默 catch；知识库树与 API 调用有 toast/error 反馈。

## 三、待追踪（Backlog 与已知风险）

- **静默 catch 收敛**：与 `bugs_and_product_alignment_backlog.md` P1 一致；本次已在 thread 三处关键路径补全「JSON 解析失败 → toast」。后续已对 SettingsView（角色偏好写入）、NotificationCenter（load/saveNotifications）、workspace.ts（addToRecent/removeFromRecent/clearRecentWorkspaces/setActiveWorkspace/closeWorkspace/notifyListeners/restoreFromStorage/saveWorkspaceSettings/saveExpandedFolders/cleanupInvalidData）在 catch 中增加 `import.meta.env?.DEV && console.warn`，开发环境可感知失败，生产保持静默。
- **ReasoningPath.from_dict**：已改为防御性实现（见第一节），非文件加载路径传入不可信 data 亦不再 KeyError。

## 四、全量走读完成（续走读 2026-03-09）

### 后端已覆盖

| 模块 | 结论 |
|------|------|
| **tools/base/code_execution.py** | 沙箱（SAFE_BUILTINS、_BLOCKED_IMPORT_MODULES）、detect_shell_bypass_risk、load_execution_policy 防御性读取，未发现新问题 |
| **api/routers/board_api.py** | task_id 校验、_safe_error_detail、A2A 鉴权、idempotency/board list 缓存，符合 Backlog 单源与门禁约定 |
| **api/knowledge_api.py** | _resolve_path_within_kb 防穿越与符号链接、_validate_optional_id、_safe_error_detail |
| **api/common.py** | resolve_read_path/resolve_write_path 空 path 400、敏感路径与文件名规则 |
| **api/deps.py** | verify_internal_token、get_api_current_tier 带 try/except 与 fallback |
| **api/app.py** | 可选 slowapi、_safe_error_detail、定期清理 run_in_executor，路径与 common 一致 |
| **api/routers/files_api.py** | 使用 common.resolve_*、verify_internal_token、大文件 413 |
| **tools/mcp/mcp_tools.py** | _load_mcp_server_configs 类型与异常回退、_resolve_mcp_env、ensure_connected 退避重试 |
| **engine/middleware/streaming_middleware.py** | get_config try/except，callbacks 注入前类型检查 |
| **engine/middleware/license_gate_middleware.py** | _load_json fallback、_allowed_tools 与 tier 防护 |
| **engine/middleware/mode_permission_middleware.py** | configurable 从 ctx 用 (ctx or {}).get("configurable", {})，角色模式判断有异常默认拒绝 |
| **engine/middleware/context_guard_middleware.py** | ctx.get("configurable") or {}，trim_messages 前校验 |
| **engine/nodes/router_node.py** | validate_configurable 在 try/except，state.get("messages", [])，additional_kwargs or {} |
| **engine/skills/skill_registry.py** | 职责边界清晰，与 skills_tool / ResourceManager 互补 |
| **engine/tasks/task_bidding.py** | is_valid_thread_id_uuid、锁与单源开关（TASK_SINGLE_SOURCE_ENABLED），与 Backlog 一致 |

### 前端已覆盖

| 模块 | 结论 |
|------|------|
| **MyRuntimeProvider.tsx** | session_context 仅当 isCurrentSession && notYetApplied 写存储并派发 EVENTS；threadId 校验 isValidServerThreadId；与 domain-model 一致 |
| **InterruptDialog.tsx** | threadId 必填，checkInterrupt 无 threadId 早退；interruptData 类型安全 |
| **thread.tsx** | sendMessage/PlanExecuteBar/sendFirstInQueue 等 .catch 有 toast；runCode/retryTool 等参数有 fallback |
| **SettingsView.tsx** | getStorageItem 均 try/catch 或带默认值；getCurrentThreadIdFromStorage 用于 FILL_PROMPT 时 threadId \|\| undefined |
| **WorkspaceFileTree.tsx** | 使用 getCurrentWorkspacePathFromStorage、safeStorage，与 sessionState 单源一致 |
| **langserveChat.ts** | configurable 构建含 thread_id；validServerThreadIdOrUndefined、isValidServerThreadId 统一校验；getApiUrl 归一化与缓存 |

### 全量走读结论

- **核心路径**：configurable/thread_id/workspace_path 的入口与深层次使用已审查，必要处已加固（见第一节）。
- **未发现新的高优先级 bug**；静默 catch 与 ReasoningPath.from_dict 非文件路径仍属 Backlog/低风险。
- **建议**：后续若有新加 API 或中间件，延续「configurable 取不到则为 {}」「path/thread_id 先校验再解析」的约定即可。

## 五、后端二次优化（2026-03-10）

在首轮审计与「全面优化」基础上，对健康检查、日志与资源做补充加固。

| 项 | 位置 | 修改内容 |
|----|------|----------|
| 深度健康检查覆盖 Store 降级 | `backend/api/app.py` | `/health/deep` 增加 `store_fallback` 检查：调用 `get_store_fallback_reason()`，非空时 status=degraded，便于运维发现 InMemoryStore 降级 |
| 深度健康检查覆盖 MCP | `backend/api/app.py` | `/health/deep` 增加 `mcp` 检查：`await get_mcp_health()`（2s 超时），上报连接数及明细，失败不拉低 overall |
| 存储初始化失败日志 | `backend/api/app.py` | lifespan 中存储初始化异常使用 `_safe_error_detail(e)`，生产环境不暴露内部异常详情 |
| 调试日志并发写 | `backend/engine/core/main_graph.py` | `_filter_content_leakage` 内 `_dbg` 与 `_debug_log_agent` 写 debug-e543f7.log 时使用 `_debug_log_file_lock`，避免多线程交叉写入；写文件统一 `encoding="utf-8"` |
| 可选依赖类型提示 | `backend/engine/core/main_graph.py` | `langgraph_checkpoint_sqlite` 导入增加 `# type: ignore[import-not-found]`，消除 type checker 对可选依赖的告警 |

**结论**：健康检查可观测 Store/MCP 状态；启动与调试日志不泄露敏感信息且并发安全；embedding_tools 已具备单例与 httpx limits，VectorStoreCache 可配置，无需本轮改动。

### 三轮优化（续）

| 项 | 位置 | 修改内容 |
|----|------|----------|
| 调试 ingest 日志编码与锁 | `backend/engine/core/main_graph.py` | `_debug_ingest` 写文件改为 `encoding="utf-8"`，使用 `_debug_log_file_lock` 避免并发交叉写；异常时 `logger.debug` 记录，避免静默 pass |
| 任务服务 atexit 关闭日志 | `backend/engine/tasks/task_service.py` | `_close_http_client` 内两处 `except Exception: pass` 改为 `logger.debug("...", e)`，便于排查关闭阶段异常 |

**审计结论**：API 层已统一使用 `_safe_error_detail`；main_graph / task_service 的 httpx 单例均带 timeout；Guardrails/Thread 绑定缓存已有 TTL 与 max_size 裁剪；知识库/board 路径与 configurable 入口已有校验。

## 六、举一反三：去重与逻辑收敛（2026-03-10）

| 项 | 位置 | 修改内容 |
|----|------|----------|
| Electron 工作区切换去重 | WorkspaceFileTree.tsx | Electron 选文件夹后原先先 `switchWorkspaceByPath(result.path)` 再 `workspaceService.setActiveWorkspace(ws.id)`，后者 linked 模式内会再次 `syncWorkspaceRoot(ws.path)`，造成两次 `/workspace/switch`。改为仅通过「先写入 workspaces 再 setActiveWorkspace(ws.id)」单一路径，由 setActiveWorkspace 内统一调后端再写本地，去掉开头重复的 switchWorkspaceByPath。 |
| workspaces 读写单源 | WorkspaceFileTree.tsx | Electron/Web 两处保存工作区列表由 `localStorage.getItem/setItem('workspaces')` 改为 `getStorageItem/setStorageItem('workspaces')`，与 workspace.ts 的 listWorkspaces/getWorkspace 同源，避免多键或存储层不一致。 |
| JSON 解析哨兵工具化 | lib/utils/api-helpers.ts、MCPManager.tsx | 新增 `safeParseResponseJson(res)`、`isParseError(data)`、`PARSE_ERROR_SENTINEL`，MCPManager 的 fetchBackendMCP 改为使用上述工具，减少重复的 `res.json().catch(() => ({ __parseError: true }))` 与类型判断；后续其他模块可复用。 |

### 四轮优化（续）

| 项 | 位置 | 修改内容 |
|----|------|----------|
| 抓取 URL 失败错误对外暴露 | `backend/api/knowledge_api.py` | 抓取 URL 失败时 `HTTPException(detail=f"抓取 URL 失败: {e}")` 改为使用 `_safe_error_detail(e)`，生产环境不暴露 httpx 内部异常详情 |
| 本体文件锁关闭异常可观测 | `backend/api/knowledge_api.py` | `_ontology_file_lock` / `_ontology_file_unlock` 中 `f.close()` 的 `except Exception: pass` 改为 `logger.debug("...", close_e)`，便于排查句柄关闭失败 |
| .indexignore 读取编码与异常 | `backend/tools/base/storage_manager.py` | `load_indexignore` 中 `read_text()` 改为 `read_text(encoding="utf-8")`，异常时 `logger.debug("load_indexignore failed: %s", e)` 替代静默 pass |

### P1 静默 catch 收敛（加载失败可感知）

| 项 | 位置 | 修改内容 |
|----|------|----------|
| 欢迎区档案加载失败 | AgentCapabilities.tsx | getAgentProfile：`!res.ok` 时 toast.error(t("dashboard.agentProfileLoadError"))；`.catch` 时 toast.error(..., description) |
| 任务列表加载失败 | TaskListSidebar.tsx | loadTasks：`!res.ok` 与 catch 均增加 toast.error(t("task.loadFailed"))，与 setLoadError 并存 |
| 记忆面板用户画像加载失败 | MemoryPanel.tsx | userModelApi.get(wsId) 的 `.catch` 增加 toast.error(t("execution.loadFailed")) |
| MCP 后端状态请求失败 | MCPManager.tsx | fetchBackendMCP 的 catch 增加 toast.error(t("editor.mcpListLoadError"), { description }) |
| 待办任务数轮询失败 | FullEditorV2Enhanced.tsx | getTasks('personal','pending') 的 .catch 增加一次性 toast.error(t("task.loadFailed"))（pendingTaskCountErrorToastShownRef 防刷） |
| 知识库同步状态加载失败 | KnowledgeBasePanel.tsx | loadSyncStatus 的 catch 增加 toast.error("加载同步状态失败", { description }) |
| 技能列表按 profile 加载失败 | KnowledgeBasePanel.tsx | loadSkillsByProfile 的 catch 增加 toast.error("加载技能列表失败", { description }) |
| 后端 except 补 logger | backend/api/app.py | 安装 Skill 时 market 列表解析 requires_tier 的 except Exception 改为 logger.debug("market item requires_tier parse skip", e)，便于排障 |
| 设置页敏感文件巡检加载失败 | SettingsView.tsx SensitiveFilesCard | loadItems 的 catch 增加 toast.error(t("settings.sensitiveScan.loadFailed"), { description }) |
| 设置页技能反馈统计加载失败 | SettingsView.tsx SkillFeedbackStatsCard | loadStats 的 catch 增加 toast.error(t("settings.getFailed"), { description }) |
| 仪表盘简报加载失败 | WorkspaceDashboard.tsx | 简报重试请求的 .catch 增加 toast.error(t("execution.loadFailed")) 再 setBriefingError(true) |
