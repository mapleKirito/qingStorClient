'use strict';

/**
 * 界面状态持久化：userData/ui-state.json
 *
 * 只存「纯界面偏好」——目录树宽度、折叠状态、展开的节点。
 * 与 config.json（连接配置）、update-channel.json（更新渠道）分开：
 * 前者是业务数据，后者是更新偏好，这里是窗口布局，三者互不影响，
 * 清配置、换渠道都不该把窗口布局重置掉。
 */

const path = require('node:path');
const fs = require('node:fs');

const TREE_MIN = 160;
const TREE_MAX = 640;
const EXPANDED_MAX = 300;

function defaults() {
  return {
    treeWidth: 240,
    treeCollapsed: false,
    treeExpanded: [''], // 展开的目录 key，根节点是 ''，默认只展开根
  };
}

function clampWidth(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return defaults().treeWidth;
  return Math.min(TREE_MAX, Math.max(TREE_MIN, Math.round(n)));
}

class UiStateStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'ui-state.json');
    this.data = defaults();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        treeWidth: clampWidth(raw.treeWidth),
        treeCollapsed: raw.treeCollapsed === true,
        // 展开集合只保留字符串、限长，避免脏文件把渲染拖死
        treeExpanded: Array.isArray(raw.treeExpanded)
          ? raw.treeExpanded.filter((k) => typeof k === 'string').slice(0, EXPANDED_MAX)
          : defaults().treeExpanded,
      };
    } catch {
      this.data = defaults();
    }
    return this.data;
  }

  /** 局部更新：只认已知字段，未知字段忽略 */
  save(partial) {
    const next = { ...this.data };
    if (partial && partial.treeWidth !== undefined) next.treeWidth = clampWidth(partial.treeWidth);
    if (partial && partial.treeCollapsed !== undefined) next.treeCollapsed = partial.treeCollapsed === true;
    if (partial && Array.isArray(partial.treeExpanded)) {
      next.treeExpanded = partial.treeExpanded
        .filter((k) => typeof k === 'string')
        .slice(0, EXPANDED_MAX);
    }
    this.data = next;

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(next, null, 2), 'utf8');
    } catch (e) {
      // 布局存不下来不该影响主流程：磁盘满 / 权限问题都只降级为「本次会话有效」
      console.warn('[ui-state] 写入失败：', e.message);
    }
    return this.data;
  }
}

module.exports = { UiStateStore };
