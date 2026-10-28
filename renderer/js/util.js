/** 通用工具：格式化、toast、弹窗、右键菜单、SVG 图标。 */

export function fmtBytes(n) {
  if (n === null || n === undefined || n < 0) return '—';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i];
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------------- toast ---------------- */
export function toast(msg, type = '') {
  const root = document.getElementById('toastRoot');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, 2600);
}

/* ---------------- 通用弹窗 ---------------- */
function openModal(html, { onClose } = {}) {
  const root = document.getElementById('modalRoot');
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = html;
  root.appendChild(mask);
  const close = () => { mask.remove(); onClose && onClose(); };
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  return { mask, close };
}

/** 确认框，resolve(true/false) */
export function confirmDialog({ title, text, okText = '确定', danger = false }) {
  return new Promise((resolve) => {
    const { mask, close } = openModal(`
      <div class="modal" style="width:400px">
        <div class="modal-head">
          <div class="modal-title">${esc(title)}</div>
          <button class="modal-close" data-close>✕</button>
        </div>
        <div class="modal-body"><div class="confirm-text">${text}</div></div>
        <div class="modal-foot">
          <button class="btn" data-close>取消</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" id="cfOk">${esc(okText)}</button>
        </div>
      </div>`);
    let done = false;
    mask.querySelector('#cfOk').addEventListener('click', () => { done = true; resolve(true); close(); });
    mask.addEventListener('mousedown', (e) => { if (e.target === mask && !done) resolve(false); });
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { if (!done) resolve(false); }));
  });
}

/** 单行输入框，resolve(text/null) */
export function promptDialog({ title, label, value = '', placeholder = '', okText = '确定' }) {
  return new Promise((resolve) => {
    const { mask, close } = openModal(`
      <div class="modal" style="width:380px">
        <div class="modal-head">
          <div class="modal-title">${esc(title)}</div>
          <button class="modal-close" data-close>✕</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>${esc(label || '')}</label>
            <input type="text" id="piText" value="${esc(value)}" placeholder="${esc(placeholder)}" />
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-close>取消</button>
          <button class="btn primary" id="piOk">${esc(okText)}</button>
        </div>
      </div>`);
    const input = mask.querySelector('#piText');
    let done = false;
    const ok = () => {
      const v = input.value.trim();
      if (!v) return;
      done = true;
      resolve(v);
      close();
    };
    mask.querySelector('#piOk').addEventListener('click', ok);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
    setTimeout(() => { input.focus(); input.select(); }, 30);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask && !done) resolve(null); });
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { if (!done) resolve(null); }));
  });
}

/** 连接配置弹窗。resolve(savedConfigOrPrompted/null) */
export function configDialog(current, { canCancel = true } = {}) {
  return new Promise((resolve) => {
    const c = current || {};
    const { mask, close } = openModal(`
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title">连接配置</div>
          ${canCancel ? '<button class="modal-close" data-close>✕</button>' : ''}
        </div>
        <div class="modal-body">
          <div class="field">
            <label>Endpoint（S3 兼容地址）</label>
            <input type="text" id="cfEndpoint" value="${esc(c.endpoint || '')}" placeholder="https://s3.zw2.obs.yiqiyun.cn" />
          </div>
          <div class="field-row">
            <div class="field">
              <label>Region</label>
              <input type="text" id="cfRegion" value="${esc(c.region || '')}" placeholder="zw2" />
            </div>
            <div class="field">
              <label>Bucket</label>
              <input type="text" id="cfBucket" value="${esc(c.bucket || '')}" placeholder="my-bucket" />
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Access Key</label>
              <input type="text" id="cfAk" value="${esc(c.accessKey || '')}" />
            </div>
            <div class="field">
              <label>Secret Key</label>
              <input type="password" id="cfSk" value="${esc(c.secretKey || '')}" />
            </div>
          </div>
          <div class="field">
            <label>子目录前缀（可选，只关注该子目录内容）</label>
            <input type="text" id="cfPrefix" value="${esc(c.prefix || '')}" placeholder="例如：team-a/docs" />
            <div class="hint">客户端只展示与操作此子目录下的对象，与其他内容隔离。</div>
          </div>
          <label class="checkbox-row"><input type="checkbox" id="cfVerify" ${c.verifySSL !== false ? 'checked' : ''} /> 校验 SSL 证书（私有部署自签证书时取消勾选）</label>
          <div class="test-result" id="cfResult"></div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="cfTest">测试连接</button>
          <span style="flex:1"></span>
          ${canCancel ? '<button class="btn" data-close>取消</button>' : ''}
          <button class="btn primary" id="cfSave">保存</button>
        </div>
      </div>`);

    const $ = (id) => mask.querySelector(id);
    const collect = () => ({
      endpoint: $('#cfEndpoint').value.trim(),
      region: $('#cfRegion').value.trim(),
      bucket: $('#cfBucket').value.trim(),
      accessKey: $('#cfAk').value.trim(),
      secretKey: $('#cfSk').value,
      prefix: $('#cfPrefix').value.trim(),
      verifySSL: $('#cfVerify').checked,
    });

    let done = false;
    const finish = (val) => { done = true; resolve(val); close(); };

    $('#cfTest').addEventListener('click', async () => {
      const btn = $('#cfTest');
      const res = $('#cfResult');
      btn.disabled = true;
      res.className = 'test-result';
      res.textContent = '正在连接…';
      try {
        const r = await window.bridge.s3.test(collect());
        res.className = 'test-result ' + (r.ok ? 'ok' : 'bad');
        res.textContent = r.message;
      } catch (e) {
        res.className = 'test-result bad';
        res.textContent = e.message || String(e);
      }
      btn.disabled = false;
    });

    $('#cfSave').addEventListener('click', async () => {
      const cfg = collect();
      if (!cfg.endpoint || !cfg.bucket) {
        const res = $('#cfResult');
        res.className = 'test-result bad';
        res.textContent = 'Endpoint 与 Bucket 为必填项';
        return;
      }
      const saved = await window.bridge.config.save(cfg);
      finish({ saved: true, config: saved });
    });

    if (canCancel) {
      mask.addEventListener('mousedown', (e) => { if (e.target === mask && !done) finish(null); });
      mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { if (!done) finish(null); }));
    }
  });
}

