"""
图表工具 - 封装 matplotlib/plotly 生成各类图表

支持的图表类型：
- 折线图（趋势分析）
- 柱状图（对比分析）
- 饼图（占比分析）
- 散点图（相关性分析）
- 热力图（矩阵分析）
- 甘特图（进度计划）

输出格式：
- PNG 图片（默认）
- SVG 矢量图
- HTML 交互式（plotly）
"""

import os
import json
from pathlib import Path
from typing import List, Dict, Any, Optional, Literal
from datetime import datetime
import logging

from backend.tools.base.paths import get_workspace_root

logger = logging.getLogger(__name__)

# 输出目录：使用工作区 outputs/charts，与 mode_config 产出路径一致
OUTPUT_DIR = get_workspace_root() / "outputs" / "charts"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def _ensure_matplotlib():
    """确保 matplotlib 可用"""
    try:
        import matplotlib
        matplotlib.use('Agg')  # 非交互式后端
        # 统一字体策略：优先系统可用中文字体，避免 CJK 缺字告警
        try:
            from matplotlib import font_manager
            import matplotlib.pyplot as _plt
            candidates = [
                "PingFang SC",
                "Hiragino Sans GB",
                "Microsoft YaHei",
                "Noto Sans CJK SC",
                "Source Han Sans SC",
                "WenQuanYi Micro Hei",
                "SimHei",
                "Arial Unicode MS",
                "DejaVu Sans",
            ]
            available_names = {f.name for f in font_manager.fontManager.ttflist}
            selected = [name for name in candidates if name in available_names]
            if selected:
                _plt.rcParams["font.sans-serif"] = selected + ["DejaVu Sans"]
            _plt.rcParams["axes.unicode_minus"] = False
        except Exception as e:
            logger.debug("matplotlib 字体配置失败，回退默认字体: %s", e)
        import matplotlib.pyplot as plt
        return plt
    except ImportError:
        raise ImportError("matplotlib 未安装，请运行: pip install matplotlib")


def _ensure_plotly():
    """确保 plotly 可用"""
    try:
        import plotly.express as px
        import plotly.graph_objects as go
        return px, go
    except ImportError:
        raise ImportError("plotly 未安装，请运行: pip install plotly")


def create_line_chart(
    data: Dict[str, List],
    title: str = "折线图",
    x_label: str = "X",
    y_label: str = "Y",
    filename: Optional[str] = None,
    output_format: Literal["png", "svg", "html"] = "png",
) -> str:
    """
    创建折线图
    
    Args:
        data: {"x": [1,2,3], "y": [4,5,6]} 或 {"x": [...], "series1": [...], "series2": [...]}
        title: 图表标题
        x_label: X轴标签
        y_label: Y轴标签
        filename: 输出文件名（不含扩展名）
        output_format: 输出格式
    
    Returns:
        输出文件路径
    """
    if filename is None:
        filename = f"line_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    if output_format == "html":
        px, _ = _ensure_plotly()
        import pandas as pd
        df = pd.DataFrame(data)
        x_col = list(data.keys())[0]
        y_cols = list(data.keys())[1:]
        
        fig = px.line(df, x=x_col, y=y_cols, title=title)
        fig.update_xaxes(title_text=x_label)
        fig.update_yaxes(title_text=y_label)
        
        output_path = OUTPUT_DIR / f"{filename}.html"
        fig.write_html(str(output_path))
    else:
        plt = _ensure_matplotlib()
        plt.figure(figsize=(10, 6))
        
        x = data.get("x", list(range(len(list(data.values())[0]))))
        for key, values in data.items():
            if key != "x":
                plt.plot(x, values, label=key, marker='o')
        
        plt.title(title)
        plt.xlabel(x_label)
        plt.ylabel(y_label)
        if len(data) > 2:
            plt.legend()
        plt.grid(True, alpha=0.3)
        plt.tight_layout()
        
        output_path = OUTPUT_DIR / f"{filename}.{output_format}"
        plt.savefig(str(output_path), dpi=150, format=output_format)
        plt.close()
    
    logger.info(f"✅ 折线图已生成: {output_path}")
    return str(output_path)


