<#
.SYNOPSIS
    qingStorClient 更新服务 —— 一次构建，同时推送到 Docker Hub 与阿里云 ACR（Windows / PowerShell 版）

.DESCRIPTION
    与同目录的 docker-publish.sh 行为等价，参数一一对应：

      .\docker-publish.ps1                      构建并推送（默认两家都推）
      .\docker-publish.ps1 -DryRun              只打印将要打的 tag 与推送地址，不动任何东西
      .\docker-publish.ps1 -Registry hub        只推 Docker Hub
      .\docker-publish.ps1 -Registry acr        只推阿里云 ACR
      .\docker-publish.ps1 -Login               先 docker login 再推（两家依次弹输入）
      .\docker-publish.ps1 -Platform linux/amd64,linux/arm64   多架构（走 buildx）
      .\docker-publish.ps1 -NoBuild             不构建，把本地已有镜像重新打 tag 推上去
      .\docker-publish.ps1 -NoPush              只构建并打 tag，不推送（本地验证 / 配合 compose）
      .\docker-publish.ps1 -Help

    tag 自动识别：版本号取 server/package.json，并自动与 git 上 HEAD 的服务端标签
    （server-vX.Y.Z）互相校验，不一致直接拒绝，避免「标签写着 1.2.1、镜像却是 1.2.0」。
    只认 server-v* 前缀：客户端发版标签 v* 是另一套版本号，不参与校验。

    与 sh 版的 Windows 差异：
      · docker 不在 PATH 里时，会自动去 Docker Desktop 的默认安装目录找 docker.exe
        （这是 Windows 上最常见的失败原因：装了 Docker Desktop 但没重开终端）
      · 其余逻辑与 sh 版完全一致，两个脚本可以互换使用

.EXAMPLE
    .\docker-publish.ps1 -DryRun
    先看看它会打哪些 tag、推到哪些地址，不真的构建和推送。

.EXAMPLE
    .\docker-publish.ps1 -NoPush
    只在本地构建出 qingstorclient-server:1.2.1，配合 docker compose up -d 用。
