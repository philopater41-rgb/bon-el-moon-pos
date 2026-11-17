param(
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'BonElMoonPOS')
)
$ErrorActionPreference = 'Stop'
$app = Join-Path $InstallRoot 'app'

function Step($message) {
  Write-Host "`n====================================================" -ForegroundColor Cyan
  Write-Host "  $message" -ForegroundColor Cyan
  Write-Host "====================================================" -ForegroundColor Cyan
}

function Require-Exit($label) {
  if ($LASTEXITCODE -ne 0) { throw "$label failed (exit code $LASTEXITCODE)." }
}

function Refresh-Tools {
  $dirs = @(
    (Join-Path $env:ProgramFiles 'nodejs'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs'),
    (Join-Path $env:ProgramFiles 'Git\cmd'),
    (Join-Path $env:ProgramFiles 'Git\bin'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin')
  )
  foreach ($dir in $dirs) {
    if ((Test-Path -LiteralPath $dir) -and $env:Path -notlike "*$dir*") {
      $env:Path = "$dir;$env:Path"
    }
  }
}

Refresh-Tools

try {
  Step "بدء تحديث نظام BON el MOON من GitHub..."

  # Target directory: if running from inside the installed app, use current folder; otherwise use $app
  $targetDir = $app
  if (Test-Path -LiteralPath (Join-Path $PSScriptRoot '.git')) {
    $targetDir = $PSScriptRoot
  } elseif (-not (Test-Path -LiteralPath (Join-Path $app '.git'))) {
    Write-Host "[!] البرنامج غير مثبت في المسار الافتراضي. جاري تشغيل المثبت الكامل..." -ForegroundColor Yellow
    $installer = Join-Path $PSScriptRoot 'install-cafe-pos.ps1'
    if (Test-Path -LiteralPath $installer) {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installer
      exit $LASTEXITCODE
    } else {
      throw "لم يتم العثور على مثبت البرنامج."
    }
  }

  # 1. Stop running POS instances on port 3000
  Step "إيقاف خادم الكاشير مؤقتاً لتطبيق التحديثات..."
  try {
    $nodeProcs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
    foreach ($p in $nodeProcs) {
      if ($p.CommandLine -like "*next*start*" -or $p.CommandLine -like "*BonElMoonPOS*") {
        Write-Host "[+] Stopping running BON el MOON instance (PID: $($p.ProcessId))..." -ForegroundColor Yellow
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Seconds 2
  } catch {}

  Push-Location $targetDir
  try {
    # 2. Pull latest changes from GitHub
    Step "جاري سحب أحدث نسخة من GitHub (origin/main)..."
    & git.exe fetch origin main
    Require-Exit 'Git fetch'
    & git.exe reset --hard origin/main
    Require-Exit 'Git reset'

    # 3. Update dependencies & prisma
    Step "تحديث الحزم البرمجية ومولد Prisma..."
    & npm.cmd install --no-audit --no-fund
    Require-Exit 'npm install'

    & npx.cmd prisma generate
    Require-Exit 'Prisma generate'

    # 4. Build Next.js
    Step "إعادة بناء وتجهيز تطبيق الكاشير للإنتاج..."
    & node.exe node_modules/next/dist/bin/next build --webpack
    Require-Exit 'Next.js build'
  } finally {
    Pop-Location
  }

  # 5. Launch the updated application!
  Step "تم التحديث بنجاح! جاري تشغيل BON el MOON POS الآن..."
  $launcher = Join-Path $targetDir 'start-pos.bat'
  if (Test-Path -LiteralPath $launcher) {
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$launcher`"" -WorkingDirectory $targetDir
  }

  Write-Host "`n====================================================" -ForegroundColor Green
  Write-Host "  تم تحديث وتشغيل BON el MOON POS بنجاح!" -ForegroundColor Green
  Write-Host "====================================================" -ForegroundColor Green
} catch {
  Write-Host "`n====================================================" -ForegroundColor Red
  Write-Host "  فشل التحديث: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "====================================================" -ForegroundColor Red
  exit 1
}