"""
图片生成工具 - 供主 Agent / media-agent 调用

根据描述生成图片并保存到工作区 outputs/，可对接云端图生 API 或本地服务。
"""

from typing import Any, Dict, Optional
from pathlib import Path
import os
import logging
import time
from langchain_core.tools import tool

from backend.tools.base.paths import get_workspace_root

logger = logging.getLogger(__name__)


def _get_image_output_dir() -> Path:
    """工作区 outputs 下的 image 子目录。"""
    root = get_workspace_root()
    out = root / "outputs" / "images"
    out.mkdir(parents=True, exist_ok=True)
    return out


def _call_cloud_image_api(prompt: str, size: str) -> Optional[str]:
    """
    调用云端/本地图生 API（OpenAI 兼容）。
    需配置 IMAGE_GENERATION_BASE_URL 或 OPENAI_API_KEY 等；未配置时返回 None。
    """
    base_url = (
        os.getenv("IMAGE_GENERATION_BASE_URL", "").strip()
        or os.getenv("OPENAI_IMAGE_BASE_URL", "").strip()
    )
    if not base_url:
        return None
    if not base_url.startswith(("http://", "https://")):
        base_url = "https://" + base_url
    api_key = (
        os.getenv("IMAGE_GENERATION_API_KEY", "").strip()
        or os.getenv("OPENAI_API_KEY", "").strip()
    )
    try:
        import httpx
        url = base_url.rstrip("/") + "/images/generations"
        payload = {
            "model": os.getenv("IMAGE_GENERATION_MODEL", "dall-e-3"),
            "prompt": prompt[:4000],
            "n": 1,
            "size": size or "1024x1024",
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        with httpx.Client(timeout=60.0) as client:
            resp = client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        urls = []
        for item in (data.get("data") or []):
            u = item.get("url") or (item.get("b64_json") and ("data:image/png;base64," + item["b64_json"]))
            if u:
                urls.append(u)
        if not urls:
            return None
        # 若返回 URL，下载到本地后返回路径
        img_url = urls[0]
        if img_url.startswith("data:"):
            import base64
            b64 = img_url.split(",", 1)[-1]
            raw = base64.b64decode(b64)
            out_dir = _get_image_output_dir()
            path = out_dir / f"gen_{int(time.time() * 1000)}.png"
            path.write_bytes(raw)
            return str(path)
        # 下载 HTTP URL，按 Content-Type 或 URL 后缀选择扩展名
        with httpx.Client(timeout=30.0) as client:
            r = client.get(img_url)
            r.raise_for_status()
            out_dir = _get_image_output_dir()
            ext = "png"
            ct = (r.headers.get("content-type") or "").split(";")[0].strip().lower()
            if "jpeg" in ct or "jpg" in ct:
                ext = "jpg"
            elif "webp" in ct:
                ext = "webp"
            elif "gif" in ct:
                ext = "gif"
            else:
                suf = (img_url.split("?")[0].split("/")[-1] or "").rsplit(".", 1)
                if len(suf) == 2 and suf[1].lower() in ("jpg", "jpeg", "webp", "gif", "png"):
                    ext = "jpg" if suf[1].lower() == "jpeg" else suf[1].lower()
            path = out_dir / f"gen_{int(time.time() * 1000)}.{ext}"
            path.write_bytes(r.content)
            return str(path)
    except Exception as e:
        logger.warning("Cloud image generation failed: %s", e)
        return None


@tool
def generate_image(
    prompt: str,
    size: str = "1024x1024",
    output_filename: Optional[str] = None,
) -> str:
    """Generate an image from a text description and save to workspace outputs/images.

    Use when:
    - 用户或任务需要根据描述生成配图（如 PPT 插图、报告图、封面）。
    - 与 generate_ppt 配合：先调用本工具得到 image_path，再在 slides 中传入 image_path。

    Avoid when:
    - 仅需分析已有图片（用 analyze_image）。

    Strategy:
    - 需配置 IMAGE_GENERATION_BASE_URL 与 IMAGE_GENERATION_API_KEY（或 OPENAI 等）才会真正调用图生 API。
    - 未配置时返回友好提示，建议配置或使用 task(media-agent) 由云端 VL 协助。

    Args:
        prompt: 图片描述（英文或中文，建议清晰具体）
        size: 尺寸，如 1024x1024、1792x1024（默认 1024x1024）
        output_filename: 可选，输出文件名（不含路径），缺省则自动命名
    """
    if not (prompt or "").strip():
        return "请提供图片描述（prompt 不能为空）。"
    result: Dict[str, Any] = {"ok": False, "path": None, "message": ""}
    path = _call_cloud_image_api(prompt, size or "1024x1024")
    if path:
        if output_filename:
            out_dir = _get_image_output_dir()
            dest = out_dir / output_filename
            try:
                Path(path).rename(dest)
                path = str(dest)
            except Exception as e:
                logger.warning("rename generated image failed: %s", e)
        result["ok"] = True
        result["path"] = path
        result["message"] = f"图片已生成: {path}"
        return result["message"]
    result["message"] = (
        "当前环境未配置图生 API（请设置 IMAGE_GENERATION_BASE_URL 与 IMAGE_GENERATION_API_KEY，或 OPENAI 等）。"
        "可改用 task(media-agent) 由云端 VL 协助生成配图描述与流程。"
    )
    return result["message"]


@tool(
    description="Placeholder for video generation. 当前未配置视频生成 API；返回友好提示。用户请求生成视频或视频脚本时可调用。"
)
def generate_video(prompt: str = "", duration_seconds: int = 5) -> str:
    """Placeholder: 当前环境未配置视频生成 API."""
    return (
        "当前环境未配置视频生成 API。"
        "如需生成视频脚本或分镜文案，可用自然语言描述需求由主 Agent 输出文本；"
        "后续可接入云端视频生成服务后启用本工具。"
    )


__all__ = ["generate_image", "generate_video"]