/* ---------------- 右键菜单 ---------------- */

// 当前的「点击外部即关闭」监听器。每次弹菜单前先卸掉上一份，
// 否则多次弹菜单会累积监听器，一次外部点击就把新菜单关掉。
let outsideHandler = null;

function clearOutsideHandler() {
  if (!outsideHandler) return;
  window.removeEventListener('mousedown', outsideHandler, true);
  window.removeEventListener('blur', outsideHandler);
  outsideHandler = null;
}

export function showContextMenu(x, y, items) {
  closeContextMenu();
  const root = document.getElementById('ctxRoot');
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const it of items) {
    if (it === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
    } else {
      const el = document.createElement('div');
      el.className = 'ctx-item' + (it.danger ? ' danger' : '');
      el.textContent = (it.icon ? it.icon + '  ' : '') + it.label;
      el.addEventListener('click', () => { closeContextMenu(); it.click(); });
      menu.appendChild(el);
    }
  }
  root.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 6) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 6) + 'px';

  // 关键：不能在 mousedown 时无条件关闭。
  // mousedown 早于 click，一旦在这里把 #ctxRoot 清空，菜单项节点已被移除，
  // 后续 click 不会派发到它身上 —— 表现就是「菜单能弹出，点任何项都只是消失」。
  // 所以先看落点：点在菜单内就放过，click 才有机会执行。
  outsideHandler = (e) => {
    if (e.type === 'mousedown' && menu.contains(e.target)) return;
    closeContextMenu();
  };
  // 用捕获阶段：即便菜单项内部对 mousedown 做了 stopPropagation，外部点击照样能关闭。
  window.addEventListener('mousedown', outsideHandler, true);
  window.addEventListener('blur', outsideHandler);
}

export function closeContextMenu() {
  clearOutsideHandler();
  const root = document.getElementById('ctxRoot');
  if (root) root.innerHTML = '';
}

/* ---------------- 更新相关弹窗 ---------------- */

/** 发现新版本，resolve('download' | 'later') */
export function updateAvailableDialog({ current, latest }) {
  return new Promise((resolve) => {
    const notes = latest.notes
      ? `<div class="upd-notes">${esc(latest.notes).replace(/\n/g, '<br/>')}</div>`
      : '';
    const { mask, close } = openModal(`
      <div class="modal" style="width:440px">
        <div class="modal-head">
          <div class="modal-title">发现新版本</div>
          <button class="modal-close" data-close>✕</button>
        </div>
        <div class="modal-body">
          <div class="upd-head">
            <span class="upd-ver">v${esc(latest.version)}</span>
            <span class="upd-from">当前 v${esc(current)}</span>
          </div>
          <div class="upd-meta">${esc(latest.channel)} 渠道 · ${esc(latest.platform)} · ${esc(latest.arch)} · ${esc(fmtBytes(latest.size))}${latest.publishedAt ? ' · ' + esc(fmtTime(new Date(latest.publishedAt).toISOString())) : ''}</div>
          ${notes}
          <div class="hint" style="margin-top:12px">下载完成后需手动运行安装包完成升级（程序未做代码签名，系统会弹一次安全提示）。</div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-close>以后再说</button>
          <button class="btn primary" id="updGo">下载更新</button>
        </div>
      </div>`);
    let done = false;
    mask.querySelector('#updGo').addEventListener('click', () => { done = true; resolve('download'); close(); });
    mask.addEventListener('mousedown', (e) => { if (e.target === mask && !done) resolve('later'); });
    mask.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { if (!done) resolve('later'); }));
  });
}

/** 下载进度弹窗，返回 { setProgress, setDetail, close } */
export function updateProgressDialog({ version, onCancel }) {
  const { mask, close } = openModal(`
    <div class="modal" style="width:420px">
      <div class="modal-head"><div class="modal-title">下载更新 v${esc(version)}</div></div>
      <div class="modal-body">
        <div class="pbar" style="height:8px"><div class="pbar-fill" id="updBar"></div></div>
        <div class="upd-progress-line"><span id="updDetail">准备中…</span><span id="updPct">0%</span></div>
      </div>
      <div class="modal-foot"><button class="btn" id="updCancel">取消</button></div>
    </div>`);
  mask.querySelector('#updCancel').addEventListener('click', () => {
    mask.querySelector('#updDetail').textContent = '正在取消…';
    mask.querySelector('#updCancel').disabled = true;
    onCancel && onCancel();
  });
  return {
    setProgress(p) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(p && p.pct) || 0)));
      mask.querySelector('#updBar').style.width = pct + '%';
      mask.querySelector('#updPct').textContent = pct + '%';
      mask.querySelector('#updDetail').textContent =
        `${fmtBytes(p.received)}${p.total ? ' / ' + fmtBytes(p.total) : ''}`;
    },
    setDetail(text) { mask.querySelector('#updDetail').textContent = text; },
    close,
  };
}

/* ---------------- SVG/字符图标 ---------------- */
export const ICONS = {
  dir: '📁',
  file: '📄',
  upload: '⇧',
  download: '⤓',
};
