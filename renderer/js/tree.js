/**
 * 左侧目录树。
 *
 * 设计约束（避免与主列表互相触发的死循环）：
 *   树点击 → onOpen(key) → main.loadDir(key) → 完成后调 setCurrent(key)
 *   setCurrent 只更新树自身的展开与高亮，**绝不回调 onOpen**。
 *
 * 数据来源是独立的 s3:listDirs（只取 CommonPrefixes），不复用 s3:list：
 * 后者会把文件一起拉回来，万级目录下纯属浪费。
 */

import { esc } from './util.js';
import { fileIconHtml } from './fileicon.js';

const LOADING = Symbol('loading');
const MIN_W = 160;
const MAX_W = 640;

export function createTree({ panel, body, splitter, expandBtn, collapseBtn, refreshBtn, onOpen }) {
  /** key -> { dirs: [{name,key}], truncated, error? } | LOADING */
  const cache = new Map();
  const expanded = new Set(['']);
  let currentKey = '';
  let width = 240;
  let collapsed = false;
  let saveTimer = null;

  /* ---------------- 持久化 ---------------- */

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      window.bridge.uiState.save({
        treeWidth: width,
        treeCollapsed: collapsed,
        treeExpanded: [...expanded],
      });
    }, 250);
  }

  function applyWidth() {
    panel.style.setProperty('--tree-w', width + 'px');
  }

  function applyCollapsed() {
    panel.classList.toggle('collapsed', collapsed);
    expandBtn.classList.toggle('hidden', !collapsed);
  }

  /* ---------------- 数据加载 ---------------- */

  async function ensureLoaded(key) {
    const hit = cache.get(key);
    if (hit && hit !== LOADING) return hit;
    cache.set(key, LOADING);
    try {
      const r = await window.bridge.s3.listDirs(key);
      const val = { dirs: r.dirs || [], truncated: !!r.truncated };
      cache.set(key, val);
      return val;
    } catch (e) {
      const val = { dirs: [], truncated: false, error: String((e && e.message) || e) };
      cache.set(key, val);
      return val;
    }
  }

  /* ---------------- 渲染 ---------------- */

  function rootLabel() {
    return window.__brand || '未连接';
  }

  function nodeHtml(key, name, depth) {
    const isOpen = expanded.has(key);
    const hit = cache.get(key);
    const pad = 6 + depth * 13;
    const loading = hit === LOADING;
    let html = `<div class="tree-node${key === currentKey ? ' current' : ''}${loading ? ' loading' : ''}"`
      + ` data-key="${esc(key)}" style="padding-left:${pad}px">`
      + `<span class="tn-caret${isOpen ? ' open' : ''}" data-toggle="1" title="展开 / 收起">▸</span>`
      + `<span class="tn-icon">${fileIconHtml('dir')}</span>`
      + `<span class="tn-name" title="${esc(name)}">${esc(name)}</span>`
      + '</div>';

    if (!isOpen) return html;

    const childPad = pad + 19;
    if (loading) return html + `<div class="tree-empty" style="padding-left:${childPad}px">加载中…</div>`;
    if (!hit) return html;
    if (hit.error) return html + `<div class="tree-error" style="padding-left:${childPad}px">${esc(hit.error)}</div>`;
    if (!hit.dirs.length) return html + `<div class="tree-empty" style="padding-left:${childPad}px">无子目录</div>`;

    for (const d of hit.dirs) html += nodeHtml(d.key, d.name, depth + 1);
    if (hit.truncated) {
      html += `<div class="tree-empty" style="padding-left:${childPad}px">仅显示前 500 个目录</div>`;
    }
    return html;
  }

  function render({ scroll = false } = {}) {
    body.innerHTML = nodeHtml('', rootLabel(), 0);
    if (scroll) {
      const cur = body.querySelector('.tree-node.current');
      if (cur) cur.scrollIntoView({ block: 'nearest' });
    }
  }

  /* ---------------- 展开 / 收起 ---------------- */

  async function toggle(key) {
    if (expanded.has(key)) {
      expanded.delete(key);
      render();
      persist();
      return;
    }
    expanded.add(key);
    render(); // 先出「加载中」
    await ensureLoaded(key);
    render();
    persist();
  }

  /* ---------------- 对外接口 ---------------- */

  /** 高亮并展开到目标目录；只改树自身状态，不触发导航 */
  async function setCurrent(dir) {
    currentKey = String(dir || '');
    const parts = currentKey.split('/').filter(Boolean);
    const chain = [''];
    let acc = '';
    for (const p of parts) {
      acc = acc ? acc + '/' + p : p;
      chain.push(acc);
    }
    let changed = false;
    for (const k of chain) {
      if (!expanded.has(k)) { expanded.add(k); changed = true; }
      await ensureLoaded(k); // 已缓存则同步返回
    }
    render({ scroll: true });
    if (changed) persist();
  }

  /** 丢掉某节点（含其子树）的缓存；key 为空表示整棵树 */
  async function refresh(key = '') {
    if (!key) {
      cache.clear();
    } else {
      const pref = key + '/';
      for (const k of [...cache.keys()]) {
        if (k === key || k.startsWith(pref)) cache.delete(k);
      }
    }
    // 按层级从浅到深重新拉取仍处于展开态的节点
    const open = [...expanded].sort((a, b) => a.length - b.length);
    for (const k of open) await ensureLoaded(k);
    render();
  }

  /* ---------------- 事件 ---------------- */

  function bind() {
    body.addEventListener('click', async (e) => {
      const node = e.target.closest('.tree-node');
      if (!node) return;
      const key = node.dataset.key || '';
      if (e.target.classList.contains('tn-caret')) {
        await toggle(key);
        return;
      }
      if (key !== currentKey) onOpen(key);
    });

    collapseBtn.addEventListener('click', () => {
      collapsed = true;
      applyCollapsed();
      persist();
    });
    expandBtn.addEventListener('click', () => {
      collapsed = false;
      applyCollapsed();
      persist();
    });
    refreshBtn.addEventListener('click', () => refresh(''));

    // 拖拽改宽
    let dragging = false;
    let startX = 0;
    let startW = 0;
    splitter.addEventListener('mousedown', (e) => {
      dragging = true;
      startX = e.clientX;
      startW = panel.getBoundingClientRect().width;
      document.body.classList.add('resizing');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      width = Math.max(MIN_W, Math.min(MAX_W, startW + (e.clientX - startX)));
      applyWidth();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('resizing');
      persist();
    });
  }

  /* ---------------- 初始化 ---------------- */

  async function init() {
    let st = null;
    try {
      st = await window.bridge.uiState.get();
    } catch { /* 读不到就用默认值 */ }
    width = Math.max(MIN_W, Math.min(MAX_W, (st && st.treeWidth) || 240));
    collapsed = !!(st && st.treeCollapsed);
    if (st && Array.isArray(st.treeExpanded) && st.treeExpanded.length) {
      expanded.clear();
      // 根节点必须始终可展开
      expanded.add('');
      for (const k of st.treeExpanded) if (typeof k === 'string') expanded.add(k);
    }
    applyWidth();
    applyCollapsed();
    bind();

    render();
    const open = [...expanded].sort((a, b) => a.length - b.length);
    for (const k of open) await ensureLoaded(k);
    render();
  }

  return { init, setCurrent, refresh, render };
}
