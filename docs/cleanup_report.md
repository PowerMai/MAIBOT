# 项目空间占用与清理报告

生成时间：按当前扫描结果整理。

## 一、项目总占用约 40G，主要构成

| 路径 | 占用 | 说明 |
|------|------|------|
| `.git` | **14G** | Git 历史与对象，需保留；可做 `git gc --aggressive` 尝试压缩 |
| `knowledge_base/global` | **13G** | 主要为 `global/domain`，疑似向量库/索引，删除后可能需重建 |
| `frontend/desktop/node_modules` | **2.2G** | 前端依赖，可 `pnpm install` 重建 |
| `backend/.venv` | **2.5G** | 后端 Python 虚拟环境，可 `uv sync` 等重建 |
| `.venv`（根目录） | **1.1G** | 根目录 Python 虚拟环境，可能与 backend 重复 |
| `node_modules`（根目录） | 18M | 根目录 Node 依赖 |
| 其余 | 若干 | docs、data、outputs、logs 等 |

---

## 二、已执行的安全清理（无需你确认）

以下已在本机执行，可安全重复执行：

- 删除所有 **`__pycache__`** 目录及 **`.pyc`** 文件（已排除 .venv）
- 删除项目内 **`.DS_Store`**
- 删除 **`.ruff_cache`**、**`.pytest_cache`**（含 backend 下）
- **清空 `logs/`** 下大日志（backend.log、frontend.log 已清空，perf-baseline 已删）

这些释放空间有限（约几十 MB～百 MB 级），主要作用是减少无用缓存与日志。

---

## 三、需要你确认后再清理的内容

以下每一项都会明显释放空间，但可能影响使用或需要重新生成，请按需决定是否清理。

### 1. `knowledge_base/global`（约 13G）

- **路径**：`knowledge_base/global/`（主要为 `global/domain`）
- **可能内容**：向量库、文档索引等，供检索/学习用
- **若删除**：检索或知识库相关功能可能变慢或需重新建索引
- **建议**：确认不再用“全局知识/向量检索”再删；若只是暂时不用，可整目录备份到移动硬盘后再删

### 2. 根目录 `.venv`（约 1.1G）

- **路径**：项目根目录 `.venv`
- **说明**：后端已有 `backend/.venv`（2.5G），根目录可能为历史或重复环境
- **若删除**：若你平时只用 `backend/.venv` 跑后端，可删；若某脚本依赖根目录 `.venv`，需先改脚本或改用 backend 的 venv
- **建议**：确认所有命令、脚本都不依赖根目录 `.venv` 后再删

### 3. `frontend/desktop/node_modules`（约 2.2G）

- **路径**：`frontend/desktop/node_modules`
- **若删除**：需在 `frontend/desktop` 下重新执行 `pnpm install`（或你当前用的包管理器）才能再跑前端
- **建议**：若可接受重新安装依赖，可删以释放约 2.2G

### 4. `backend/.venv`（约 2.5G）

- **路径**：`backend/.venv`
- **若删除**：需在 backend 下重新创建虚拟环境并安装依赖（如 `uv sync` 或 `pip install -r requirements.txt`）
- **建议**：仅在确定可以重新装依赖且暂时不跑后端时考虑；一般建议保留

### 5. `.git` 压缩（不删历史，只尝试缩小体积）

- **操作**：在项目根执行  
  `git gc --aggressive --prune=now`
- **说明**：会压缩对象与 reflog，可能从约 14G 缩小一些；不会删除提交历史
- **风险**：低；若仓库很大，可能耗时较久

### 6. `tmp/` 目录（约 612K）

- **路径**：项目根目录 `tmp/`
- **内容**：临时文件、部分 .learnings、.maibot、outputs 等
- **若删除**：可能影响未保存的临时结果或调试数据
- **建议**：可先打开 `tmp/` 看是否有重要内容，再决定是否整目录删除或只删明显临时文件

---

## 四、建议的清理顺序（在确认后执行）

1. **先做 Git 压缩**（不删任何文件，只缩小 .git）：  
   `git gc --aggressive --prune=now`
2. 若可接受重装前端依赖：删除 **`frontend/desktop/node_modules`**，再在 `frontend/desktop` 执行 `pnpm install`。
3. 若确认根目录不再需要 Python 环境：删除 **根目录 `.venv`**。
4. 若确认不需要本机“全局知识/向量”数据：备份后删除 **`knowledge_base/global`**（约 13G）。
5. 按需清理 **`tmp/`** 内容。

---

## 五、本系统文件夹是否“都是有用文件”

- **有用且不建议删**：业务源码（如 `backend/` 除 .venv、`frontend/` 除 node_modules）、配置（如 `.maibot`、`.cursor/rules`）、`knowledge_base` 下的 skills/ontology/docs 等、`.git`（保留历史）。
- **可安全清理的已处理**：`__pycache__`、`.pyc`、`.DS_Store`、ruff/pytest 缓存、大日志（见第二节）。
- **需你确认再动**：`knowledge_base/global`、根目录 `.venv`、`frontend/desktop/node_modules`、`backend/.venv`、`tmp/`（见第三节）。

按上述区分后，当前项目里“明显无用且已清理”的是缓存和日志；“大块占用”多为运行/构建依赖（venv、node_modules）和知识库数据（global），是否删除取决于你是否还需要在本机跑前后端和检索功能。
