# 安全与敏感信息说明

## 1. 不应提交到仓库的内容

- **API Key / 密钥**：云端大模型（OpenAI、通义、OpenRouter 等）的 API Key **禁止**写入代码或提交到 Git。
- **`.env` 文件**：已列入 `.gitignore`，仅本地使用；请勿将 `.env` 加入版本控制。
- **内网地址与密钥**：`backend/config/models.json` 中 `cloud_endpoints` 与各模型的 `url` 仅使用占位或公网示例（如 `https://your-cloud-endpoint/v1`），**不要**提交真实内网 IP 或直填的 `sk-xxx` 密钥。

## 2. 正确配置方式

- **云端 API Key**：在本地创建 `.env`（复制自 `.env.example`），设置例如 `CLOUD_QWEN_API_KEY=sk-你的Key`；在 `models.json` 的 `cloud_endpoints` 与对应模型中只填 **环境变量名** `api_key_env: "CLOUD_QWEN_API_KEY"`，不要写密钥本身。
- **内部 API 鉴权**：若需 `INTERNAL_API_TOKEN`，同样仅在 `.env` 中配置，不要写入代码或提交。

## 3. 若曾误提交过密钥

若历史提交中曾包含真实 API Key 或内网地址：

1. **立即在对应平台轮换/撤销该 Key**，并更新本地 `.env`。
2. 密钥一旦进入 Git 历史，即使用新提交删除，仍可能被他人从历史记录中看到；轮换是必须的。
3. 本仓库已移除配置中的明文 Key 与内网 URL，改为占位与环境变量名。

## 4. 其他注意

- **知识库索引**：`knowledge_base/learned/` 下的索引与缓存可能包含你曾索引的文档摘要，请勿将含敏感信息的文档放入可被索引的路径，或注意访问控制。
- **运行环境**：本系统提供代码/命令执行能力，仅适合在受信环境使用；对外服务时请做好鉴权与沙箱策略。详见 README「安全与运行环境」与 `docs/SYSTEM_REVIEW_AND_OPTIMIZATION.md`。

---

*若发现新的敏感信息泄露风险，欢迎通过 GitHub Issues 私下说明（勿在公开 Issue 中粘贴密钥）。*
