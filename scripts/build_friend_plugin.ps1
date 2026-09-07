param(
    [string]$ApiUrl = $env:JOB_ACCELERATOR_API_URL,
    [string]$ApiToken = $env:JOB_ACCELERATOR_ACCESS_TOKEN,
    [string]$OutputDir = "release/plugin-cloud",
    [switch]$ReuseExistingToken,
    [switch]$AllowEmptyToken
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
$pluginDir = Join-Path $repoRoot "plugin"
$targetDir = Join-Path $repoRoot $OutputDir
$zipPath = "$targetDir.zip"
$targetFull = [System.IO.Path]::GetFullPath($targetDir)
$zipFull = [System.IO.Path]::GetFullPath($zipPath)
$existingConfig = Join-Path $targetFull "config.js"

if ([string]::IsNullOrWhiteSpace($ApiUrl)) {
    throw "ApiUrl is required. Set `$env:JOB_ACCELERATOR_API_URL or pass -ApiUrl."
}

$parsedApiUrl = $null
if (-not [Uri]::TryCreate($ApiUrl, [UriKind]::Absolute, [ref]$parsedApiUrl) -or $parsedApiUrl.Scheme -notin @("http", "https")) {
    throw "ApiUrl must be an absolute http or https URL."
}

if ($parsedApiUrl.Scheme -ne "https") {
    Write-Warning "ApiUrl uses HTTP. Access tokens and resume content can be exposed in transit."
}

$transportNote = if ($parsedApiUrl.Scheme -eq "https") {
    "- This package uses HTTPS. Keep the package private because it contains its access token."
} else {
    "- This package uses HTTP. Access tokens and resume content can be exposed in transit; use it only for isolated testing."
}

if (-not (Test-Path $pluginDir)) {
    throw "plugin directory not found: $pluginDir"
}

if (-not $targetFull.StartsWith($repoRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputDir must stay inside repo: $OutputDir"
}

if ([string]::IsNullOrWhiteSpace($ApiToken) -and $ReuseExistingToken -and (Test-Path $existingConfig)) {
    $existingConfigText = Get-Content -Raw -LiteralPath $existingConfig
    $tokenMatch = [regex]::Match($existingConfigText, 'API_TOKEN:\s*"([^"]*)"')
    if ($tokenMatch.Success) {
        $ApiToken = $tokenMatch.Groups[1].Value
    }
}

if ([string]::IsNullOrWhiteSpace($ApiToken) -and -not $AllowEmptyToken) {
    throw "ApiToken is required. Set `$env:JOB_ACCELERATOR_ACCESS_TOKEN, pass -ApiToken, or explicitly use -AllowEmptyToken for an unauthenticated backend."
}

if (Test-Path $targetFull) {
    Remove-Item -LiteralPath $targetFull -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $targetFull | Out-Null
Copy-Item -Path (Join-Path $pluginDir "*") -Destination $targetFull -Recurse -Force

$configPath = Join-Path $targetFull "config.js"
$apiUrlJson = ConvertTo-Json -Compress -InputObject $ApiUrl
$apiTokenJson = ConvertTo-Json -Compress -InputObject $ApiToken
$configContent = @(
    "// Private friend-build config. Do not commit or publish this file if it contains API_TOKEN."
    "window.JOB_ACCELERATOR_CONFIG = {"
    "  DEFAULT_API: $apiUrlJson,"
    "  API_TOKEN: $apiTokenJson,"
    "};"
)
Set-Content -LiteralPath $configPath -Encoding UTF8 -Value $configContent

$manifestPath = Join-Path $targetFull "manifest.json"
$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
$apiHostPermission = "{0}://{1}/*" -f $parsedApiUrl.Scheme, $parsedApiUrl.Host
$hostPermissions = @($manifest.host_permissions)
if ($apiHostPermission -notin $hostPermissions) {
    $manifest.host_permissions = @($hostPermissions + $apiHostPermission)
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$readmePath = Join-Path $targetFull "README.txt"
$readmeContent = @(
    "Job Accelerator - friend demo package"
    ""
    "This package is already configured to use the cloud backend."
    "You do not need to install Python, run server.py, or configure an LLM API key."
    ""
    "Install:"
    "1. Unzip plugin-cloud.zip."
    "2. Open Chrome and visit chrome://extensions/."
    "3. Enable Developer mode."
    "4. Click Load unpacked."
    "5. Select the unzipped plugin-cloud folder, not the zip file."
    "6. After installing or reloading the extension, refresh the opened BOSS page once."
    ""
    "Use:"
    "1. Set city, job keyword, salary, experience, education, and other filters on BOSS first."
    "2. Click the Job Accelerator extension icon."
    "3. Upload a text-based PDF resume. If parsing fails, paste resume text manually."
    "4. First test: daily target 3, match threshold 70%, choose Fast Apply."
    "5. Expected flow: scan JD -> match eligible job -> click chat -> stay on page -> continue next job."
    ""
    "Modes:"
    "- Fast Apply: local rules first, does not wait for the LLM, best for batch applying."
    "- Smart Apply: cloud-assisted matching, may be slower, falls back to local rules on failure."
    ""
    "HR reply assistant:"
    "1. Open the BOSS message page and click Check HR Replies in the extension."
    "2. Select a queued conversation and click Handle Reply."
    "3. The extension verifies the current conversation and fills a draft only."
    "4. Review the draft and click Send yourself. The extension never sends automatically."
    ""
    "Backend:"
    "$ApiUrl"
    ""
    "Privacy and risk:"
    "- Resume text and job descriptions are sent to the cloud backend for matching."
    $transportNote
    "- Do not publish this package. If connection fails, contact the person who shared it."
)
Set-Content -LiteralPath $readmePath -Encoding UTF8 -Value $readmeContent

if (Test-Path $zipFull) {
    Remove-Item -LiteralPath $zipFull -Force
}

Compress-Archive -Path (Join-Path $targetFull "*") -DestinationPath $zipFull -Force

Write-Host "Built friend plugin folder: $targetFull"
Write-Host "Built friend plugin zip:    $zipFull"
