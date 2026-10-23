<#
.SYNOPSIS
    TreiWagon Remote —— 纯本地打包器 (完全不依赖 DCloud 云端打包)

.DESCRIPTION
    ── 原理 ────────────────────────────────────────────────────────────────
    HBuilderX 的 5+App 项目, 真正在手机上跑的 HTML / JS / CSS 全部躺在
    APK 内部的  assets/apps/<AppID>/www/  目录里, 而且是**明文**, 没有加密.

    所以"改完 JS 要重新打包"这件事根本不用云端:
        拿一个已经能装的 APK 当模板
          → 把模板里的 www/ 整个换成本地源目录的最新内容
          → 删掉旧签名 (CERT.SF / CERT.RSA / MANIFEST.MF)
          → zipalign 做 4KB 页对齐
          → 用本地 keystore 重新签名

    APK 里除 www/ 之外的其它东西 —— AndroidManifest、原生 so 库、图标、
    权限声明 —— 全都原封不动地沿用模板, 所以打出来的包和云端包在这个
    层面是完全一样的.

    ── 签名 ────────────────────────────────────────────────────────────────
    ★ 签出来的是**自签证书**, 和 DCloud 云端证书的签名不同.
      Android 规定: 签名不同的包不能覆盖安装, 必须先卸载旧版.
      所以第一次从云端包切到这个包, 以及以后切回云端包, 都要卸载一次.

    ★ keystore 和密码在 signing/ 目录, 别丢. 换了 keystore 等于换了签名,
      又要卸载重装一次.

.EXAMPLE
    # 在项目根目录直接跑
    powershell -ExecutionPolicy Bypass -File .\build-local.ps1

.NOTES
    作者: MiMoCode
    依赖: Android SDK build-tools (zipalign / apksigner) + JDK
#>

