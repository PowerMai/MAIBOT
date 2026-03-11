# 只推送必要内容到 GitHub

## 为什么推送失败？

- 当前 Git **历史里**约有 **17GB** 对象（含曾误提交的 `knowledge_base/global`、嵌套的 `frontend/desktop/workspace` 等）。
- GitHub 单次推送和仓库体积都有限制，推荐仓库 < 1GB，大仓库容易超时或失败。
- **Python 环境**：本机项目内 `.venv`（1.1G）+ `backend/.venv`（2.5G）约 3.6G，加上系统里 pyenv 等，多环境会占不少空间；这些都不应进仓库。

## 正确做法：只上传“必要内容”

已通过 **`.gitignore`** 排除，不会进入新提交的内容包括：

| 不推送（可本地重建/生成） | 说明 |
|--------------------------|------|
| `.venv/`、`backend/.venv/` | Python 虚拟环境，用 `uv sync` 或 `pip install -r requirements.txt` 重建 |
| `node_modules/`、`frontend/desktop/node_modules/` | 前端依赖，用 `pnpm install` 重建 |
| `knowledge_base/global/` | 约 13G，向量/索引数据，可本地重新生成 |
| `data/`、`outputs/`、`uploads/`、`backend/data/` | 运行时数据与产出 |
| `frontend/desktop/workspace/` | 工作区嵌套副本，不需进库 |
| `logs/`、`tmp/`、`.env` | 日志、临时文件、密钥 |

只提交：**源码、配置、文档、知识库结构（skills/ontology 等）、锁文件** 等必要内容。

## 已执行的“瘦身”操作

1. **已更新 `.gitignore`**：加入上述目录，之后新提交不会再把它们纳入仓库。
2. **若你按下面步骤“重新建仓并推送”**：会丢弃当前 **本地 Git 历史**（只保留当前工作区文件），在 GitHub 上以**一个新仓库**的形式推送，体积会小很多，推送容易成功。

## 重新建仓并只推必要内容（可选）

若你接受“丢弃本地 Git 历史、以当前文件为起点”，在项目根目录执行：

```bash
cd /Users/workspace/DevelopProjects/ccb-v0.378

# 1. 记下远程地址
git remote get-url origin

# 2. 删除本地 Git 历史（仅删 .git，不删任何源码）
rm -rf .git

# 3. 重新初始化并只提交“必要内容”
git init
git remote add origin https://github.com/PowerMai/Atlas.git
git add .
git status   # 确认没有 .venv、node_modules、knowledge_base/global 等
git commit -m "Initial commit: Atlas (necessary files only)"
git branch -M main
git push -u origin main --force
```

执行后 GitHub 上会是**一个干净、体积小**的仓库，只含必要文件。