#>
[CmdletBinding()]
param(
    [ValidateSet('all', 'hub', 'acr')]
    [string]$Registry = 'all',

    [string]$Platform = '',
    [string]$Version = '',
    [string[]]$Tag = @(),

    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Force,
    [switch]$NoLatest,
    [switch]$Latest,
    [switch]$NoBuild,
    [switch]$NoCache,
    [switch]$Pull,
    [switch]$NoPush,
    [switch]$Login,
    [switch]$Floating,
    [switch]$Help
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
$PkgFile = Join-Path $ScriptDir 'package.json'

# ---------------------------------------------------------------- 仓库配置
# 命名空间与地域跟参考项目 myApiTools 保持一致：myzhouye + cn-hangzhou。
#   参考项目：myzhouye/myapitools-server
#             registry.cn-hangzhou.aliyuncs.com/myzhouye/myapitools-server
# 仓库名必须不同（镜像内容不同），沿用参考项目的命名式 <项目名>-server。
$ImageName = if ($env:IMAGE_NAME) { $env:IMAGE_NAME } else { 'qingstorclient-server' }
$HubRepo = if ($env:HUB_REPO) { $env:HUB_REPO } else { 'myzhouye/qingstorclient-server' }
$AcrRepo = if ($env:ACR_REPO) { $env:ACR_REPO } else { 'registry.cn-hangzhou.aliyuncs.com/myzhouye/qingstorclient-server' }

$script:DockerExe = $null
$script:DockerExit = 0
$script:Pushed = @()

# ---------------------------------------------------------------- 输出
$script:C_RESET = "$([char]27)[0m"
$script:C_DIM = "$([char]27)[2m"
$script:C_BOLD = "$([char]27)[1m"
$script:C_RED = "$([char]27)[31m"
$script:C_GREEN = "$([char]27)[32m"
$script:C_YELLOW = "$([char]27)[33m"
$script:C_CYAN = "$([char]27)[36m"

function Write-Info { param([string]$Text = '') Write-Host $Text }
function Write-Dim { param([string]$Text = '') Write-Host "$script:C_DIM$Text$script:C_RESET" }
function Write-Ok { param([string]$Text) Write-Host "$script:C_GREEN$([char]0x2713)$script:C_RESET $Text" }
function Write-Warn { param([string]$Text) Write-Host "$script:C_YELLOW!$script:C_RESET $Text" -ForegroundColor Yellow }
function Write-Err { param([string]$Text) Write-Host "$script:C_RED$([char]0x2717)$script:C_RESET $Text" -ForegroundColor Red }
function Write-Hr { Write-Dim '  ------------------------------------------------------------' }

function Exit-WithError {
    param([string]$Text)
    Write-Err $Text
    exit 1
}

function Show-Usage {
    $text = @'
qingStorClient 更新服务 —— 一次构建，同时推送到 Docker Hub 与阿里云 ACR（Windows）

  .\docker-publish.ps1                      构建并推送（默认两家都推）
  .\docker-publish.ps1 -DryRun              只打印将要打的 tag 与推送地址，不动任何东西
  .\docker-publish.ps1 -Registry hub        只推 Docker Hub
  .\docker-publish.ps1 -Registry acr        只推阿里云 ACR
  .\docker-publish.ps1 -Login               先 docker login 再推（两家依次弹输入）
  .\docker-publish.ps1 -Platform linux/amd64,linux/arm64   多架构（buildx，构建即推送）
  .\docker-publish.ps1 -NoBuild             不构建，把本地已有镜像重新打 tag 推上去
  .\docker-publish.ps1 -NoPush              只构建并打 tag，不推送（本地验证 / 配合 compose）
  .\docker-publish.ps1 -NoCache -Pull       构建时不使用缓存 / 拉取最新基础镜像
  .\docker-publish.ps1 -Version 2.1.0       手工指定版本（跳过自动识别）
  .\docker-publish.ps1 -Tag beta            额外再打一个 :beta（可多个：-Tag beta,dev）
  .\docker-publish.ps1 -Floating            正式版额外打 :2.0 与 :2 两个浮动 tag
  .\docker-publish.ps1 -NoLatest            只推版本号，不动 latest
  .\docker-publish.ps1 -Latest              预发布版也更新 latest
  .\docker-publish.ps1 -Force               同一版本已存在时直接覆盖，不再询问
  .\docker-publish.ps1 -Yes                 不提问；有冲突直接判失败（CI 用）
  .\docker-publish.ps1 -Help

环境变量（都有默认值，一般不用动）：
  IMAGE_NAME   本地镜像名，默认 qingstorclient-server
  HUB_REPO     Docker Hub 仓库，默认 myzhouye/qingstorclient-server
  ACR_REPO     ACR 仓库，默认 registry.cn-hangzhou.aliyuncs.com/myzhouye/qingstorclient-server
               （命名空间与地域同参考项目 myApiTools 的 myapitools-server）

tag 自动识别规则（版本号唯一来源：本目录的 package.json）：

  1. 若当前 HEAD 上有服务端标签 server-vX.Y.Z，就用它，并与 package.json 交叉校验；
     两者不一致直接报错。客户端发版标签 vX.Y.Z 不参与，两者是独立的两套版本号。
  2. 否则用 package.json 的 version。
  3. 正式版 2.0.1       -> :2.0.1 和 :latest
     预发布 2.1.0-beta.1 -> 只打 :2.1.0-beta.1（不动 latest，除非加 -Latest）

命名空间已按参考项目 myApiTools 设为 myzhouye（ACR 地域 cn-hangzhou），
一般不用改；要临时换仓库用环境变量覆盖：
  $env:HUB_REPO='someone/qs-server'; $env:ACR_REPO='registry.cn-beijing.aliyuncs.com/someone/qs-server'; .\docker-publish.ps1
'@
    Write-Host $text
    exit 0
}

if ($Help) { Show-Usage }

# ------------------------------------------------------------ Docker 可执行文件
# Windows 上最常见的坑：装了 Docker Desktop 但当前终端 PATH 里没有 docker.exe
# （安装时没重启终端，或被精简的 PATH 覆盖）。这里按默认安装位置兜底探测。
#
# 还有一个坑（实测踩到）：机器上存在多份 docker 时 Get-Command 会返回**数组**
# （Docker Desktop 一份 + PATH 里另一份 / shim），直接取 .Source 得到的是数组，
# & 调用时 PowerShell 会把数组用空格拼成一个字符串，于是报
#   "术语 'C:\...\bin\docker.exe C:\...\bin\docker' 不会被识别"
# 所以这里不再直接信任第一个结果，而是收集成去重后的候选列表（只留真实存在的
# .exe），再逐个 `docker info` 试到能连上引擎为止。
function Get-DockerCandidates {
    $raw = New-Object System.Collections.Generic.List[string]

    foreach ($f in @(Get-Command docker -CommandType Application -ErrorAction SilentlyContinue)) {
        $p = $null
        try { $p = $f.Source } catch { }
        if (-not $p) { try { $p = $f.Path } catch { } }
        if ($p) { $raw.Add([string]$p) }
    }

    # 优先用 [Environment]::GetFolderPath：某些精简或受限环境里 $env:ProgramFiles
    # 是空的，直接 Join-Path 会抛错，探测就整个失效了。
    $roots = @()
    foreach ($n in @('ProgramFiles', 'ProgramFilesX86', 'CommonApplicationData', 'LocalApplicationData')) {
        try {
            $v = [Environment]::GetFolderPath($n)
            if ($v) { $roots += $v }
        } catch { }
    }
    if ($env:ProgramFiles) { $roots += $env:ProgramFiles }
    if (${env:ProgramFiles(x86)}) { $roots += ${env:ProgramFiles(x86)} }
    if ($env:ProgramData) { $roots += $env:ProgramData }
    if ($env:LOCALAPPDATA) { $roots += $env:LOCALAPPDATA }

    foreach ($r in $roots) {
        $raw.Add((Join-Path $r 'Docker\Docker\resources\bin\docker.exe'))
        $raw.Add((Join-Path $r 'DockerDesktop\version-bin\docker.exe'))
        $raw.Add((Join-Path $r 'Docker\resources\bin\docker.exe'))
    }
    $raw.Add('C:\Program Files\Docker\Docker\resources\bin\docker.exe')

    $seen = @{}
    $out = @()
    foreach ($p in $raw) {
        if (-not $p) { continue }
        $p = ([string]$p).Trim().Trim('"')
        # 只留真实存在的 .exe：候选里混进不带扩展名的条目时会被当成可执行文件，
        # 那正是上面那个报错的直接来源。
        if ($p -notmatch '\.exe$') { continue }
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
        $key = $p.ToLowerInvariant()
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $out += $p
    }
    return $out
}

function Test-DockerEngine {
    param([string]$Exe)
    if (-not $Exe) { return $false }
    try {
        & $Exe info *> $null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Initialize-Docker {
    $candidates = @(Get-DockerCandidates)

    if ($candidates.Count -eq 0) {
        if ($DryRun) {
            Write-Warn '找不到 docker 命令；-DryRun 只做计划，继续'
            return
        }
        Exit-WithError '找不到 docker 命令。装好 Docker Desktop 后重开终端；也可把 docker.exe 的目录加进 PATH'
    }

    foreach ($c in $candidates) {
        if (Test-DockerEngine $c) {
            $script:DockerExe = $c
            return
        }
    }

    if ($DryRun) {
        $script:DockerExe = $candidates[0]
        Write-Warn ('Docker 没在运行（docker info 失败）；-DryRun 只做计划，继续')
        return
    }
    Write-Info ''
    Write-Dim ('  试过的 docker：' + ($candidates -join '、'))
    Exit-WithError 'Docker 引擎没在运行（docker info 失败）。注意 docker -v 只说明 CLI 装好了，不代表 Docker Desktop 已启动；启动后重试'
}

# 打印再执行：$ docker xxx  （-DryRun 下只打印）
#
# 这里必须把 docker 的输出逐行 Write-Host 到终端，不能让它留在管道里：
# 调用方写的是 `$code = Invoke-DockerCmd $bd`，若 docker 的 stdout 走管道，
# 整段构建日志会被当成返回值塞进 $code ——
#   1. 屏幕上完全看不到构建过程（只看到一行 $ docker build 然后就静默几十秒）；
#   2. 退出码判断失效：$code 变成「日志行 + 退出码」的数组，
#      `$code -ne 0` 会过滤出所有非 0 元素得到非空数组，判真，
#      于是**构建成功也报失败**（实测踩到：包已经构建出来了，脚本却说 build 失败）。
function Invoke-DockerCmd {
    param([string[]]$DockerArgs)
    Write-Host "$script:C_CYAN`$$script:C_RESET docker $($DockerArgs -join ' ')"
    if ($DryRun) { return 0 }
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        # 2>&1 合并 stderr：buildkit 的进度是往 stderr 写的，只管道 stdout 会看不到任何过程
        & $script:DockerExe @DockerArgs 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.ToString() }
            else { Write-Host $_ }
        }
    } finally {
        $ErrorActionPreference = $prevEap
    }
    return $LASTEXITCODE
}

