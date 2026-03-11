#!/usr/bin/env node
/*
  前端契约测试脚本（最小化、无侵入）
  - 使用项目内的 api client 包装发出 HTTP 请求到后端
  - 依赖 Node 18+（fetch 原生）
  - 不改变 UI 源码，仅作为独立脚本运行
*/

import fs from 'fs';
import path from 'path';

const BASE = process.env.VITE_API_BASE_URL || 'http://127.0.0.1:2024';
const RBAC = process.env.VITE_RBAC_API_KEY || 'dev-key-1';

function log(...args) {
  console.log('[tender-contract]', ...args);
}

async function post(path, body, isAdmin = false) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (isAdmin) headers['x-api-key'] = RBAC;
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch(e) { json = { raw: txt }; }
  return { status: res.status, ok: res.ok, body: json };
}

async function get(path, params = {}, isAdmin = false) {
  const url = new URL(`${BASE}${path}`);
  Object.entries(params).forEach(([k,v]) => url.searchParams.append(k, String(v)));
  const headers = {};
  if (isAdmin) headers['x-api-key'] = RBAC;
  const res = await fetch(url.toString(), { method: 'GET', headers });
  const txt = await res.text();
  let json = null;
  try { json = JSON.parse(txt); } catch(e) { json = { raw: txt }; }
  return { status: res.status, ok: res.ok, body: json };
}

async function run() {
  log('开始契约测试');
  const health = await get('/health');
  log('health', health.status, health.ok);
  if (!health.ok) {
    log('health failed', health.body);
    process.exit(2);
  }

  const relDir = 'global/domain/sales';
  const filename = `contract-test-${Date.now()}.md`;
  const relPath = `${relDir}/${filename}`;
  const kbRoot = path.resolve(process.cwd(), '../../knowledge_base');
  const fullDir = path.join(kbRoot, relDir);
  const fullPath = path.join(kbRoot, relPath);

  fs.mkdirSync(fullDir, { recursive: true });
  fs.writeFileSync(
    fullPath,
    '# 桥梁采购需求\n\n项目：桥梁建设\n长度：100m\n预算：100万\n',
    'utf8',
  );
  log('seed.file', relPath);

  let refresh = await post('/knowledge/refresh?scope=all');
  log('knowledge.refresh', refresh.status, refresh.ok, refresh.body?.success);
  if (!refresh.ok) {
    log('knowledge.refresh failed', refresh.body);
    process.exit(3);
  }

  const meta = await get('/knowledge/metadata');
  log('knowledge.metadata', meta.status, meta.ok, meta.body?.success);
  if (!meta.ok || !meta.body?.success) {
    log('knowledge.metadata failed', meta.body);
    process.exit(4);
  }

  const search = await get('/knowledge/search', { query: '桥梁 100m', k: 5, scope: 'all' });
  log('knowledge.search', search.status, search.ok, Array.isArray(search.body) ? search.body.length : -1);
  if (!search.ok || !Array.isArray(search.body)) {
    log('knowledge.search failed', search.body);
    process.exit(5);
  }

  const doc = await get('/knowledge/document', { path: relPath });
  log('knowledge.document', doc.status, doc.ok, doc.body?.name);
  if (!doc.ok || !doc.body?.content) {
    log('knowledge.document failed', doc.body);
    process.exit(6);
  }

  const docmap = await get('/knowledge/document/docmap', { path: relPath });
  const sectionCount = Array.isArray(docmap.body?.sections) ? docmap.body.sections.length : 0;
  log('knowledge.docmap', docmap.status, docmap.ok, sectionCount);
  if (!docmap.ok || sectionCount <= 0) {
    log('knowledge.docmap failed', docmap.body);
    process.exit(7);
  }

  const delRes = await fetch(`${BASE}/knowledge/document?path=${encodeURIComponent(relPath)}`, {
    method: 'DELETE',
    headers: { 'x-api-key': RBAC },
  });
  log('knowledge.delete', delRes.status, delRes.ok);
  if (!delRes.ok) {
    const raw = await delRes.text();
    log('knowledge.delete failed', raw);
    process.exit(8);
  }

  log('契约测试完成（知识库链路）');
}

run().catch(e => { console.error(e); process.exit(10); });


