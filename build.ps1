param(
    [switch]$SelfTest,
    [switch]$Clean,
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

# Locate Go toolchain (system PATH, GO_BIN env, project .toolchain, or GOPATH cached toolchain)
if (-not (Get-Command go -ErrorAction SilentlyContinue)) {
    $Candidates = @()
    if ($env:GO_BIN) { $Candidates += $env:GO_BIN }
    $Candidates += (Join-Path $ProjectRoot ".toolchain\go\bin")
    $CachedToolchains = Get-ChildItem -Path (Join-Path $env:USERPROFILE "go\pkg\mod\golang.org\toolchain*") -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
    foreach ($tc in $CachedToolchains) {
        $Candidates += (Join-Path $tc.FullName "bin")
    }
    $FoundGo = $Candidates | Where-Object { $_ -and (Test-Path (Join-Path $_ "go.exe")) } | Select-Object -First 1
    if ($FoundGo) {
        $env:PATH = "$FoundGo;$env:PATH"
    } else {
        throw "Go toolchain not found in PATH, GO_BIN, or ~/go/pkg/mod/golang.org/toolchain*."
    }
}

Write-Host "Using Go Toolchain: $(go version)" -ForegroundColor DarkGray

$LdFlags = "-s -w"
if ($Version) {
    $LdFlags = "$LdFlags -X browser-go.AppVersion=$Version"
}
$GuiLdFlags = "$LdFlags -H=windowsgui"

$BinDir = Join-Path $ProjectRoot "bin"
if ($Clean -and (Test-Path $BinDir)) {
    Remove-Item -Recurse -Force $BinDir
}
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Write-Host "[1/3] Building Browser-Go CLI + Tunnel + Pool Gateway (bin\browser-go.exe)..." -ForegroundColor Cyan
go build -trimpath -ldflags $LdFlags -o (Join-Path $BinDir "browser-go.exe") ./cmd/browser-go
if ($LASTEXITCODE -ne 0) { throw "Failed building browser-go.exe" }

Write-Host "[2/3] Building Browser-Go Silent Windows GUI/Service Binary (bin\browser-go-noconsole.exe)..." -ForegroundColor Cyan
go build -trimpath -ldflags $GuiLdFlags -o (Join-Path $BinDir "browser-go-noconsole.exe") ./cmd/browser-go
if ($LASTEXITCODE -ne 0) { throw "Failed building browser-go-noconsole.exe" }

Get-ChildItem $BinDir -Filter *.exe | Select-Object Name, @{Name="SizeMB";Expression={[math]::Round($_.Length / 1MB, 2)}} | Format-Table -AutoSize

if ($SelfTest) {
    Write-Host "[3/3] Running Go Unit & Integration Test Suite..." -ForegroundColor Yellow
    go test -v -count=1 ./...
    if ($LASTEXITCODE -ne 0) {
        throw "Test suite failed with exit code $LASTEXITCODE"
    }
}
