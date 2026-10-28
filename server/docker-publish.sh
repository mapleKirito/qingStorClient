#!/usr/bin/env bash
# =====================================================================
# qingStorClient 更新服务 —— 一次构建，同时推送到 Docker Hub 与阿里云 ACR
#
#   ./docker-publish.sh                  构建并推送（默认两家都推）
#   ./docker-publish.sh --dry-run        只打印将要打的 tag 与推送地址，不动任何东西
#   ./docker-publish.sh --registry hub   只推 Docker Hub
#   ./docker-publish.sh --registry acr   只推阿里云 ACR
#   ./docker-publish.sh --login          先 docker login 再推（两家依次弹输入）
#   ./docker-publish.sh --platform linux/amd64,linux/arm64   多架构（走 buildx）
#   ./docker-publish.sh --no-build       不构建，把本地已有镜像重新打 tag 推上去
#   ./docker-publish.sh --no-push        只构建并打 tag，不推送（本地验证 / 配合 compose）
#   ./docker-publish.sh --help, -h
#
# 相比参考项目那套（build-push-dockerhub.sh + build-push-acr.sh）的改动：
#   · 合并成一个脚本：ACR 不再要求「先跑 Docker Hub 那套构建」，
#     本地只 build 一次，然后按需给两家分别打 tag 并推送
#   · tag 自动识别：版本号取 server/package.json，并自动与 git 上 HEAD 的
#     服务端标签（server-vX.Y.Z）互相校验，两者不一致直接拒绝 ——
#     避免出现「标签写着 1.2.1、镜像却是 1.2.0」这种对不上的情况。
#     注意只认 server-v* 前缀：客户端发版标签 v* 属于另一套号，不参与校验。
#   · 正式版自动附带 :latest，预发布版（含 -）默认不动 latest
#   · 多架构走 buildx，一次 build 直接推到所有仓库，不做本地二次打 tag
#
# 版本号唯一来源：本目录的 package.json（服务端版本，与客户端版本是两回事）
# =====================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PKG_FILE="$SCRIPT_DIR/package.json"

# ---------------------------------------------------------------- 仓库配置
# 命名空间与地域跟参考项目 myApiTools 保持一致：myzhouye + cn-hangzhou。
#   参考项目：myzhouye/myapitools-server
#             registry.cn-hangzhou.aliyuncs.com/myzhouye/myapitools-server
# 仓库名必须不同（镜像内容不同），沿用参考项目的命名式 <项目名>-server。
# Docker 要求仓库名全小写。
IMAGE_NAME="${IMAGE_NAME:-qingstorclient-server}"
HUB_REPO="${HUB_REPO:-myzhouye/qingstorclient-server}"
ACR_REPO="${ACR_REPO:-registry.cn-hangzhou.aliyuncs.com/myzhouye/qingstorclient-server}"

# ---------------------------------------------------------------- 开关默认值
REGISTRY_SEL='all'      # all | hub | acr
DRY_RUN=0
ASSUME_YES=0
FORCE=0                 # 跳过「同一版本已存在」的检查
NO_LATEST=0             # 任何情况都不动 latest
FORCE_LATEST=0          # 预发布版也更新 latest
NO_BUILD=0              # 不构建，直接推本地已有镜像
NO_PUSH=0               # 只构建并打 tag，不推送
NO_CACHE=0              # docker build --no-cache
PULL_BASE=0             # docker build --pull
DO_LOGIN=0
FLOATING=0              # 额外打 MAJOR.MINOR 与 MAJOR 浮动 tag
PLATFORMS=''            # 非空则走 buildx 多架构
VERSION_OVERRIDE=''
EXTRA_TAGS=()

# ---------------------------------------------------------------- 输出
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_RESET=''; C_DIM=''; C_BOLD=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_CYAN=''
fi

