# make-icon.ps1 —— 生成 TreiWagon Remote 的 APP 图标
#
# 为什么用 GDI+ 而不是拿浏览器渲染 SVG:
#   Edge / Chrome 的 headless 模式在已有实例运行时起不来
#   (Multiple targets are not supported in headless mode),
#   而 GDI+ 是 Windows 自带的, 不依赖任何外部浏览器.
#
# 跑法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-icon.ps1
# 产出:
#   icon.png (512x512, 满幅底色, 交给手机启动器自己裁形状)
#
# 设计:
#   左边竖条 = 油门 (前后), 右边圆盘 = 转向 (左右), 正好对应 APP 的两种摇杆形态.
#   内容全部收在 80px 安全边距内, 启动器裁成圆形/圆角方形都吃不掉.

Add-Type -AssemblyName System.Drawing

$OutPath = "D:\BlueMap\RemoteDensiaty\icon.png"
$W = 512
$H = 512

function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }

function CA($alpha, $hex) {
    $c = [System.Drawing.ColorTranslator]::FromHtml($hex)
    [System.Drawing.Color]::FromArgb($alpha, $c.R, $c.G, $c.B)
}

# 圆角矩形路径
function RoundRect($x, $y, $w, $h, $r) {
    $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $d = [Math]::Min($r * 2.0, [Math]::Min($w, $h))

    if ($d -le 0) {
        $p.AddRectangle([System.Drawing.RectangleF]::new($x, $y, $w, $h))
        $p.CloseFigure()
        return $p
    }

    $p.AddArc($x,           $y,           $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y,           $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d,   0, 90)
    $p.AddArc($x,           $y + $h - $d, $d, $d,  90, 90)
    $p.CloseFigure()
    return $p
}

function VGrad($y1, $y2, $c1, $c2) {
    return [System.Drawing.Drawing2D.LinearGradientBrush]::new(
        [System.Drawing.PointF]::new(0, $y1),
        [System.Drawing.PointF]::new(0, $y2),
        $c1, $c2)
}

$bmp = [System.Drawing.Bitmap]::new($W, $H)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

# ---------------- 背景: 满幅, 不留圆角 ----------------
$bg = VGrad 0 512 (C '#242b36') (C '#0a0c10')
$g.FillRectangle($bg, 0, 0, $W, $H)

$penRail  = [System.Drawing.Pen]::new((C '#333b49'), 6)
$penFaint = [System.Drawing.Pen]::new((CA 26 '#ffffff'), 3)

# ================= 左: 油门竖条 =================
$railPath = RoundRect 80 128 96 256 48
$railBrush = VGrad 128 384 (C '#161a21') (C '#272d38')
$g.FillPath($railBrush, $railPath)
$g.DrawPath($penRail, $railPath)

# 轨道零点刻度 (很淡的一条横线)
$tickBrush = [System.Drawing.SolidBrush]::new((CA 22 '#ffffff'))
$g.FillRectangle($tickBrush, 108, 254, 40, 4)

# 把手 (偏上 = 前进)
$knobPath = RoundRect 98 152 60 88 30
$knobBrush = VGrad 152 240 (C '#86ffb8') (C '#1e9455')
$g.FillPath($knobBrush, $knobPath)

# 把手高光
$hiPath = RoundRect 108 162 40 22 11
$hiBrush = [System.Drawing.SolidBrush]::new((CA 110 '#ffffff'))
$g.FillPath($hiBrush, $hiPath)

# ================= 右: 转向圆盘 =================
$R  = 92
$cx = 344
$cy = 256
$dx = $cx - $R
$dy = $cy - $R
$dd = $R * 2

$discBrush = VGrad ($cy - $R) ($cy + $R) (C '#161a21') (C '#272d38')
$g.FillEllipse($discBrush, $dx, $dy, $dd, $dd)
$g.DrawEllipse($penRail, $dx, $dy, $dd, $dd)

# 内圈: 给圆盘一点层次, 像游戏摇杆的活动范围
$r2 = 58
$g.DrawEllipse($penFaint, $cx - $r2, $cy - $r2, $r2 * 2, $r2 * 2)

# 把手 (偏右 = 右转)
$kr = 34
$k2Brush = VGrad ($cy - $kr) ($cy + $kr) (C '#86ffb8') (C '#1e9455')
$g.FillEllipse($k2Brush, $cx + 22 - $kr, $cy - $kr, $kr * 2, $kr * 2)

# 高光
$h2Brush = [System.Drawing.SolidBrush]::new((CA 130 '#ffffff'))
$g.FillEllipse($h2Brush, $cx + 22 + 8 - 10, $cy - 10 - 10, 20, 20)

# ---------------- 输出 ----------------
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose()
$bmp.Dispose()

Write-Output "OK -> $OutPath"