def create_bar_chart(
    data: Dict[str, Any],
    title: str = "柱状图",
    x_label: str = "类别",
    y_label: str = "数值",
    filename: Optional[str] = None,
    output_format: Literal["png", "svg", "html"] = "png",
    horizontal: bool = False,
) -> str:
    """
    创建柱状图
    
    Args:
        data: {"categories": ["A", "B", "C"], "values": [10, 20, 30]}
              或 {"categories": [...], "series1": [...], "series2": [...]}
        title: 图表标题
        horizontal: 是否水平柱状图
    
    Returns:
        输出文件路径
    """
    if filename is None:
        filename = f"bar_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    if output_format == "html":
        px, _ = _ensure_plotly()
        import pandas as pd
        df = pd.DataFrame(data)
        cat_col = "categories" if "categories" in data else list(data.keys())[0]
        val_cols = [k for k in data.keys() if k != cat_col]
        
        if horizontal:
            fig = px.bar(df, y=cat_col, x=val_cols, title=title, orientation='h')
        else:
            fig = px.bar(df, x=cat_col, y=val_cols, title=title)
        
        output_path = OUTPUT_DIR / f"{filename}.html"
        fig.write_html(str(output_path))
    else:
        plt = _ensure_matplotlib()
        import numpy as np
        
        categories = data.get("categories", list(data.keys())[0] if isinstance(list(data.values())[0], list) else list(data.keys()))
        
        # 处理多系列
        series_data = {k: v for k, v in data.items() if k != "categories"}
        n_series = len(series_data)
        
        plt.figure(figsize=(10, 6))
        
        if n_series == 1:
            values = list(series_data.values())[0]
            if horizontal:
                plt.barh(categories, values)
            else:
                plt.bar(categories, values)
        else:
            x = np.arange(len(categories))
            width = 0.8 / n_series
            
            for i, (name, values) in enumerate(series_data.items()):
                offset = (i - n_series/2 + 0.5) * width
                if horizontal:
                    plt.barh(x + offset, values, width, label=name)
                else:
                    plt.bar(x + offset, values, width, label=name)
            
            if horizontal:
                plt.yticks(x, categories)
            else:
                plt.xticks(x, categories)
            plt.legend()
        
        plt.title(title)
        plt.xlabel(x_label if not horizontal else y_label)
        plt.ylabel(y_label if not horizontal else x_label)
        plt.tight_layout()
        
        output_path = OUTPUT_DIR / f"{filename}.{output_format}"
        plt.savefig(str(output_path), dpi=150, format=output_format)
        plt.close()
    
    logger.info(f"✅ 柱状图已生成: {output_path}")
    return str(output_path)


def create_pie_chart(
    data: Dict[str, Any],
    title: str = "饼图",
    filename: Optional[str] = None,
    output_format: Literal["png", "svg", "html"] = "png",
) -> str:
    """
    创建饼图
    
    Args:
        data: {"labels": ["A", "B", "C"], "values": [30, 50, 20]}
    
    Returns:
        输出文件路径
    """
    if filename is None:
        filename = f"pie_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    labels = data.get("labels", data.get("categories", []))
    values = data.get("values", [])
    
    if output_format == "html":
        px, _ = _ensure_plotly()
        fig = px.pie(values=values, names=labels, title=title)
        
        output_path = OUTPUT_DIR / f"{filename}.html"
        fig.write_html(str(output_path))
    else:
        plt = _ensure_matplotlib()
        plt.figure(figsize=(8, 8))
        
        plt.pie(values, labels=labels, autopct='%1.1f%%', startangle=90)
        plt.title(title)
        plt.axis('equal')
        
        output_path = OUTPUT_DIR / f"{filename}.{output_format}"
        plt.savefig(str(output_path), dpi=150, format=output_format)
        plt.close()
    
    logger.info(f"✅ 饼图已生成: {output_path}")
    return str(output_path)


