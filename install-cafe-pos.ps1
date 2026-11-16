param(
  [string]$RepositoryUrl = 'https://github.com/philopater41-rgb/bon-el-moon-pos.git',
  [string]$Branch = 'main',
  [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'BonElMoonPOS'),
  [switch]$SkipShortcuts
)
$ErrorActionPreference = 'Stop'
$root = $InstallRoot
$app = Join-Path $root 'app'
$config = Join-Path $root 'repository.txt'
$stage = Join-Path $root ('staging-' + [guid]::NewGuid().ToString('N'))
$previous = Join-Path $root ('previous-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
function Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }
function Require-Exit($label) { if ($LASTEXITCODE -ne 0) { throw "$label failed (exit $LASTEXITCODE)." } }
function Refresh-Tools {
  foreach ($dir in @((Join-Path $env:ProgramFiles 'nodejs'), (Join-Path $env:ProgramFiles 'Git\cmd'), (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd'))) {
    if ((Test-Path -LiteralPath $dir) -and $env:Path -notlike "*$dir*") { $env:Path = "$dir;$env:Path" }
  }
}
function Ensure-Tool($command, $package) {
  Refresh-Tools
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw "$command is missing and Windows Package Manager (winget) is unavailable. Install it and run this installer again." }
    Step "Installing $package"
    & winget.exe install --id $package --exact --accept-source-agreements --accept-package-agreements --disable-interactivity
    Require-Exit "Installing $package"
    Refresh-Tools
  }
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is not available yet. Restart Windows and run the installer again." }
}
New-Item -ItemType Directory -Path $root -Force | Out-Null
if (Test-Path -LiteralPath $config) { $saved = (Get-Content -LiteralPath $config -Raw).Trim(); if ($saved) { $RepositoryUrl = $saved } }
if ($RepositoryUrl -notmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$') { throw 'Use a GitHub HTTPS repository URL without credentials.' }
try {
  Ensure-Tool 'git.exe' 'Git.Git'
  Ensure-Tool 'node.exe' 'OpenJS.NodeJS.LTS'
  $nodeVersion = & node.exe -p "process.versions.node"
  $v = [version]$nodeVersion
  if ($v.Major -lt 20 -or ($v.Major -eq 20 -and $v.Minor -lt 19) -or ($v.Major -eq 21) -or ($v.Major -eq 22 -and $v.Minor -lt 12) -or ($v.Major -eq 23)) { throw "Node.js $nodeVersion is too old. Install a current Node.js LTS and retry." }
  if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 3000 is in use. Close the POS or the other program using it, then retry. No process was stopped.' }
  if (Test-Path -LiteralPath (Join-Path $app '.git')) {
    $changes = & git.exe -C $app status --porcelain --untracked-files=no
    Require-Exit 'Checking local changes'
    if ($changes) { throw 'The installed application has modified tracked files. Update stopped to preserve them.' }
  }
  Step 'Downloading a clean copy from GitHub (sign in to GitHub if prompted)'
  & git.exe clone --branch $Branch --single-branch -- $RepositoryUrl $stage
  Require-Exit 'Git clone'
  if (-not (Test-Path -LiteralPath (Join-Path $stage 'package-lock.json'))) { throw 'The repository is not a valid BON el MOON project.' }
  $oldEnv = Join-Path $app '.env'
  $newEnv = Join-Path $stage '.env'
  if (Test-Path -LiteralPath $app) {
    # Copy local databases and SQLite sidecars without removing the old copy.
    Get-ChildItem -LiteralPath $app -File -Recurse -Force | Where-Object {
      $_.FullName -notmatch '[\\/](node_modules|\.next|\.git)[\\/]' -and $_.Name -match '\.(db|sqlite|sqlite3)(-(wal|shm|journal))?$'
    } | ForEach-Object {
      $relative = $_.FullName.Substring($app.Length).TrimStart([char[]]'\/')
      $destination = Join-Path $stage $relative
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }
    Get-ChildItem -LiteralPath $app -File -Force | Where-Object { $_.Name -match '^\.env($|\.)' } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $stage $_.Name) -Force }
    if (Test-Path -LiteralPath (Join-Path $app 'backups')) { Copy-Item -LiteralPath (Join-Path $app 'backups') -Destination (Join-Path $stage 'backups') -Recurse -Force }
  }
  if (-not (Test-Path -LiteralPath $newEnv)) {
    $dataDir = Join-Path $root 'data'
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
    $database = Join-Path $dataDir 'cafe.db'
    if (Test-Path -LiteralPath $database) { throw 'A database already exists without its configuration. Installation stopped to protect it.' }
    $dbUrl = 'file:' + $database.Replace('\','/')
    [IO.File]::WriteAllText($newEnv, "DATABASE_URL=`"$dbUrl`"`r`n", (New-Object Text.UTF8Encoding($false)))
    $initialize = $true
  } else { $initialize = $false }
  Step 'Installing dependencies and building the application'
  Push-Location $stage
  try {
    & npm.cmd ci --no-audit --no-fund
    Require-Exit 'npm ci'
    if ($initialize) {
      # This branch is reached only for a newly created, previously nonexistent database.
      $schemaSql = Join-Path $stage 'initial-schema.sql'
      & npx.cmd prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script --output $schemaSql
      Require-Exit 'Preparing the new database schema'
      & node.exe scripts/initialize-new-db.mjs $schemaSql
      Require-Exit 'Creating initial users and tables'
    }
    # Webpack avoids Turbopack junctions that point to the temporary staging path.
    & node.exe node_modules/next/dist/bin/next build --webpack
    Require-Exit 'Building the application'
  } finally { Pop-Location }
  Step 'Activating the new version'
  if (Test-Path -LiteralPath $app) { Move-Item -LiteralPath $app -Destination $previous }
  try { Move-Item -LiteralPath $stage -Destination $app }
  catch { if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $app }; throw }
  [IO.File]::WriteAllText($config, $RepositoryUrl + "`r`n", (New-Object Text.UTF8Encoding($false)))
  if (-not $SkipShortcuts) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  foreach ($entry in @(@('BON el MOON POS', 'start-pos.bat'), @('Update BON el MOON POS', 'تحديث-البرنامج.bat'))) {
    $shortcut = $shell.CreateShortcut((Join-Path $desktop ($entry[0] + '.lnk')))
    $shortcut.TargetPath = Join-Path $app $entry[1]
    $shortcut.WorkingDirectory = $app
    $shortcut.Save()
  }
  }
  Write-Host "`nInstallation/update completed. Start BON el MOON POS from the desktop." -ForegroundColor Green
  if ($initialize) { Write-Host 'New empty local database created. Initial login: admin / admin123 or cashier / cashier123. Add your menu or connect your database separately.' -ForegroundColor Yellow }
  if (Test-Path -LiteralPath $previous) { Write-Host "Previous version preserved at: $previous" }
} catch {
  Write-Host "`nInstallation/update failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "The existing application and its data have not been deleted. Staging files, if any: $stage" -ForegroundColor Yellow
  exit 1
}
