# Backend 依赖说明

## 唯一来源

- **规范来源**：`backend/pyproject.toml` 为唯一依赖声明。
- **requirements.txt**：与 pyproject.toml 核心依赖保持一致，供 pip 安装使用。勿手写修改；若使用 uv，可从 pyproject 重新生成：
  ```bash
  cd backend && uv export --no-dev -o requirements.txt
  ```

## 可选重依赖（按需安装）

以下依赖会显著增加安装体积与内存占用，仅在有对应能力需求时安装。

| 场景 | 安装方式 | 说明 |
|------|----------|------|
| 本地向量检索（FAISS + sentence-transformers） | `uv pip install -e ".[local-embedding]"` | 约 1.5GB 磁盘 + 500MB 内存；不装时嵌入走 HTTP API。 |
| 高级文档解析（unstructured OCR 等） | `uv pip install -e ".[advanced-docs]"` | 会拉入 torch，内存占用大。 |
| Jupyter 开发 | `uv pip install -e ".[notebook]"` | 仅开发/调试用。 |
| 额外 LLM 提供商（Anthropic/Google） | `uv pip install -e ".[llm-providers]"` | langchain-anthropic、langchain-google-genai。 |
| 外部知识源（Wikipedia/Wikidata） | `uv pip install -e ".[external-knowledge]"` | 知识管理师等角色使用。 |

**vllm / torch / transformers**：未列入 pyproject.toml 默认依赖。若需本地 vLLM 推理或 embedding 重排序（如 `embedding_tools.py` 中的 CrossEncoder），需单独安装对应 extra（如 local-embedding）或按需 `pip install vllm`；建议仅在 CI/演示或专用环境使用，生产默认不安装以减少体积与安全面。

## 版本与安全

- 核心库（langchain、langgraph、deepagents、fastapi）使用小版本范围（如 `>=1.2.10`），CI 可定期检查已知 CVE 与升级兼容性。
- 可选依赖安装后请定期更新，避免长期锁定旧版本。