def create_scatter_chart(
    data: Dict[str, List],
    title: str = "散点图",
    x_label: str = "X",
    y_label: str = "Y",
    filename: Optional[str] = None,
    output_format: Literal["png", "svg", "html"] = "png",
) -> str:
    """
    创建散点图
    
    Args:
        data: {"x": [1,2,3], "y": [4,5,6]} 或带 "size" 和 "color" 字段
    
    Returns:
        输出文件路径
    """
    if filename is None:
        filename = f"scatter_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    x = data.get("x", [])
    y = data.get("y", [])
    size = data.get("size", None)
    color = data.get("color", None)
    
    if output_format == "html":
        px, _ = _ensure_plotly()
        fig = px.scatter(x=x, y=y, size=size, color=color, title=title)
        fig.update_xaxes(title_text=x_label)
        fig.update_yaxes(title_text=y_label)
        
        output_path = OUTPUT_DIR / f"{filename}.html"
        fig.write_html(str(output_path))
    else:
        plt = _ensure_matplotlib()
        plt.figure(figsize=(10, 6))
        
        scatter_kwargs = {}
        if size:
            scatter_kwargs['s'] = [s * 10 for s in size]
        if color:
            scatter_kwargs['c'] = color
            scatter_kwargs['cmap'] = 'viridis'
        
        plt.scatter(x, y, **scatter_kwargs)
        plt.title(title)
        plt.xlabel(x_label)
        plt.ylabel(y_label)
        plt.grid(True, alpha=0.3)
        
        if color:
            plt.colorbar()
        
        plt.tight_layout()
        
        output_path = OUTPUT_DIR / f"{filename}.{output_format}"
        plt.savefig(str(output_path), dpi=150, format=output_format)
        plt.close()
    
    logger.info(f"✅ 散点图已生成: {output_path}")
    return str(output_path)


def create_heatmap(
    data: List[List[float]],
    x_labels: Optional[List[str]] = None,
    y_labels: Optional[List[str]] = None,
    title: str = "热力图",
    filename: Optional[str] = None,
    output_format: Literal["png", "svg", "html"] = "png",
) -> str:
    """
    创建热力图
    
    Args:
        data: 二维数组 [[1,2,3], [4,5,6], [7,8,9]]
        x_labels: X轴标签
        y_labels: Y轴标签
    
    Returns:
        输出文件路径
    """
    if filename is None:
        filename = f"heatmap_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    if output_format == "html":
        px, go = _ensure_plotly()
        fig = go.Figure(data=go.Heatmap(
            z=data,
            x=x_labels,
            y=y_labels,
            colorscale='Viridis',
        ))
        fig.update_layout(title=title)
        
        output_path = OUTPUT_DIR / f"{filename}.html"
        fig.write_html(str(output_path))
    else:
        plt = _ensure_matplotlib()
        import numpy as np
        
        plt.figure(figsize=(10, 8))
        
        im = plt.imshow(data, cmap='viridis', aspect='auto')
        plt.colorbar(im)
        
        if x_labels:
            plt.xticks(range(len(x_labels)), x_labels, rotation=45, ha='right')
        if y_labels:
            plt.yticks(range(len(y_labels)), y_labels)
        
        plt.title(title)
        plt.tight_layout()
        
        output_path = OUTPUT_DIR / f"{filename}.{output_format}"
        plt.savefig(str(output_path), dpi=150, format=output_format)
        plt.close()
    
    logger.info(f"✅ 热力图已生成: {output_path}")
    return str(output_path)


def create_gantt_chart(
    tasks: List[Dict[str, Any]],
    title: str = "甘特图",
    filename: Optional[str] = None,
    output_format: Literal["png", "svg", "html"] = "png",
) -> str:
    """
    创建甘特图
    
    Args:
        tasks: [
            {"name": "任务1", "start": "2024-01-01", "end": "2024-01-15", "progress": 100},
            {"name": "任务2", "start": "2024-01-10", "end": "2024-01-25", "progress": 50},
        ]
    
    Returns:
        输出文件路径
    """
    if filename is None:
        filename = f"gantt_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    if output_format == "html":
        px, _ = _ensure_plotly()
        import pandas as pd
        
        df = pd.DataFrame(tasks)
        df['start'] = pd.to_datetime(df['start'])
        df['end'] = pd.to_datetime(df['end'])
        
        fig = px.timeline(
            df, 
            x_start="start", 
            x_end="end", 
            y="name",
            title=title,
            color="progress" if "progress" in df.columns else None,
        )
        fig.update_yaxes(autorange="reversed")
        
        output_path = OUTPUT_DIR / f"{filename}.html"
        fig.write_html(str(output_path))
    else:
        plt = _ensure_matplotlib()
        from datetime import datetime as dt
        import matplotlib.dates as mdates
        
        plt.figure(figsize=(12, len(tasks) * 0.5 + 2))
        
        for i, task in enumerate(tasks):
            start = dt.strptime(task["start"], "%Y-%m-%d")
            end = dt.strptime(task["end"], "%Y-%m-%d")
            duration = (end - start).days
            
            color = plt.cm.Blues(task.get("progress", 50) / 100)
            plt.barh(i, duration, left=start, height=0.4, color=color, edgecolor='black')
        
        plt.yticks(range(len(tasks)), [t["name"] for t in tasks])
        plt.xlabel("日期")
        plt.title(title)
        
        plt.gca().xaxis.set_major_formatter(mdates.DateFormatter('%Y-%m-%d'))
        plt.gca().xaxis.set_major_locator(mdates.WeekdayLocator())
        plt.gcf().autofmt_xdate()
        
        plt.tight_layout()
        
        output_path = OUTPUT_DIR / f"{filename}.{output_format}"
        plt.savefig(str(output_path), dpi=150, format=output_format)
        plt.close()
    
    logger.info(f"✅ 甘特图已生成: {output_path}")
    return str(output_path)