info() { printf '%s\n' "$*"; }
dim()  { printf '%s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }
hr()   { dim '  ------------------------------------------------------------'; }

usage() {
  cat <<'EOF'
qingStorClient 更新服务 —— 构建镜像并推送到 Docker Hub / 阿里云 ACR

  ./docker-publish.sh                      构建并推送（两家都推，正式版带 latest）
  ./docker-publish.sh --dry-run            只打印 tag 计划与推送地址，不做任何改动
  ./docker-publish.sh --registry hub|acr|all
  ./docker-publish.sh --login              先登录（两家依次提示输入账号密码）
  ./docker-publish.sh --no-build           不构建，把本地已有镜像重新打 tag 推上去
  ./docker-publish.sh --no-push            只构建并打 tag，不推送（本地验证 / 配合 compose）
  ./docker-publish.sh --platform linux/amd64,linux/arm64
                                           多架构构建（走 buildx，直接推远端）
  ./docker-publish.sh --no-cache --pull    构建时不使用缓存 / 拉取最新基础镜像
  ./docker-publish.sh --version 2.1.0      手工指定版本（跳过自动识别）
  ./docker-publish.sh --tag beta           额外再打一个 :beta
  ./docker-publish.sh --floating           正式版额外打 :2.0 与 :2 两个浮动 tag
  ./docker-publish.sh --no-latest          只推版本号，不动 latest
  ./docker-publish.sh --latest             预发布版也更新 latest
  ./docker-publish.sh --force, -f          同一版本已存在时直接覆盖，不再询问
  ./docker-publish.sh --yes, -y            不提问；有冲突直接判失败（CI 用）
  ./docker-publish.sh --help, -h

环境变量（都有默认值，一般不用动）：
  IMAGE_NAME   本地镜像名，默认 qingstorclient-server
  HUB_REPO     Docker Hub 仓库，默认 myzhouye/qingstorclient-server
  ACR_REPO     ACR 仓库，默认 registry.cn-hangzhou.aliyuncs.com/myzhouye/qingstorclient-server
               （命名空间与地域同参考项目 myApiTools 的 myapitools-server）

tag 自动识别规则（版本号唯一来源：本目录的 package.json）：

  1. 若当前 HEAD 上有服务端标签 server-vX.Y.Z，就用它，并与 package.json 交叉校验；
     两者不一致直接报错。客户端发版标签 vX.Y.Z 不参与，两者是独立的两套版本号。
  2. 否则用 package.json 的 version。
  3. 正式版 2.0.1       → :2.0.1 和 :latest
     预发布 2.1.0-beta.1 → 只打 :2.1.0-beta.1（不动 latest，除非加 --latest）

命名空间已按参考项目 myApiTools 设为 myzhouye（ACR 地域 cn-hangzhou），
一般不用改；要临时换仓库用环境变量覆盖：
  HUB_REPO=someone/qs-server ACR_REPO=registry.cn-beijing.aliyuncs.com/someone/qs-server ./docker-publish.sh
EOF
  exit 0
}

# ------------------------------------------------------------ 参数解析
need_arg() {
  [ $# -ge 2 ] && [ -n "${2:-}" ] || die "参数 $1 需要值（--help 看用法）"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --registry) need_arg "$@"; REGISTRY_SEL="$2"; shift 2 ;;
    --hub)      REGISTRY_SEL='hub'; shift ;;
    --acr)      REGISTRY_SEL='acr'; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --force|-f) FORCE=1; shift ;;
    --no-latest) NO_LATEST=1; shift ;;
    --latest)   FORCE_LATEST=1; shift ;;
    --no-build) NO_BUILD=1; shift ;;
    --no-push)  NO_PUSH=1; shift ;;
    --no-cache) NO_CACHE=1; shift ;;
    --pull)     PULL_BASE=1; shift ;;
    --login)    DO_LOGIN=1; shift ;;
    --floating) FLOATING=1; shift ;;
    --platform) need_arg "$@"; PLATFORMS="$2"; shift 2 ;;
    --version)  need_arg "$@"; VERSION_OVERRIDE="$2"; shift 2 ;;
    --tag)      need_arg "$@"; EXTRA_TAGS+=("$2"); shift 2 ;;
    --help|-h)  usage ;;
    *) die "未知参数：$1（--help 看用法）" ;;
  esac
done

case "$REGISTRY_SEL" in
  all|hub|acr) : ;;
  *) die "--registry 只能是 all / hub / acr，收到：$REGISTRY_SEL" ;;
esac

# ------------------------------------------------------------ 版本号读写
read_pkg_version() {
  local v=''
  if command -v node >/dev/null 2>&1; then
    v="$(cd "$SCRIPT_DIR" && node -p "require('./package.json').version" 2>/dev/null || true)"
    case "$v" in undefined|null) v='' ;; esac
  fi
  [ -n "$v" ] || v="$(awk '
    !found && match($0, /"version"[[:space:]]*:[[:space:]]*"[^"]+"/) {
      s = substr($0, RSTART, RLENGTH)
      sub(/^"version"[[:space:]]*:[[:space:]]*"/, "", s)
      sub(/"$/, "", s)
      print s; found = 1; exit
    }' "$PKG_FILE")"
  printf '%s' "$v"
}

