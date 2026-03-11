"""模型管理器 - Claude/Cursor 风格

职责：
1. 加载配置并合并云端/本地发现：列表来源包含配置、云端端点动态发现、本地端点自动发现
2. 检测模型可用状态（探测或发现结果决定 available）
3. 维护会话与模型的绑定关系
4. 提供模型选择逻辑

业务逻辑（重要）：
- 会话（Thread）创建时绑定模型，会话过程中不能切换
- 切换模型 = 创建新会话
- Auto 选择规则：按 priority 排序，选择第一个可用的模型
- 缺省模型：来自 models.json 的 default_model（缺失时回退到首个可用模型）
- SubAgent 使用与主 Agent 相同的模型（same_as_main）

会话模型绑定：
- Thread 创建时，通过 config.configurable.model 指定模型
- 后续消息复用同一个 Thread，模型不变
- 前端显示当前会话使用的模型（只读）
"""
import json
import asyncio
import os
import httpx
import logging
from pathlib import Path
from typing import Optional, Dict, List, Any, TYPE_CHECKING, Tuple
from dataclasses import dataclass, field
from datetime import datetime, timezone
import threading
import sys
from backend.engine.license.tier_service import is_cloud_model_allowed, check_daily_cloud_quota

logger = logging.getLogger(__name__)

# 设置 LLM_DEBUG=1 可将 LLM 原始 delta 和 callback 层内容写入 debug 日志，用于诊断响应格式问题
_LLM_DEBUG = os.environ.get("LLM_DEBUG", "").lower() in ("1", "true", "yes")
_LLM_DEBUG_LOG_PATH = Path(__file__).resolve().parents[3] / ".cursor" / "llm_debug.log"


def _llm_debug(tag: str, data: dict) -> None:
    if not _LLM_DEBUG:
        return
    import time, json as _json
    try:
        _LLM_DEBUG_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        line = _json.dumps({"t": int(time.time() * 1000), "tag": tag, **data}, ensure_ascii=False)
        with _LLM_DEBUG_LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception as e:
        logger.debug("llm_debug write failed: %s", e)


SENSITIVE_FIELDS = {"api_key", "api_secret", "token"}

_PROBE_HTTP_CLIENT: Optional[httpx.Client] = None
_PROBE_HTTP_CLIENT_LOCK = threading.Lock()
_LLM_HTTP_CLIENT: Optional[httpx.Client] = None
_LLM_HTTP_ASYNC_CLIENT: Optional[httpx.AsyncClient] = None
_LLM_HTTP_CLIENT_LOCK = threading.Lock()


def _get_probe_http_client() -> httpx.Client:
    global _PROBE_HTTP_CLIENT
    if _PROBE_HTTP_CLIENT is not None:
        return _PROBE_HTTP_CLIENT
    with _PROBE_HTTP_CLIENT_LOCK:
        if _PROBE_HTTP_CLIENT is None:
            _PROBE_HTTP_CLIENT = httpx.Client(
                limits=httpx.Limits(max_keepalive_connections=10, max_connections=20, keepalive_expiry=30.0),
            )
    return _PROBE_HTTP_CLIENT


def _get_llm_http_clients() -> tuple[httpx.Client, httpx.AsyncClient]:
    global _LLM_HTTP_CLIENT, _LLM_HTTP_ASYNC_CLIENT
    if _LLM_HTTP_CLIENT is not None and _LLM_HTTP_ASYNC_CLIENT is not None:
        return _LLM_HTTP_CLIENT, _LLM_HTTP_ASYNC_CLIENT
    with _LLM_HTTP_CLIENT_LOCK:
        if _LLM_HTTP_CLIENT is None:
            _LLM_HTTP_CLIENT = httpx.Client(
                limits=httpx.Limits(max_keepalive_connections=20, max_connections=50, keepalive_expiry=30.0),
            )
        if _LLM_HTTP_ASYNC_CLIENT is None:
            _LLM_HTTP_ASYNC_CLIENT = httpx.AsyncClient(
                limits=httpx.Limits(max_keepalive_connections=20, max_connections=50, keepalive_expiry=30.0),
            )
    return _LLM_HTTP_CLIENT, _LLM_HTTP_ASYNC_CLIENT


async def cleanup_llm_http_clients() -> None:
    """应用关闭时关闭 LLM HTTP 客户端，避免连接池泄漏。"""
    global _LLM_HTTP_CLIENT, _LLM_HTTP_ASYNC_CLIENT
    with _LLM_HTTP_CLIENT_LOCK:
        sync_c = _LLM_HTTP_CLIENT
        async_c = _LLM_HTTP_ASYNC_CLIENT
        _LLM_HTTP_CLIENT = None
        _LLM_HTTP_ASYNC_CLIENT = None
    try:
        if sync_c is not None:
            sync_c.close()
    except Exception:
        pass
    try:
        if async_c is not None:
            await async_c.aclose()
    except Exception:
        pass


async def _probe_get_async(url: str, timeout: float, headers: Optional[Dict[str, str]] = None):
    client = _get_probe_http_client()
    return await asyncio.to_thread(client.get, url, timeout=timeout, headers=headers or {})


def _normalize_api_key(key: str) -> str:
    """去掉首尾空白和一层双引号，避免 env/配置写成 \"sk-xxx\" 导致 Authorization 错误。"""
    if not key:
        return ""
    s = (key or "").strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        s = s[1:-1].strip()
    return s


def _resolve_api_key(api_key_env: str) -> str:
    """解析 API key：优先从环境变量读取；若为空且 api_key_env 形似内联 key（如 sk- 开头），则直接使用（兼容误填）。"""
    if not (api_key_env or "").strip():
        return ""
    s = (api_key_env or "").strip()
    key = (os.getenv(s) or "").strip()
    if not key and (s.startswith("sk-") or (len(s) > 24 and " " not in s and "=" not in s)):
        key = s
    return _normalize_api_key(key)


def _probe_headers_for_model(model: "ModelInfo") -> Dict[str, str]:
    """探测时若模型配置了 api_key_env 且环境变量已设置，则返回 Authorization 头（云端 401 时仍可标为可用）。"""
    api_key_env = (getattr(model, "api_key_env", None) or "").strip()
    if not api_key_env:
        return {}
    key = _resolve_api_key(api_key_env)
    if not key:
        return {}
    return {"Authorization": f"Bearer {key}"}

TASK_CAPABILITY_WEIGHTS: Dict[str, Dict[str, float]] = {
    "code_generation": {"coding_quality": 0.5, "reasoning_depth": 0.3, "tool_use": 0.2},
    "document_analysis": {"reasoning_depth": 0.4, "writing": 0.3, "retrieval": 0.3},
    "planning": {"planning": 0.5, "reasoning_depth": 0.3, "stability": 0.2},
    "quick_answer": {"stability": 0.5, "writing": 0.3, "reasoning_depth": 0.2},
    "chat": {"reasoning_depth": 0.35, "writing": 0.3, "tool_use": 0.2, "stability": 0.15},
    "default": {"reasoning_depth": 0.35, "writing": 0.25, "tool_use": 0.2, "stability": 0.2},
}

# 按 provider 对应的环境变量名解析 API Key（用于 init_chat_model）
PROVIDER_ENV_KEYS: Dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google_genai": "GOOGLE_API_KEY",
    "google_vertexai": "GOOGLE_CLOUD_PROJECT",  # Vertex 通常用 ADC
    "azure_openai": "AZURE_OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "dashscope": "DASHSCOPE_API_KEY",  # 阿里云百炼
}

if TYPE_CHECKING:
    from langchain_openai import ChatOpenAI
    from langchain_core.runnables import RunnableConfig


# ============================================================
# LLM 流式 reasoning_content 透传
# ============================================================
#
# langchain-openai 1.0.3 的 _convert_delta_to_message_chunk 只提取
# delta.content / delta.tool_calls，丢弃 LM Studio / Qwen 推理模型
# 返回的 delta.reasoning_content 字段。
#
# 通过覆写 _convert_chunk_to_generation_chunk，在 Chat Completions
# 流式路径中将 reasoning_content 注入 AIMessageChunk.additional_kwargs，
# 使 DeepAgent → main_graph → 前端的整条链路都能拿到推理内容。
# ============================================================

def _patch_reasoning_content_on_chunk(generation_chunk):
    """将 delta.reasoning_content 注入到 AIMessageChunk.additional_kwargs 中。
    
    在 _convert_chunk_to_generation_chunk 之后调用：
    langchain-openai 已将 delta 转为 AIMessageChunk，但丢弃了 reasoning_content；
    我们从原始 chunk dict 中补回。
    """
    return generation_chunk


# 配置文件路径。打包（含 macOS App）时使用与后端同目录的 config/models.json，default_model 决定缺省模型；
# 缺省对接本地 LM Studio 时请保持 models.json 中 default_model 为 local 模型，勿用环境变量 DEFAULT_MODEL 覆盖为云端 id。
CONFIG_PATH = Path(__file__).parent.parent.parent / "config" / "models.json"
LICENSE_PATH = Path(__file__).resolve().parents[3] / "data" / "license.json"