def create_network_graph(
    nodes: List[Dict[str, Any]],
    edges: List[Dict[str, Any]],
    title: str = "网络拓扑图",
    filename: Optional[str] = None,
    output_format: Literal["png", "svg", "html"] = "png",
    layout: str = "spring",
) -> str:
    """
    创建网络拓扑图（支持网络架构、组织结构、知识图谱等）
    
    Args:
        nodes: 节点列表 [{"id": "A", "label": "服务器A", "group": "server", "size": 20}, ...]
        edges: 边列表 [{"source": "A", "target": "B", "label": "连接", "weight": 1}, ...]
        title: 图表标题
        layout: 布局算法 (spring/circular/shell/kamada_kawai/spectral)
        output_format: 输出格式
    
    Returns:
        输出文件路径
    """
    if filename is None:
        filename = f"network_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    try:
        import networkx as nx
    except ImportError:
        raise ImportError("networkx 未安装，请运行: pip install networkx")
    
    # 创建图
    G = nx.DiGraph()
    
    # 添加节点
    for node in nodes:
        node_id = node.get("id", node.get("name", str(len(G.nodes))))
        G.add_node(node_id, **{k: v for k, v in node.items() if k != "id"})
    
    # 添加边
    for edge in edges:
        G.add_edge(
            edge.get("source", edge.get("from")),
            edge.get("target", edge.get("to")),
            **{k: v for k, v in edge.items() if k not in ["source", "target", "from", "to"]}
        )
    
    if output_format == "html":
        # 使用 pyvis 生成交互式网络图
        try:
            from pyvis.network import Network
            net = Network(height="600px", width="100%", directed=True, notebook=False)
            net.from_nx(G)
            net.toggle_physics(True)
            
            output_path = OUTPUT_DIR / f"{filename}.html"
            net.save_graph(str(output_path))
        except ImportError:
            # 降级到 plotly
            px, go = _ensure_plotly()
            
            # 获取布局位置
            layouts = {
                "spring": nx.spring_layout,
                "circular": nx.circular_layout,
                "shell": nx.shell_layout,
                "kamada_kawai": nx.kamada_kawai_layout,
                "spectral": nx.spectral_layout,
            }
            pos = layouts.get(layout, nx.spring_layout)(G)
            
            # 创建边的线条
            edge_x, edge_y = [], []
            for edge in G.edges():
                x0, y0 = pos[edge[0]]
                x1, y1 = pos[edge[1]]
                edge_x.extend([x0, x1, None])
                edge_y.extend([y0, y1, None])
            
            edge_trace = go.Scatter(
                x=edge_x, y=edge_y,
                line=dict(width=1, color='#888'),
                hoverinfo='none',
                mode='lines'
            )
            
            # 创建节点
            node_x = [pos[node][0] for node in G.nodes()]
            node_y = [pos[node][1] for node in G.nodes()]
            node_text = [G.nodes[node].get("label", node) for node in G.nodes()]
            
            node_trace = go.Scatter(
                x=node_x, y=node_y,
                mode='markers+text',
                hoverinfo='text',
                text=node_text,
                textposition="top center",
                marker=dict(size=20, color='#1f77b4', line=dict(width=2, color='white'))
            )
            
            fig = go.Figure(data=[edge_trace, node_trace],
                          layout=go.Layout(title=title, showlegend=False,
                                          xaxis=dict(showgrid=False, zeroline=False, showticklabels=False),
                                          yaxis=dict(showgrid=False, zeroline=False, showticklabels=False)))
            
            output_path = OUTPUT_DIR / f"{filename}.html"
            fig.write_html(str(output_path))
    else:
        plt = _ensure_matplotlib()
        plt.figure(figsize=(12, 10))
        
        # 获取布局
        layouts = {
            "spring": nx.spring_layout,
            "circular": nx.circular_layout,
            "shell": nx.shell_layout,
            "kamada_kawai": nx.kamada_kawai_layout,
            "spectral": nx.spectral_layout,
        }
        pos = layouts.get(layout, nx.spring_layout)(G, seed=42)
        
        # 获取节点属性
        node_colors = [G.nodes[n].get("color", "#1f77b4") for n in G.nodes()]
        node_sizes = [G.nodes[n].get("size", 300) * 10 for n in G.nodes()]
        labels = {n: G.nodes[n].get("label", n) for n in G.nodes()}
        
        # 绘制
        nx.draw_networkx_edges(G, pos, alpha=0.5, edge_color='gray', arrows=True, arrowsize=15)
        nx.draw_networkx_nodes(G, pos, node_color=node_colors, node_size=node_sizes, alpha=0.9)
        nx.draw_networkx_labels(G, pos, labels, font_size=9, font_weight='bold')
        
        # 绘制边标签
        edge_labels = {(e[0], e[1]): G.edges[e].get("label", "") for e in G.edges()}
        nx.draw_networkx_edge_labels(G, pos, edge_labels, font_size=8)
        
        plt.title(title, fontsize=14)
        plt.axis('off')
        plt.tight_layout()
        
        output_path = OUTPUT_DIR / f"{filename}.{output_format}"
        plt.savefig(str(output_path), dpi=150, format=output_format, bbox_inches='tight')
        plt.close()
    
    logger.info(f"✅ 网络拓扑图已生成: {output_path}")
    return str(output_path)


