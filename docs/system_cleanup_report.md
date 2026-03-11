# 本机空间优化检查报告

**当前磁盘**：约 7.3G 可用（/），空间紧张。

以下为可优化项，按「可安全执行」与「需你确认」分类。

---

## 一、可安全清理（执行后仅影响重建/重下速度，不丢个人数据）

| 项目 | 路径/命令 | 约释放 | 说明 |
|------|-----------|--------|------|
| **pip 缓存** | `pip cache purge` 或删 `~/Library/Caches/pip` | **7.6G** | 下次 pip install 会重新下载包 |
| **npm 缓存** | `npm cache clean --force` 或删 `~/.npm` | **10G** | 下次 npm install 会重新下载 |
| **pnpm 缓存** | `pnpm store prune` 或删 `~/Library/Caches/pnpm` | **1.6G** | 未用到的包会被删，常用包会重下 |
| **Homebrew 缓存** | `brew cleanup -s` | **约 254M** | 旧版公式与下载缓存 |
| **Python 官方缓存** | 删 `~/Library/Caches/com.apple.python` | **1.1G** | 系统 Python 相关缓存 |

**合计可安全释放约 20G+**（pip + npm 已占大部分）。

---

## 二、需你确认后再清理

| 项目 | 路径 | 约占用 | 说明 |
|------|------|--------|------|
| **下载目录** | `~/Downloads` | **26G** | 建议本人在 Finder 里查看，删不需要的安装包、旧文档等 |
| **Cursor 缓存** | `~/Library/Caches/Cursor` | **1.2G** | 清空后 Cursor 启动可能略慢，会重新建缓存 |
| **Playwright 浏览器** | `~/Library/Caches/ms-playwright` | **1.9G** | 若不做浏览器自动化测试可删，需要时再装 |
| **Cypress** | `~/Library/Caches/Cypress` | **1.1G** | 若不用 Cypress 做 E2E 可删 |
| **ToDesktop ShipIt** | `~/Library/Caches/com.todesktop.230313mzl4w4u92.ShipIt` | **1.1G** | 某桌面应用更新缓存，不用可删 |
| **Electron 缓存** | `~/Library/Caches/electron` | **412M** | Electron 应用缓存 |
| **Chrome/Google 缓存** | `~/Library/Caches/Google` | **520M** | 浏览器会重新积累缓存 |

---

## 三、不建议动（或仅了解）

| 项目 | 约占用 | 说明 |
|------|--------|------|
| **Cursor 工作区/配置** | `.cursor` 1.3G + workspaceStorage 388M | 含项目索引与状态，删了影响使用 |
| **废纸篓** | — | 在 Finder 里清空即可 |

---

## 四、建议执行顺序

1. **先做「可安全清理」**（见下一节命令），可释放约 20G+。
2. **手动整理 `~/Downloads`**，能再腾出最多 26G。
3. 若仍不够，再按需清理「需确认」里的 Cursor/Playwright/Cypress 等。

---

## 五、可安全执行的命令（复制到终端执行）

```bash
# 1. pip 缓存（约 7.6G）
pip cache purge

# 2. npm 缓存（约 10G）
npm cache clean --force

# 3. pnpm 缓存（约 1.6G）
pnpm store prune

# 4. Homebrew（约 254M）
brew cleanup -s

# 5. 系统 Python 缓存（约 1.1G，可选）
rm -rf ~/Library/Caches/com.apple.python
```

执行后可用 `df -h /` 再看可用空间。
