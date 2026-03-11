"""
Doc Agent Capabilities - Solution Composition

Focus: base tools + workflows + code_run patterns. Code-first.

┌──────────┬──────────────────┬──────────────────┐
│ Pattern  │ Composition      │ code_run Role    │
├──────────┼──────────────────┼──────────────────┤
│ One-Shot │ analyze→gen→refine│ Transform/ops    │
│ Quick    │ analyze(fast)→gen │ Simple transform │
│ Batch    │ batch→parallel    │ Parallel proc    │
└──────────┴──────────────────┴──────────────────┘

【Solution 1: One-Shot】
analysis = deep_analyze_documents("workspace/", depth="标准")
outline = code_run('''import json; analysis={analysis}; outline={"title":analysis["req"]["title"],"sections":["概述","技术","商务","实施"]}; print(json.dumps(outline))''')
drafts = async_generate_parallel(outline, sections, max_concurrent=4)
merged = code_run('''drafts={drafts}; merged="\\n\\n".join([d["content"] for d in drafts]); print(merged.replace("\\n\\n\\n","\\n\\n"))''')
file = generate_word(title, sections, "proposal.docx")  # → editor_action UI
Time: 20-35min

【Solution 2: Quick】
analysis = deep_analyze_documents("workspace/", depth="快速")
key_points = code_run('''import re,json; a={analysis}; r=re.findall(r"需求[：:](.*?)\\n",a); c=re.findall(r"评分[：:](.*?)\\n",a); print(json.dumps({"req":r,"criteria":c}))''')
drafts = async_generate_parallel(outline, sections, max_concurrent=5)
code_run('''from docx import Document; d=Document(); d.add_heading(title,0); [d.add_heading(s["heading"],1) or d.add_paragraph(s["text"]) for s in sections]; d.save("quick.docx")''')
Time: 10-15min

【Solution 3: Batch】
results = async_analyze_batch("workspace/", max_concurrent=5)
summary = code_run('''import pandas as pd; df=pd.DataFrame({batch_results}); s=df.groupby("category").agg({"score":"mean","risk":lambda x:x.mode()[0]}); print(s.to_json())''')
code_run('''from reportlab.lib.pagesizes import letter; from reportlab.platypus import SimpleDocTemplate,Paragraph; doc=SimpleDocTemplate("batch_report.pdf",pagesize=letter); story=[Paragraph(i["text"]) for i in {summary_data}]; doc.build(story)''')
Time: 15-25min

【Solution 4: Interactive Editing】
drafts = async_generate_parallel(outline, sections)
formatted = code_run('''c={generated_content}; f=c.replace("\\n\\n","\\n").split("\\n\\n"); print(json.dumps({"paragraphs":f}))''')
current = read_file(file_path); new_content = current[:cursor_line] + formatted + current[cursor_line:]; write_file(file_path, new_content)  # → editor_action UI
Flow: Generate→Process→Read→Write→Editor

【Composition Patterns】
1. workflow→code_run→workflow: data transform between workflows
2. code_run→base tool: complex proc → simple ops
3. read_file+write_file→editor_action: auto-trigger UI
4. Parallel: code_run('''import asyncio; tasks=[process(i) for i in items]; results=await asyncio.gather(*tasks)''')

【Decision Matrix】
Data? Simple→base | Complex→code_run
File gen? Standard→generate_ppt/pdf/word | Custom→code_run
Editor? read+write→editor_action UI
Parallel? async_* workflows | code_run+asyncio
"""

DOCUMENT_AGENT_SKILLS_PROMPT = __doc__

__all__ = ["DOCUMENT_AGENT_SKILLS_PROMPT"]