def create_flowchart(
    steps: List[Dict[str, Any]],
    title: str = "流程图",
    filename: Optional[str] = None,
    output_format: Literal["png", "svg", "html", "mermaid"] = "png",
) -> str:
    """
    创建流程图
    
    Args:
        steps: 步骤列表 [
            {"id": "start", "label": "开始", "type": "start"},
            {"id": "step1", "label": "步骤1", "type": "process", "next": "step2"},
            {"id": "decision", "label": "判断?", "type": "decision", "yes": "step2", "no": "end"},
            {"id": "end", "label": "结束", "type": "end"}
        ]
        type: start/end/process/decision/io
    
    Returns:
        输出文件路径或 Mermaid 代码
    """
    if filename is None:
        filename = f"flowchart_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    # 生成 Mermaid 代码
    mermaid_code = ["graph TD"]
    
    shape_map = {
        "start": ("([", "])"),      # 圆角矩形
        "end": ("([", "])"),
        "process": ("[", "]"),       # 矩形
        "decision": ("{", "}"),      # 菱形
        "io": ("[/", "/]"),          # 平行四边形
    }
    
    for step in steps:
        step_id = step.get("id", f"step{steps.index(step)}")
        label = step.get("label", step_id)
        step_type = step.get("type", "process")
        
        left, right = shape_map.get(step_type, ("[", "]"))
        mermaid_code.append(f"    {step_id}{left}\"{label}\"{right}")
        
        # 添加连接
        if "next" in step:
            mermaid_code.append(f"    {step_id} --> {step['next']}")
        if "yes" in step:
            mermaid_code.append(f"    {step_id} -->|是| {step['yes']}")
        if "no" in step:
            mermaid_code.append(f"    {step_id} -->|否| {step['no']}")
    
    mermaid_text = "\n".join(mermaid_code)
    
    if output_format == "mermaid":
        # 直接返回 Mermaid 代码
        output_path = OUTPUT_DIR / f"{filename}.md"
        output_path.write_text(f"```mermaid\n{mermaid_text}\n```", encoding="utf-8")
        logger.info(f"✅ 流程图 Mermaid 代码已生成: {output_path}")
        return str(output_path)
    
    if output_format == "html":
        # 生成包含 Mermaid 的 HTML
        html_content = f"""<!DOCTYPE html>
<html>
<head>
    <title>{title}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
</head>
<body>
    <h2>{title}</h2>
    <div class="mermaid">
{mermaid_text}
    </div>
    <script>mermaid.initialize({{startOnLoad:true}});</script>
</body>
</html>"""
        output_path = OUTPUT_DIR / f"{filename}.html"
        output_path.write_text(html_content, encoding="utf-8")
        logger.info(f"✅ 流程图 HTML 已生成: {output_path}")
        return str(output_path)
    
    # PNG/SVG: 使用 networkx 绘制简化版
    try:
        import networkx as nx
    except ImportError:
        # 降级到 Mermaid 输出
        return create_flowchart(steps, title, filename, "mermaid")
    
    plt = _ensure_matplotlib()
    G = nx.DiGraph()
    
    # 添加节点和边
    for step in steps:
        step_id = step.get("id", f"step{steps.index(step)}")
        G.add_node(step_id, label=step.get("label", step_id), type=step.get("type", "process"))
        
        for next_key in ["next", "yes", "no"]:
            if next_key in step:
                G.add_edge(step_id, step[next_key])
    
    plt.figure(figsize=(10, 8))
    
    # 使用分层布局
    try:
        pos = nx.drawing.nx_agraph.graphviz_layout(G, prog='dot')
    except Exception:
        pos = nx.spring_layout(G, seed=42)
    
    # 根据类型设置颜色
    color_map = {
        "start": "#90EE90",
        "end": "#FFB6C1",
        "process": "#87CEEB",
        "decision": "#FFD700",
        "io": "#DDA0DD",
    }
    node_colors = [color_map.get(G.nodes[n].get("type", "process"), "#87CEEB") for n in G.nodes()]
    labels = {n: G.nodes[n].get("label", n) for n in G.nodes()}
    
    nx.draw_networkx_nodes(G, pos, node_color=node_colors, node_size=2000, alpha=0.9)
    nx.draw_networkx_labels(G, pos, labels, font_size=9)
    nx.draw_networkx_edges(G, pos, edge_color='gray', arrows=True, arrowsize=20)
    
    plt.title(title, fontsize=14)
    plt.axis('off')
    plt.tight_layout()
    
    output_path = OUTPUT_DIR / f"{filename}.{output_format}"
    plt.savefig(str(output_path), dpi=150, format=output_format, bbox_inches='tight')
    plt.close()
    
    logger.info(f"✅ 流程图已生成: {output_path}")
    return str(output_path)