# 写回 package.json 里的 version。
# 用 node 做「只替换那一个字符串」的定点改写，而不是整体重新序列化 ——
# 后者会把用户的缩进、字段顺序、换行风格（本仓库工作区是 CRLF）全部重排，
# 一个改版本号的提交能带出几十行无意义 diff。
set_pkg_version() {
  local new="$1" tmp="$PKG_FILE.tmp"
  if command -v node >/dev/null 2>&1; then
    if ! node -e '
      const fs = require("node:fs");
      const [file, ver] = process.argv.slice(1);
      const src = fs.readFileSync(file, "utf8");
      const re = /("version"\s*:\s*")[^"]*(")/;
      if (!re.test(src)) process.exit(3);
      fs.writeFileSync(file, src.replace(re, (_m, a, b) => a + ver + b));
    ' "$PKG_FILE" "$new"; then
      die "在 $PKG_FILE 里找不到 version 字段"
    fi
    return 0
  fi
  # 没有 node 时的兜底（会统一成 LF，可接受）
  if ! awk -v nv="$new" '
        !done && match($0, /"version"[[:space:]]*:[[:space:]]*"[^"]*"/) {
          head = substr($0, 1, RSTART - 1)
          tail = substr($0, RSTART + RLENGTH)
          printf "%s\"version\": \"%s\"%s\n", head, nv, tail
          done = 1; next
        }
        { print }
        END { if (!done) exit 3 }
      ' "$PKG_FILE" > "$tmp"; then
    rm -f "$tmp"; die "在 $PKG_FILE 里找不到 version 字段"
  fi
  cat "$tmp" > "$PKG_FILE"; rm -f "$tmp"
}

is_valid_version() {
  printf '%s' "$1" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$'
}

is_prerelease() {
  case "$1" in *-*) return 0 ;; *) return 1 ;; esac
}

bump_version() {
  local major minor patch
  IFS=. read -r major minor patch <<<"$1"
  patch="${patch%%-*}"
  case "$2" in
    major) major=$((major + 1)); minor=0; patch=0 ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    patch) patch=$((patch + 1)) ;;
    *) die "内部错误：未知的抬升类型 $2" ;;
  esac
  printf '%s.%s.%s' "$major" "$minor" "$patch"
}

# 当前 HEAD 上正好有一个「服务端标签」（server-vX.Y.Z）时返回它（去掉 server-v 前缀），
# 否则返回空。
#
# 为什么必须限定 server-v 前缀：客户端与服务端是两套独立版本号（客户端 0.0.x-dev、
# 服务端 1.2.1），却共用同一个 git 标签空间。如果不加 --match，客户端发版打的
# v0.0.1-dev 会被这里读到、去掉前导 v 变成 0.0.1-dev，再与 server/package.json 的 1.2.1
# 做严格相等校验 —— 必然失败，服务端镜像从此发不出去。
# 限定前缀后，客户端打 v*、服务端打 server-v*，两个版本号互不干扰。
read_git_tag() {
  command -v git >/dev/null 2>&1 || return 0
  local t
  t="$(git -C "$REPO_ROOT" describe --tags --exact-match --match 'server-v*' HEAD 2>/dev/null || true)"
  [ -n "$t" ] || return 0
  printf '%s' "${t#server-v}"
}