[CmdletBinding()]
param(
    # 当模板用的 APK. 必须是之前确认能正常安装的那个包.
    [string]$TemplateApk = 'D:\BlueMap\RemoteDensiaty\unpackage\release\apk\TreiWagonRemote_H50C22D40_v2.apk',

    # 源目录 (HBuilderX 项目根)
    [string]$SourceDir   = 'D:\BlueMap\RemoteDensiaty',

    # 输出路径
    [string]$OutApk      = 'D:\BlueMap\RemoteDensiaty\unpackage\release\apk\TreiWagonRemote_H50C22D40_local.apk',

    # keystore
    [string]$Keystore    = 'D:\BlueMap\RemoteDensiaty\signing\treiwagon-local.keystore',
    [string]$KeyAlias    = 'treiwagon',
    [string]$KeyPass     = 'treiwagon-local-2026',

    # APK 内部的 www 前缀 (由 AppID 决定, 一般不用改)
    [string]$WwwPrefix   = 'assets/apps/H50C22D40/www'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ============================================================================
#  工具链定位 —— 不写死版本号, 取 build-tools 里版本最高的那个
# ============================================================================
function Resolve-BuildTool {
    param([string]$Name)

    $sdkRoot = Join-Path $env:LOCALAPPDATA 'Android\Sdk\build-tools'
    if (-not (Test-Path $sdkRoot)) { throw "找不到 Android build-tools: $sdkRoot" }

    $tool = Get-ChildItem $sdkRoot -Recurse -Filter $Name -ErrorAction SilentlyContinue |
            Sort-Object { [version]($_.Directory.Name) } -Descending |
            Select-Object -First 1

    if (-not $tool) { throw "在 $sdkRoot 下找不到 $Name" }
    return $tool.FullName
}

# java 不在 PATH 里也能跑 apksigner
$jdk = 'C:\Program Files\Java\jdk-21'
if (Test-Path $jdk) { $env:JAVA_HOME = $jdk }

$zipalign  = Resolve-BuildTool 'zipalign.exe'
$apksigner = Resolve-BuildTool 'apksigner.bat'

# ============================================================================
#  前置检查
# ============================================================================
foreach ($p in @($TemplateApk, $Keystore)) {
    if (-not (Test-Path $p)) { throw "找不到必需文件: $p" }
}
if (-not (Test-Path (Join-Path $SourceDir 'index.html'))) {
    throw "源目录不像 HBuilderX 项目 (没有 index.html): $SourceDir"
}

# 这个前缀必须真实存在于模板里, 否则说明 AppID 对不上
$probe = [System.IO.Compression.ZipFile]::OpenRead($TemplateApk)
$hasPrefix = $probe.Entries | Where-Object { $_.FullName -like "$WwwPrefix/*" } | Select-Object -First 1
$probe.Dispose()
if (-not $hasPrefix) { throw "模板 APK 里没有 $WwwPrefix/ —— AppID 或模板选错了" }

# ============================================================================
#  要排除的东西
#
#  这些是开发过程中留下的垃圾, 不该进 APK:
#    *.bak / *.ps1        备份文件和脚本
#    icon-preview.html    图标预览页, 只在电脑上看
#    unpackage/           构建产物自己
#    signing/             keystore, 绝对不能进包
#    node_modules/        如果有的话
# ============================================================================
$ExcludePatterns = @(
    '*.bak',
    '*.ps1',
    'icon-preview.html',
    'unpackage/*',
    'unpackage/**',
    'signing/*',
    'signing/**',
    'node_modules/*',
    'node_modules/**',
    '.git/*',
    '.git/**'
)

# ============================================================================
#  主流程
# ============================================================================
$buildDir   = Join-Path $SourceDir 'unpackage\localbuild'
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$unsigned = Join-Path $buildDir 'unsigned.apk'
$aligned  = Join-Path $buildDir 'aligned.apk'

Write-Host '[1/5] 复制模板 APK' -ForegroundColor Cyan
Copy-Item $TemplateApk $unsigned -Force
Write-Host "      $TemplateApk"

Write-Host '[2/5] 替换 www/ 内容' -ForegroundColor Cyan
$zip = [System.IO.Compression.ZipFile]::Open($unsigned, 'Update')

# 先把模板里旧的 www 全删掉 —— 这样源目录删掉的文件不会残留在包里
$old = $zip.Entries | Where-Object { $_.FullName -like "$WwwPrefix/*" } | Select-Object -ExpandProperty FullName
foreach ($n in $old) { $zip.GetEntry($n).Delete() }
Write-Host "      清掉模板里的 $($old.Count) 个旧文件"

# 再把源目录递归写进去
$added = 0
Get-ChildItem $SourceDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($SourceDir.Length + 1).Replace('\', '/')

    foreach ($pat in $ExcludePatterns) {
        if ($rel -like $pat) { return }
    }

    $entryName = "$WwwPrefix/$rel"
    $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Close()
    $added++
    Write-Verbose "      + $rel ($($bytes.Length) B)"
}
Write-Host "      写入 $added 个文件"

# 删签名 —— 只删这三件套. META-INF/services/ 和 META-INF/androidx.*.version
# 是正常资源文件, 删了会让原生库起不来
Write-Host '[3/5] 清除旧签名' -ForegroundColor Cyan
foreach ($n in @('META-INF/CERT.SF', 'META-INF/CERT.RSA', 'META-INF/MANIFEST.MF')) {
    $e = $zip.GetEntry($n)
    if ($e) { $e.Delete(); Write-Host "      删除 $n" }
}
$zip.Dispose()

Write-Host '[4/5] zipalign 页对齐' -ForegroundColor Cyan
if (Test-Path $aligned) { Remove-Item $aligned -Force }
& $zipalign -p -f 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }

Write-Host '[5/5] apksigner 签名' -ForegroundColor Cyan
if (Test-Path $OutApk) { Remove-Item $OutApk -Force }
& $apksigner sign --ks $Keystore --ks-key-alias $KeyAlias `
    --ks-pass "pass:$KeyPass" --key-pass "pass:$KeyPass" `
    --out $OutApk $aligned
if ($LASTEXITCODE -ne 0) { throw 'apksigner 签名失败' }

# ============================================================================
#  自检 —— 签名验证不过就当场报错, 不要等装到手机上才发现
# ============================================================================
Write-Host ''
Write-Host '--- 签名验证 ---' -ForegroundColor Cyan
$verify = & $apksigner verify --verbose $OutApk 2>&1
$verify | Select-String -Pattern 'Verified using v[123] scheme' | ForEach-Object { "      $($_.Line)" }

if (-not ($verify | Select-String -Pattern 'Verifies' -Quiet)) {
    throw 'APK 签名验证失败!'
}

$info = Get-Item $OutApk
Write-Host ''
Write-Host '打包完成' -ForegroundColor Green
Write-Host "      输出: $OutApk"
Write-Host "      大小: $('{0:N0}' -f $info.Length) 字节"
Write-Host ''
Write-Host '注意: 这是自签证书, 和云端包签名不同.' -ForegroundColor Yellow
Write-Host '      第一次安装前必须先卸载手机上的旧版本.' -ForegroundColor Yellow
