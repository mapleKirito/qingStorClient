/**
 * 文件类型图标：扩展名 → 类别 → 内联 SVG。
 *
 * 为什么不用 emoji：📁 / 📄 在 Windows（Segoe UI Emoji）与 macOS（Apple Color Emoji）
 * 上字形和大小都不一致，也没法按类别着色。SVG 走 currentColor，颜色由 CSS 的
 * `.file-ic.<category>` 决定，深色主题下可控。
 *
 * 图标本体是 index.html 里 #iconDefs 的 <symbol>，这里只输出 <use> 引用：
 * 同一文档内联 SVG 不受 CSP 的 img-src 限制，也不必把每个图标路径重复进 JS。
 */

/** 类别清单（顺序即 smoke 测试的期望顺序） */
export const CATEGORIES = [
  'dir', 'image', 'video', 'audio', 'doc', 'sheet', 'slide',
  'pdf', 'archive', 'code', 'text', 'exe', 'font', 'other',
];

const EXT = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'avif', 'psd', 'raw', 'cr2', 'nef'],
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'rmvb', 'rm', '3gp'],
  audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'ape', 'opus', 'aiff', 'mid'],
  doc: ['doc', 'docx', 'rtf', 'odt', 'pages', 'wps', 'dot', 'dotx'],
  sheet: ['xls', 'xlsx', 'csv', 'tsv', 'ods', 'numbers', 'et', 'xlsm'],
  slide: ['ppt', 'pptx', 'key', 'odp', 'dps', 'pps', 'ppsx'],
  pdf: ['pdf'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'iso', 'cab', 'lz4', 'zst', 'zipx'],
  code: [
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'json', 'jsonc', 'html', 'htm', 'xhtml',
    'css', 'scss', 'sass', 'less', 'styl', 'java', 'py', 'go', 'rs', 'c', 'cc', 'cpp', 'h',
    'hpp', 'cs', 'php', 'rb', 'swift', 'kt', 'kts', 'scala', 'sh', 'bash', 'zsh', 'fish',
    'bat', 'cmd', 'ps1', 'psm1', 'sql', 'yml', 'yaml', 'xml', 'toml', 'ini', 'cfg', 'conf',
    'gradle', 'cmake', 'lua', 'pl', 'r', 'dart', 'proto', 'graphql', 'gql', 'env',
  ],
  text: ['txt', 'md', 'markdown', 'log', 'rst', 'tex', 'nfo', 'srt', 'ass', 'vtt', 'csv.txt', 'diff', 'patch'],
  exe: ['exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'apk', 'ipa', 'snap'],
  font: ['ttf', 'otf', 'woff', 'woff2', 'eot', 'ttc', 'fon'],
};

/** 无扩展名或点开头的已知文件（顺序在扩展名之后） */
const NAME_MAP = {
  dockerfile: 'code',
  makefile: 'code',
  'cmakelists.txt': 'code',
  '.gitignore': 'code',
  '.gitattributes': 'code',
  '.gitmodules': 'code',
  '.npmrc': 'code',
  '.editorconfig': 'code',
  '.env': 'code',
  license: 'text',
  'license.txt': 'text',
  readme: 'text',
  'readme.md': 'text',
  changelog: 'text',
};

/** 扩展名 → 类别，建表一次，查询 O(1) */
const EXT_MAP = new Map();
for (const cat of Object.keys(EXT)) {
  for (const ext of EXT[cat]) EXT_MAP.set(ext, cat);
}

/**
 * 判定类别。
 * 顺序：目录 → 扩展名 → 文件名特征 → other（无扩展名不报错）
 */
export function categoryOf(name, isDir = false) {
  if (isDir) return 'dir';
  const base = String(name || '').split('/').pop();
  if (!base) return 'other';

  const m = /\.([A-Za-z0-9]+)$/.exec(base);
  if (m) {
    const cat = EXT_MAP.get(m[1].toLowerCase());
    if (cat) return cat;
  }
  const named = NAME_MAP[base.toLowerCase()];
  if (named) return named;
  return 'other';
}

/** 输出一行可用的图标标记；入参可以是类别名，也可以是 { name, isDir } */
export function fileIconHtml(input) {
  const cat = typeof input === 'string' ? input : categoryOf(input && input.name, !!(input && input.isDir));
  const safe = CATEGORIES.includes(cat) ? cat : 'other';
  return `<svg class="fic" viewBox="0 0 24 24" aria-hidden="true"><use href="#ico-${safe}"></use></svg>`;
}