# 交互式命令（docker login 这类要读 stdin 的）。
# 上面那个把输出并进管道，会让 docker 的 TTY 探测失真、口令提示也可能不刷新；
# 这里用 Out-Host 让它直接写终端。因为输出不能进管道，退出码就放到
# $script:DockerExit 里，调用方从该变量取（写成 `$x = Invoke-DockerInteractive` 会把提示吞掉）。
function Invoke-DockerInteractive {
    param([string[]]$DockerArgs)
    Write-Host "$script:C_CYAN`$$script:C_RESET docker $($DockerArgs -join ' ')"
    $script:DockerExit = 0
    if ($DryRun) { return }
    & $script:DockerExe @DockerArgs | Out-Host
    $script:DockerExit = $LASTEXITCODE
}

function Test-LocalImage {
    param([string]$Ref)
    if (-not $script:DockerExe) { return $false }
    & $script:DockerExe image inspect $Ref *> $null
    return ($LASTEXITCODE -eq 0)
}

function Get-LocalImageId {
    param([string]$Ref)
    if (-not $script:DockerExe) { return '' }
    $out = & $script:DockerExe image inspect -f '{{.Id}}' $Ref 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    return ([string]($out | Select-Object -First 1)).Trim()
}

# ------------------------------------------------------------ 版本号读写
function Get-PkgVersion {
    $raw = Get-Content -LiteralPath $PkgFile -Raw -Encoding UTF8
    try {
        $obj = $raw | ConvertFrom-Json
        if ($obj.PSObject.Properties.Name -contains 'version' -and $obj.version) {
            return [string]$obj.version
        }
    } catch { }
    $m = [regex]::Match($raw, '"version"\s*:\s*"([^"]+)"')
    if (-not $m.Success) { return '' }
    return $m.Groups[1].Value
}

# 只替换 version 那一个字符串，不整体重新序列化 ——
# 否则缩进、字段顺序、换行风格（本仓库是 CRLF）会被重排，一个改版本号的提交能带出几十行无意义 diff。
function Set-PkgVersion {
    param([string]$NewVersion)
    $raw = Get-Content -LiteralPath $PkgFile -Raw -Encoding UTF8
    $re = [regex]'("version"\s*:\s*")[^"]*(")'
    if (-not $re.IsMatch($raw)) { Exit-WithError "在 $PkgFile 里找不到 version 字段" }
    $new = $re.Replace($raw, { param($m) $m.Groups[1].Value + $NewVersion + $m.Groups[2].Value }, 1)
    [System.IO.File]::WriteAllText($PkgFile, $new, (New-Object System.Text.UTF8Encoding($false)))
}