# ------------------------------------------------------------ 仓库与 tag
# 镜像仓库名必须是全小写，且第一段若带点则是 registry 域名
validate_repo() {
  local repo="$1" label="$2"
  [ -n "$repo" ] || die "$label 为空"
  # 只看最后一段有没有冒号：registry 带端口（host:5000/ns/name）是合法的，
  # 但 ns/name:tag 这种「自己带了 tag」的写法会让本脚本的 tag 拼接变成两个冒号
  case "${repo##*/}" in
    *:*) die "$label 不能带 tag（脚本自己会加）：$repo" ;;
  esac
  if printf '%s' "$repo" | grep -q '[A-Z]'; then
    die "$label 含大写字母：$repo
    Docker 只接受全小写仓库名，改小写后重试。"
  fi
  case "$repo" in
    *//*|/*|*/) die "$label 格式不对：$repo" ;;
  esac
  case "$repo" in
    */*) : ;;
    *) die "$label 需要是 <命名空间>/<仓库名> 形式：$repo" ;;
  esac
}

host_of() {
  local first="${1%%/*}"
  case "$first" in
    *.*|*:*) printf '%s' "$first" ;;
    *)       printf 'docker.io' ;;
  esac
}

# ------------------------------------------------------------ Docker 可用性
check_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$DRY_RUN" -eq 1 ]; then
      warn '找不到 docker 命令；--dry-run 只做计划，继续'
      return 0
    fi
    die '找不到 docker 命令，请先安装 Docker'
  fi
  if ! docker info >/dev/null 2>&1; then
    if [ "$DRY_RUN" -eq 1 ]; then
      warn 'Docker 没在运行（docker info 失败）；--dry-run 只做计划，继续'
      return 0
    fi
    die 'Docker 没在运行（docker info 失败）。启动 Docker Desktop 后重试'
  fi
}

local_image_exists() {
  command -v docker >/dev/null 2>&1 || return 1
  docker image inspect "$1" >/dev/null 2>&1
}

# 远端是否已经有这个 tag
#   yes / no / unknown（私有仓库、网络不通、未登录都会落到 unknown）
tag_exists() {
  local ref="$1" repo="${1%:*}" tag="${1##*:}" host code
  host="$(host_of "$repo")"
  if [ "$host" = 'docker.io' ]; then
    local repo_path="${repo#*/}" repo_lc
    repo_lc="$(printf '%s' "$repo_path" | tr '[:upper:]' '[:lower:]')"
    if command -v curl >/dev/null 2>&1; then
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
        "https://registry.hub.docker.com/v2/repositories/${repo_lc}/tags/${tag}/" 2>/dev/null || true)"
      case "$code" in
        200) printf 'yes'; return ;;
        404) printf 'no';  return ;;
      esac
    fi
  fi
  if command -v docker >/dev/null 2>&1 \
     && DOCKER_CLI_EXPERIMENTAL=enabled docker manifest inspect "$ref" >/dev/null 2>&1; then
    printf 'yes'
  else
    printf 'unknown'
  fi
}

# ------------------------------------------------------------ 登录
is_logged_in() {
  local host="$1" cfg="${DOCKER_CONFIG:-$HOME/.docker}/config.json"
  [ -f "$cfg" ] || return 1
  # 用了凭据助手时，config.json 里只有 credsStore，看不出具体登录了哪个仓库
  if grep -q '"credsStore"' "$cfg" 2>/dev/null; then return 0; fi
  if [ "$host" = 'docker.io' ]; then
    grep -qE '"(https://index\.docker\.io/v1/|docker\.io)"' "$cfg" 2>/dev/null
  else
    grep -q "\"${host}\"" "$cfg" 2>/dev/null
  fi
}

login_hint_for() {
  local host; host="$(host_of "$1")"
  if [ "$host" = 'docker.io' ]; then
    printf 'docker login'
  else
    printf 'docker login %s' "$host"
  fi
}

do_login_all() {
  local host
  for host in $(printf '%s\n' "${REPOS[@]}" | while read -r r; do host_of "$r"; done | sort -u); do
    if [ "$host" = 'docker.io' ]; then
      info ''
      info "  ${C_BOLD}登录 Docker Hub${C_RESET}（用户名 = 你的 Docker ID，不是邮箱）"
      run docker login || warn 'Docker Hub 登录失败，后续推送可能被拒'
    else
      info ''
      info "  ${C_BOLD}登录 ${host}${C_RESET}（用户名/密码用阿里云容器镜像服务的凭证）"
      run docker login "$host" || warn "${host} 登录失败，后续推送可能被拒"
    fi
  done
}

# ------------------------------------------------------------ 执行
run() {
  printf '%s$%s %s\n' "$C_CYAN" "$C_RESET" "$*"
  if [ "$DRY_RUN" -eq 0 ]; then
    "$@"
  fi
}

push_failed_report() {
  local ref="$1" reason="$2" hint="$3"
  printf '\n' >&2
  err "没有推送到远端：${ref}"
  info ''
  warn '本地镜像已经构建好了，但远端拿不到它'
  dim  '  部署端 docker compose pull 会报 not found 或拉到旧内容 —— 原因就是这次没推上去。' >&2
  info ''
  dim  "  失败原因：${reason}" >&2
  dim  "  怎么办：${hint}" >&2
  info ''
}

push_image() {
  local ref="$1" out
  if [ "$NO_PUSH" -eq 1 ]; then
    dim "  跳过推送（--no-push）：${ref}"
    PUSHED+=("${ref}（--no-push 未推送）")
    return 0
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '%s$%s docker push %s\n' "$C_CYAN" "$C_RESET" "$ref"
    PUSHED+=("$ref（预演，未实际推送）")
    return 0
  fi
  if ! out="$(docker push "$ref" 2>&1)"; then
    printf '%s\n' "$out" >&2
    if printf '%s' "$out" | grep -qiE 'denied|unauthorized|authentication required|access token|no basic auth'; then
      push_failed_report "$ref" \
        '推送被拒绝（没登录，或当前账号对这个仓库没有写权限）' \
        "先登录再重跑：$(login_hint_for "$ref")"
    else
      push_failed_report "$ref" \
        '推送失败（网络中断 / registry 不可达 / Docker 异常）' \
        '确认网络与 Docker 状态后重跑本脚本'
    fi
    return 1
  fi
  printf '%s\n' "$out" | tail -n 2
  ok "已推送 ${ref}"
  PUSHED+=("$ref")
}