def create_mindmap(
    root: Dict[str, Any],
    title: str = "思维导图",
    filename: Optional[str] = None,
    output_format: Literal["png", "svg", "html", "mermaid"] = "html",
) -> str:
    """
    创建思维导图
    
    Args:
        root: 根节点 {
            "label": "主题",
            "children": [
                {"label": "分支1", "children": [{"label": "子节点1"}, {"label": "子节点2"}]},
                {"label": "分支2", "children": [{"label": "子节点3"}]}
            ]
        }
    
    Returns:
        输出文件路径
    """
    if filename is None:
        filename = f"mindmap_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    # 递归生成 Mermaid 代码
    def build_mermaid(node, indent=0):
        lines = []
        label = node.get("label", "节点")
        prefix = "  " * indent
        lines.append(f"{prefix}{label}")
        for child in node.get("children", []):
            lines.extend(build_mermaid(child, indent + 1))
        return lines
    
    mermaid_lines = ["mindmap", f"  root(({root.get('label', '主题')}))"]
    for child in root.get("children", []):
        mermaid_lines.extend(build_mermaid(child, 2))
    
    mermaid_text = "\n".join(mermaid_lines)
    
    if output_format == "mermaid":
        output_path = OUTPUT_DIR / f"{filename}.md"
        output_path.write_text(f"```mermaid\n{mermaid_text}\n```", encoding="utf-8")
        logger.info(f"✅ 思维导图 Mermaid 代码已生成: {output_path}")
        return str(output_path)
    
    if output_format == "html":
        html_content = f"""<!DOCTYPE html>
<html>
<head>
    <title>{title}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
    <style>
        body {{ font-family: Arial, sans-serif; padding: 20px; }}
        h2 {{ color: #333; }}
    </style>
</head>
<body>
    <h2>{title}</h2>
    <div class="mermaid">
{mermaid_text}
    </div>
    <script>mermaid.initialize({{startOnLoad:true, theme:'default'}});</script>
</body>
</html>"""
        output_path = OUTPUT_DIR / f"{filename}.html"
        output_path.write_text(html_content, encoding="utf-8")
        logger.info(f"✅ 思维导图 HTML 已生成: {output_path}")
        return str(output_path)
    
    # PNG/SVG: 使用树形布局
    try:
        import networkx as nx
    except ImportError:
        return create_mindmap(root, title, filename, "mermaid")
    
    plt = _ensure_matplotlib()
    G = nx.DiGraph()
    
    # 递归添加节点
    def add_nodes(node, parent=None, depth=0):
        label = node.get("label", "节点")
        node_id = f"{label}_{depth}_{len(G.nodes)}"
        G.add_node(node_id, label=label, depth=depth)
        if parent:
            G.add_edge(parent, node_id)
        for child in node.get("children", []):
            add_nodes(child, node_id, depth + 1)
    
    add_nodes(root)
    
    plt.figure(figsize=(14, 10))
    
    # 使用树形布局
    try:
        from networkx.drawing.nx_agraph import graphviz_layout
        pos = graphviz_layout(G, prog='twopi', root=list(G.nodes())[0])
    except Exception:
        pos = nx.spring_layout(G, k=2, seed=42)
    
    # 根据深度设置颜色
    colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD']
    node_colors = [colors[min(G.nodes[n].get("depth", 0), len(colors)-1)] for n in G.nodes()]
    labels = {n: G.nodes[n].get("label", n) for n in G.nodes()}
    
    nx.draw_networkx_nodes(G, pos, node_color=node_colors, node_size=1500, alpha=0.9)
    nx.draw_networkx_labels(G, pos, labels, font_size=8)
    nx.draw_networkx_edges(G, pos, edge_color='#888', arrows=False, width=1.5)
    
    plt.title(title, fontsize=14)
    plt.axis('off')
    plt.tight_layout()
    
    output_path = OUTPUT_DIR / f"{filename}.{output_format}"
    plt.savefig(str(output_path), dpi=150, format=output_format, bbox_inches='tight')
    plt.close()
    
    logger.info(f"✅ 思维导图已生成: {output_path}")
    return str(output_path)