def _load_license_profile_fallback() -> Dict[str, Any]:
    try:
        if LICENSE_PATH.exists():
            data = json.loads(LICENSE_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
    except Exception as e:
        logger.debug("[ModelManager] 加载 license fallback 失败，使用 free: %s", e)
    return {"tier": "free"}


@dataclass
class ModelInfo:
    """模型信息"""
    id: str
    name: str
    description: str
    url: str
    enabled: bool
    display_name: Optional[str] = None
    priority: int = 999  # 优先级，数字越小优先级越高
    context_length: int = 65536  # 模型真实上下文窗口长度（用于 SummarizationMiddleware）
    config: Dict[str, Any] = field(default_factory=dict)
    available: bool = False  # 运行时检测
    last_check: Optional[datetime] = None
    # 多供应商：init_chat_model 的 model_provider（openai/anthropic/google_genai/azure_openai 等）
    provider: str = "openai"
    api_key: Optional[str] = None  # 为空时从环境变量按 provider 读取
    api_key_env: Optional[str] = None  # 优先从指定环境变量读取（云端代理场景）
    tier: str = "local"  # local / cloud-reasoning / cloud-strong / cloud-premium
    cost_level: str = "unknown"  # zero / low / medium / high
    is_reasoning_model: bool = False
    supports_images: bool = False
    capability: Dict[str, Any] = field(default_factory=dict)
    prompt_profile: Dict[str, Any] = field(default_factory=dict)
    role_affinity: Dict[str, float] = field(default_factory=dict)
    usage: str = "chat"  # chat / embedding / rerank
    internal_only: bool = False
    # 运行时探测出的可达地址（不持久化）
    runtime_url: Optional[str] = None
    # 运行时匹配到的远程模型 id（GET /models 返回的 data[].id 或 loaded_instances[].id，请求时优先使用，不持久化）
    runtime_model_id: Optional[str] = None
    # LM Studio 实际模型 id（与 GET /models 返回的 data[].id 一致时填写，用于可用性检测与请求）
    lm_studio_id: Optional[str] = None
    # 多 endpoint 返回同 id 时的 URL 候选（仅云端发现，不持久化）
    url_candidates: Optional[List[str]] = None


@dataclass
class ModelConfig:
    """模型配置"""
    models: List[ModelInfo]
    default_model: str
    subagent_model: str  # "same_as_main" 或模型 ID
    subagent_model_mapping: Dict[str, str] = field(default_factory=dict)  # 按 agent_type 指定模型
    api_timeout: int = 180
    api_timeout_doc: int = 300
    api_timeout_analysis: int = 600
    auto_selection_rule: str = "priority_then_available"  # auto 选择规则
    escalation_policy: Dict[str, Any] = field(default_factory=dict)
    dynamic_context: Dict[str, Any] = field(default_factory=dict)
    # 云端端点：配置后自动 GET /v1/models 发现模型并加入可用列表
    cloud_endpoints: List[Dict[str, Any]] = field(default_factory=list)  # [{"base_url": "...", "api_key_env": "..."}]


class ModelManager:
    """模型管理器（单例）
    
    使用方式：
    ```python
    manager = get_model_manager()
    
    # 获取模型列表（供前端）
    models = manager.get_models_list()
    
    # 创建 LLM
    llm = manager.create_llm(config=config, task_type="default")
    
    # 为 SubAgent 创建 LLM
    llm = manager.create_llm(config=config, for_subagent=True)
    ```
    """
    
    _instance: Optional["ModelManager"] = None
    _lock = threading.Lock()
    
    def __new__(cls):
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = super().__new__(cls)
                    cls._instance._initialized = False
        return cls._instance
    
    def __init__(self):
        if self._initialized:
            return
        
        self._config: Optional[ModelConfig] = None
        self._current_model: Optional[str] = None
        self._llm_cache: Dict[str, "ChatOpenAI"] = {}
        self._llm_cache_lock = threading.Lock()
        self._config_lock = threading.RLock()
        self._configurable_llm: Optional[Any] = None
        self._initialized = True
        self._availability_check_interval = 15  # 可用性检查间隔（秒），配合前端 5s 轮询便于 LM Studio 启动后尽快发现
        # 云端动态发现：从 cloud_endpoints 的 GET /v1/models 拉取的模型列表（不写入 models.json）
        self._discovered_cloud_models: List["ModelInfo"] = []
        self._discovered_by_id: Dict[str, "ModelInfo"] = {}
        self._discovered_lock: threading.RLock = threading.RLock()
        
        # 加载配置
        self._load_config()
        
        # 后台拉取云端端点模型列表（不阻塞启动）
        def _bg_fetch_cloud():
            try:
                self._fetch_cloud_models_sync()
            except Exception as e:
                logger.warning("[ModelManager] 后台拉取云端模型失败: %s", e)
        t = threading.Thread(target=_bg_fetch_cloud, daemon=True)
        t.start()
        
        logger.info("[ModelManager] 初始化完成，加载了 %d 个模型", len(self._config.models))
    
    def _load_config(self):
        """加载配置文件"""
        if not CONFIG_PATH.exists():
            logger.warning("[ModelManager] 配置文件不存在: %s，使用默认配置", CONFIG_PATH)
            fallback_model_id = os.getenv("DEFAULT_MODEL") or os.getenv("LM_STUDIO_MODEL") or "local/default-model"
            # 使用默认配置
            self._config = ModelConfig(
                models=[
                    ModelInfo(
                        id=fallback_model_id,
                        name="Default Local Model",
                        description="默认模型",
                        url="http://localhost:1234/v1",
                        enabled=True,
                        config={
                            "temperature": 0.25,
                            "max_tokens_default": 32768,
                        },
                        provider="openai",
                        api_key=None,
                        api_key_env=None,
                        tier="local",
                        cost_level="zero",
                        is_reasoning_model=False,
                        usage="chat",
                        internal_only=False,
                    )
                ],
                default_model=fallback_model_id,
                subagent_model="same_as_main",
                subagent_model_mapping={},
                api_timeout_analysis=600,
                escalation_policy={
                    "enabled": True,
                    "context_compression": True,
                    "triggers": ["retry_count_ge_2"],
                    "fallback_order": ["cloud-reasoning", "cloud-strong", "cloud-premium"],
                },
                cloud_endpoints=[],
            )
            self._rebuild_model_index()
            return
        
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            models = [
                ModelInfo(
                    id=m["id"],
                    name=m["name"],
                    display_name=m.get("display_name"),
                    description=m.get("description", ""),
                    url=m["url"],
                    enabled=m.get("enabled", True),
                    priority=m.get("priority", 999),
                    context_length=m.get("context_length", 65536),  # 默认 64K
                    config=m.get("config", {}),
                    provider=m.get("provider", "openai"),
                    api_key=m.get("api_key"),
                    api_key_env=m.get("api_key_env"),
                    tier=m.get("tier", "local"),
                    cost_level=m.get("cost_level", "unknown"),
                    is_reasoning_model=m.get("is_reasoning_model", False),
                    supports_images=m.get("supports_images", False),
                    capability=m.get("capability", {}),
                    prompt_profile=m.get("prompt_profile", {}),
                    role_affinity=m.get("role_affinity", {}),
                    usage=str(m.get("usage", "chat") or "chat"),
                    internal_only=bool(m.get("internal_only", False)),
                    lm_studio_id=m.get("lm_studio_id"),
                    runtime_model_id=(m.get("runtime_model_id") or "").strip() or None,
                )
                for m in data.get("models", [])
            ]
            
            # 按优先级排序
            models.sort(key=lambda m: m.priority)
            
            cloud_endpoints = data.get("cloud_endpoints")
            if not isinstance(cloud_endpoints, list):
                cloud_endpoints = []
            self._config = ModelConfig(
                models=models,
                default_model=data.get("default_model", models[0].id if models else (os.getenv("DEFAULT_MODEL") or os.getenv("LM_STUDIO_MODEL") or "local/default-model")),
                subagent_model=data.get("subagent_model", "same_as_main"),
                subagent_model_mapping=data.get("subagent_model_mapping", {}) if isinstance(data.get("subagent_model_mapping", {}), dict) else {},
                api_timeout=data.get("api_timeout", 180),
                api_timeout_doc=data.get("api_timeout_doc", 300),
                api_timeout_analysis=data.get("api_timeout_analysis", data.get("api_timeout_doc", 300)),
                auto_selection_rule=data.get("auto_selection_rule", "priority_then_available"),
                escalation_policy=data.get("escalation_policy", {}),
                dynamic_context=data.get("dynamic_context", {}),
                cloud_endpoints=cloud_endpoints,
            )
            
            logger.info("[ModelManager] 配置文件加载成功: %s", CONFIG_PATH)
            logger.info("[ModelManager] 默认模型: %s", self._config.default_model)
            for m in models:
                logger.debug("[ModelManager] - %s (%s) [priority=%d]", m.id, m.name, m.priority)
            self._rebuild_model_index()
                
        except Exception as e:
            logger.error("[ModelManager] 配置文件加载失败: %s", e)
            raise
    
    def _rebuild_model_index(self):
        self._model_by_id: dict[str, "ModelInfo"] = {m.id: m for m in self._config.models}

    def _fetch_cloud_models_sync(self) -> int:
        """从配置的 cloud_endpoints 拉取 GET /v1/models，将发现的模型填入 _discovered_cloud_models。返回发现的模型数量。"""
        endpoints = getattr(self._config, "cloud_endpoints", None) or []
        if not endpoints:
            with self._discovered_lock:
                self._discovered_cloud_models = []
                self._discovered_by_id = {}
            return 0
        discovered: List[ModelInfo] = []
        seen_ids: set = set()
        by_id: Dict[str, ModelInfo] = {}  # mid -> ModelInfo，用于多 endpoint 同 id 时合并 url_candidates
        client = _get_probe_http_client()
        for ep in endpoints:
            if not isinstance(ep, dict):
                continue
            base_url = (ep.get("base_url") or "").strip().rstrip("/")
            if not base_url:
                continue
            api_key_env = (ep.get("api_key_env") or "").strip()
            api_key = _resolve_api_key(api_key_env) if api_key_env else None
            url = f"{base_url}/models" if "/v1" in base_url else f"{base_url}/v1/models"
            headers: Dict[str, str] = {}
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            try:
                resp = client.get(url, headers=headers or None, timeout=10.0)
                if resp.status_code != 200:
                    logger.debug("[ModelManager] 云端端点 %s 返回 %s", base_url, resp.status_code)
                    continue
                data = resp.json() if resp.content else {}
            except Exception as e:
                logger.debug("[ModelManager] 拉取云端模型失败 %s: %s", base_url, e)
                continue
            # 多种响应格式：data[]、models[]、根为 list
            items: List[Dict[str, Any]] = []
            if isinstance(data, list):
                items = [x for x in data if isinstance(x, dict)]
            else:
                items = list(data.get("data") or data.get("models") or data.get("model_list") or [])
                items = [x for x in items if isinstance(x, dict)]
            for item in items:
                if not isinstance(item, dict):
                    continue
                # 业界常规（OpenAI 兼容）：列表 data[].id 即请求用 model；云端发现统一使用规范 id（cloud/ + 原始 id），与列表/请求一致，单一数据源
                raw_id = (item.get("id") or item.get("name") or "").strip()
                if not raw_id:
                    continue
                canonical_id = raw_id if raw_id.lower().startswith("cloud/") else f"cloud/{raw_id}"
                existing = by_id.get(canonical_id)
                if existing is not None:
                    # 多 endpoint 返回同 id：追加当前 base_url 到 url_candidates
                    if existing.url_candidates is None:
                        existing.url_candidates = [existing.url or "", base_url]
                    elif base_url not in existing.url_candidates:
                        existing.url_candidates.append(base_url)
                    continue
                seen_ids.add(canonical_id)
                # 从 API 解析上下文长度（业界常见字段：context_length / max_model_len / max_tokens / max_input_tokens）
                ctx = (
                    item.get("context_length")
                    or item.get("max_model_len")
                    or item.get("max_tokens")
                    or item.get("max_input_tokens")
                    or item.get("context_window")
                )
                if ctx is None and isinstance(item.get("root"), dict):
                    r = item["root"]
                    ctx = r.get("context_length") or r.get("max_model_len") or r.get("max_input_tokens")
                context_length = int(ctx) if ctx is not None else 262144
                display_name = (item.get("name") or item.get("id") or raw_id).strip()
                info = ModelInfo(
                    id=canonical_id,
                    name=display_name,
                    display_name=display_name,
                    description=f"云端发现 ({base_url})",
                    url=base_url,
                    enabled=True,
                    available=True,  # 发现即视为可用，否则 _is_model_available 为 False 会回退到本地模型导致 502
                    priority=50,
                    context_length=context_length,
                    config={"temperature": 0.3, "max_tokens_default": min(32768, context_length)},
                    provider="openai",
                    api_key=None,
                    api_key_env=api_key_env or None,
                    tier="cloud",
                    cost_level="medium",
                    is_reasoning_model=False,
                    supports_images=bool(item.get("supports_images", False)),
                    capability={},
                    usage="chat",
                    internal_only=False,
                    url_candidates=[base_url],
                    runtime_model_id=raw_id,  # 请求上游时传 API 原始 id，否则传 cloud/xxx 会导致 401/参数错误
                )
                discovered.append(info)
                by_id[canonical_id] = info
        with self._discovered_lock:
            self._discovered_cloud_models = discovered
            self._discovered_by_id = {m.id: m for m in discovered}
        # 将发现结果中的 runtime_model_id 同步到同 endpoint 的配置模型（按 url + id 匹配），避免硬编码
        endpoints_base = {(ep.get("base_url") or "").strip().rstrip("/") for ep in (endpoints or []) if isinstance(ep, dict) and (ep.get("base_url") or "").strip()}
        for cfg in (getattr(self._config, "models", None) or []):
            if not getattr(cfg, "url", ""):
                continue
            tier = str(getattr(cfg, "tier", "") or "").strip().lower()
            if tier != "cloud" and not tier.startswith("cloud-"):
                continue
            base = (cfg.url or "").strip().rstrip("/")
            if base not in endpoints_base:
                continue
            for d in discovered:
                d_base = (getattr(d, "url", "") or "").strip().rstrip("/")
                if d_base != base:
                    continue
                rid = (getattr(d, "runtime_model_id", None) or "").strip()
                if not rid:
                    continue
                cfg_id_lower = (cfg.id or "").strip().lower()
                d_id_lower = (d.id or "").strip().lower()
                rid_cloud_lower = ("cloud/" + rid).strip().lower()
                if cfg_id_lower == d_id_lower or cfg_id_lower == rid_cloud_lower or (rid.lower() in cfg_id_lower):
                    cfg.runtime_model_id = rid
                    logger.debug("[ModelManager] 已同步配置模型 %s 的 runtime_model_id=%s", cfg.id, rid)
                    break
        if discovered:
            logger.info("[ModelManager] 云端动态发现 %d 个模型", len(discovered))
        return len(discovered)

    @staticmethod
    def _normalize_model_id_for_match(model_id: str) -> str:
        """宽松匹配用：转小写并去掉常见 vendor 前缀（如 qwen/、cloud/）。"""
        if not model_id or not isinstance(model_id, str):
            return ""
        s = model_id.strip().lower()
        for prefix in ("cloud/", "qwen/", "openai/", "local/"):
            if s.startswith(prefix):
                s = s[len(prefix):].strip()
                break
        return s

    def _model_id_matches_remote(self, model: "ModelInfo", config_id: str, available_list: List[str]) -> bool:
        """判断配置模型是否与 LM Studio 返回的列表匹配（含 lm_studio_id、宽松匹配、本地前缀/包含匹配）。"""
        if self._get_matched_remote_id(model, config_id, available_list) is not None:
            return True
        return False

    def _get_matched_remote_id(self, model: "ModelInfo", config_id: str, available_list: List[str]) -> Optional[str]:
        """若配置模型与远程列表匹配，返回应用于请求的远程 id；否则返回 None。"""
        if config_id in available_list:
            return config_id
        lm_sid = getattr(model, "lm_studio_id", None)
        if lm_sid and str(lm_sid).strip():
            sid = str(lm_sid).strip()
            if sid in available_list:
                return sid
        norm_config = self._normalize_model_id_for_match(config_id)
        if not norm_config:
            return None
        for remote in available_list:
            if self._normalize_model_id_for_match(str(remote)) == norm_config:
                return str(remote).strip()
        # 仅 local 模型：前缀或包含匹配（LM Studio 常返回 Qwen3.5-9B-Instruct-Q4_K_M 等，与 qwen3.5-9b 需宽松匹配）
        if str(getattr(model, "tier", "")).lower() == "local":
            cand = (norm_config, (str(lm_sid).strip().lower() if lm_sid and str(lm_sid).strip() else ""))
            for needle in cand:
                if not needle or len(needle) < 3:
                    continue
                for remote in available_list:
                    r = str(remote).strip().lower()
                    if r.startswith(needle) or (len(needle) >= 5 and needle in r):
                        return str(remote).strip()
        return None

    @staticmethod
    def _parse_available_model_ids_from_response(json_obj: Any) -> List[str]:
        """从 LM Studio / OpenAI / vLLM 等兼容接口的响应中解析可用模型 id 列表。
        支持：data[].id；models[].id/key 与 loaded_instances[].id；根为 list 的响应。
        """
        out: List[str] = []
        if json_obj is None:
            return out
        # 根为 list（部分 vLLM/网关直接返回数组）
        if isinstance(json_obj, list):
            for m in json_obj:
                if isinstance(m, dict):
                    raw = (m.get("id") or m.get("name") or m.get("key") or "").strip()
                    if raw:
                        out.append(raw)
            return list(dict.fromkeys(x for x in out if x))
        if not isinstance(json_obj, dict):
            return out
        # OpenAI 兼容：data[].id
        for m in json_obj.get("data") or []:
            if isinstance(m, dict):
                raw = (m.get("id") or m.get("name") or "").strip()
                if raw:
                    out.append(raw)
        # models[]（常见备用键）
        for m in json_obj.get("models") or json_obj.get("model_list") or []:
            if not isinstance(m, dict):
                continue
            raw = (m.get("id") or m.get("name") or m.get("key") or "").strip()
            if raw:
                out.append(raw)
            for inst in m.get("loaded_instances") or []:
                if isinstance(inst, dict) and inst.get("id"):
                    out.append(str(inst["id"]).strip())
        return list(dict.fromkeys(x for x in out if x))

    def _runtime_request_model_id(self, model: "ModelInfo") -> str:
        """请求时传给后端的 model 参数：优先 runtime_model_id（仅本地可用性检测会填充），否则 local 用 lm_studio_id，否则用 id。云端发现时 id 即为请求用 id。"""
        rid = getattr(model, "runtime_model_id", None)
        if rid and str(rid).strip():
            return str(rid).strip()
        if str(getattr(model, "tier", "")).lower() == "local":
            lsid = getattr(model, "lm_studio_id", None)
            if lsid and str(lsid).strip():
                return str(lsid).strip()
        return model.id

    def reload_config(self):
        """重新加载配置文件"""
        with self._config_lock:
            self._load_config()
            self._rebuild_model_index()
        with self._llm_cache_lock:
            self._llm_cache.clear()
        self._configurable_llm = None
        try:
            self._fetch_cloud_models_sync()
        except Exception as e:
            logger.warning("[ModelManager] reload 后拉取云端模型失败: %s", e)

    def refresh_cloud_models(self) -> int:
        """重新从 cloud_endpoints 拉取模型列表并更新发现缓存。返回发现的模型数量。"""
        return self._fetch_cloud_models_sync()

    def update_cloud_endpoints(self, cloud_endpoints: List[Dict[str, Any]]) -> int:
        """更新 cloud_endpoints 并写回 models.json，然后重新拉取云端模型。返回发现的模型数量。base_url 存储时统一去掉末尾斜杠，与业界常见用法一致。"""
        normalized = [
            {"base_url": str(e.get("base_url", "")).strip().rstrip("/") or "", "api_key_env": str(e.get("api_key_env", "")).strip()}
            for e in cloud_endpoints
        ]
        if not CONFIG_PATH.exists():
            self._config.cloud_endpoints = normalized
            return self._fetch_cloud_models_sync()
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        data["cloud_endpoints"] = normalized
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        with self._config_lock:
            self._config.cloud_endpoints = normalized
        with self._llm_cache_lock:
            self._llm_cache.clear()
        n = self._fetch_cloud_models_sync()
        logger.info("[ModelManager] 已更新 cloud_endpoints 并刷新发现，共 %d 条端点、%d 个模型（已清 LLM 缓存）", len(normalized), n)
        return n

    def get_cloud_endpoints_with_models(self) -> List[Dict[str, Any]]:
        """返回云端端点及其下发现的模型 id 列表，供配置页按端点展示「本端点有哪些模型、Key 是否可用」。API Key 属于端点，该端点下所有模型共用。"""
        endpoints = list(getattr(self._config, "cloud_endpoints", None) or [])
        result = []
        with self._discovered_lock:
            discovered = list(self._discovered_cloud_models)
        for ep in endpoints:
            base_url = str(ep.get("base_url", "")).strip().rstrip("/")
            api_key_env = (ep.get("api_key_env") or "").strip()
            has_key = bool(_resolve_api_key(api_key_env))
            model_ids = [m.id for m in discovered if (getattr(m, "url", "") or "").strip().rstrip("/") == base_url]
            result.append({"base_url": ep.get("base_url", ""), "api_key_env": ep.get("api_key_env", ""), "has_key": has_key, "model_ids": model_ids})
        return result

    def check_model_availability(self, model_id: str) -> bool:
        """检测模型是否可用（同步版本）"""
        model = self.get_model_info(model_id)
        if not model or not model.enabled:
            return False
        probe_headers = _probe_headers_for_model(model)
        tier = str(getattr(model, "tier", "") or "").strip().lower()
        is_cloud = tier == "cloud" or tier.startswith("cloud-")
        for base_url in self._iter_model_candidate_urls(model):
            probe_path = "/models" if "/v1" in base_url else "/v1/models" if is_cloud else "/models"
            probe_url = f"{base_url.rstrip('/')}{probe_path}"
            try:
                resp = _get_probe_http_client().get(probe_url, timeout=5.0, headers=probe_headers)
                if resp.status_code != 200:
                    continue
                try:
                    payload = resp.json()
                except Exception as e:
                    logger.debug("check_model_availability resp.json 失败 %s: %s", base_url, e)
                    continue
                available_models = self._parse_available_model_ids_from_response(payload)
                if not available_models and str(getattr(model, "tier", "")).lower() == "local":
                    alt_base = base_url.replace("/v1", "/api/v1")
                    if alt_base != base_url:
                        try:
                            alt_resp = _get_probe_http_client().get(f"{alt_base}/models", timeout=5.0, headers=probe_headers)
                            if alt_resp.status_code == 200:
                                try:
                                    available_models = self._parse_available_model_ids_from_response(alt_resp.json())
                                except Exception as e:
                                    logger.debug("check_model_availability alt parse failed %s: %s", alt_base, e)
                        except Exception as e:
                            logger.debug("check_model_availability alt probe failed %s: %s", alt_base, e)
                matched_id = self._get_matched_remote_id(model, model_id, available_models)
                if matched_id is not None:
                    with self._config_lock:
                        model.available = True
                        model.runtime_url = base_url
                        model.runtime_model_id = matched_id
                        model.last_check = datetime.now()
                    return True
            except Exception as e:
                logger.debug("check_model_availability probe failed %s: %s", base_url, e)
                continue
        with self._config_lock:
            model.available = False
            model.runtime_model_id = None
            model.last_check = datetime.now()
        return False
    
    async def check_model_availability_async(self, model_id: str) -> bool:
        """检测模型是否可用（异步版本）"""
        model = self.get_model_info(model_id)
        if not model or not model.enabled:
            return False
        probe_headers = _probe_headers_for_model(model)
        tier = str(getattr(model, "tier", "") or "").strip().lower()
        is_cloud = tier == "cloud" or tier.startswith("cloud-")
        for base_url in self._iter_model_candidate_urls(model):
            probe_path = "/models" if "/v1" in base_url else "/v1/models" if is_cloud else "/models"
            probe_url = f"{base_url.rstrip('/')}{probe_path}"
            try:
                resp = await _probe_get_async(probe_url, timeout=5.0, headers=probe_headers)
                if resp.status_code != 200:
                    continue
                try:
                    payload = resp.json()
                except Exception as e:
                    logger.debug("check_model_availability_async resp.json 失败 %s: %s", base_url, e)
                    continue
                available_models = self._parse_available_model_ids_from_response(payload)
                if not available_models and str(getattr(model, "tier", "")).lower() == "local":
                    alt_base = base_url.replace("/v1", "/api/v1")
                    if alt_base != base_url:
                        try:
                            alt_resp = await _probe_get_async(f"{alt_base}/models", timeout=5.0, headers=probe_headers)
                            if alt_resp.status_code == 200:
                                try:
                                    available_models = self._parse_available_model_ids_from_response(alt_resp.json())
                                except Exception as e:
                                    logger.debug("check_model_availability_async alt parse failed %s: %s", alt_base, e)
                        except Exception as e:
                            logger.debug("check_model_availability_async alt probe failed %s: %s", alt_base, e)
                matched_id = self._get_matched_remote_id(model, model_id, available_models)
                if matched_id is not None:
                    with self._config_lock:
                        model.available = True
                        model.runtime_url = base_url
                        model.runtime_model_id = matched_id
                        model.last_check = datetime.now()
                    return True
            except Exception as e:
                logger.debug("check_model_availability_async probe failed %s: %s", base_url, e)
                continue
        with self._config_lock:
            model.available = False
            model.runtime_model_id = None
            model.last_check = datetime.now()
        return False

    def _iter_model_candidate_urls(self, model: ModelInfo) -> List[str]:
        """返回模型候选端点（配置优先，默认 localhost，可选自动发现）。"""
        primary = str(model.url or "").rstrip("/")
        urls: List[str] = []
        tier = str(getattr(model, "tier", "local")).lower()
        model_cfg = getattr(model, "config", {}) or {}
        enable_endpoint_discovery = bool(model_cfg.get("enable_endpoint_discovery", False))

        if tier == "local":
            # 本地模型默认使用 localhost；切换地址应通过配置显式设置 url。
            if primary:
                urls.append(primary)
                # 若配置为 /v1，同时尝试 /api/v1（部分 LM Studio 或兼容服务仅暴露 /api/v1）
                if primary.rstrip("/").endswith("/v1") and "/api/v1" not in primary:
                    alt = primary.rstrip("/").replace("/v1", "/api/v1")
                    if alt != primary:
                        urls.append(alt)
            else:
                urls.append("http://localhost:1234/v1")
                urls.append("http://localhost:1234/api/v1")
            if enable_endpoint_discovery:
                env_base = str(os.getenv("LM_STUDIO_BASE_URL", "")).strip().rstrip("/")
                if env_base:
                    urls.append(env_base)
                urls.extend(["http://localhost:1234/v1", "http://127.0.0.1:1234/v1", "http://localhost:1234/api/v1", "http://127.0.0.1:1234/api/v1"])
        else:
            # 云端：多 endpoint 同 id 时使用 url_candidates，否则用 model.url
            candidates = getattr(model, "url_candidates", None)
            if candidates and isinstance(candidates, list):
                for u in candidates:
                    u = str(u or "").rstrip("/")
                    if u and u not in urls:
                        urls.append(u)
            if not urls and primary:
                urls.append(primary)
            env_base = str(os.getenv("LM_STUDIO_BASE_URL", "")).strip().rstrip("/")
            if env_base and env_base not in urls:
                urls.append(env_base)
        # 去重保序
        dedup: List[str] = []
        seen: set[str] = set()
        for u in urls:
            if not u or u in seen:
                continue
            seen.add(u)
            dedup.append(u)
        return dedup

    def _resolve_runtime_base_url(self, model: ModelInfo) -> str:
        """为当前请求选择可用端点（主链路无阻塞探测）。"""
        if model.runtime_url and model.last_check:
            age = (datetime.now() - model.last_check).total_seconds()
            if age < 60:
                return str(model.runtime_url).rstrip("/")

        candidates = self._iter_model_candidate_urls(model)
        if not candidates:
            return str(model.runtime_url or model.url or "").rstrip("/")
        # 关键路径不做同步探测，直接使用上次可用地址或候选首地址。
        fallback = str(model.runtime_url or candidates[0] or model.url or "").rstrip("/")
        return fallback

    def get_model_endpoint_diagnostics(
        self, config: Optional["RunnableConfig"] = None
    ) -> Dict[str, Any]:
        """返回当前会话模型的端点诊断信息（不触发网络探测）。"""
        model_id = ""
        try:
            model_id = str(self.get_model(config) or "").strip()
        except Exception:
            model_id = str(self._current_model or "").strip()
        if not model_id:
            try:
                model_id = str(self._resolve_auto_model() or "").strip()
            except Exception:
                model_id = ""

        model = self.get_model_info(model_id) if model_id else None
        if model is None:
            return {
                "model_id": model_id or "unknown",
                "configured_url": "",
                "runtime_url": "",
                "candidate_urls": [],
                "provider": "",
                "tier": "",
            }

        candidates = self._iter_model_candidate_urls(model)
        runtime_url = self._resolve_runtime_base_url(model)
        return {
            "model_id": model.id,
            "configured_url": str(model.url or "").rstrip("/"),
            "runtime_url": str(runtime_url or "").rstrip("/"),
            "candidate_urls": candidates,
            "provider": str(getattr(model, "provider", "") or ""),
            "tier": str(getattr(model, "tier", "") or ""),
        }
    
    def _check_interval_for(self, model) -> float:
        """可用模型 15s，不可用模型 60s 负缓存，减少无效探测。"""
        if getattr(model, "available", False):
            return self._availability_check_interval
        return max(self._availability_check_interval, 60)

    def refresh_availability(self, force: bool = False):
        """刷新所有模型的可用状态（同步版本）
        
        Args:
            force: 是否强制刷新（忽略检查间隔）
        """
        now = datetime.now()
        for model in self._config.models:
            if not force and model.last_check:
                elapsed = (now - model.last_check).total_seconds()
                if elapsed < self._check_interval_for(model):
                    continue
            
            self.check_model_availability(model.id)
    
    async def refresh_availability_async(self, force: bool = False):
        """刷新所有模型的可用状态（异步版本）"""
        now = datetime.now()
        tasks = []
        
        for model in self._config.models:
            if not force and model.last_check:
                elapsed = (now - model.last_check).total_seconds()
                if elapsed < self._check_interval_for(model):
                    continue
            
            tasks.append(self.check_model_availability_async(model.id))
        
        if tasks:
            await asyncio.gather(*tasks)
        await self._auto_discover_local_models()

    async def _auto_discover_local_models(self):
        """扫描本地端点并自动发现未配置模型（默认禁用）。"""
        known_urls = {
            str(m.url).rstrip("/")
            for m in self._config.models
            if getattr(m, "tier", "local") == "local" and m.url
        }
        if not known_urls:
            return

        known_ids = {m.id for m in self._config.models}
        next_priority = max((m.priority for m in self._config.models), default=0) + 1
        discovered_count = 0

        for url in known_urls:
            try:
                resp = await _probe_get_async(f"{url}/models", timeout=5.0)
                if resp.status_code != 200:
                    continue
                try:
                    raw = resp.json()
                    data = raw.get("data", []) if isinstance(raw, dict) else []
                except Exception as e:
                    logger.debug("_auto_discover_local_models resp.json 失败 %s: %s", url, e)
                    continue
                remote_ids = {
                    str(item.get("id", "")).strip()
                    for item in data
                    if isinstance(item, dict) and str(item.get("id", "")).strip()
                }
                for model_id in sorted(remote_ids):
                    lowered = model_id.lower()
                    if model_id in known_ids:
                        continue
                    if "embed" in lowered or "rerank" in lowered:
                        continue
                    self.add_model(
                        id=model_id,
                        name=model_id,
                        display_name=None,
                        description="自动发现（默认禁用）",
                        url=url,
                        enabled=False,
                        priority=next_priority,
                        provider="openai",
                        tier="local",
                        cost_level="zero",
                        supports_images=False,
                        usage="chat",
                        internal_only=False,
                    )
                    known_ids.add(model_id)
                    next_priority += 1
                    discovered_count += 1
            except Exception as e:
                logger.debug("[ModelManager] 自动发现本地模型失败 (%s): %s", url, e)

        if discovered_count:
            logger.info("[ModelManager] 自动发现并写入 %d 个本地模型", discovered_count)
    
    def get_model_info(self, model_id: str) -> Optional[ModelInfo]:
        """获取模型信息（O(1) 字典查找）；含配置模型与云端动态发现的模型。云端发现模型支持 ID 兼容查找：精确匹配失败时，按 cloud/ 后缀与 runtime_model_id 做大小写不敏感匹配，避免前端/网关大小写不一致导致「资源包不支持」等误报。"""
        idx = getattr(self, "_model_by_id", None)
        if idx is not None:
            hit = idx.get(model_id)
            if hit is not None:
                return hit
        for model in self._config.models:
            if model.id == model_id:
                if idx is not None:
                    idx[model_id] = model
                return model
        with self._discovered_lock:
            hit = self._discovered_by_id.get(model_id)
        if hit is not None:
            return hit
        # 云端发现模型兼容：请求体中的 model 可能与 GET /v1/models 返回的 id 大小写或格式略不同，用后缀+大小写不敏感匹配
        if model_id and (str(model_id).lower().startswith("cloud/") or "/" in str(model_id)):
            suffix = str(model_id).strip()
            for prefix in ("cloud/", "Cloud/", "CLOUD/"):
                if suffix.startswith(prefix):
                    suffix = suffix[len(prefix):].strip()
                    break
            if suffix:
                with self._discovered_lock:
                    for m in self._discovered_cloud_models:
                        rid = (getattr(m, "runtime_model_id", None) or "").strip()
                        mid = (getattr(m, "id", None) or "").strip()
                        mid_suffix = mid[len("cloud/"):] if mid.lower().startswith("cloud/") else mid
                        if rid and rid.lower() == suffix.lower():
                            if idx is not None:
                                idx[model_id] = m
                            logger.debug("[ModelManager] 云端模型 ID 兼容匹配: 请求 %r → 发现 %r (runtime_model_id=%r)", model_id, m.id, rid)
                            return m
                        if mid_suffix and mid_suffix.lower() == suffix.lower():
                            if idx is not None:
                                idx[model_id] = m
                            logger.debug("[ModelManager] 云端模型 ID 兼容匹配: 请求 %r → 发现 %r (runtime_model_id=%r)", model_id, m.id, getattr(m, "runtime_model_id", None))
                            return m
        return None

    def _is_chat_model(self, model: ModelInfo) -> bool:
        """判断是否属于可选聊天模型集合。"""
        return str(getattr(model, "usage", "chat") or "chat").strip().lower() == "chat"

    def _iter_models_by_usage(self, usage: str, enabled_only: bool = True) -> List[ModelInfo]:
        usage_key = str(usage or "").strip().lower()
        output: List[ModelInfo] = []
        for model in self._config.models:
            if str(getattr(model, "usage", "chat") or "chat").strip().lower() != usage_key:
                continue
            if enabled_only and not bool(getattr(model, "enabled", False)):
                continue
            output.append(model)
        output.sort(key=lambda m: m.priority)
        return output

    def get_embedding_model(self) -> Optional[ModelInfo]:
        """返回首个可用 embedding 能力模型（不可用则返回首个启用模型）。"""
        candidates = self._iter_models_by_usage("embedding", enabled_only=True)
        if not candidates:
            return None
        for model in candidates:
            if self._is_provider_ready(model) and self._is_model_available(model.id):
                return model
        for model in candidates:
            if self._is_provider_ready(model):
                return model
        return None

    def get_rerank_model(self) -> Optional[ModelInfo]:
        """返回首个可用 rerank 能力模型（不可用则返回首个启用模型）。"""
        candidates = self._iter_models_by_usage("rerank", enabled_only=True)
        if not candidates:
            return None
        for model in candidates:
            if self._is_provider_ready(model) and self._is_model_available(model.id):
                return model
        for model in candidates:
            if self._is_provider_ready(model):
                return model
        return None

    def get_capability_models_status(self) -> Dict[str, Any]:
        """返回 embedding/rerank 能力模型状态（用于日志与前端提示）。"""
        emb = self.get_embedding_model()
        rerank = self.get_rerank_model()
        return {
            "embedding": {
                "id": getattr(emb, "id", None),
                "enabled": bool(getattr(emb, "enabled", False)) if emb else False,
                "available": bool(getattr(emb, "available", False)) if emb else False,
                "provider_ready": self._is_provider_ready(emb) if emb else False,
                "base_url": (getattr(emb, "runtime_url", None) or getattr(emb, "url", None)) if emb else None,
            },
            "rerank": {
                "id": getattr(rerank, "id", None),
                "enabled": bool(getattr(rerank, "enabled", False)) if rerank else False,
                "available": bool(getattr(rerank, "available", False)) if rerank else False,
                "provider_ready": self._is_provider_ready(rerank) if rerank else False,
                "base_url": (getattr(rerank, "runtime_url", None) or getattr(rerank, "url", None)) if rerank else None,
            },
        }

    def get_model_config(self, model_id: str) -> Optional[Dict[str, Any]]:
        """获取模型配置字典（供 API / 前端使用），含 context_length、config 等。"""
        info = self.get_model_info(model_id)
        if not info:
            return None
        return {
            "id": info.id,
            "name": info.name,
            "context_length": info.context_length,
            "config": info.config,
            "provider": getattr(info, "provider", "openai"),
            "is_reasoning_model": getattr(info, "is_reasoning_model", False),
            "supports_images": getattr(info, "supports_images", False),
        }

    def get_escalation_policy(self) -> Dict[str, Any]:
        """获取升级策略配置。"""
        return self._config.escalation_policy or {}

    def get_fallback_model_for(self, primary_model_id: str) -> Optional[str]:
        """根据 escalation_policy 为主模型选择 fallback 模型。"""
        policy = self.get_escalation_policy()
        if not policy.get("enabled", False):
            return None

        tier_order = policy.get("fallback_order", ["cloud-reasoning", "cloud-strong", "cloud-premium"])
        for tier in tier_order:
            candidates = [
                m for m in self._config.models
                if (
                    m.enabled
                    and m.id != primary_model_id
                    and getattr(m, "tier", "local") == tier
                    and self._is_model_available(m.id)
                    and self._is_provider_ready(m)
                    and self._is_model_allowed_by_license(m)
                )
            ]
            if candidates:
                candidates.sort(key=lambda x: x.priority)
                return candidates[0].id

        # 回退：若没有云模型，优先 default_model（与 auto 选模一致），再按配置顺序选任意可用非主模型
        default_id = self._config.default_model
        if (
            default_id
            and default_id != primary_model_id
            and self._is_model_available(default_id)
        ):
            default_info = self.get_model_info(default_id)
            if default_info and self._is_provider_ready(default_info) and self._is_model_allowed_by_license(default_info):
                return default_id
        for m in self._config.models:
            if (
                m.enabled
                and m.id != primary_model_id
                and self._is_model_available(m.id)
                and self._is_provider_ready(m)
                and self._is_model_allowed_by_license(m)
            ):
                return m.id
        return None

    @staticmethod
    def _cost_rank(value: str) -> int:
        return {"zero": 0, "low": 1, "medium": 2, "high": 3}.get(str(value or "unknown").lower(), 2)

    def _select_model_by_load_signals(self, model_id: str, configurable: Dict[str, Any]) -> str:
        """根据排队时延/重试/成本档位做负载感知路由（优先复用现有模型池）。"""
        queue_wait_ms = max(0, int(configurable.get("queue_wait_ms", 0) or 0))
        retry_count = max(0, int(configurable.get("retry_count", 0) or 0))
        cost_tier = str(configurable.get("cost_tier", "medium") or "medium").lower()
        current = self.get_model_info(model_id)
        current_rank = self._cost_rank(getattr(current, "cost_level", "unknown") if current else "unknown")
        max_rank = {"low": 1, "medium": 2, "high": 3}.get(cost_tier, 2)

        # 重试优先走 fallback（稳定性优先）
        if retry_count >= 2:
            fallback = self.get_fallback_model_for(model_id)
            if fallback:
                return fallback

        # 拥塞时优先保响应：若当前模型成本级别偏高，选择更低成本可用模型
        if queue_wait_ms >= 15000 and current_rank > max_rank:
            candidates = [
                m for m in self._config.models
                if (
                    self._is_chat_model(m)
                    and m.enabled
                    and self._is_model_available(m.id)
                    and self._is_provider_ready(m)
                    and self._is_model_allowed_by_license(m, configurable)
                    and self._cost_rank(getattr(m, "cost_level", "unknown")) <= max_rank
                )
            ]
            if candidates:
                candidates.sort(key=lambda m: (self._cost_rank(getattr(m, "cost_level", "unknown")), m.priority))
                return candidates[0].id
        return model_id

    def should_escalate(self, context: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        """根据上下文和策略判断是否升级，返回 (是否升级, 目标 tier)。"""
        policy = self.get_escalation_policy()
        if not policy.get("enabled", False):
            return False, None

        triggers = set(policy.get("triggers", []))
        retry_count = int(context.get("retry_count", 0) or 0)
        critic_quality = str(context.get("critic_overall_quality", "") or "").lower()
        user_explicit = bool(context.get("user_explicit_request", False))
        complexity = float(context.get("task_complexity_score", 0.0) or 0.0)

        if "critic_review_reject" in triggers and critic_quality == "reject":
            return True, "cloud-strong"
        if "retry_count_ge_2" in triggers and retry_count >= 2:
            return True, "cloud-reasoning"
        if "user_explicit_request" in triggers and user_explicit:
            return True, "cloud-strong"
        if "task_complexity_high" in triggers and complexity > 0.8:
            return True, "cloud-premium"
        return False, None

    def _resolve_api_key(self, provider: str, explicit_key: Optional[str] = None) -> str:
        """解析 API Key：显式配置优先，否则从环境变量按 provider 读取。
        本地模型无需 key 时返回占位符；云端模型 key 缺失时返回空字符串。"""
        if explicit_key:
            return _normalize_api_key(str(explicit_key))
        env_key = PROVIDER_ENV_KEYS.get(provider, "OPENAI_API_KEY")
        return _normalize_api_key(os.environ.get(env_key, ""))

    def _is_provider_ready(self, model: ModelInfo) -> bool:
        """检查模型 Provider 配置是否满足最小可用条件。"""
        provider = (getattr(model, "provider", "openai") or "openai").strip()
        tier = (getattr(model, "tier", "local") or "local").strip().lower()
        # 本地模型允许无 key（如 LM Studio）。
        if tier == "local":
            return True
        api_key = self._resolve_api_key(provider, getattr(model, "api_key", None))
        return bool(api_key)

    def _resolve_license_profile(self, configurable: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if isinstance(configurable, dict):
            profile = configurable.get("license_profile")
            if isinstance(profile, dict):
                return profile
        return _load_license_profile_fallback()

    def _load_cloud_model_used_today_from_store(self) -> int:
        try:
            from backend.config.store_namespaces import NS_BILLING_USAGE
            from backend.engine.core.main_graph import get_sqlite_store

            store = get_sqlite_store()
            if store is None:
                return 0
            day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            out = store.get(NS_BILLING_USAGE, f"cloud_model_requests:{day}")
            raw = getattr(out, "value", out) if out else {}
            value = dict(raw) if isinstance(raw, dict) else {}
            return max(0, int(value.get("count", 0) or 0))
        except Exception:
            return 0

    def _resolve_cloud_model_used_today(self, configurable: Optional[Dict[str, Any]] = None) -> int:
        explicit = 0
        if isinstance(configurable, dict):
            try:
                explicit = max(0, int(configurable.get("cloud_model_used_today", 0) or 0))
            except Exception:
                explicit = 0
        return max(explicit, self._load_cloud_model_used_today_from_store())

    def _is_cloud_tier(self, tier: str) -> bool:
        val = str(tier or "").strip().lower()
        return val == "cloud" or val.startswith("cloud-")

    def _is_model_allowed_by_license(
        self, model: Optional[ModelInfo], configurable: Optional[Dict[str, Any]] = None
    ) -> bool:
        if model is None:
            return False
        tier = str(getattr(model, "tier", "local") or "local").strip().lower()
        if not self._is_cloud_tier(tier):
            return True
        # 前端已做确认（勾选「允许云端」或弹窗确认）时，请求体带 allow_cloud_without_confirm / cloud_consented，直接放行
        if isinstance(configurable, dict):
            if configurable.get("allow_cloud_without_confirm") or configurable.get("cloud_consented"):
                return True
        profile = self._resolve_license_profile(configurable)
        if not is_cloud_model_allowed(profile):
            return False
        used_today = self._resolve_cloud_model_used_today(configurable)
        allowed, _ = check_daily_cloud_quota(profile, used_today)
        return allowed

    def is_model_runtime_eligible(
        self,
        model: Optional[ModelInfo],
        configurable: Optional[Dict[str, Any]] = None,
        *,
        require_enabled: bool = True,
    ) -> bool:
        """公共能力接口：判断模型是否满足运行时最小可用条件。"""
        if model is None:
            return False
        if require_enabled and not bool(getattr(model, "enabled", True)):
            return False
        return self._is_provider_ready(model) and self._is_model_allowed_by_license(model, configurable)

    def _resolve_best_local_model(self) -> Optional[str]:
        """返回最优本地模型：优先 default_model（若为 local 且可用），否则按配置顺序。"""
        default_id = self._config.default_model
        if default_id:
            info = self.get_model_info(default_id)
            if (
                info
                and self._is_chat_model(info)
                and info.enabled
                and str(getattr(info, "tier", "local") or "local").strip().lower() == "local"
                and self._is_provider_ready(info)
                and (info.last_check is None or info.available)
            ):
                return default_id
        for model in self._config.models:
            if not self._is_chat_model(model):
                continue
            if not model.enabled:
                continue
            if str(getattr(model, "tier", "local") or "local").strip().lower() != "local":
                continue
            if not self._is_provider_ready(model):
                continue
            if model.last_check is not None and not model.available:
                continue
            return model.id
        return None

    def has_discovered_cloud_models(self) -> bool:
        """是否已有云端动态发现的模型（用于 API 层决定是否需使列表缓存失效）。"""
        with self._discovered_lock:
            return len(self._discovered_cloud_models) > 0

    def get_models_list(self, include_auto: bool = True) -> List[Dict[str, Any]]:
        """获取模型列表（供前端使用）
        
        Args:
            include_auto: 是否包含 "auto" 选项
        
        Returns:
            模型列表，每个模型包含：
            - id: 模型 ID
            - name: 显示名称
            - description: 描述
            - enabled: 是否启用
            - available: 是否可用（后端检测）
            - is_default: 是否为默认模型
            - is_current: 是否为当前使用的模型
            - priority: 优先级
        """
        result = []
        # 云端发现 id 集合（含规范化 id）：用于「发现优先于探测」，与 Claude/Cursor/Cowork 一致；宽松匹配避免配置 id 与 API 返回 id 格式差异
        with self._discovered_lock:
            discovered_ids = set(self._discovered_by_id.keys())
            normalized_discovered = {self._normalize_model_id_for_match(k) for k in discovered_ids if self._normalize_model_id_for_match(k)}

        def _in_discovered(mid: str) -> bool:
            if not mid:
                return False
            return mid in discovered_ids or self._normalize_model_id_for_match(mid) in normalized_discovered

        # 添加 auto 选项
        if include_auto:
            auto_resolved = self._resolve_auto_model()
            auto_available = self._is_model_available(auto_resolved) or _in_discovered(auto_resolved or "")
            result.append({
                "id": "auto",
                "name": "自动选择",
                "description": f"自动选择最优模型（当前: {self._get_model_display_name(auto_resolved)}）",
                "enabled": True,
                "available": auto_available,
                "is_default": True,  # auto 是推荐的默认选项
                "is_current": self._current_model is None,
                "resolved_model": auto_resolved,
            })

        # 添加配置的模型（已按优先级排序）；记录规范化 id 供发现列表去重
        result_ids = set()
        result_normalized = set()
        for m in self._config.models:
            if not self._is_chat_model(m):
                continue
            result_ids.add(m.id)
            norm = self._normalize_model_id_for_match(m.id)
            if norm:
                result_normalized.add(norm)
            # 发现优先于探测：id 或规范化 id 在云端发现列表中则 available=True
            available = True if _in_discovered(m.id) else m.available
            is_reasoning = bool(getattr(m, "is_reasoning_model", False))
            # 配置的云端模型若存在同规范化 id 的发现条，合并发现的 is_reasoning_model
            if not is_reasoning and norm and norm in normalized_discovered:
                with self._discovered_lock:
                    for _did, _d in self._discovered_by_id.items():
                        if self._normalize_model_id_for_match(_did) == norm and getattr(_d, "is_reasoning_model", False):
                            is_reasoning = True
                            break
            result.append({
                "id": m.id,
                "name": m.display_name or m.name,
                "raw_name": m.name,
                "display_name": getattr(m, "display_name", None),
                "description": m.description,
                "url": m.url,
                "provider": getattr(m, "provider", "openai"),
                "enabled": m.enabled,
                "available": available,
                "is_default": m.id == self._config.default_model,
                "is_current": m.id == self._current_model,
                "priority": m.priority,
                "context_length": m.context_length,
                "config": m.config,
                "tier": getattr(m, "tier", "local"),
                "cost_level": getattr(m, "cost_level", "unknown"),
                "is_reasoning_model": is_reasoning,
                "supports_images": getattr(m, "supports_images", False),
                "capability": getattr(m, "capability", {}) or {},
                "prompt_profile": getattr(m, "prompt_profile", {}) or {},
                "role_affinity": getattr(m, "role_affinity", {}) or {},
                "api_key_env": getattr(m, "api_key_env", None),
                "has_api_key": bool(getattr(m, "api_key", None) or _resolve_api_key(getattr(m, "api_key_env", "") or "")),
                "last_check": (m.last_check.isoformat() if getattr(m, "last_check", None) else None),
                "source": "config",
            })
        # 追加云端动态发现的模型（id 与规范化 id 均不与配置重复，避免同模型出现两条）
        with self._discovered_lock:
            for m in self._discovered_cloud_models:
                if m.id in result_ids:
                    continue
                norm = self._normalize_model_id_for_match(m.id)
                if norm and norm in result_normalized:
                    continue
                result_ids.add(m.id)
                if norm:
                    result_normalized.add(norm)
                result.append({
                    "id": m.id,
                    "name": m.display_name or m.name,
                    "raw_name": m.name,
                    "display_name": getattr(m, "display_name", None),
                    "description": m.description,
                    "url": m.url,
                    "provider": getattr(m, "provider", "openai"),
                    "enabled": m.enabled,
                    "available": True,  # 发现成功即端点可达，与主流云端产品「配置即用」一致
                    "is_default": False,
                    "is_current": m.id == self._current_model,
                    "priority": m.priority,
                    "context_length": m.context_length,
                    "config": m.config,
                    "tier": "cloud",
                    "cost_level": getattr(m, "cost_level", "unknown"),
                    "is_reasoning_model": getattr(m, "is_reasoning_model", False),
                    "supports_images": getattr(m, "supports_images", False),
                    "capability": getattr(m, "capability", {}) or {},
                    "prompt_profile": getattr(m, "prompt_profile", {}) or {},
                    "role_affinity": getattr(m, "role_affinity", {}) or {},
                    "api_key_env": getattr(m, "api_key_env", None),
                    "has_api_key": bool(_resolve_api_key(getattr(m, "api_key_env", "") or "")),
                    "last_check": None,
                    "source": "discovered",
                })
        return [{k: v for k, v in item.items() if k not in SENSITIVE_FIELDS} for item in result]

    def get_recommended_models_for_role(self, role_id: str, limit: int = 5) -> List[Dict[str, Any]]:
        """基于角色能力画像推荐模型清单。"""
        role_key = str(role_id or "").strip()
        if not role_key:
            return []
        try:
            role_cfg_path = Path(__file__).parent.parent.parent / "config" / "roles.json"
            role_data = json.loads(role_cfg_path.read_text(encoding="utf-8")) if role_cfg_path.exists() else {}
            role_cfg = ((role_data or {}).get("roles") or {}).get(role_key) or {}
            role_caps = role_cfg.get("capabilities") or []
            role_skill_profile = str(role_cfg.get("skill_profile") or "").strip().lower()
        except Exception:
            role_caps = []
            role_skill_profile = ""

        cap_skill_names = {
            str(item.get("skill") or "").strip().lower()
            for item in role_caps
            if isinstance(item, dict) and str(item.get("skill") or "").strip()
        }
        scored: List[Tuple[float, ModelInfo]] = []
        for model in self._config.models:
            if not self._is_chat_model(model):
                continue
            if not model.enabled:
                continue
            affinity = float((getattr(model, "role_affinity", {}) or {}).get(role_key, 0.0) or 0.0)
            capability = getattr(model, "capability", {}) or {}
            plan = float(capability.get("planning", 0.0) or 0.0)
            reason = float(capability.get("reasoning_depth", 0.0) or 0.0)
            writing = float(capability.get("writing", 0.0) or 0.0)
            retrieval = float(capability.get("retrieval", 0.0) or 0.0)
            tool_use = float(capability.get("tool_use", 0.0) or 0.0)
            profile_bonus = 0.0
            if role_skill_profile in {"knowledge", "ontology"}:
                profile_bonus = retrieval * 0.6 + reason * 0.4
            elif role_skill_profile in {"bidding", "solution", "contract"}:
                profile_bonus = plan * 0.6 + writing * 0.4
            elif role_skill_profile in {"office", "document"}:
                profile_bonus = writing * 0.6 + tool_use * 0.4
            skill_hint_bonus = 0.0
            if cap_skill_names:
                if any(x in cap_skill_names for x in {"ontology-management", "knowledge-building"}):
                    skill_hint_bonus += retrieval * 0.2
                if any(x in cap_skill_names for x in {"bidding", "solution-design", "proposal-writing"}):
                    skill_hint_bonus += plan * 0.2
            cost_bonus = 0.15 if getattr(model, "cost_level", "") == "zero" else 0.0
            score = affinity * 0.6 + profile_bonus * 0.25 + skill_hint_bonus + cost_bonus
            score -= (float(model.priority) / 10000.0)
            scored.append((score, model))

        scored.sort(key=lambda x: x[0], reverse=True)
        output: List[Dict[str, Any]] = []
        for score, m in scored[: max(1, int(limit))]:
            output.append(
                {
                    "id": m.id,
                    "name": m.name,
                    "description": m.description,
                    "tier": getattr(m, "tier", "local"),
                    "cost_level": getattr(m, "cost_level", "unknown"),
                    "is_reasoning_model": bool(getattr(m, "is_reasoning_model", False)),
                    "available": bool(getattr(m, "available", False)),
                    "enabled": bool(getattr(m, "enabled", True)),
                    "score": round(float(score), 4),
                    "reason": f"affinity={round(float((getattr(m, 'role_affinity', {}) or {}).get(role_key, 0.0) or 0.0), 2)}",
                }
            )
        return output
    
    def _resolve_auto_model(self, context: Optional[Dict[str, Any]] = None) -> str:
        """解析 auto 选择的实际模型
        
        Auto 选择规则（按配置文件 auto_selection_rule）：
        1. default_only: 只使用 default_model
        2. priority_then_available: 先使用 default_model（若可用），否则 capability 选模或按列表顺序回退
        3. strict_available_only / available_only: 仅选 enabled+available 的第一个
        
        这样可避免在用户未显式选择 35B 时，仅因 capability 分数高而自动选用 35B。
        """
        rule = self._config.auto_selection_rule
        
        if rule == "default_only":
            return self._config.default_model
        if rule in {"strict_available_only", "available_only"}:
            for model in self._config.models:
                if not self._is_chat_model(model):
                    continue
                if model.enabled and model.available and self._is_provider_ready(model) and self._is_model_allowed_by_license(model, context):
                    return model.id
            return self._config.default_model

        # priority_then_available：优先使用 default_model，避免 capability 选模直接选中 35B 等大模型
        if rule == "priority_then_available":
            default_id = self._config.default_model
            if default_id and self._is_model_available(default_id):
                default_info = self.get_model_info(default_id)
                if default_info and self._is_provider_ready(default_info) and self._is_model_allowed_by_license(default_info, context):
                    return default_id

        # 尝试使用 capability 感知的自动选模（default 不可用或非 priority_then_available 时）
        selected = self._select_model_by_capability(context=context)
        if selected:
            return selected

        # capability 选模失败时，按配置列表顺序回退到可用聊天模型
        for model in self._config.models:
            if not self._is_chat_model(model):
                continue
            if model.enabled and model.available and self._is_provider_ready(model) and self._is_model_allowed_by_license(model, context):
                return model.id

        # 可用性未刷新/启动阶段：放宽到 enabled + provider_ready
        for model in self._config.models:
            if not self._is_chat_model(model):
                continue
            if model.enabled and self._is_provider_ready(model) and self._is_model_allowed_by_license(model, context):
                return model.id

        # 没有启用的模型，返回默认模型
        default_info = self.get_model_info(self._config.default_model)
        if default_info and self._is_model_allowed_by_license(default_info, context):
            return self._config.default_model
        return self._resolve_best_local_model() or self._config.default_model

    def _normalized_task_type(self, context: Optional[Dict[str, Any]] = None) -> str:
        ctx = context or {}
        workspace_domain = str(
            ctx.get("workspace_domain")
            or ctx.get("business_domain")
            or "general"
        ).strip().lower()
        task_type = str(
            ctx.get("task_type")
            or ctx.get("recommended_task_type")
            or ""
        ).strip().lower()
        if not task_type:
            if workspace_domain in {"code", "coding", "dev", "development"}:
                task_type = "code_generation"
            elif workspace_domain in {"research", "deep_research", "internet_research", "office"}:
                task_type = "document_analysis"
            else:
                task_type = "default"
        mapping = {
            "doc": "document_analysis",
            "report_generation": "document_analysis",
            "deep_analysis": "document_analysis",
            "analysis": "document_analysis",
            "research": "document_analysis",
            "deep_research": "document_analysis",
            "internet_research": "document_analysis",
            "office": "document_analysis",
            "quick_answer": "quick_answer",
            "fast": "quick_answer",
            "plan": "planning",
            "code": "code_generation",
            "coding": "code_generation",
            "implementation": "code_generation",
            "debugging": "code_generation",
            "bugfix": "code_generation",
        }
        return mapping.get(task_type, task_type if task_type in TASK_CAPABILITY_WEIGHTS else "default")

    def select_model_by_task_profile(self, context: Optional[Dict[str, Any]] = None) -> Optional[str]:
        """按任务画像与 capability 评分选择最优模型（本地模型优先）。"""
        task_type = self._normalized_task_type(context)
        weights = TASK_CAPABILITY_WEIGHTS.get(task_type, TASK_CAPABILITY_WEIGHTS["default"])
        best_score = float("-inf")
        best_model: Optional[ModelInfo] = None

        for model in self._config.models:
            if not self._is_chat_model(model):
                continue
            if not (model.enabled and self._is_provider_ready(model)):
                continue
            if not self._is_model_allowed_by_license(model, context):
                continue
            if model.last_check is not None and not model.available:
                continue

            capability = getattr(model, "capability", {}) or {}
            weighted_cap = 0.0
            for name, weight in weights.items():
                weighted_cap += float(capability.get(name, 0.0) or 0.0) * float(weight)

            # 本地免费模型优先，成本低优先，priority 越小越优
            tier_bonus = 0.08 if str(getattr(model, "tier", "local") or "local").lower() == "local" else 0.0
            cost_bonus = 0.05 if str(getattr(model, "cost_level", "") or "").lower() == "zero" else 0.0
            priority_penalty = float(model.priority) / 10000.0
            score = weighted_cap + tier_bonus + cost_bonus - priority_penalty

            if score > best_score:
                best_score = score
                best_model = model

        return best_model.id if best_model else None

    def _select_model_by_capability(self, context: Optional[Dict[str, Any]] = None) -> Optional[str]:
        """自动选模入口：优先使用运行时上下文，否则回退环境变量。"""
        ctx: Dict[str, Any] = dict(context or {})
        if "task_type" not in ctx:
            ctx["task_type"] = os.getenv("MODEL_TASK_TYPE", "default")
        selected = self.select_model_by_task_profile(ctx)
        if selected:
            return selected
        return None

    def _get_model_display_name(self, model_id: str) -> str:
        """获取模型显示名（display_name 优先）。"""
        info = self.get_model_info(model_id)
        if not info:
            return model_id
        return info.display_name or info.name or info.id
    
    def get_current_model(self) -> str:
        """获取当前使用的模型
        
        如果没有设置当前模型，返回 auto 解析的模型
        """
        if self._current_model:
            return self._current_model
        return self._resolve_auto_model()
    
    def _is_model_available(self, model_id: str) -> bool:
        """检查模型是否可用
        
        注意：这里的"可用"有两层含义：
        1. 模型存在于配置中且已启用（enabled=True）
        2. 模型实际可连接（available=True，通过 check_model_availability 检测）
        
        云端模型：不做本地探活，存在且启用即视为可用；本地模型：未探活时放行，已探活则遵循 available。
        """
        if model_id == "auto":
            return True
        model = self.get_model_info(model_id)
        if model is None or not model.enabled:
            return False
        tier = str(getattr(model, "tier", "local") or "local").strip().lower()
        if tier == "cloud" or tier.startswith("cloud-"):
            return True
        # 本地：已有探活结果时遵循探活状态；未探活时允许放行（避免冷启动误杀）。
        if model.last_check is None:
            return True
        return bool(model.available)
    
    def get_model_for_thread(self, config: Optional["RunnableConfig"] = None) -> str:
        """获取会话（Thread）使用的模型
        
        选哪个模型就走哪个通道：请求中显式的 model/model_id 优先于会话绑定。
        
        逻辑：
        1. 若 config 中 model/model_id 非空且非 "auto"（用户当前选择）→ 优先使用，不可用时回退 auto
        2. 若未传显式模型或为 "auto"：再看 pinned_model / thread_model（会话绑定）
        3. 否则使用 auto 解析的模型
        """
        if config:
            configurable = config.get("configurable", {})
            logger.debug("get_model_for_thread configurable keys: %s", list(configurable.keys()))

            # 1. 请求显式指定的模型（用户当前选择）优先，确保「选哪个就走哪个」
            model = str(configurable.get("model") or configurable.get("model_id") or "").strip()
            if model and model != "auto":
                model_info = self.get_model_info(model)
                avail = self._is_model_available(model)
                allowed = bool(model_info and self._is_model_allowed_by_license(model_info, configurable))
                if model_info and avail and allowed:
                    return model
                logger.warning("[ModelManager] 请求的模型 %s 不可用或无授权，回退 auto", model)
                return self._resolve_auto_model(configurable)
            if model == "auto":
                return self._resolve_auto_model(configurable)

            # 2. 无显式模型时：会话已固定/绑定模型
            pinned_model = str(configurable.get("pinned_model") or "").strip()
            if pinned_model and pinned_model != "auto":
                pinned_info = self.get_model_info(pinned_model)
                if self._is_model_available(pinned_model) and self._is_model_allowed_by_license(pinned_info, configurable):
                    return pinned_model
                raise ValueError(
                    f"会话固定模型不可用或无授权: pinned_model={pinned_model}。"
                    "为保持会话一致性，已拒绝自动回退；请显式创建新会话并选择可用模型。"
                )
            thread_model = str(configurable.get("thread_model") or "").strip()
            if thread_model and thread_model != "auto":
                thread_info = self.get_model_info(thread_model)
                if self._is_model_available(thread_model) and self._is_model_allowed_by_license(thread_info, configurable):
                    return thread_model
                raise ValueError(
                    f"会话绑定模型不可用或无授权: thread_model={thread_model}。"
                    "为保持会话一致性，已拒绝自动回退；请显式创建新会话并选择可用模型。"
                )

        # 3. 使用 auto 解析的模型
        return self._resolve_auto_model(config.get("configurable", {}) if config else None)

    def explain_model_selection(self, config: Optional["RunnableConfig"] = None) -> Dict[str, Any]:
        """返回当前请求的选模解释（用于可观测与发布复盘）。"""
        configurable: Dict[str, Any] = {}
        if config and isinstance(config, dict):
            configurable = dict(config.get("configurable", {}) or {})

        selected = self.get_model_for_thread(config)
        selected_info = self.get_model_info(selected)
        auto_selected = self._resolve_auto_model(configurable)
        capability_selected = self._select_model_by_capability(configurable)

        source = "auto"
        explicit_model = str(configurable.get("model") or configurable.get("model_id") or "").strip()
        pinned_model = str(configurable.get("pinned_model") or "").strip()
        thread_model = str(configurable.get("thread_model") or "").strip()
        if explicit_model and explicit_model != "auto":
            source = "explicit_model"
        elif pinned_model and pinned_model != "auto":
            source = "pinned_model"
        elif thread_model and thread_model != "auto":
            source = "thread_model"

        return {
            "selected_model": selected,
            "selected_tier": getattr(selected_info, "tier", "unknown") if selected_info else "unknown",
            "source": source,
            "auto_rule": self._config.auto_selection_rule,
            "auto_selected": auto_selected,
            "capability_selected": capability_selected,
            "license_profile": self._resolve_license_profile(configurable),
            "fallback_model": self.get_fallback_model_for(selected),
            "context": {
                "task_type": self._normalized_task_type(configurable),
                "workspace_domain": str(
                    configurable.get("workspace_domain")
                    or configurable.get("business_domain")
                    or "general"
                ).strip().lower(),
                "model": explicit_model or "auto",
                "thread_model": thread_model or "",
                "pinned_model": pinned_model or "",
            },
        }
    
    def get_model(self, config: Optional["RunnableConfig"] = None) -> str:
        """获取要使用的模型（兼容旧接口）
        
        注意：推荐使用 get_model_for_thread() 来确保会话一致性
        
        优先级：
        1. config.configurable.thread_model（会话绑定的模型）
        2. config.configurable.model（前端传递，非 "auto"）
        3. 当前正在使用的模型（如果有）
        4. auto 解析的模型
        
        Args:
            config: LangChain RunnableConfig
        
        Returns:
            模型 ID
        """
        # 使用新的会话模型获取逻辑
        model = self.get_model_for_thread(config)
        with self._llm_cache_lock:
            self._current_model = model
        return model
    
    def get_subagent_model(
        self,
        config: Optional["RunnableConfig"] = None,
        agent_type: Optional[str] = None,
    ) -> str:
        """获取 SubAgent 使用的模型
        
        Args:
            config: LangChain RunnableConfig
            agent_type: 子代理类型（如 explore/planning/executor/general-purpose）
        
        Returns:
            模型 ID
        """
        at = str(agent_type or "").strip().lower()
        if at == "planning":
            at = "plan"
        mapping = self._config.subagent_model_mapping or {}
        if at:
            mapped = str(mapping.get(at, "") or "").strip()
            if mapped and mapped != "same_as_main":
                # 映射模型不可用时回退到主会话模型，保证无云时 explore 等子代理仍可用
                if self._is_model_available(mapped):
                    info = self.get_model_info(mapped)
                    configurable = (config or {}).get("configurable", {}) if isinstance(config, dict) else getattr(config, "configurable", {}) if config else {}
                    if info and self._is_model_allowed_by_license(info, configurable):
                        return mapped
                return self.get_model(config)
            if mapped == "same_as_main":
                return self.get_model(config)
        if self._config.subagent_model == "same_as_main":
            return self.get_model(config)
        fallback_model = str(self._config.subagent_model or "").strip()
        if not fallback_model:
            return self.get_model(config)
        return fallback_model
    
    def set_model_for_new_session(self, model_id: str, *, skip_license_for_switch: bool = False) -> bool:
        """设置新会话使用的模型
        
        重要：这只影响新创建的会话，不会改变已有会话的模型！
        已有会话通过 thread_model 绑定模型，不受此设置影响。
        
        Args:
            model_id: 模型 ID，"auto" 表示自动选择
            skip_license_for_switch: 为 True 时（如来自 /models/switch 显式切换）仅校验模型存在/启用/聊天，不校验许可；许可在 run 时仍会校验
        
        Returns:
            是否设置成功
        """
        if model_id == "auto":
            with self._llm_cache_lock:
                self._current_model = None
            resolved = self._resolve_auto_model()
            logger.info("[ModelManager] 新会话将使用自动选择: %s", resolved)
            return True
        
        model = self.get_model_info(model_id)
        if not model:
            logger.error("[ModelManager] 模型不存在: %s", model_id)
            return False
        
        if not model.enabled:
            logger.warning("[ModelManager] 模型已禁用: %s", model_id)
            return False
        if not skip_license_for_switch and not self._is_model_allowed_by_license(model):
            logger.warning("[ModelManager] 当前授权不允许该模型: %s", model_id)
            return False
        if not self._is_chat_model(model):
            logger.warning(
                "[ModelManager] 非聊天模型不能用于会话: %s (usage=%s)",
                model_id,
                getattr(model, "usage", "chat"),
            )
            return False
        with self._llm_cache_lock:
            self._current_model = model_id
        logger.info("[ModelManager] 新会话将使用模型: %s", model_id)
        return True
    
    # 兼容旧接口
    def set_current_model(self, model_id: str, *, skip_license_for_switch: bool = False) -> bool:
        """设置当前模型（兼容旧接口，推荐使用 set_model_for_new_session）"""
        return self.set_model_for_new_session(model_id, skip_license_for_switch=skip_license_for_switch)

    def set_default_model(self, model_id: str) -> bool:
        """设置默认模型并持久化到 models.json。仅接受具体模型 id，不接受 "auto"。"""
        if not model_id or (model_id or "").strip() == "" or model_id == "auto":
            return False
        model_id = model_id.strip()
        if not self.get_model_info(model_id):
            return False
        with self._config_lock:
            self._config.default_model = model_id
            self._save_config()
        logger.info("[ModelManager] 默认模型已更新并持久化: %s", model_id)
        return True

    def _ensure_llm_cache_initialized(self):
        """确保 LangChain 全局 LLM 响应缓存已初始化
        
        LangChain 的 cache=True 参数需要先设置全局缓存，
        否则会报错：Asked to cache, but no cache found at `langchain.cache`
        """
        from langchain_core.globals import get_llm_cache, set_llm_cache
        
        if get_llm_cache() is None:
            from langchain_core.caches import InMemoryCache
            # 使用 InMemoryCache，设置合理的 maxsize
            cache = InMemoryCache(maxsize=1000)
            set_llm_cache(cache)
            logger.info("[ModelManager] 初始化 LangChain 全局缓存 (maxsize=1000)")
    
    def create_llm(
        self,
        config: Optional["RunnableConfig"] = None,
        task_type: str = "default",
        agent_type: str = None,
        for_subagent: bool = False
    ) -> "ChatOpenAI":
        """创建 LLM 实例
        
        Args:
            config: LangChain RunnableConfig
            task_type: 任务类型 ("default", "doc", "fast", "analysis")
            agent_type: Agent 类型 ("orchestrator", "planning", "executor", "knowledge")
                        优先级高于 task_type，用于精细控制各 Agent 的窗口
            for_subagent: 是否为 SubAgent 创建
        
        动态窗口策略（Claude 风格）：
        - 每个 Agent 有独立的窗口配置，匹配其任务特点
        - Orchestrator: 中等窗口（协调任务，不处理大文档）
        - Planning: 中等窗口（快速扫描，输出 JSON）
        - Executor: 大窗口（处理文档，生成报告）
        - Knowledge: 小窗口（检索型，输入小输出中等）
        
        Returns:
            BaseChatModel 实例（openai 时为 ChatOpenAI）
        """
        # ✅ 确保 LangChain 全局缓存已初始化
        self._ensure_llm_cache_initialized()
        
        # 获取模型
        if for_subagent:
            model_id = self.get_subagent_model(config, agent_type=agent_type)
        else:
            model_id = self.get_model(config)

        # 运行时升级策略（可由 configurable 上下文触发）
        configurable: Dict[str, Any] = {}
        if isinstance(config, dict):
            raw_cfg = config.get("configurable")
            if not isinstance(raw_cfg, dict):
                raw_cfg = {}
                config["configurable"] = raw_cfg
            configurable = raw_cfg
        route_reason = str(configurable.get("model_route_reason") or "direct")
        if configurable:
            routed_model = self._select_model_by_load_signals(model_id, configurable)
            if routed_model != model_id:
                logger.info(
                    "[ModelManager] 负载感知路由: %s -> %s (queue_wait_ms=%s retry_count=%s cost_tier=%s)",
                    model_id,
                    routed_model,
                    configurable.get("queue_wait_ms", 0),
                    configurable.get("retry_count", 0),
                    configurable.get("cost_tier", "medium"),
                )
                if int(configurable.get("retry_count", 0) or 0) >= 2:
                    route_reason = "fallback"
                else:
                    route_reason = "load_route"
                model_id = routed_model
        if not for_subagent and configurable.get("escalation_enabled", True):
            manual_tier = configurable.get("escalation_tier")
            if manual_tier:
                tier_models = [
                    m for m in self._config.models
                    if (
                        m.enabled
                        and m.id != model_id
                        and getattr(m, "tier", "local") == str(manual_tier)
                        and self._is_model_available(m.id)
                        and self._is_provider_ready(m)
                        and self._is_model_allowed_by_license(m, configurable)
                    )
                ]
                if tier_models:
                    tier_models.sort(key=lambda x: x.priority)
                    model_id = tier_models[0].id
                    route_reason = "escalation"
            else:
                should_up, target_tier = self.should_escalate(
                    {
                        "retry_count": configurable.get("retry_count", 0),
                        "critic_overall_quality": configurable.get("critic_overall_quality", ""),
                        "user_explicit_request": configurable.get("user_explicit_request", False),
                        "task_complexity_score": configurable.get("task_complexity_score", 0.0),
                    }
                )
                if should_up:
                    candidate_id = None
                    if target_tier:
                        tier_models = [
                            m for m in self._config.models
                            if (
                                m.enabled
                                and m.id != model_id
                                and getattr(m, "tier", "local") == target_tier
                                and self._is_model_available(m.id)
                                and self._is_provider_ready(m)
                                and self._is_model_allowed_by_license(m, configurable)
                            )
                        ]
                        if tier_models:
                            tier_models.sort(key=lambda x: x.priority)
                            candidate_id = tier_models[0].id
                    if candidate_id is None:
                        candidate_id = self.get_fallback_model_for(model_id)
                        if candidate_id:
                            route_reason = "fallback"
                    else:
                        route_reason = "escalation"
                    if candidate_id:
                        logger.info(
                            "[ModelManager] 触发运行时升级: %s -> %s (tier=%s)",
                            model_id,
                            candidate_id,
                            target_tier or "auto",
                        )
                        model_id = candidate_id
        if isinstance(configurable, dict):
            configurable["model_route_reason"] = route_reason

        model_info = self.get_model_info(model_id)
        if not model_info:
            logger.warning("[ModelManager] 模型 %s 不存在，使用默认模型", model_id)
            model_id = self._config.default_model
            model_info = self.get_model_info(model_id)
            if not model_info:
                raise ValueError(f"默认模型也不存在: {model_id}")
        if not self._is_model_allowed_by_license(model_info, configurable):
            fallback_local = self._resolve_best_local_model()
            if fallback_local:
                logger.info("[ModelManager] 当前 license 不允许云端模型，回退本地模型: %s -> %s", model_id, fallback_local)
                model_id = fallback_local
                model_info = self.get_model_info(model_id)
            else:
                raise ValueError("当前授权不允许云端模型，且没有可用本地模型。")

        with self._llm_cache_lock:
            self._current_model = model_id
        if isinstance(configurable, dict):
            configurable["resolved_model_id"] = model_id
            configurable["actual_model_id"] = model_id
        
        # 获取配置
        model_cfg = model_info.config
        
        # 根据 Agent 类型或任务类型选择 max_tokens
        # 优先级: agent_type > task_type > default
        if agent_type:
            # 按 Agent 类型选择（精细控制）
            agent_token_map = {
                "orchestrator": model_cfg.get("max_tokens_orchestrator", model_cfg.get("max_tokens_default", 16384)),
                "planning": model_cfg.get("max_tokens_planning", model_cfg.get("max_tokens_default", 16384)),
                "executor": model_cfg.get("max_tokens_executor", model_cfg.get("max_tokens_doc", 32768)),
                "knowledge": model_cfg.get("max_tokens_knowledge", model_cfg.get("max_tokens_fast", 8192)),
            }
            max_tokens = agent_token_map.get(agent_type, model_cfg.get("max_tokens_default", 16384))
            # Executor 使用更长的超时
            timeout = self._config.api_timeout_doc if agent_type == "executor" else self._config.api_timeout
        elif task_type == "doc":
            max_tokens = model_cfg.get("max_tokens_doc", 65536)
            timeout = self._config.api_timeout_doc
        elif task_type == "fast":
            max_tokens = model_cfg.get("max_tokens_fast", 8192)
            timeout = self._config.api_timeout
        elif task_type == "analysis":
            max_tokens = model_cfg.get("max_tokens_analysis", 24576)
            timeout = self._config.api_timeout_analysis
        else:
            max_tokens = model_cfg.get("max_tokens_default", 16384)
            timeout = self._config.api_timeout
        
        # 任务级 thinking 策略
        # 本地模型：仅在 config 显式 enable_thinking=true 且非轻量任务时开启
        # 云端模型：保持原逻辑（默认开启）
        tier = str(getattr(model_info, "tier", "local")).lower()
        mode = str(configurable.get("mode", "agent") or "agent").strip().lower() if isinstance(configurable, dict) else "agent"
        local_profile_cfg = str(model_cfg.get("local_stream_profile", "balanced") or "balanced").strip().lower()
        if tier == "local":
            if local_profile_cfg in {"auto", "adaptive", ""}:
                # ask/fast 路径优先响应速度；其余保持稳态。
                local_profile = "latency" if (task_type == "fast" or mode == "ask") else "balanced"
            elif local_profile_cfg in {"latency", "balanced"}:
                local_profile = local_profile_cfg
            else:
                local_profile = "balanced"
        else:
            local_profile = "balanced"
        is_reasoning = bool(getattr(model_info, "is_reasoning_model", False))
        if tier == "local":
            # 本地：仅当 config 显式 enable_thinking=true 时开启，避免未配置时注入 reasoning_content
            thinking_enabled = bool(model_cfg.get("enable_thinking", False))
        else:
            thinking_enabled = bool(model_cfg.get("enable_thinking", True))
        if task_type == "fast":
            thinking_enabled = False
        if agent_type in {"knowledge", "planning"}:
            thinking_enabled = bool(model_cfg.get(f"enable_thinking_{agent_type}", False))
        # 缓存 key（纳入 task/agent/thinking，避免跨场景复用导致参数错配）
        cache_key = f"{model_id}:{max_tokens}:{task_type}:{agent_type or '-'}:{int(thinking_enabled)}:{local_profile if tier == 'local' else 'cloud'}"
        with self._llm_cache_lock:
            if cache_key in self._llm_cache:
                logger.debug("[ModelManager] 使用缓存的 LLM: %s (%d tokens)", model_id, max_tokens)
                return self._llm_cache[cache_key]

        provider = getattr(model_info, "provider", "openai") or "openai"
        api_key_env = (getattr(model_info, "api_key_env", None) or "").strip()
        # 云端/显式配置了 api_key_env 时，只用该环境变量，避免误用 OPENAI_API_KEY 导致 401
        if api_key_env:
            api_key = _resolve_api_key(api_key_env)
        else:
            api_key = self._resolve_api_key(provider, getattr(model_info, "api_key", None))
        api_key = (api_key or "").strip()
        if not api_key and str(getattr(model_info, "tier", "")).lower() in ("cloud", "cloud-strong", "cloud-reasoning", "cloud-premium"):
            logger.warning("[ModelManager] 云端模型 %s 未配置有效 API Key（api_key_env=%s），请求可能 401", model_id, api_key_env or "未设置")

        # 统一使用 init_chat_model 多供应商
        if tier == "local":
            default_local_connect_timeout = 3.0 if local_profile == "latency" else 6.0
            _connect_timeout = float(model_cfg.get("local_connect_timeout", default_local_connect_timeout) or default_local_connect_timeout)
        else:
            _connect_timeout = 30.0
        if tier == "local":
            default_local_retries = 0 if local_profile == "latency" else 1
            max_retries = int(model_cfg.get("local_max_retries", default_local_retries) or default_local_retries)
        else:
            max_retries = 1
        kwargs: Dict[str, Any] = {
            "temperature": model_cfg.get("temperature", 0.6),
            "max_tokens": max_tokens,
            "timeout": (_connect_timeout, float(timeout)),
            "streaming": True,
            "api_key": api_key,
            "max_retries": max_retries,
        }
        # OpenRouter 与 OpenAI 兼容（base_url + api_key），统一走 openai 兼容路径
        if provider == "openrouter":
            provider = "openai"
        if provider == "openai":
            llm_http_client, llm_http_async_client = _get_llm_http_clients()
            kwargs["http_client"] = llm_http_client
            kwargs["http_async_client"] = llm_http_async_client
            resolved_base = self._resolve_runtime_base_url(model_info) if model_info.url else ""
            if model_info.url:
                kwargs["base_url"] = resolved_base
            if tier != "local" and api_key:
                kwargs["default_headers"] = {"Authorization": f"Bearer {api_key}"}
            model_kwargs: Dict[str, Any] = dict(model_cfg.get("model_kwargs", {}) or {})
            if tier == "local":
                stream_options = dict(model_kwargs.get("stream_options", {}) or {})
                include_usage_cfg = model_cfg.get("stream_include_usage_local")
                if include_usage_cfg is None:
                    # latency profile 下默认关闭 usage 流式回传，减少本地网关尾段负担；
                    # 其余 profile 保持开启以便更精确 token 统计。
                    stream_options["include_usage"] = False if local_profile == "latency" else True
                else:
                    stream_options["include_usage"] = bool(include_usage_cfg)
                model_kwargs["stream_options"] = stream_options
            if model_kwargs:
                kwargs["model_kwargs"] = model_kwargs
            # extra_body：本地端点可传 LM Studio 等扩展字段；云端仅传 OpenAI 规范或常见字段，避免 400 No schema matches
            # strict_openai_schema：若模型所接网关/代理对请求体校验严格（报 Validation error / No schema matches），
            # 可在该模型 config 中设 strict_openai_schema=true，则 extra_body 不传、model_kwargs 仅保留常见字段
            strict_schema = bool(model_cfg.get("strict_openai_schema", False))
            if strict_schema and kwargs.get("model_kwargs"):
                _allowed = {"temperature", "max_tokens", "top_p", "presence_penalty", "frequency_penalty", "stream", "n", "stop"}
                kwargs["model_kwargs"] = {k: v for k, v in kwargs["model_kwargs"].items() if k in _allowed}
            if strict_schema:
                extra_body = {}
            elif tier == "local":
                extra_body = {
                    "top_p": model_cfg.get("top_p", 0.9),
                    "top_k": model_cfg.get("top_k", 40),
                    "min_p": model_cfg.get("min_p", 0.05),
                    "repeat_penalty": model_cfg.get("repeat_penalty", 1.1),
                    "presence_penalty": model_cfg.get("presence_penalty", 0.0),
                    "frequency_penalty": model_cfg.get("frequency_penalty", 0.0),
                    "cache_prompt": True,
                    "parallel_tool_calls": bool(model_cfg.get("parallel_tool_calls", True)),
                }
                max_concurrent_predictions = model_cfg.get("max_concurrent_predictions")
                if isinstance(max_concurrent_predictions, int) and max_concurrent_predictions > 0:
                    extra_body["max_concurrent_predictions"] = max_concurrent_predictions
                num_threads = model_cfg.get("num_threads")
                if isinstance(num_threads, int) and num_threads > 0:
                    extra_body["num_threads"] = num_threads
                if bool(getattr(model_info, "is_reasoning_model", False)):
                    extra_body["chat_template_kwargs"] = {"enable_thinking": thinking_enabled}
                    extra_body["enable_thinking"] = thinking_enabled
            else:
                # 云端（tier != "local"）：统一不传 extra_body，符合 OpenAI 标准接口，避免 400 No schema matches
                extra_body = {}
            kwargs["extra_body"] = extra_body

        request_model = self._runtime_request_model_id(model_info)
        logger.info("[ModelManager] 创建 LLM: %s (request_model=%s, provider=%s) (%d tokens, %s)", model_id, request_model, provider, max_tokens, task_type)

        from langchain.chat_models import init_chat_model
        base_llm = init_chat_model(
            model=request_model,
            model_provider=provider,
            **kwargs,
        )

        llm = base_llm

        # langchain-openai 1.x 的 _convert_delta_to_message_chunk 不解析
        # LM Studio / Qwen 推理模型返回的 delta.reasoning_content。
        # 通过覆写 _convert_chunk_to_generation_chunk 在流式路径中补回。
        # 本地与云端共用此路径：仅由 is_reasoning_model + thinking_enabled 决定，不因 tier 跳过。
        if bool(getattr(model_info, "is_reasoning_model", False)) and thinking_enabled:
            _orig_convert = getattr(llm, "_convert_chunk_to_generation_chunk", None)
            if callable(_orig_convert):
                # 用列表包装状态，使闭包可修改（Python 3.9 兼容）
                _think_state = [False]  # [0]: 当前是否处于 <think> 阶段

                def _convert_with_reasoning(chunk, default_chunk_class, base_generation_info,
                                             _orig=_orig_convert, _mid=model_id, _state=_think_state):
                    gen_chunk = _orig(chunk, default_chunk_class, base_generation_info)
                    if gen_chunk is None:
                        return gen_chunk
                    choices = chunk.get("choices") or chunk.get("chunk", {}).get("choices") or []
                    if not choices:
                        return gen_chunk
                    delta = choices[0].get("delta") or {}

                    # --- 诊断日志：记录原始 delta 结构（仅 LLM_DEBUG=1 时）---
                    _llm_debug("delta", {
                        "model": _mid,
                        "rc": delta.get("reasoning_content"),
                        "content": (delta.get("content") or "")[:200],
                        "think_state": _state[0],
                    })

                    msg = gen_chunk.message
                    if not hasattr(msg, "additional_kwargs"):
                        return gen_chunk
                    ak = dict(msg.additional_kwargs) if msg.additional_kwargs else {}

                    # --- 路径 A：服务端已拆分 reasoning 字段（vLLM/LM Studio 新版 / 云端兼容）---
                    # 兼容云端 API 字段名：reasoning_content / thinking / reasoning，统一写入 reasoning_content
                    rc = (
                        delta.get("reasoning_content")
                        or delta.get("thinking")
                        or delta.get("reasoning")
                    )
                    if isinstance(rc, str) and rc:
                        ak["reasoning_content"] = rc
                        msg.additional_kwargs = ak
                        return gen_chunk

                    # --- 路径 B：服务端未拆分，thinking 内容混在 content 里（<think>...</think>）---
                    # LM Studio 旧版 / 部分 OpenAI 兼容网关走此路径
                    raw_content = delta.get("content") or ""
                    if not isinstance(raw_content, str):
                        return gen_chunk

                    if not _state[0]:
                        # 尚未进入 think 阶段：检测 <think> 开始标记
                        if "<think>" in raw_content:
                            _state[0] = True
                            # 将 <think> 之后的部分作为 reasoning，清空 content
                            after_think = raw_content.split("<think>", 1)[1]
                            if "</think>" in after_think:
                                # 同一 chunk 内 thinking 已结束
                                reasoning_part, _, content_part = after_think.partition("</think>")
                                _state[0] = False
                                ak["reasoning_content"] = reasoning_part
                                msg.additional_kwargs = ak
                                msg.content = content_part
                            else:
                                ak["reasoning_content"] = after_think
                                msg.additional_kwargs = ak
                                msg.content = ""
                    else:
                        # 处于 think 阶段：检测 </think> 结束标记
                        if "</think>" in raw_content:
                            _state[0] = False
                            reasoning_part, _, content_part = raw_content.partition("</think>")
                            existing_rc = ak.get("reasoning_content", "")
                            ak["reasoning_content"] = existing_rc + reasoning_part
                            msg.additional_kwargs = ak
                            msg.content = content_part
                        else:
                            # 仍在 thinking：全部内容归入 reasoning_content，清空 content
                            existing_rc = ak.get("reasoning_content", "")
                            ak["reasoning_content"] = existing_rc + raw_content
                            msg.additional_kwargs = ak
                            msg.content = ""

                    return gen_chunk
                llm._convert_chunk_to_generation_chunk = _convert_with_reasoning
                logger.info("[ModelManager] 已为推理模型 %s 启用 reasoning_content 流式透传（含 <think> 标签解析）", model_id)
        
        # 设置 profile（DeepAgent SummarizationMiddleware 需要）
        # ✅ 修正：使用模型真实上下文长度（context_length），而非输出上限（max_tokens）
        # SummarizationMiddleware 在 85% 时触发压缩，应基于模型真实窗口大小
        # max_tokens 是单次生成长度限制，context_length 是输入+输出的总预算
        from backend.engine.agent.deep_agent import Config as DeepAgentConfig
        default_ctx_len = getattr(DeepAgentConfig, 'DEFAULT_CONTEXT_LENGTH', 65536)
        context_length = model_info.context_length if model_info.context_length else default_ctx_len
        llm.profile = {"max_input_tokens": context_length}
        
        with self._llm_cache_lock:
            self._llm_cache[cache_key] = llm
        
        return llm

    def create_escalation_llm(
        self,
        tier: Optional[str] = None,
        config: Optional["RunnableConfig"] = None,
        task_type: str = "analysis",
    ) -> "ChatOpenAI":
        """创建升级通道模型实例。

        当本地模型能力不足时，按 tier（或策略）选择更强模型。
        """
        chosen_model: Optional[ModelInfo] = None
        if tier:
            candidates = [
                m for m in self._config.models
                if (
                    m.enabled
                    and getattr(m, "tier", "local") == tier
                    and self._is_model_available(m.id)
                    and self._is_provider_ready(m)
                )
            ]
            if candidates:
                candidates.sort(key=lambda x: x.priority)
                chosen_model = candidates[0]

        if chosen_model is None:
            fallback_id = self.get_fallback_model_for(self.get_model(config))
            if fallback_id:
                chosen_model = self.get_model_info(fallback_id)

        if chosen_model is None:
            raise ValueError("未找到可用的升级模型，请先在 models.json 启用 cloud tier 模型。")

        local_config = {"configurable": {"model": chosen_model.id}}
        return self.create_llm(config=local_config, task_type=task_type)
    
    def create_configurable_llm(self, config: Optional["RunnableConfig"] = None):
        """创建可配置的 LLM 实例（用于主 Orchestrator Agent）
        
        使用 LangChain 的 configurable_fields 机制，支持运行时动态切换模型。
        
        Args:
            config: LangChain RunnableConfig
        
        Returns:
            可配置的 LLM 实例
        """
        from langchain_core.runnables import ConfigurableField
        
        # 单例模式
        if self._configurable_llm is not None:
            return self._configurable_llm
        
        # 获取默认模型
        default_model = self.get_model(config)
        
        logger.info("[ModelManager] 创建可配置 LLM，默认模型: %s", default_model)
        
        # 创建基础 LLM
        base_llm = self.create_llm(config=config, task_type="default")
        
        # 使用 configurable_fields 允许运行时切换模型
        llm = base_llm.configurable_fields(
            model_name=ConfigurableField(
                id="model",  # 与前端一致
                name="Model",
                description="The LLM model to use",
            )
        )
        
        logger.info("[ModelManager] 可配置 LLM 创建完成")
        
        self._configurable_llm = llm
        return llm
    
    def _save_config(self) -> None:
        """将当前配置写回 models.json（用于运行时 add/update/delete 后持久化）。"""
        raw: Dict[str, Any] = {
            "models": [],
            "default_model": self._config.default_model,
            "subagent_model": self._config.subagent_model,
            "subagent_model_mapping": self._config.subagent_model_mapping,
            "api_timeout": self._config.api_timeout,
            "api_timeout_doc": self._config.api_timeout_doc,
            "api_timeout_analysis": self._config.api_timeout_analysis,
            "auto_selection_rule": self._config.auto_selection_rule,
            "escalation_policy": self._config.escalation_policy,
            "dynamic_context": self._config.dynamic_context,
            "cloud_endpoints": getattr(self._config, "cloud_endpoints", None) or [],
        }
        for m in self._config.models:
            raw["models"].append({
                "id": m.id,
                "name": m.name,
                "display_name": m.display_name,
                "description": m.description,
                "url": m.url,
                "enabled": m.enabled,
                "priority": m.priority,
                "context_length": m.context_length,
                "config": m.config,
                "provider": getattr(m, "provider", "openai"),
                "api_key": None,  # 不持久化明文 key，应通过 api_key_env 环境变量传入
                "api_key_env": getattr(m, "api_key_env", None),
                "tier": getattr(m, "tier", "local"),
                "cost_level": getattr(m, "cost_level", "unknown"),
                "is_reasoning_model": getattr(m, "is_reasoning_model", False),
                "supports_images": getattr(m, "supports_images", False),
                "capability": getattr(m, "capability", {}) or {},
                "role_affinity": getattr(m, "role_affinity", {}) or {},
                "usage": getattr(m, "usage", "chat"),
                "internal_only": bool(getattr(m, "internal_only", False)),
                "lm_studio_id": getattr(m, "lm_studio_id", None),
                "runtime_model_id": getattr(m, "runtime_model_id", None),
            })
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False, indent=2)
        logger.info("[ModelManager] 配置已保存: %s", CONFIG_PATH)

    def add_model(
        self,
        id: str,
        name: str,
        display_name: Optional[str] = None,
        url: str = "",
        description: str = "",
        enabled: bool = True,
        priority: int = 999,
        context_length: int = 65536,
        config: Optional[Dict[str, Any]] = None,
        provider: str = "openai",
        api_key: Optional[str] = None,
        api_key_env: Optional[str] = None,
        tier: str = "local",
        cost_level: str = "unknown",
        is_reasoning_model: bool = False,
        supports_images: bool = False,
        capability: Optional[Dict[str, Any]] = None,
        role_affinity: Optional[Dict[str, float]] = None,
        usage: str = "chat",
        internal_only: bool = False,
    ) -> ModelInfo:
        """运行时添加模型并持久化到 models.json。"""
        with self._config_lock:
            if self.get_model_info(id):
                raise ValueError(f"模型已存在: {id}")
            info = ModelInfo(
                id=id,
                name=name,
                display_name=display_name,
                description=description,
                url=url or "http://localhost:1234/v1",
                enabled=enabled,
                priority=priority,
                context_length=context_length,
                config=config or {},
                provider=provider,
                api_key=api_key,
                api_key_env=api_key_env,
                tier=tier,
                cost_level=cost_level,
                is_reasoning_model=is_reasoning_model,
                supports_images=supports_images,
                capability=capability or {},
                role_affinity=role_affinity or {},
                usage=str(usage or "chat"),
                internal_only=bool(internal_only),
            )
            self._config.models.append(info)
            self._config.models.sort(key=lambda m: m.priority)
            self._save_config()
        logger.info("[ModelManager] 已添加模型: %s", id)
        return info

    def update_model(self, model_id: str, **kwargs: Any) -> ModelInfo:
        """运行时更新模型并持久化。仅支持配置中的模型；云端发现模型不可编辑。"""
        with self._config_lock:
            info = self.get_model_info(model_id)
            if not info:
                raise ValueError(f"模型不存在: {model_id}")
            in_config = any(m.id == info.id for m in self._config.models)
            if not in_config:
                raise ValueError("云端发现模型不可编辑，请在设置中「云端端点」管理端点后自动发现。")
            for k, v in kwargs.items():
                if hasattr(info, k):
                    setattr(info, k, v)
            if "config" in kwargs and isinstance(kwargs["config"], dict):
                info.config = kwargs["config"]
            self._config.models.sort(key=lambda m: m.priority)
            self._save_config()
        self.release_model_memory(info.id)
        logger.info("[ModelManager] 已更新模型: %s", info.id)
        return info

    def delete_model(self, model_id: str) -> bool:
        """运行时删除模型并持久化。若为 default_model 则不允许删除；云端发现模型不可删除。"""
        with self._config_lock:
            info = self.get_model_info(model_id)
            if not info:
                return False
            if self._config.default_model == model_id or self._config.default_model == info.id:
                raise ValueError("不能删除当前默认模型，请先修改 default_model")
            in_config = any(m.id == info.id for m in self._config.models)
            if not in_config:
                return False
            self._config.models = [m for m in self._config.models if m.id != info.id]
            self._save_config()
        self.release_model_memory(info.id)
        with self._llm_cache_lock:
            if self._current_model == info.id:
                self._current_model = None
        logger.info("[ModelManager] 已删除模型: %s", info.id)
        return True

    def clear_cache(self):
        """清除 LLM 缓存"""
        with self._llm_cache_lock:
            self._llm_cache.clear()
        self._configurable_llm = None
        logger.debug("[ModelManager] LLM 缓存已清除")
    
    def release_model_memory(self, model_id: str = None):
        """显式释放模型内存（切换模型时调用）
        
        Args:
            model_id: 要释放的模型 ID，None 表示释放所有缓存的模型
        
        内存优化策略：
        - 清除 LLM 缓存中的指定模型
        - 触发 Python 垃圾回收
        - 清除 LangChain 全局响应缓存
        """
        import gc
        
        if model_id:
            with self._llm_cache_lock:
                keys_to_remove = [k for k in self._llm_cache if k.startswith(f"{model_id}:")]
                for key in keys_to_remove:
                    del self._llm_cache[key]
            logger.debug("[ModelManager] 已释放模型 %s 的内存 (%d 个缓存)", model_id, len(keys_to_remove))
        else:
            with self._llm_cache_lock:
                cache_count = len(self._llm_cache)
                self._llm_cache.clear()
            self._configurable_llm = None
            logger.debug("[ModelManager] 已释放所有模型内存 (%d 个缓存)", cache_count)
        
        # 清除 LangChain 全局响应缓存
        try:
            from langchain_core.globals import get_llm_cache
            cache = get_llm_cache()
            if cache and hasattr(cache, 'clear'):
                cache.clear()
                logger.debug("[ModelManager] 已清除 LangChain 响应缓存")
        except Exception as e:
            logger.debug("[ModelManager] 清理 LangChain 响应缓存失败: %s", e)
        
        # 强制垃圾回收
        gc.collect()
        gc.collect()  # 两次调用确保释放循环引用
    
    def get_memory_usage(self) -> dict:
        """获取内存使用情况（诊断用）
        
        Returns:
            内存使用统计
        """
        import gc
        
        result = {
            "llm_cache_count": len(self._llm_cache),
            "llm_cache_models": list(set(k.split(":")[0] for k in self._llm_cache.keys())),
            "has_configurable_llm": self._configurable_llm is not None,
            "gc_objects": len(gc.get_objects()),
        }
        
        # 尝试获取进程内存信息
        try:
            import psutil
            process = psutil.Process()
            mem_info = process.memory_info()
            result["process_rss_mb"] = round(mem_info.rss / 1024 / 1024, 2)
            result["process_vms_mb"] = round(mem_info.vms / 1024 / 1024, 2)
        except ImportError:
            logger.debug("[ModelManager] psutil 未安装，跳过进程内存统计")
        
        return result
    
    def get_status(self) -> Dict[str, Any]:
        """获取模型管理器状态"""
        return {
            "current_model": self._current_model,
            "default_model": self._config.default_model,
            "subagent_model": self._config.subagent_model,
            "subagent_model_mapping": self._config.subagent_model_mapping,
            "escalation_policy": self._config.escalation_policy,
            "models_count": len(self._config.models),
            "cache_size": len(self._llm_cache),
            "has_configurable_llm": self._configurable_llm is not None,
            "capability_models": self.get_capability_models_status(),
        }


# 全局实例
_model_manager: Optional[ModelManager] = None


def get_model_manager() -> ModelManager:
    """获取模型管理器实例"""
    global _model_manager
    if _model_manager is None:
        _model_manager = ModelManager()
    return _model_manager


# 便捷函数
def get_model_from_config(config: Optional["RunnableConfig"] = None) -> str:
    """从 config 中获取模型名称"""
    return get_model_manager().get_model(config)


def create_llm(
    config: Optional["RunnableConfig"] = None,
    task_type: str = "default"
) -> "ChatOpenAI":
    """创建 LLM 实例"""
    return get_model_manager().create_llm(config=config, task_type=task_type)


def create_llm_for_subagent(
    config: Optional["RunnableConfig"] = None,
    task_type: str = "default",
    agent_type: str = None
) -> "ChatOpenAI":
    """为 SubAgent 创建 LLM 实例
    
    Args:
        config: LangChain RunnableConfig
        task_type: 任务类型 ("default", "doc", "fast", "analysis")
        agent_type: Agent 类型 ("orchestrator", "planning", "executor", "knowledge")
                    优先级高于 task_type
    
    Returns:
        ChatOpenAI 实例
    """
    return get_model_manager().create_llm(
        config=config, 
        task_type=task_type,
        agent_type=agent_type,
        for_subagent=True
    )


def create_configurable_llm(config: Optional["RunnableConfig"] = None):
    """创建可配置的 LLM 实例"""
    return get_model_manager().create_configurable_llm(config=config)


def create_escalation_llm(
    tier: Optional[str] = None,
    config: Optional["RunnableConfig"] = None,
    task_type: str = "analysis",
) -> "ChatOpenAI":
    """创建升级通道 LLM（便捷函数）。"""
    return get_model_manager().create_escalation_llm(tier=tier, config=config, task_type=task_type)
