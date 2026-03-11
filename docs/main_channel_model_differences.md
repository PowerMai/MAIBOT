# 主通道中不同模型的差异说明

## 概述

qwen3-coder 能正常得到回复，而 qwen3.5 常出现长时间无输出或超时，主要差异来自 **`enable_thinking`** 与 **`is_reasoning_model`** 的组合，以及 LM Studio 对“思考模式”的流式行为。

## 配置差异（models.json）

| 项目 | qwen3.5-9b / qwen3.5-35b | qwen3-coder-30b |
|------|--------------------------|------------------|
| **is_reasoning_model** | `true` | `true` |
| **config.enable_thinking** | **`true`**（显式） | **未配置**（本地默认 `false`） |
| **prompt_profile.thinking_guidance** | `minimal` | `light` |
| **prompt_profile.style** | `structured_xml` | `code_first` |

## 主通道中的代码分支差异

### 1. model_manager.create_llm（backend/engine/agent/model_manager.py）

- **thinking_enabled**（本地模型）  
  - 取自 `model_cfg.get("enable_thinking", False)`。  
  - qwen3.5：有 `enable_thinking: true` → **thinking_enabled = True**。  
  - qwen3-coder：无该字段 → **thinking_enabled = False**。

- **发给 LM Studio 的 extra_body**  
  - 当 `is_reasoning_model and thinking_enabled` 时：
    - `extra_body["enable_thinking"] = True`
    - `extra_body["chat_template_kwargs"] = {"enable_thinking": True}`
  - qwen3.5：会带 **enable_thinking=true** 请求。  
  - qwen3-coder：**enable_thinking=false**，不开启“思考模式”。

- **_convert_chunk_to_generation_chunk 补丁**  
  - 仅当 `is_reasoning_model and thinking_enabled` 时挂载：
    - 解析 `delta.reasoning_content`（路径 A）
    - 或解析 content 中的 `<think>...</think>`（路径 B）
  - qwen3.5：**会挂载**，期望 LM 返回 reasoning_content 或 <think> 流。  
  - qwen3-coder：**不挂载**，只走默认 content 流，首 token 行为与普通模型一致。

### 2. 提示词（agent_prompts）

- **is_reasoning_model** 为 true 时：
  - 不注入 think_tool 的“结构化思考”长段落；
  - 只注入“推理型模型适配”的短约束（科学方法触发器等）。
- 两者都是推理型，提示词在这层**无区分**，差异在 **enable_thinking** 和上面的 LLM 请求/解析。

### 3. main_graph 流式与回调

- 流式超时、心跳、callbacks 注入、首包空 partial 等对**所有模型一致**。
- 差异在于：  
  - qwen3-coder：不开启思考模式，LM 直接输出 content，首 token 快，回调很快触发。  
  - qwen3.5：开启思考模式后，LM Studio 可能在内部长时“思考”再开始推流，或只在一段 thinking 结束后才给 delta，导致首 token 极晚或格式不同，表现为“等很久/超时、无思考流”。

## 行为对比小结

| 行为 | qwen3.5（enable_thinking=true） | qwen3-coder（enable_thinking 默认 false） |
|------|----------------------------------|-------------------------------------------|
| 请求体 | 带 enable_thinking / chat_template_kwargs | 不带思考开关 |
| 首 token 时机 | 依赖 LM Studio 思考流实现，可能极晚 | 正常流式，首 token 早 |
| 流式解析 | 使用 reasoning_content + <think> 解析补丁 | 仅默认 content，无补丁 |
| 思考流展示 | 依赖服务端返回 reasoning_content 或 <think> | 无思考流 |

## 可选调整（若希望 qwen3.5 先“能回复”再考虑思考流）

- 在 **backend/config/models.json** 里，将 qwen3.5-9b（及 35b）的 **config.enable_thinking** 改为 **false**：
  - 请求不再带 `enable_thinking: true`，行为与 qwen3-coder 类似；
  - 首 token 会提前，一般能避免长时间无输出/超时；
  - 代价是暂时不使用“思考流”展示（reasoning_content / <think> 解析也不会被使用）。
- 若 LM Studio 或后端后续支持“边思考边流式”且格式稳定，再把 **enable_thinking** 改回 **true** 并配合主通道的 reasoning 解析与前端思考流展示即可。

## 相关代码位置

- 模型配置与 thinking 开关：`backend/config/models.json`（各模型 `config.enable_thinking`）。
- thinking_enabled 与 extra_body：`backend/engine/agent/model_manager.py`（约 1717–1820、1837 行）。
- reasoning_content / <think> 解析：`backend/engine/agent/model_manager.py`（约 1837–1915 行）。
- 提示词中 is_reasoning_model 分支：`backend/engine/prompts/agent_prompts.py`（约 1268–1292 行）。
- 后端发送 reasoning 事件：`backend/engine/core/main_graph.py`（reasoning phase=start/content/end，msg_id 与首包 partial 一致）。

## 后端测试（保障思考流契约与解析）

- **tests/test_reasoning_stream_contract.py**：约定 `type=reasoning`、`data.phase`（start/content/end）、`data.msg_id`、`data.content` 形状，与前端 RunTracker/thread 解析方式一致。
- **tests/test_model_manager_reasoning.py**：推理模型 + enable_thinking 时，delta.reasoning_content（路径 A）与 content 内 `<think>...</think>`（路径 B）能正确注入 `additional_kwargs.reasoning_content`；未开启时不挂载解析。

运行：`cd backend && .venv/bin/python -m pytest tests/test_reasoning_stream_contract.py tests/test_model_manager_reasoning.py -v`

## 谁在调用 qwen3.5-35B（auto 选模）

当用户选择「自动」或未指定模型时，`model_manager._resolve_auto_model()` 决定实际使用的模型。

- **原逻辑**：`auto_selection_rule = "priority_then_available"` 时，**先**执行 capability 选模（`_select_model_by_capability`），再按配置顺序回退。35B 的 capability 分数高于 9B（reasoning_depth/planning 等），因此常被选为「最优」，导致即使用户期望用 9B 或 Coder，实际仍可能走 35B。
- **调用链**：`get_model_for_thread(config)` → `_resolve_auto_model(configurable)` → `_select_model_by_capability()` → `select_model_by_task_profile()` → 按加权能力打分，35B 胜出。
- **合理性**：capability 选模本意是「按任务选最优」，但 default_model 在配置中明确为 9B，用户未显式选 35B 时期望以默认为主。若 35B 未被加载或显式选择，不应仅因分数高而被自动选用。
- **建议**：`priority_then_available` 下应**优先使用 default_model**（若可用），仅当其不可用时再走 capability 或按列表顺序回退。这样 35B 只会在：用户显式选择、或 default（9B）不可用时的回退中被调用。

### 举一反三：其他会用到 35B 的路径（已对齐 default_model）

- **get_fallback_model_for(primary)**：escalation 回退时，若无云模型，原先按配置列表顺序选「任意可用非主模型」，可能选中 35B。现已改为**优先返回 default_model**（若其非主模型且可用），再按列表顺序，避免从 9B 重试时误回退到 35B；主模型为 35B 时则回退到 9B。
- **_resolve_best_local_model()**：用于 license 不允许云端时的本地回退、以及 _resolve_auto_model 最终兜底。原先按配置列表顺序返回第一个 local 可用模型。现已改为**优先返回 default_model**（若为 local 且可用），再按列表顺序，保证与 auto 选模一致。
- **create_llm(config=None)**：如 knowledge_learning、registry、task_bidding、api 等处无 config 调用时，get_model(None) → _resolve_auto_model()，已优先 default_model，无需再改。