# ------------------------------------------------------------ 冲突处理
ask() {
  local reply=''
  printf '%s ' "$*" >&2
  read -r reply || reply=''
  printf '%s' "$reply"
}

need_tty() {
  if [ "$ASSUME_YES" -eq 0 ] && [ ! -t 0 ]; then
    die '当前不是交互式终端，无法询问。请改用 --yes（有冲突则失败）或 --force（直接覆盖）'
  fi
}

CONFLICT_ACTION=''
resolve_conflict() {
  local short="$1" existing="$2" patch_next minor_next major_next choice manual
  need_tty
  patch_next="$(bump_version "$short" patch)"
  minor_next="$(bump_version "$short" minor)"
  major_next="$(bump_version "$short" major)"

  if [ "$ASSUME_YES" -eq 1 ]; then
    err "${existing} 已经存在"
    dim '  --yes 不会替你决定覆盖。要重新发布请显式加 --force，或先升版本号。' >&2
    CONFLICT_ACTION='abort'
    return 1
  fi

  printf '\n' >&2
  warn "${existing} 在远端已经存在了"
  dim  '  正式版发布出去内容就不再变化，同一个 tag 带新内容再推一次会直接覆盖它，' >&2
  dim  '  正在用这个版本的人下次 pull 会拿到不一样的镜像。' >&2
  dim  '  只是日常构建、本来就要反复覆盖的话，把版本号改成预发布版即可（如 2.1.0-dev）。' >&2
  printf '\n' >&2
  printf '    [1] 升 patch  → %s\n' "$patch_next" >&2
  printf '    [2] 升 minor  → %s\n' "$minor_next" >&2
  printf '    [3] 升 major  → %s\n' "$major_next" >&2
  printf '    [4] 手动输入版本号\n' >&2
  printf '    [5] 保持 %s，强制覆盖远端\n' "$short" >&2
  printf '    [0] 中止\n' >&2
  printf '\n' >&2

  if [ "$DRY_RUN" -eq 1 ]; then
    dim '  --dry-run 下不会改写 package.json：这里只说明有冲突，' >&2
    dim '  请手动改好版本号后重跑，或去掉 --dry-run 让脚本代为抬版。' >&2
    CONFLICT_ACTION='abort'
    return 1
  fi

  while true; do
    choice="$(ask '  请选择 [1-5, 0]:')"
    case "$choice" in
      1) set_pkg_version "$patch_next"; CONFLICT_ACTION='bumped'; return 0 ;;
      2) set_pkg_version "$minor_next"; CONFLICT_ACTION='bumped'; return 0 ;;
      3) set_pkg_version "$major_next"; CONFLICT_ACTION='bumped'; return 0 ;;
      5) CONFLICT_ACTION='force'; return 0 ;;
      0|'') CONFLICT_ACTION='abort'; return 1 ;;
      4)
        manual="$(ask '  输入新版本号（形如 1.2.3，可带 -beta.1）:')"
        if ! is_valid_version "$manual"; then
          err "版本号格式不对：$manual"
          continue
        fi
        set_pkg_version "$manual"
        CONFLICT_ACTION='bumped'
        return 0
        ;;
      *) err '请输入 1 / 2 / 3 / 4 / 5 / 0' ;;
    esac
  done
}