def create_architecture_diagram(
    components: List[Dict[str, Any]],
    connections: List[Dict[str, Any]],
    title: str = "系统架构图",
    filename: Optional[str] = None,
    output_format: Literal["png", "svg", "html"] = "png",
) -> str:
    """
    创建系统架构图（适用于软件架构、网络架构等）
    
    Args:
        components: 组件列表 [
            {"id": "web", "label": "Web层", "layer": "presentation", "type": "server"},
            {"id": "api", "label": "API层", "layer": "business", "type": "service"},
            {"id": "db", "label": "数据库", "layer": "data", "type": "database"}
        ]
        connections: 连接列表 [
            {"from": "web", "to": "api", "label": "HTTP"},
            {"from": "api", "to": "db", "label": "SQL"}
        ]
        layer: presentation/business/data（用于分层显示）
        type: server/service/database/storage/external
    
    Returns:
        输出文件路径
    """
    # 转换为网络图格式
    nodes = []
    for comp in components:
        # 根据类型设置颜色
        type_colors = {
            "server": "#4CAF50",
            "service": "#2196F3",
            "database": "#FF9800",
            "storage": "#9C27B0",
            "external": "#607D8B",
            "client": "#E91E63",
        }
        nodes.append({
            "id": comp.get("id"),
            "label": comp.get("label", comp.get("id")),
            "color": type_colors.get(comp.get("type", "service"), "#2196F3"),
            "size": 25,
            "group": comp.get("layer", "default"),
        })
    
    edges = [{"source": c.get("from"), "target": c.get("to"), "label": c.get("label", "")} 
             for c in connections]
    
    return create_network_graph(nodes, edges, title, filename, output_format, layout="shell")


# ============================================================
# LangChain 工具包装
# ============================================================
from langchain_core.tools import tool