function Test-ValidVersion {
    param([string]$Value)
    return ($Value -match '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$')
}

function Test-Prerelease {
    param([string]$Value)
    return ($Value -match '-')
}

function Get-BumpedVersion {
    param([string]$Value, [ValidateSet('major', 'minor', 'patch')][string]$Part)
    $core = ($Value -split '-')[0]
    $parts = $core -split '\.'
    $major = [int]$parts[0]
    $minor = [int]$parts[1]
    $patch = [int]$parts[2]
    switch ($Part) {
        'major' { $major++; $minor = 0; $patch = 0 }
        'minor' { $minor++; $patch = 0 }
        'patch' { $patch++ }
    }
    return "$major.$minor.$patch"
}

# 当前 HEAD 上正好有一个「服务端标签」（server-vX.Y.Z）时返回它（去掉 server-v 前缀），
# 否则返回空。
#
# 为什么必须限定 server-v 前缀：客户端与服务端是两套独立版本号（客户端 0.0.x-dev、
# 服务端 1.2.1），却共用同一个 git 标签空间。不加 --match 时，客户端发版打的
# v0.0.1-dev 会被读到、去掉前导 v 变成 0.0.1-dev，再与 server/package.json 的 1.2.1
# 做严格相等校验 —— 必然失败，服务端镜像从此发不出去。
function Get-GitTag {
    if (-not (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) { return '' }
    $out = & git -C $RepoRoot describe --tags --exact-match --match 'server-v*' HEAD 2>$null
    if ($LASTEXITCODE -ne 0) { return '' }
    $tag = ([string]($out | Select-Object -First 1)).Trim()
    if (-not $tag) { return '' }
    return ($tag -replace '^server-v', '')
}

# ------------------------------------------------------------ 仓库校验
function Test-RepoName {
    param([string]$Repo, [string]$Label)
    if (-not $Repo) { Exit-WithError "$Label 为空" }
    $lastSeg = $Repo.Substring($Repo.LastIndexOf('/') + 1)
    if ($lastSeg -match ':') { Exit-WithError "$Label 不能带 tag（脚本自己会加）：$Repo" }
    if ($Repo -cmatch '[A-Z]') {
        Exit-WithError "$Label 含大写字母：$Repo`n    Docker 只接受全小写仓库名，改小写后重试。"
    }
    if ($Repo -match '//' -or $Repo.StartsWith('/') -or $Repo.EndsWith('/')) {
        Exit-WithError "$Label 格式不对：$Repo"
    }
    if ($Repo -notmatch '/') { Exit-WithError "$Label 需要是 <命名空间>/<仓库名> 形式：$Repo" }
}

function Get-RegistryHost {
    param([string]$Repo)
    $first = ($Repo -split '/')[0]
    if ($first -match '\.' -or $first -match ':') { return $first }
    return 'docker.io'
}

# ------------------------------------------------------------ 登录状态
function Get-DockerConfigPath {
    if ($env:DOCKER_CONFIG) { return (Join-Path $env:DOCKER_CONFIG 'config.json') }
    $home_dir = $env:USERPROFILE
    if (-not $home_dir) { $home_dir = [Environment]::GetFolderPath('UserProfile') }
    return (Join-Path $home_dir '.docker\config.json')
}

function Test-LoggedIn {
    param([string]$HostName)
    $cfg = Get-DockerConfigPath
    if (-not (Test-Path -LiteralPath $cfg)) { return $false }
    $raw = Get-Content -LiteralPath $cfg -Raw -ErrorAction SilentlyContinue
    if (-not $raw) { return $false }
    # 用了凭据助手时，config.json 里只有 credsStore，看不出具体登录了哪个仓库
    if ($raw -match '"credsStore"') { return $true }
    if ($HostName -eq 'docker.io') { return ($raw -match 'index\.docker\.io/v1/|"docker\.io"') }
    return ($raw -match [regex]::Escape('"' + $HostName + '"'))
}

function Get-LoginHint {
    param([string]$Repo)
    $h = Get-RegistryHost $Repo
    if ($h -eq 'docker.io') { return 'docker login' }
    return "docker login $h"
}

# ------------------------------------------------------------ 远端 tag 检查
# 返回 yes / no / unknown（私有仓库、网络不通、未登录都会落到 unknown）
function Test-RemoteTag {
    param([string]$Ref)

    $idx = $Ref.LastIndexOf(':')
    $repo = $Ref.Substring(0, $idx)
    $tag = $Ref.Substring($idx + 1)
    $hostName = Get-RegistryHost $repo

    if ($hostName -eq 'docker.io') {
        $repoPath = $repo.Substring($repo.IndexOf('/') + 1).ToLowerInvariant()
        $url = "https://registry.hub.docker.com/v2/repositories/$repoPath/tags/$tag/"
        try {
            $null = Invoke-WebRequest -Uri $url -Method Get -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
            return 'yes'
        } catch {
            $status = $null
            if ($_.Exception.Response) {
                try { $status = [int]$_.Exception.Response.StatusCode } catch { $status = $null }
            }
            if ($status -eq 404) { return 'no' }
        }
    }

    $env:DOCKER_CLI_EXPERIMENTAL = 'enabled'
    if ($script:DockerExe) {
        & $script:DockerExe manifest inspect $Ref *> $null
        if ($LASTEXITCODE -eq 0) { return 'yes' }
    }
    return 'unknown'
}

# ------------------------------------------------------------ 推送
function Write-PushFailedReport {
    param([string]$Ref, [string]$Reason, [string]$Hint)
    Write-Info ''
    Write-Err "没有推送到远端：$Ref"
    Write-Info ''
    Write-Warn '本地镜像已经构建好了，但远端拿不到它'
    Write-Dim '  部署端 docker compose pull 会报 not found 或拉到旧内容 —— 原因就是这次没推上去。'
    Write-Info ''
    Write-Dim "  失败原因：$Reason"
    Write-Dim "  怎么办：$Hint"
    Write-Info ''
}

function Push-Image {
    param([string]$Ref)

    if ($NoPush) {
        Write-Dim "  跳过推送（-NoPush）：$Ref"
        $script:Pushed += "$Ref（-NoPush 未推送）"
        return $true
    }
    if ($DryRun) {
        Write-Host "$script:C_CYAN`$$script:C_RESET docker push $Ref"
        $script:Pushed += "$Ref（预演，未实际推送）"
        return $true
    }

    Write-Host "$script:C_CYAN`$$script:C_RESET docker push $Ref"
    # 边推边显示：200MB 以上的镜像推一次要几分钟，攒到最后再打印等于全程黑屏。
    # 同时把每一行收进 $lines，失败时仍能按关键字区分「没登录」和「网络问题」。
    $lines = New-Object System.Collections.Generic.List[string]
    & $script:DockerExe push $Ref 2>&1 | ForEach-Object {
        $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { [string]$_ }
        if ($line) { $lines.Add($line); Write-Host $line }
    }
    $code = $LASTEXITCODE
    if ($code -ne 0) {
        $text = ($lines -join "`n")
        Write-Host $text
        if ($text -match '(?i)denied|unauthorized|authentication required|access token|no basic auth') {
            Write-PushFailedReport $Ref '推送被拒绝（没登录，或当前账号对这个仓库没有写权限）' "先登录再重跑：$(Get-LoginHint $Ref)"
        } else {
            Write-PushFailedReport $Ref '推送失败（网络中断 / registry 不可达 / Docker 异常）' '确认网络与 Docker 状态后重跑本脚本'
        }
        return $false
    }
    Write-Ok "已推送 $Ref"
    $script:Pushed += $Ref
    return $true
}

function Invoke-LoginAll {
    $hosts = @()
    foreach ($r in $script:Repos) {
        $h = Get-RegistryHost $r
        if ($hosts -notcontains $h) { $hosts += $h }
    }
    foreach ($h in $hosts) {
        Write-Info ''
        if ($h -eq 'docker.io') {
            Write-Info "  $script:C_BOLD登录 Docker Hub$script:C_RESET（用户名 = 你的 Docker ID，不是邮箱）"
            Invoke-DockerInteractive @('login')
            if ($script:DockerExit -ne 0) { Write-Warn 'Docker Hub 登录失败，后续推送可能被拒' }
        } else {
            Write-Info "  $script:C_BOLD登录 $h$script:C_RESET（用户名/密码用阿里云容器镜像服务的凭证）"
            Invoke-DockerInteractive @('login', $h)
            if ($script:DockerExit -ne 0) { Write-Warn "$h 登录失败，后续推送可能被拒" }
        }
    }
}

# ------------------------------------------------------------ 冲突处理
function Assert-Interactive {
    if ($Yes) { return }
    $interactive = $true
    try {
        if ([Console]::IsInputRedirected) { $interactive = $false }
    } catch {
        $interactive = $false
    }
    if (-not $interactive) {
        Exit-WithError '当前不是交互式终端，无法询问。请改用 -Yes（有冲突则失败）或 -Force（直接覆盖）'
    }
}

# 返回 'bumped' / 'force' / 'abort'
function Resolve-VersionConflict {
    param([string]$ShortVersion, [string]$Existing)

    Assert-Interactive
    $patchNext = Get-BumpedVersion $ShortVersion 'patch'
    $minorNext = Get-BumpedVersion $ShortVersion 'minor'
    $majorNext = Get-BumpedVersion $ShortVersion 'major'

    if ($Yes) {
        Write-Err "$Existing 已经存在"
        Write-Dim '  -Yes 不会替你决定覆盖。要重新发布请显式加 -Force，或先升版本号。'
        return 'abort'
    }

    Write-Info ''
    Write-Warn "$Existing 在远端已经存在了"
    Write-Dim '  正式版发布出去内容就不再变化，同一个 tag 带新内容再推一次会直接覆盖它，'
    Write-Dim '  正在用这个版本的人下次 pull 会拿到不一样的镜像。'
    Write-Dim '  只是日常构建、本来就要反复覆盖的话，把版本号改成预发布版即可（如 2.1.0-dev）。'
    Write-Info ''
    Write-Host "    [1] 升 patch  -> $patchNext"
    Write-Host "    [2] 升 minor  -> $minorNext"
    Write-Host "    [3] 升 major  -> $majorNext"
    Write-Host '    [4] 手动输入版本号'
    Write-Host "    [5] 保持 $ShortVersion，强制覆盖远端"
    Write-Host '    [0] 中止'
    Write-Info ''

    if ($DryRun) {
        Write-Dim '  -DryRun 下不会改写 package.json：这里只说明有冲突，'
        Write-Dim '  请手动改好版本号后重跑，或去掉 -DryRun 让脚本代为抬版。'
        return 'abort'
    }

    while ($true) {
        $choice = Read-Host '  请选择 [1-5, 0]'
        switch ($choice) {
            '1' { Set-PkgVersion $patchNext; return 'bumped' }
            '2' { Set-PkgVersion $minorNext; return 'bumped' }
            '3' { Set-PkgVersion $majorNext; return 'bumped' }
            '5' { return 'force' }
            { $_ -in @('0', '') } { return 'abort' }
            '4' {
                $manual = Read-Host '  输入新版本号（形如 1.2.3，可带 -beta.1）'
                if (-not (Test-ValidVersion $manual)) {
                    Write-Err "版本号格式不对：$manual"
                    continue
                }
                Set-PkgVersion $manual
                return 'bumped'
            }
            default { Write-Err '请输入 1 / 2 / 3 / 4 / 5 / 0' }
        }
    }
}

# ------------------------------------------------------------ 收尾报告
function Show-ReportDone {
    param([string]$Ver)

    if ($NoPush) {
        if ($Platform) {
            Write-Ok "多架构构建完成（-NoPush）：$ScriptDir\buildx-multiarch.tar"
            Write-Dim '  多架构产物是单个 tar，无法 load 进本地 daemon；要本地起容器请去掉 -Platform'
        } else {
            Write-Ok "本地构建完成（-NoPush 未推送）：$ImageName`:$Ver"
        }
        foreach ($p in $script:Pushed) { Write-Dim "  $p" }
        Write-Info ''
        if (-not $Platform) {
            Write-Dim '  可直接用本地镜像起容器：cd server; docker compose up -d（不会去远端拉）'
        }
        Write-Info ''
        return
    }

    Write-Ok "发布完成：$Ver"
    foreach ($p in $script:Pushed) { Write-Dim "  $p" }
    Write-Info ''
    Write-Dim '  部署端（服务器）拉取：'
    if ($Registry -eq 'hub' -or $Registry -eq 'all') { Write-Dim "    docker pull ${HubRepo}:$Ver" }
    if ($Registry -eq 'acr' -or $Registry -eq 'all') { Write-Dim "    docker pull ${AcrRepo}:$Ver" }
    Write-Dim '  境内 ECS 建议用 ACR 地址（Docker Hub 拉取常超时），compose 里改 image 即可。'
    Write-Dim '  服务端更新后记得核对 data/ 卷与 ADMIN_TOKEN，别把令牌打进镜像。'
    Write-Info ''
}

# ------------------------------------------------------------ 主流程
function Invoke-Main {
    if (-not (Test-Path -LiteralPath $PkgFile)) { Exit-WithError "找不到 $PkgFile" }
    if (-not (Test-Path -LiteralPath (Join-Path $ScriptDir 'Dockerfile'))) { Exit-WithError "找不到 $ScriptDir\Dockerfile" }

    # ---- 仓库列表 ----
    $script:Repos = switch ($Registry) {
        'hub' { @($HubRepo) }
        'acr' { @($AcrRepo) }
        default { @($HubRepo, $AcrRepo) }
    }
    foreach ($r in $script:Repos) { Test-RepoName $r '镜像仓库名' }
    # 两家配成同一个地址时去重，避免重复 build/push
    if ($script:Repos.Count -eq 2 -and $script:Repos[0] -eq $script:Repos[1]) {
        $script:Repos = @($script:Repos[0])
        Write-Warn 'HUB_REPO 与 ACR_REPO 是同一个地址，已去重'
    }

    Initialize-Docker

    # ---- 版本号自动识别 ----
    $pkgVersion = Get-PkgVersion
    if (-not $pkgVersion) { Exit-WithError "读不出 $PkgFile 里的 version" }
    if (-not (Test-ValidVersion $pkgVersion)) { Exit-WithError "package.json 里的版本号不是 x.y.z 形式：$pkgVersion" }

    $gitTag = Get-GitTag
    if ($Version) {
        $ver = $Version
        $versionSource = '-Version 手工指定'
        if (-not (Test-ValidVersion $ver)) { Exit-WithError "手工指定的版本号不合法：$ver" }
        if ($ver -ne $pkgVersion) { Write-Warn "手工指定的 $ver 与 package.json 的 $pkgVersion 不一致，按 $ver 发布" }
    } elseif ($gitTag) {
        $ver = $gitTag
        $versionSource = 'git HEAD 上的标签'
        if ($gitTag -ne $pkgVersion) {
            Write-Err "服务端标签 server-v$gitTag 与 package.json 的版本 $pkgVersion 不一致"
            Write-Dim "  这两个必须严格相等，否则会出现「标签写着 $gitTag、镜像却是 $pkgVersion」这种对不上的情况。"
            Write-Dim "  要么把 package.json 改成 $gitTag，要么 git tag -d server-v$gitTag 后重新打。"
            exit 1
        }
    } else {
        $ver = $pkgVersion
        $versionSource = 'package.json（HEAD 上没有 git 标签）'
    }

    $isPre = (Test-Prerelease $ver)

    # ---- tag 集合 ----
    $tags = New-Object System.Collections.Generic.List[string]
    $tags.Add($ver)
    if ($NoLatest) {
        # 什么都不加
    } elseif ($Latest) {
        $tags.Add('latest')
    } elseif (-not $isPre) {
        $tags.Add('latest')
    }
    if ($Floating -and -not $isPre) {
        $tags.Add($ver.Substring(0, $ver.LastIndexOf('.')))
        $tags.Add($ver.Substring(0, $ver.IndexOf('.')))
    }
    foreach ($t in $Tag) {
        if ($t -notmatch '^[a-zA-Z0-9._-]+$') { Exit-WithError "非法 tag：$t（只允许字母数字和 . _ -）" }
        $tags.Add($t)
    }
    $uniq = New-Object System.Collections.Generic.List[string]
    foreach ($t in $tags) { if (-not $uniq.Contains($t)) { $uniq.Add($t) } }
    $tags = $uniq

    # ---- 横幅 ----
    Write-Info ''
    Write-Host "  $script:C_BOLD qingStorClient 更新服务镜像 · 构建 & 推送$script:C_RESET"
    Write-Hr
    $kind = if ($isPre) { '预发布版' } else { '正式版' }
    Write-Info "  版本        : $script:C_BOLD$ver$script:C_RESET  ($kind)"
    Write-Info "  版本来源    : $versionSource"
    Write-Info "  镜像 tag    : $($tags -join ' ')"
    Write-Info "  推送目标    : $(if ($NoPush) { "$Registry（-NoPush：只构建不推送）" } else { $Registry })"
    foreach ($r in $script:Repos) { Write-Info "                $r" }
    Write-Info "  构建上下文  : $ScriptDir"
    if ($script:DockerExe) { Write-Dim "  docker      : $script:DockerExe" }
    if ($Platform) { Write-Info "  多架构      : $Platform（buildx，构建即推送）" }
    if ($NoBuild) { Write-Dim '  跳过构建    : -NoBuild，推本地已有镜像' }
    if ($DryRun) { Write-Dim '  模式        : -DryRun（不会 build / tag / push）' }
    Write-Hr

    # ---- 登录 ----
    if ($Login) {
        if ($DryRun) {
            Write-Dim '  -DryRun：跳过 -Login 的交互登录'
        } else {
            Invoke-LoginAll
        }
    } elseif (-not $NoPush) {
        $checkHosts = @()
        foreach ($r in $script:Repos) {
            $h = Get-RegistryHost $r
            if ($checkHosts -notcontains $h) { $checkHosts += $h }
        }
        foreach ($h in $checkHosts) {
            if (-not (Test-LoggedIn $h)) {
                Write-Warn "看起来没有登录 $h，推送可能被拒（要现在登录就加 -Login）"
                if ($h -eq 'docker.io') { Write-Dim '  docker login' } else { Write-Dim "  docker login $h" }
            }
        }
    }

    # ---- 版本冲突检查 ----
    if (-not $NoPush) {
        $conflicts = @()
        foreach ($r in $script:Repos) {
            $exists = Test-RemoteTag "${r}:$ver"
            if ($exists -eq 'yes') {
                $conflicts += "${r}:$ver"
            } elseif ($exists -eq 'unknown') {
                Write-Dim "  无法确认 ${r}:$ver 是否已存在（私有仓库 / 网络不通），继续"
            }
        }

        $foundAny = ($conflicts.Count -gt 0)
        if ($foundAny -and $Force) {
            Write-Warn '已指定 -Force，跳过版本存在性检查，直接覆盖'
            $foundAny = $false
        }
        if ($foundAny -and $isPre) {
            Write-Warn "预发布版 $ver 已存在，按规则直接覆盖（预发布本来就会被反复重推）"
            $foundAny = $false
        }
        if ($foundAny) {
            $existing = $conflicts[0]
            if ($conflicts.Count -gt 1) { $existing = "$($conflicts[0]) 等 $($conflicts.Count) 个 tag" }
            $action = Resolve-VersionConflict $ver $existing
            if ($action -eq 'abort') {
                Write-Info ''
                Write-Info '  已中止，本地与远端都没有变化。'
                exit 1
            }
            if ($action -eq 'force') { Write-Warn "将强制覆盖 $ver" }
            if ($action -eq 'bumped') {
                $newVer = Get-PkgVersion
                Write-Ok "版本号已改为 $newVer，重新计算 tag"
                $reArgs = @{ Registry = $Registry; Version = $newVer }
                if ($NoLatest) { $reArgs['NoLatest'] = $true }
                if ($Latest) { $reArgs['Latest'] = $true }
                if ($NoBuild) { $reArgs['NoBuild'] = $true }
                if ($NoCache) { $reArgs['NoCache'] = $true }
                if ($Pull) { $reArgs['Pull'] = $true }
                if ($Floating) { $reArgs['Floating'] = $true }
                if ($Login) { $reArgs['Login'] = $true }
                if ($NoPush) { $reArgs['NoPush'] = $true }
                if ($Platform) { $reArgs['Platform'] = $Platform }
                if ($Tag) { $reArgs['Tag'] = $Tag }
                & $PSCommandPath @reArgs
                exit $LASTEXITCODE
            }
        }
    }

    # ---- 构建 ----
    $localRef = "${ImageName}:$ver"

    Write-Info ''
    Write-Hr
    if ($NoBuild) {
        if (-not $DryRun -and -not (Test-LocalImage $localRef)) {
            Exit-WithError "-NoBuild 要求本地已有 $localRef，当前没有`n    先不带 -NoBuild 跑一次，或用 docker tag <已有镜像> $localRef 打上"
        }
        Write-Ok "跳过构建，使用本地镜像 $localRef"
    } elseif ($Platform) {
        $bx = @('buildx', 'build', '--platform', $Platform)
        foreach ($r in $script:Repos) { foreach ($t in $tags) { $bx += @('-t', "${r}:$t") } }
        $bx += @(
            '--label', "org.opencontainers.image.title=$ImageName",
            '--label', "org.opencontainers.image.version=$ver",
            '--label', 'org.opencontainers.image.source=https://github.com/maplekirito/qingStorClient'
        )
        if ($NoCache) { $bx += '--no-cache' }
        if ($Pull) { $bx += '--pull' }
        # buildx 的多架构产物无法 load 回本地 daemon，只能直接 push；
        # -NoPush 下改用 --output type=tar 落到本地，保留「只构建」的语义
        if ($NoPush) {
            $bx += @('--output', "type=tar,dest=$ScriptDir\buildx-multiarch.tar")
            Write-Warn '-NoPush 与 -Platform 同时使用：产物写成 buildx-multiarch.tar（多架构无法 load 进本地 daemon）'
        } else {
            $bx += '--push'
        }
        $bx += $ScriptDir
        Write-Info "  多架构构建（$Platform）"
        Write-Dim '  buildx 一次构建覆盖所有仓库与 tag。'
        if (-not $DryRun) {
            & $script:DockerExe buildx version *> $null
            if ($LASTEXITCODE -ne 0) {
                Exit-WithError '当前 docker 没有 buildx。装好 buildx 后重试，或去掉 -Platform 用单架构构建'
            }
        }
        $code = Invoke-DockerCmd $bx
        if (-not $DryRun -and $code -ne 0) { Exit-WithError "buildx 构建/推送失败（退出码 $code）" }
        if (-not $NoPush) {
            foreach ($r in $script:Repos) { foreach ($t in $tags) { $script:Pushed += "${r}:$t" } }
        }

        Write-Info ''
        Write-Hr
        if ($DryRun) {
            Write-Ok '预演结束（-DryRun：没构建、没推送）'
            Write-Dim '  去掉 -DryRun 再跑一次才会真正执行。'
            Write-Info ''
            return
        }
        Show-ReportDone $ver
        return
    } else {
        $bd = @('build', '-t', $localRef)
        if ($NoCache) { $bd += '--no-cache' }
        if ($Pull) { $bd += '--pull' }
        $bd += @(
            '--label', "org.opencontainers.image.title=$ImageName",
            '--label', "org.opencontainers.image.version=$ver",
            '--label', 'org.opencontainers.image.source=https://github.com/maplekirito/qingStorClient'
        )
        $bd += $ScriptDir
        Write-Info "  构建本地镜像 $localRef"
        $code = Invoke-DockerCmd $bd
        if (-not $DryRun -and $code -ne 0) { Exit-WithError "docker build 失败（退出码 $code）" }

        # 正式版顺带在本地打一个 latest，方便 docker compose up -d 直接用
        if (-not $isPre -and -not $DryRun -and $ver -ne 'latest') {
            $latestRef = "${ImageName}:latest"
            if (-not (Test-LocalImage $latestRef) -or (Get-LocalImageId $localRef) -ne (Get-LocalImageId $latestRef)) {
                $null = Invoke-DockerCmd @('tag', $localRef, $latestRef)
            }
        }
    }

    # ---- 打 tag 并推送 ----
    $fails = 0
    foreach ($r in $script:Repos) {
        foreach ($t in $tags) {
            $ref = "${r}:$t"
            if ($ref -ne $localRef) {
                $null = Invoke-DockerCmd @('tag', $localRef, $ref)
            }
            if (-not (Push-Image $ref)) { $fails++ }
        }
    }

    Write-Info ''
    Write-Hr
    if ($DryRun) {
        Write-Ok '预演结束（-DryRun：没构建、没打 tag、没推送）'
        Write-Dim '  去掉 -DryRun 再跑一次才会真正执行。'
        Write-Info ''
        return
    }
    if ($fails -gt 0) {
        Write-Err "有 $fails 个镜像没推上去，部署端拉不到"
        exit 1
    }
    Show-ReportDone $ver
}

Invoke-Main