# ------------------------------------------------------------ 主流程
main() {
  [ -f "$PKG_FILE" ] || die "找不到 $PKG_FILE"
  [ -f "$SCRIPT_DIR/Dockerfile" ] || die "找不到 $SCRIPT_DIR/Dockerfile"

  # ---- 仓库列表 ----
  REPOS=()
  case "$REGISTRY_SEL" in
    hub) REPOS=("$HUB_REPO") ;;
    acr) REPOS=("$ACR_REPO") ;;
    all) REPOS=("$HUB_REPO" "$ACR_REPO") ;;
  esac
  local r
  for r in "${REPOS[@]}"; do validate_repo "$r" '镜像仓库名'; done
  # 两家配成同一个地址时去重，避免重复 build/push
  if [ "${#REPOS[@]}" -eq 2 ] && [ "${REPOS[0]}" = "${REPOS[1]}" ]; then
    REPOS=("${REPOS[0]}")
  fi

  check_docker

  # ---- 版本号自动识别 ----
  local pkg_version git_tag version version_source
  pkg_version="$(read_pkg_version)"
  [ -n "$pkg_version" ] || die "读不出 $PKG_FILE 里的 version"
  is_valid_version "$pkg_version" || die "package.json 里的版本号不是 x.y.z 形式：$pkg_version"

  git_tag="$(read_git_tag)"
  if [ -n "$VERSION_OVERRIDE" ]; then
    version="$VERSION_OVERRIDE"
    version_source='--version 手工指定'
    is_valid_version "$version" || die "手工指定的版本号不合法：$version"
    [ "$version" = "$pkg_version" ] || warn "手工指定的 ${version} 与 package.json 的 ${pkg_version} 不一致，按 ${version} 发布"
  elif [ -n "$git_tag" ]; then
    version="$git_tag"
    version_source='git HEAD 上的标签'
    if [ "$git_tag" != "$pkg_version" ]; then
      err "服务端标签 server-v${git_tag} 与 package.json 的版本 ${pkg_version} 不一致"
      dim "  这两个必须严格相等，否则会出现「标签写着 ${git_tag}、镜像却是 ${pkg_version}」这种对不上的情况。" >&2
      dim "  要么把 package.json 改成 ${git_tag}，要么 git tag -d server-v${git_tag} 后重新打。" >&2
      exit 1
    fi
  else
    version="$pkg_version"
    version_source='package.json（HEAD 上没有 git 标签）'
  fi

  local is_pre=0
  if is_prerelease "$version"; then is_pre=1; fi

  # ---- tag 集合 ----
  TAGS=("$version")
  if [ "$NO_LATEST" -eq 1 ]; then
    :
  elif [ "$FORCE_LATEST" -eq 1 ]; then
    TAGS+=('latest')
  elif [ "$is_pre" -eq 0 ]; then
    TAGS+=('latest')
  fi
  if [ "$FLOATING" -eq 1 ] && [ "$is_pre" -eq 0 ]; then
    local mm="${version%.*}" mj="${version%%.*}"
    TAGS+=("$mm" "$mj")
  fi
  local t
  for t in "${EXTRA_TAGS[@]+"${EXTRA_TAGS[@]}"}"; do
    case "$t" in
      ''|*[!a-zA-Z0-9._-]*) die "非法 tag：$t（只允许字母数字和 . _ -）" ;;
    esac
    TAGS+=("$t")
  done
  # 去重并保持顺序
  local -a uniq=()
  local seen=' '
  for t in "${TAGS[@]}"; do
    case "$seen" in *" $t "*) continue ;; esac
    seen="$seen$t "
    uniq+=("$t")
  done
  TAGS=("${uniq[@]}")

  # ---- 横幅 ----
  info ''
  info "  ${C_BOLD}qingStorClient 更新服务镜像 · 构建 & 推送${C_RESET}"
  hr
  info "  版本        : ${C_BOLD}${version}${C_RESET}  ($( [ "$is_pre" -eq 1 ] && echo '预发布版' || echo '正式版' ))"
  info "  版本来源    : ${version_source}"
  info "  镜像 tag    : ${TAGS[*]}"
  info "  推送目标    : ${REGISTRY_SEL}$( [ "$NO_PUSH" -eq 1 ] && echo '（--no-push：只构建不推送）' )"
  for r in "${REPOS[@]}"; do info "                ${r}"; done
  info "  构建上下文  : ${SCRIPT_DIR}"
  [ -n "$PLATFORMS" ] && info "  多架构      : ${PLATFORMS}（buildx，构建即推送）"
  [ "$NO_BUILD" -eq 1 ] && dim '  跳过构建    : --no-build，推本地已有镜像'
  [ "$NO_PUSH" -eq 1 ] && dim '  跳过推送    : --no-push，只构建并打 tag'
  [ "$DRY_RUN" -eq 1 ] && dim '  模式        : --dry-run（不会 build / tag / push）'
  hr

  # ---- 登录 ----
  if [ "$DO_LOGIN" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
      dim '  --dry-run：跳过 --login 的交互登录'
    else
      do_login_all
    fi
  elif [ "$NO_PUSH" -eq 0 ]; then
    local host
    for host in $(for r in "${REPOS[@]}"; do host_of "$r"; done | sort -u); do
      if ! is_logged_in "$host"; then
        warn "看起来没有登录 ${host}，推送可能被拒（要现在登录就加 --login）"
        dim "  $( [ "$host" = 'docker.io' ] && echo 'docker login' || echo "docker login ${host}" )" >&2
      fi
    done
  fi

  # ---- 版本冲突检查 ----
  # --no-push 不推远端，也就不存在「远端已有同版本」的冲突
  local existing='' found_any=0 exists
  local -a conflicts=()
  if [ "$NO_PUSH" -eq 0 ]; then
  for r in "${REPOS[@]}"; do
    exists="$(tag_exists "${r}:${version}")"
    case "$exists" in
      yes)
        found_any=1
        conflicts+=("${r}:${version}")
        ;;
      unknown)
        dim "  无法确认 ${r}:${version} 是否已存在（私有仓库 / 网络不通），继续"
        ;;
    esac
  done

  if [ "$found_any" -eq 1 ] && [ "$FORCE" -eq 1 ]; then
    warn '已指定 --force，跳过版本存在性检查，直接覆盖'
    found_any=0
  fi
  if [ "$found_any" -eq 1 ] && [ "$is_pre" -eq 1 ]; then
    warn "预发布版 ${version} 已存在，按规则直接覆盖（预发布本来就会被反复重推）"
    found_any=0
  fi
  if [ "$found_any" -eq 1 ]; then
    existing="${conflicts[0]}"
    if [ "${#conflicts[@]}" -gt 1 ]; then
      existing="${conflicts[0]} 等 ${#conflicts[@]} 个 tag"
    fi
    if ! resolve_conflict "$version" "$existing"; then
      info ''
      info '  已中止，本地与远端都没有变化。'
      exit 1
    fi
    if [ "$CONFLICT_ACTION" = 'bumped' ]; then
      ok "版本号已改为 $(read_pkg_version)，重新计算 tag"
      exec "$0" \
        --registry "$REGISTRY_SEL" --version "$(read_pkg_version)" \
        $( [ "$NO_LATEST" -eq 1 ] && echo '--no-latest' ) \
        $( [ "$FORCE_LATEST" -eq 1 ] && echo '--latest' ) \
        $( [ "$NO_BUILD" -eq 1 ] && echo '--no-build' ) \
        $( [ "$NO_PUSH" -eq 1 ] && echo '--no-push' ) \
        $( [ "$NO_CACHE" -eq 1 ] && echo '--no-cache' ) \
        $( [ "$PULL_BASE" -eq 1 ] && echo '--pull' ) \
        $( [ "$FLOATING" -eq 1 ] && echo '--floating' ) \
        $( [ "$DO_LOGIN" -eq 1 ] && echo '--login' ) \
        $( [ -n "$PLATFORMS" ] && echo "--platform $PLATFORMS" )
    fi
    if [ "$CONFLICT_ACTION" = 'force' ]; then
      warn "将强制覆盖 ${version}"
    fi
  fi
  fi

  # ---- 构建 ----
  PUSHED=()
  local primary="${REPOS[0]}"
  local local_ref="${IMAGE_NAME}:${version}"

  info ''
  dim '  ---------------------------------------------'
  if [ "$NO_BUILD" -eq 1 ]; then
    if [ "$DRY_RUN" -eq 0 ] && ! local_image_exists "$local_ref"; then
      die "--no-build 要求本地已有 ${local_ref}，当前没有
    先不带 --no-build 跑一次，或用 docker tag <已有镜像> ${local_ref} 打上"
    fi
    ok "跳过构建，使用本地镜像 ${local_ref}"
  elif [ -n "$PLATFORMS" ]; then
    # buildx：一次构建，把所有仓库的所有 tag 一起推上去
    local -a bx=(docker buildx build --platform "$PLATFORMS")
    for r in "${REPOS[@]}"; do
      for t in "${TAGS[@]}"; do bx+=(-t "${r}:${t}"); done
    done
    bx+=(--label "org.opencontainers.image.title=${IMAGE_NAME}"
         --label "org.opencontainers.image.version=${version}"
         --label "org.opencontainers.image.source=https://github.com/maplekirito/qingStorClient")
    [ "$NO_CACHE" -eq 1 ] && bx+=(--no-cache)
    [ "$PULL_BASE" -eq 1 ] && bx+=(--pull)
    # buildx 的多架构产物无法 load 回本地 daemon：
    #   正常情况直接 --push；--no-push 时写成 tar 落到本地，保留「只构建」的语义
    if [ "$NO_PUSH" -eq 1 ]; then
      bx+=(--output "type=tar,dest=$SCRIPT_DIR/buildx-multiarch.tar" .)
    else
      bx+=(--push .)
    fi
    info "  多架构构建并直接推送（${PLATFORMS}）"
    dim '  buildx 一次构建覆盖所有仓库与 tag；产物不进本地 daemon，所以本地不会有这个镜像。'
    if [ "$DRY_RUN" -eq 0 ] && ! docker buildx version >/dev/null 2>&1; then
      die '当前 docker 没有 buildx。装好 buildx 后重试，或去掉 --platform 用单架构构建'
    fi
    ( cd "$SCRIPT_DIR" && run "${bx[@]}" ) || die 'buildx 构建/推送失败'
    if [ "$NO_PUSH" -eq 0 ]; then
      for r in "${REPOS[@]}"; do for t in "${TAGS[@]}"; do PUSHED+=("${r}:${t}"); done; done
    fi
    info ''
    dim '  ---------------------------------------------'
    if [ "$DRY_RUN" -eq 1 ]; then
      ok '预演结束（--dry-run：没构建、没推送）'
      dim '  去掉 --dry-run 再跑一次才会真正执行。'
      info ''
      return 0
    fi
    report_done "$version"
    return 0
  else
    local -a bd=(docker build -t "$local_ref")
    [ "$NO_CACHE" -eq 1 ] && bd+=(--no-cache)
    [ "$PULL_BASE" -eq 1 ] && bd+=(--pull)
    bd+=(--label "org.opencontainers.image.title=${IMAGE_NAME}"
        --label "org.opencontainers.image.version=${version}"
        --label "org.opencontainers.image.source=https://github.com/maplekirito/qingStorClient")
    bd+=(.)
    info "  构建本地镜像 ${local_ref}"
    ( cd "$SCRIPT_DIR" && run "${bd[@]}" ) || die 'docker build 失败'
    # 正式版顺带在本地打一个 latest，方便 docker compose up -d 直接用
    if [ "$is_pre" -eq 0 ] && [ "$DRY_RUN" -eq 0 ] && [ "$version" != 'latest' ]; then
      if ! local_image_exists "${IMAGE_NAME}:latest" \
         || [ "$(docker image inspect -f '{{.Id}}' "$local_ref")" != "$(docker image inspect -f '{{.Id}}' "${IMAGE_NAME}:latest" 2>/dev/null || true)" ]; then
        run docker tag "$local_ref" "${IMAGE_NAME}:latest"
      fi
    fi
  fi

  # ---- 打 tag 并推送 ----
  local fails=0
  for r in "${REPOS[@]}"; do
    for t in "${TAGS[@]}"; do
      local ref="${r}:${t}"
      if [ "$ref" != "$local_ref" ]; then
        run docker tag "$local_ref" "$ref"
      fi
      push_image "$ref" || fails=$((fails + 1))
    done
  done

  info ''
  dim '  ---------------------------------------------'
  if [ "$DRY_RUN" -eq 1 ]; then
    ok '预演结束（--dry-run：没构建、没打 tag、没推送）'
    dim '  去掉 --dry-run 再跑一次才会真正执行。'
    info ''
    return 0
  fi
  if [ "$fails" -gt 0 ]; then
    err "有 ${fails} 个镜像没推上去，部署端拉不到"
    exit 1
  fi
  report_done "$version"
}

report_done() {
  local version="$1" p
  if [ "$NO_PUSH" -eq 1 ]; then
    ok "本地构建完成（--no-push 未推送）：${IMAGE_NAME}:${version}"
    for p in "${PUSHED[@]+"${PUSHED[@]}"}"; do dim "  ${p}"; done
    info ''
    dim '  可直接用本地镜像起容器：cd server && docker compose up -d（不会去远端拉）'
    info ''
    return 0
  fi
  ok "发布完成：${version}"
  for p in "${PUSHED[@]+"${PUSHED[@]}"}"; do dim "  ${p}"; done
  info ''
  dim '  部署端（服务器）拉取：'
  case "$REGISTRY_SEL" in
    hub|all) dim "    docker pull ${HUB_REPO}:${version}" ;;
  esac
  case "$REGISTRY_SEL" in
    acr|all) dim "    docker pull ${ACR_REPO}:${version}" ;;
  esac
  dim '  境内 ECS 建议用 ACR 地址（Docker Hub 拉取常超时），compose 里改 image 即可。'
  dim "  服务端更新后记得核对 data/ 卷与 ADMIN_TOKEN，别把令牌打进镜像。"
  info ''
}

main "$@"