@tool
def create_chart(
    chart_type: str,
    data: str,
    title: str = "图表",
    options: str = "{}",
) -> str:
    """
    创建各类图表（支持基础图表和高级图表）

    Use when:
    - 需要把结构化数据转成可视化输出（PNG/SVG/HTML）。
    - 需要在聊天/报告中快速展示趋势、对比、网络关系或流程结构。

    Avoid when:
    - 输入 data/options 不是合法 JSON。
    - 只需要简单数值结论，不需要图形表达。

    Strategy:
    - 先用 python_run 清洗并聚合数据，再传入 create_chart。
    - 对交互场景优先 output_format=html；归档场景优先 png/svg。
    
    Args:
        chart_type: 图表类型，可选值：
            基础图表：
            - line: 折线图（趋势分析）
            - bar: 柱状图（对比分析）
            - pie: 饼图（占比分析）
            - scatter: 散点图（相关性分析）
            - heatmap: 热力图（矩阵分析）
            - gantt: 甘特图（进度计划）
            
            高级图表：
            - network: 网络拓扑图（网络架构、组织结构、知识图谱）
            - flowchart: 流程图（业务流程、算法流程）
            - mindmap: 思维导图（知识整理、头脑风暴）
            - architecture: 系统架构图（软件架构、网络架构）
        
        data: JSON 格式的数据，例如：
            - 折线图/柱状图：{"x": [1,2,3], "y": [4,5,6]}
            - 饼图：{"labels": ["A","B","C"], "values": [30,50,20]}
            - 甘特图：[{"name": "任务1", "start": "2024-01-01", "end": "2024-01-15"}]
            - 网络图：{"nodes": [{"id": "A", "label": "节点A"}], "edges": [{"source": "A", "target": "B"}]}
            - 流程图：[{"id": "start", "label": "开始", "type": "start", "next": "step1"}]
            - 思维导图：{"label": "主题", "children": [{"label": "分支1"}]}
            - 架构图：{"components": [...], "connections": [...]}
        
        title: 图表标题
        options: JSON 格式的额外选项，例如：
            - {"output_format": "html"} - 生成交互式 HTML
            - {"output_format": "svg"} - 生成矢量图
            - {"layout": "circular"} - 网络图布局（spring/circular/shell）
    
    Returns:
        生成的图表文件路径
    """
    try:
        data_dict = json.loads(data)
        opts = json.loads(options) if options else {}
        
        # 基础图表
        basic_chart_funcs = {
            "line": create_line_chart,
            "bar": create_bar_chart,
            "pie": create_pie_chart,
            "scatter": create_scatter_chart,
            "heatmap": create_heatmap,
            "gantt": create_gantt_chart,
        }
        
        # 高级图表
        advanced_chart_funcs = {
            "network": lambda d, **kw: create_network_graph(
                d.get("nodes", []), d.get("edges", []), **kw
            ),
            "flowchart": lambda d, **kw: create_flowchart(d, **kw),
            "mindmap": lambda d, **kw: create_mindmap(d, **kw),
            "architecture": lambda d, **kw: create_architecture_diagram(
                d.get("components", []), d.get("connections", []), **kw
            ),
        }
        
        all_funcs = {**basic_chart_funcs, **advanced_chart_funcs}
        
        if chart_type not in all_funcs:
            return f"❌ 不支持的图表类型: {chart_type}，可选值: {list(all_funcs.keys())}"
        
        func = all_funcs[chart_type]
        
        # 构建参数
        kwargs = {"title": title}
        kwargs.update(opts)
        
        return func(data_dict, **kwargs)
        
    except json.JSONDecodeError as e:
        return f"❌ JSON 解析错误: {e}"
    except ImportError as e:
        return f"❌ 缺少依赖库: {e}。请安装: pip install networkx pyvis"
    except Exception as e:
        return f"❌ 图表生成失败: {e}"


# 导出
CHART_TOOLS = [create_chart]

__all__ = [
    # 基础图表
    "create_line_chart",
    "create_bar_chart",
    "create_pie_chart",
    "create_scatter_chart",
    "create_heatmap",
    "create_gantt_chart",
    # 高级图表
    "create_network_graph",
    "create_flowchart",
    "create_mindmap",
    "create_architecture_diagram",
    # 统一工具
    "create_chart",
    "CHART_TOOLS",
]
