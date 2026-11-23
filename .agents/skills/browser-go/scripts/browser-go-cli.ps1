param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CliArgs
)

$ErrorActionPreference = "Stop"

function Resolve-BrowserGoBin {
    if ($env:BROWSER_GO_BIN -and (Test-Path -LiteralPath $env:BROWSER_GO_BIN)) {
        return $env:BROWSER_GO_BIN
    }

    $candidates = @(
        (Join-Path (Get-Location) "bin\browser-go.exe"),
        (Join-Path $PSScriptRoot "..\..\..\..\bin\browser-go.exe"),
        (Join-Path $env:LOCALAPPDATA "BrowserGo\browser-go.exe"),
        (Join-Path $env:LOCALAPPDATA "BrowserGo\bin\browser-go.exe")
    )

    foreach ($c in $candidates) {
        if ($c -and (Test-Path -LiteralPath $c)) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }

    $cmd = Get-Command "browser-go.exe" -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $cmd2 = Get-Command "browser-go" -ErrorAction SilentlyContinue
    if ($cmd2) { return $cmd2.Source }

    throw "browser-go binary not found. Set BROWSER_GO_BIN or download from https://github.com/yattin/browser-go/releases/latest"
}

$bin = Resolve-BrowserGoBin
& $bin @CliArgs
exit $LASTEXITCODE
