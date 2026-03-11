# 本体路径约定（Schema 单源与根目录分工）

## 单一权威路径：`knowledge_base/learned/ontology`

- **用途**：主 KG 存储、Schema 单源、本体工具实例写入。
- **路径常量**：`paths.ONTOLOGY_PATH`
- **内容**：
  - `schema.json`、`domain/{domain}/schema.json`：权威 schema（JSON），注入与抽取共用。
  - `entities.json`、`relations.json`：KnowledgeGraph 持久化。
  - `entities.jsonl`：ontology_extract 写入的实例（与主 KG 同根，便于后续合并或检索扩展）。

## 外部导入暂存：`knowledge_base/ontology`

- **用途**：LOV/Wikidata/Schema.org/OWL 等外部本体导入产物落盘，与主 KG 合并前暂存。
- **路径常量**：`paths.ONTOLOGY_IMPORT_STAGING_PATH`
- **说明**：检索与 `expand_query` 不直接读此目录；需通过「导入并合并」流程写入主 KG 后才参与检索。

## 外部导入与主 KG 闭环

- **流程**：`ontology_import`(action=search_lov / import_wikidata / import_owl / import_schema_org) 将结果落盘到 `ONTOLOGY_IMPORT_STAGING_PATH`；随后 `ontology_import`(action=merge_into_kg) 调用 merge_imported_into_kg，将暂存区产物映射并写入主 KG（learned/ontology 的 entities.json、relations.json）；`expand_query` 与 `search_knowledge` 使用同一 KG（get_knowledge_graph()），故合并后的概念可参与检索与多跳。
- **映射规则**：外部实体类型/关系谓词与主 KG 的对应关系见 [merge_imported.py](backend/tools/ontology/merge_imported.py) 的 `DEFAULT_ENTITY_MAPPING`、`DEFAULT_RELATION_MAPPING`。

## 代码约定

- Schema 读取：统一使用 `knowledge_graph.get_canonical_schema_path(domain)` / `load_schema(domain)` / `get_schema_for_tools(domain)` / `get_schema_snippet_for_injection(domain)`。
- 注入（OntologyContextMiddleware）与抽取（OntologyBuilder、ontology_tools）均从 `ONTOLOGY_PATH` 下 schema 读取，保证单源一致。

## 环境变量与行为

| 变量 | 说明 | 默认 |
|------|------|------|
| `ENABLE_KNOWLEDGE_GRAPH` | 启用 knowledge_graph 工具与 KG 增强检索（expand_query、多跳/推理） | true |
| `KG_USE_MULTIHOP_IN_RETRIEVAL` | 检索时是否使用多跳路径与规则推理（search_knowledge 的 KG 上下文） | true |
| `KG_MULTIHOP_MAX_DEPTH` | 检索时多跳路径最大深度 | 2 |
| `KNOWLEDGE_RETRIEVAL_TIMEOUT_SEC` | search_knowledge 总耗时上限（秒），0 表示不启用；可配合反向代理超时使用 | 0 |
| `AUTO_BUILD_ONTOLOGY_AFTER_UPLOAD` | 上传/导入后是否自动触发本体构建 | false |
| `KB_PATH` | 知识库根目录（未设置时由项目根推导） | 项目根/knowledge_base |
| `ONTOLOGY_PATH` | 由 `paths` 推导：`KB_PATH / "learned" / "ontology"`，不单独配置 | - |
| `ONTOLOGY_IMPORT_STAGING_PATH` | 由 `paths` 推导：`KB_PATH / "ontology"`，外部导入暂存 | - |

当 `KG_USE_MULTIHOP_IN_RETRIEVAL=true` 时，search_knowledge 的 KG 上下文会包含：（1）expand_query 的匹配实体与关系；（2）对前两个匹配实体的多跳路径（max_depth 由 `KG_MULTIHOP_MAX_DEPTH` 控制，默认 2）；（3）对首个匹配实体的规则推理结果（infer_relations）。便于运维与排障时理解行为。

## 验收清单

发布前或迭代后，可对照以下项做人工/脚本检查：

- **Schema 单源**：注入（OntologyContextMiddleware）与抽取（ontology 工具、OntologyBuilder）均从 `ONTOLOGY_PATH` 下 schema 读取，无其他 schema 来源。
- **工具归纳**：Agent 侧仅暴露 `ontology`、`ontology_import`、`knowledge_graph`；无旧名 `search_lov` / `query_kg` / `extract_entities` 等。
- **多跳/推理**：`KG_USE_MULTIHOP_IN_RETRIEVAL=true` 时，`search_knowledge` 的 KG 上下文中可包含多跳路径与规则推理结果。
- **外部导入闭环**：`ontology_import(action=merge_into_kg)` 执行后，主 KG 可被 `expand_query` / `search_knowledge` 利用。
- **多跳深度可配置**：`KG_MULTIHOP_MAX_DEPTH` 生效且检索链使用该值（见环境变量与行为）。
- **KG 懒加载**：Registry 初始化不触发 KG 文件加载；首次 search_knowledge 才加载 KG（可通过日志或自检验证）。
- **检索降级**：KG 加载或 expand_query 失败时，search_knowledge 仍可返回向量检索结果或明确超时/降级文案。

## 业界对标

- **GraphRAG（Microsoft）**：通过社区检测与社区摘要实现全局/局部双路检索；本项目当前为「局部检索 + KG 扩展与多跳/规则推理」，未做社区检测与社区级摘要，适用于先做强局部与类型约束、再按需演进全局摘要的路线。
- **本项目的选择**：单源 schema、少工具（ontology / ontology_import / knowledge_graph）、检索链内多跳与规则推理、外部导入合并至主 KG。与 GraphRAG 的差异：无社区级摘要与全局问题检索；适用场景为以向量与实体扩展为主、多跳与推理辅助的领域知识检索，便于产品与运维对标国际大厂能力边界与演进方向。
