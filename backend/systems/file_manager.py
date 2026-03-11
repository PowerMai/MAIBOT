"""Research File Lifecycle Manager

完整的文件管理系统，支持研究任务的各个阶段。
遵循官方示例的 write_file/read_file 模式。
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any
from enum import Enum


class ResearchStage(str, Enum):
    """Research workflow stages"""
    REQUEST = "request"              # 用户原始需求
    PLAN = "plan"                    # 任务分解计划
    RESEARCH_LOGS = "research_logs"  # 并行执行日志
    FINDINGS_RAW = "findings_raw"    # 原始研究结果
    CITATIONS = "citations"          # 统一引用索引
    REPORT_DRAFT = "report_draft"    # 初稿
    REPORT_FINAL = "report_final"    # 最终报告
    METADATA = "metadata"            # 元数据


class ResearchFileManager:
    """Manage research document lifecycle"""
    
    # 固定目录结构
    BASE_DIR = Path("/research")
    RESULTS_DIR = BASE_DIR / "results"
    CACHE_DIR = BASE_DIR / ".cache"
    
    # 文件名模板
    FILES = {
        ResearchStage.REQUEST: "research_request.md",
        ResearchStage.PLAN: ".plan.md",
        ResearchStage.RESEARCH_LOGS: ".research_logs.json",
        ResearchStage.FINDINGS_RAW: ".findings_raw.md",
        ResearchStage.CITATIONS: ".citations_index.json",
        ResearchStage.REPORT_DRAFT: ".report_draft.md",
        ResearchStage.REPORT_FINAL: "final_report.md",
        ResearchStage.METADATA: ".metadata.json",
    }
    
    def __init__(self, research_id: str):
        """初始化研究文件管理器
        
        Args:
            research_id: 研究会话的唯一ID (UUID)
        """
        self.research_id = research_id
        self.research_dir = self.RESULTS_DIR / research_id
        self._ensure_directories()
        self._initialize_metadata()
    
    def _ensure_directories(self) -> None:
        """确保所有必需的目录存在"""
        self.BASE_DIR.mkdir(parents=True, exist_ok=True)
        self.RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        self.CACHE_DIR.mkdir(parents=True, exist_ok=True)
        self.research_dir.mkdir(parents=True, exist_ok=True)
    
    def _initialize_metadata(self) -> None:
        """初始化元数据"""
        metadata_path = self.research_dir / self.FILES[ResearchStage.METADATA]
        if not metadata_path.exists():
            metadata = {
                "research_id": self.research_id,
                "created_at": datetime.now().isoformat(),
                "updated_at": datetime.now().isoformat(),
                "stages": {stage.value: None for stage in ResearchStage},
                "metrics": {
                    "total_tokens": 0,
                    "total_search_calls": 0,
                    "subagents_used": [],
                    "duration_seconds": 0,
                }
            }
            self._write_json(metadata_path, metadata)
    
    def save_request(self, content: str) -> Path:
        """保存原始研究需求
        
        Args:
            content: 用户的研究请求文本
            
        Returns:
            保存的文件路径
        """
        path = self.research_dir / self.FILES[ResearchStage.REQUEST]
        path.write_text(content, encoding="utf-8")
        self._update_stage(ResearchStage.REQUEST)
        return path
    
    def save_plan(self, todos: List[Dict[str, Any]]) -> Path:
        """保存任务计划 (TODO列表)
        
        Args:
            todos: write_todos 生成的任务列表
            
        Returns:
            保存的文件路径
        """
        path = self.research_dir / self.FILES[ResearchStage.PLAN]
        
        # 格式化为可读的Markdown
        content = "# Research Plan\n\n"
        for i, todo in enumerate(todos, 1):
            content += f"## {i}. {todo.get('title', 'Untitled')}\n"
            content += f"- Status: {todo.get('status', 'pending')}\n"
            if 'sub_tasks' in todo:
                for sub in todo['sub_tasks']:
                    content += f"  - [ ] {sub}\n"
            content += "\n"
        
        path.write_text(content, encoding="utf-8")
        self._update_stage(ResearchStage.PLAN)
        return path
    
    def append_research_log(self, agent_id: str, findings: str, 
                          metadata: Optional[Dict] = None) -> Path:
        """追加Sub-Agent的研究日志
        
        Args:
            agent_id: Sub-Agent的ID
            findings: 研究结果文本
            metadata: 执行元数据 (tokens, duration, searches等)
            
        Returns:
            日志文件路径
        """
        path = self.research_dir / self.FILES[ResearchStage.RESEARCH_LOGS]
        
        # 读取现有日志或创建新的
        logs = self._read_json(path) if path.exists() else {"logs": []}
        
        # 添加新日志条目
        logs["logs"].append({
            "timestamp": datetime.now().isoformat(),
            "agent_id": agent_id,
            "findings_preview": findings[:200] + "..." if len(findings) > 200 else findings,
            "metadata": metadata or {}
        })
        
        # 保存日志
        self._write_json(path, logs)
        self._update_stage(ResearchStage.RESEARCH_LOGS)
        return path
    
    def save_raw_findings(self, content: str) -> Path:
        """保存原始研究结果 (在综合之前)
        
        Args:
            content: 来自所有Sub-Agents的原始结果
            
        Returns:
            保存的文件路径
        """
        path = self.research_dir / self.FILES[ResearchStage.FINDINGS_RAW]
        path.write_text(content, encoding="utf-8")
        self._update_stage(ResearchStage.FINDINGS_RAW)
        return path
    
    def consolidate_citations(self, all_sources: List[Dict[str, str]]) -> Path:
        """整合所有引用为统一的引用索引
        
        Args:
            all_sources: 所有来源的列表
                [{id: 1, title: "...", url: "..."}]
                
        Returns:
            引用索引文件路径
        """
        path = self.research_dir / self.FILES[ResearchStage.CITATIONS]
        
        # 去重并重新编号
        seen_urls = {}
        unique_sources = []
        citation_map = {}
        
        for source in all_sources:
            url = source.get("url", "")
            if url not in seen_urls:
                citation_num = len(unique_sources) + 1
                seen_urls[url] = citation_num
                unique_sources.append({
                    "id": citation_num,
                    "title": source.get("title", "Unknown"),
                    "url": url
                })
                citation_map[source.get("id", url)] = citation_num
        
        citations = {
            "unique_sources": unique_sources,
            "total_count": len(unique_sources),
            "citation_map": citation_map  # 原始ID → 新ID映射
        }
        
        self._write_json(path, citations)
        self._update_stage(ResearchStage.CITATIONS)
        return path
    
    def save_draft_report(self, content: str) -> Path:
        """保存初稿 (合并前的中间版本)
        
        Args:
            content: 初稿内容
            
        Returns:
            保存的文件路径
        """
        path = self.research_dir / self.FILES[ResearchStage.REPORT_DRAFT]
        path.write_text(content, encoding="utf-8")
        self._update_stage(ResearchStage.REPORT_DRAFT)
        return path
    
    def save_final_report(self, content: str) -> Path:
        """保存最终报告
        
        Args:
            content: 最终报告内容
            
        Returns:
            保存的文件路径 (通常是 /research/results/{id}/final_report.md)
        """
        path = self.research_dir / self.FILES[ResearchStage.REPORT_FINAL]
        path.write_text(content, encoding="utf-8")
        self._update_stage(ResearchStage.REPORT_FINAL)
        return path
    
    def read_file(self, stage: ResearchStage) -> Optional[str]:
        """读取特定阶段的文件
        
        Args:
            stage: 研究阶段
            
        Returns:
            文件内容，如果不存在则返回None
        """
        path = self.research_dir / self.FILES[stage]
        if path.exists():
            return path.read_text(encoding="utf-8")
        return None
    
    def get_metadata(self) -> Dict[str, Any]:
        """获取研究元数据
        
        Returns:
            元数据字典
        """
        path = self.research_dir / self.FILES[ResearchStage.METADATA]
        return self._read_json(path) if path.exists() else {}
    
    def update_metrics(self, updates: Dict[str, Any]) -> None:
        """更新指标信息
        
        Args:
            updates: 指标更新 {'total_tokens': 2500, ...}
        """
        metadata = self.get_metadata()
        metadata["metrics"].update(updates)
        metadata["updated_at"] = datetime.now().isoformat()
        path = self.research_dir / self.FILES[ResearchStage.METADATA]
        self._write_json(path, metadata)
    
    def cleanup_cache(self) -> int:
        """清理缓存目录
        
        Returns:
            删除的文件数
        """
        deleted_count = 0
        if self.CACHE_DIR.exists():
            for item in self.CACHE_DIR.iterdir():
                if item.is_file():
                    item.unlink()
                    deleted_count += 1
        return deleted_count
    
    def get_workflow_status(self) -> Dict[str, Optional[str]]:
        """获取完整的工作流状态
        
        Returns:
            {stage_name: timestamp_completed_or_None}
        """
        metadata = self.get_metadata()
        return metadata.get("stages", {})
    
    def verify_completeness(self) -> Dict[str, bool]:
        """验证研究的完整性
        
        Returns:
            {
                "has_request": bool,
                "has_plan": bool,
                "has_research_logs": bool,
                "has_findings": bool,
                "has_citations": bool,
                "has_final_report": bool,
                "all_complete": bool
            }
        """
        status = {
            "has_request": (self.research_dir / self.FILES[ResearchStage.REQUEST]).exists(),
            "has_plan": (self.research_dir / self.FILES[ResearchStage.PLAN]).exists(),
            "has_research_logs": (self.research_dir / self.FILES[ResearchStage.RESEARCH_LOGS]).exists(),
            "has_findings": (self.research_dir / self.FILES[ResearchStage.FINDINGS_RAW]).exists(),
            "has_citations": (self.research_dir / self.FILES[ResearchStage.CITATIONS]).exists(),
            "has_final_report": (self.research_dir / self.FILES[ResearchStage.REPORT_FINAL]).exists(),
        }
        status["all_complete"] = all([
            status["has_request"],
            status["has_plan"],
            status["has_findings"],
            status["has_citations"],
            status["has_final_report"]
        ])
        return status
    
    # 私有辅助方法
    
    def _update_stage(self, stage: ResearchStage) -> None:
        """更新阶段的完成时间戳"""
        metadata = self.get_metadata()
        metadata["stages"][stage.value] = datetime.now().isoformat()
        metadata["updated_at"] = datetime.now().isoformat()
        path = self.research_dir / self.FILES[ResearchStage.METADATA]
        self._write_json(path, metadata)
    
    def _write_json(self, path: Path, data: Dict) -> None:
        """写入JSON文件"""
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    
    def _read_json(self, path: Path) -> Dict:
        """读取JSON文件"""
        if not path.exists():
            return {}
        return json.loads(path.read_text(encoding="utf-8"))


# 全局单例实例管理器
_file_managers = {}


def get_research_file_manager(research_id: str) -> ResearchFileManager:
    """获取或创建研究文件管理器
    
    Args:
        research_id: 研究ID
        
    Returns:
        ResearchFileManager实例
    """
    if research_id not in _file_managers:
        _file_managers[research_id] = ResearchFileManager(research_id)
    return _file_managers[research_id]


if __name__ == "__main__":
    # 示例使用
    import uuid
    
    # 创建新研究
    research_id = str(uuid.uuid4())
    manager = get_research_file_manager(research_id)
    
    # 保存请求
    manager.save_request("Compare machine learning frameworks: PyTorch vs TensorFlow")
    
    # 保存计划
    manager.save_plan([
        {"title": "Research PyTorch", "status": "pending"},
        {"title": "Research TensorFlow", "status": "pending"},
        {"title": "Synthesize comparison", "status": "pending"},
    ])
    
    # 添加研究日志
    manager.append_research_log(
        agent_id="research-sub-agent-1",
        findings="PyTorch is known for dynamic computation graphs...",
        metadata={"searches": 3, "tokens": 2500}
    )
    
    # 保存最终报告
    manager.save_final_report("# PyTorch vs TensorFlow Comparison\n\nContent here...")
    
    # 验证完整性
    print("Workflow Status:", manager.verify_completeness())
    print("Metadata:", manager.get_metadata())

