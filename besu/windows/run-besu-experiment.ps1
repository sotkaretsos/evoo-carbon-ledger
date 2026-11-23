# Four-validator Hyperledger Besu QBFT experiment for evoo-carbon-ledger 1.3.0, run natively on
# Windows (no WSL distribution, Docker or administrator rights needed). Uses the verified Besu and
# JDK archives in tools\ next to this script, an installed Node.js 22 or a verified download, starts
# four validators on 127.0.0.1, runs the latency benchmark and the validator-failure phases, and
# copies the results to results\ next to this script. Progress: run.log; state: STATUS.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$WIN = Split-Path -Parent $MyInvocation.MyCommand.Path
$RUN = Join-Path $env:USERPROFILE 'evoo-besu-run'
if ($RUN -match '\s') { $RUN = 'C:\evoo-besu-run' }
$TOOLS = Join-Path $RUN 'tools'
$NET = Join-Path $RUN 'net'
$REPO = Join-Path $RUN 'repo'
$OUT = Join-Path $WIN 'results'
$LOG = Join-Path $WIN 'run.log'
$STATUS = Join-Path $WIN 'STATUS'
$EVENTS = Join-Path $OUT 'events.log'
$BV = '26.11.1'
$BESU_TGZ = Join-Path $WIN "tools\besu-$BV.tar.gz"
$BESU_SHA = '28336f46c44d6660e203546b51b8c81eea0cd3499ceff0d3e716f6b029e5e4f7'
$JDK_ZIP = Join-Path $WIN 'tools\OpenJDK25U-jdk_x64_windows_hotspot_25.0.5.1_2.zip'
$JDK_SHA = '849d380ab0a64d9098e7d3a2de28beb73841c3b255c8284f019ccd8748c5eb5b'
$env:HARDHAT_DISABLE_TELEMETRY_PROMPT = 'true'

New-Item -ItemType Directory -Force -Path $TOOLS, $OUT | Out-Null
# Single instance: a second launch exits instead of interfering with a run in progress.
try { $script:Lock = [System.IO.File]::Open((Join-Path $RUN 'run.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { Write-Host 'Another run of this experiment is in progress; this window can be closed.'; exit 2 }
Set-Content -Path $LOG -Value '' -Encoding ASCII
Set-Content -Path $STATUS -Value 'RUNNING' -Encoding ASCII
Set-Content -Path $EVENTS -Value '' -Encoding ASCII
$script:Pids = @{}

function Log([string]$m) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Write-Host $line
  Add-Content -Path $LOG -Value $line -Encoding ASCII
}
function Add-Event([string]$m) { Add-Content -Path $EVENTS -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffzzz'), $m) -Encoding ASCII }
function Kill-Strays {
  Get-CimInstance Win32_Process -Filter "Name='java.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$RUN*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function Stop-All {
  foreach ($n in @($script:Pids.Keys)) { & cmd.exe /c "taskkill /PID $($script:Pids[$n]) /T /F >nul 2>&1" }
  $script:Pids = @{}
  Start-Sleep -Seconds 2
  Kill-Strays
}
function Fail([string]$m) {
  Log "FAILED: $m"
  Set-Content -Path $STATUS -Value 'FAILED' -Encoding ASCII
  Stop-All
  exit 1
}
function Hash-Ok([string]$file, [string]$sha) {
  if (-not (Test-Path $file)) { return $false }
  return ((Get-FileHash -Algorithm SHA256 -Path $file).Hash.ToLower() -eq $sha)
}
function Rpc([string]$method, [string]$params, [int]$port = 8545) {
  $body = '{"jsonrpc":"2.0","method":"' + $method + '","params":' + $params + ',"id":1}'
  try { return (Invoke-RestMethod -Uri "http://127.0.0.1:$port" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 5).result } catch { return $null }
}
function Hex([object]$h) { if ($h) { return [Convert]::ToInt64(([string]$h).Substring(2), 16) } else { return -1 } }

if (($RUN -match '\s') -or ($WIN -match '\s')) { Fail "paths must not contain spaces ($WIN, $RUN)" }
Kill-Strays
$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$memGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
$HEAP = '768m'
if ($memGB -lt 8) { $HEAP = '512m' }
Log "Windows: $($os.Caption) $($os.Version); CPU: $($cpu.Name); logical processors: $($cs.NumberOfLogicalProcessors); memory: $memGB GB; heap per node: $HEAP"

# ---- Node.js 22
$nv = $null
if (Get-Command node.exe -ErrorAction SilentlyContinue) { $nv = (& node.exe --version) -replace '^v', '' }
if ($nv -and ([int]($nv.Split('.')[0]) -ge 22)) {
  Log "Node.js v$nv found"
} else {
  $sums = & curl.exe -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt
  if ($LASTEXITCODE -ne 0) { Fail 'Node.js checksum list' }
  $parts = (($sums | Where-Object { $_ -match 'win-x64\.zip$' } | Select-Object -First 1) -split '\s+')
  $nsha = $parts[0]; $nzip = $parts[1]
  $ndir = Join-Path $TOOLS ($nzip -replace '\.zip$', '')
  if (-not (Test-Path (Join-Path $ndir 'node.exe'))) {
    Log "Downloading $nzip"
    $nz = Join-Path $TOOLS $nzip
    & curl.exe -fsSL -o $nz "https://nodejs.org/dist/latest-v22.x/$nzip"
    if (-not (Hash-Ok $nz $nsha)) { Fail 'Node.js download or checksum' }
    & tar.exe -xf $nz -C $TOOLS
    if ($LASTEXITCODE -ne 0) { Fail 'Node.js unpack' }
  }
  $env:PATH = "$ndir;$env:PATH"
  Log "Node.js $(& node.exe --version) ready"
}

# ---- Java 25 (required by Besu 26.11)
$jdk = Get-ChildItem -Path $TOOLS -Directory -Filter 'jdk-25*' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $jdk) {
  if (-not (Hash-Ok $JDK_ZIP $JDK_SHA)) { Fail 'JDK archive missing or checksum mismatch' }
  Log 'Unpacking Temurin JDK 25'
  & tar.exe -xf $JDK_ZIP -C $TOOLS
  if ($LASTEXITCODE -ne 0) { Fail 'JDK unpack' }
  $jdk = Get-ChildItem -Path $TOOLS -Directory -Filter 'jdk-25*' | Select-Object -First 1
}
$env:JAVA_HOME = $jdk.FullName
$env:PATH = "$($jdk.FullName)\bin;$env:PATH"
$jv = (& cmd.exe /c 'java -version 2>&1' | Select-Object -First 1)
Log "Java ready: $jv"

# ---- Besu
$BESU = Join-Path $TOOLS "besu-$BV\bin\besu.bat"
if (-not (Test-Path $BESU)) {
  if (-not (Hash-Ok $BESU_TGZ $BESU_SHA)) { Fail 'Besu archive missing or checksum mismatch' }
  Log "Unpacking Besu $BV"
  & tar.exe -xzf $BESU_TGZ -C $TOOLS
  if ($LASTEXITCODE -ne 0) { Fail 'Besu unpack' }
}
$bver = (& cmd.exe /c "$BESU --version 2>nul" | Where-Object { $_ -match 'besu/' } | Select-Object -Last 1)
Log "Besu ready: $bver"

# ---- repository
if (Test-Path $REPO) { Remove-Item -Recurse -Force $REPO }
Copy-Item -Recurse -Path (Join-Path $WIN 'evoo-carbon-ledger-1.3.0') -Destination $REPO
Set-Location $REPO
Log 'Installing packages (npm ci)'
& cmd.exe /c "npm ci --no-audit --no-fund > $OUT\npm-ci.log 2>&1"
if ($LASTEXITCODE -ne 0) { Fail 'npm ci (see results\npm-ci.log)' }
& cmd.exe /c "npx hardhat compile > $OUT\compile.log 2>&1"
if ($LASTEXITCODE -ne 0) { Fail 'compile (see results\compile.log)' }
Log 'Contracts compiled'

# ---- network
if (Test-Path $NET) { Remove-Item -Recurse -Force $NET }
New-Item -ItemType Directory -Force -Path $NET | Out-Null
& cmd.exe /c "$BESU operator generate-blockchain-config --config-file=$REPO\besu\qbftConfigFile.json --to=$NET\networkFiles --private-key-file-name=key > $NET\generate.log 2>&1"
if (-not (Test-Path "$NET\networkFiles\genesis.json")) { Fail "genesis generation (see $NET\generate.log)" }
$i = 1
foreach ($d in (Get-ChildItem "$NET\networkFiles\keys" -Directory | Sort-Object Name)) {
  $dd = "$NET\node$i\data"
  New-Item -ItemType Directory -Force -Path $dd | Out-Null
  Copy-Item "$($d.FullName)\key", "$($d.FullName)\key.pub" $dd
  $i++
}
function Enode([int]$n) {
  $pub = ((Get-Content "$NET\node$n\data\key.pub" -Raw).Trim()) -replace '^0x', ''
  return "enode://$pub@127.0.0.1:$(30302 + $n)"
}
function Write-NodeConfig([int]$n) {
  # Peers are given as static nodes (Besu 26.11 on Windows rejects enode URLs in --bootnodes).
  $peers = (@(1, 2, 3, 4) | Where-Object { $_ -ne $n } | ForEach-Object { '"' + (Enode $_) + '"' }) -join ', '
  Set-Content -Path "$NET\node$n\static-nodes.json" -Value "[$peers]" -Encoding ASCII
  $toml = @(
    "data-path='$NET\node$n\data'",
    "genesis-file='$NET\networkFiles\genesis.json'",
    'p2p-host="127.0.0.1"',
    'p2p-interface="127.0.0.1"',
    "p2p-port=$(30302 + $n)",
    'nat-method="NONE"',
    'discovery-enabled=false',
    "static-nodes-file='$NET\node$n\static-nodes.json'",
    'rpc-http-enabled=true',
    'rpc-http-host="127.0.0.1"',
    "rpc-http-port=$(8544 + $n)",
    'rpc-http-api=["ETH", "NET", "WEB3", "QBFT", "TXPOOL"]',
    'host-allowlist=["localhost", "127.0.0.1"]',
    'rpc-http-max-active-connections=1000',
    'min-gas-price=0',
    'target-gas-limit=30000000',
    'sync-mode="FULL"'
  )
  Set-Content -Path "$NET\node$n\config.toml" -Value $toml -Encoding ASCII
}
function Start-Node([int]$n) {
  if (-not (Test-Path "$NET\node$n\config.toml")) { Write-NodeConfig $n }
  $env:BESU_OPTS = "-Xmx$HEAP"
  $p = Start-Process -FilePath cmd.exe -ArgumentList "/c $BESU --config-file=$NET\node$n\config.toml >> $NET\node$n.log 2>&1" -WindowStyle Hidden -PassThru
  $script:Pids[$n] = $p.Id
  Add-Event "start node$n"
}
function Stop-Node([int]$n) {
  Add-Event "stop node$n (process tree terminated)"
  & cmd.exe /c "taskkill /PID $($script:Pids[$n]) /T /F >nul 2>&1"
  $script:Pids.Remove($n)
  Start-Sleep -Seconds 2
}
function Phase([string]$label, [int]$ntx = 0, [int]$timeoutS = 0, [bool]$halt = $false) {
  Log "Phase $label"
  $env:PHASE = $label
  if ($ntx -gt 0) { $env:N_TX = "$ntx" } else { Remove-Item Env:N_TX -ErrorAction SilentlyContinue }
  if ($timeoutS -gt 0) { $env:PHASE_TIMEOUT_S = "$timeoutS" } else { Remove-Item Env:PHASE_TIMEOUT_S -ErrorAction SilentlyContinue }
  if ($halt) { $env:EXPECT_HALT = '1' } else { Remove-Item Env:EXPECT_HALT -ErrorAction SilentlyContinue }
  & cmd.exe /c "npx hardhat run scripts/besu-phase.js --network besu >> $OUT\phases.log 2>&1"
  if ($LASTEXITCODE -ne 0) { Fail "phase $label (see results\phases.log)" }
}

try {
  foreach ($n in 1, 2, 3, 4) { Start-Node $n }
  Log 'Four validators started; waiting for blocks'
  $ok = $false
  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Process -Id $script:Pids[1] -ErrorAction SilentlyContinue)) { Fail "node1 exited (see $NET\node1.log)" }
    $V = Rpc 'qbft_getValidatorsByBlockNumber' '["latest"]'
    $B = Hex (Rpc 'eth_blockNumber' '[]')
    $P = Hex (Rpc 'net_peerCount' '[]')
    if ($V -and ($V.Count -eq 4) -and ($B -ge 5) -and ($P -ge 3)) { $ok = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $ok) { Fail "network did not produce blocks (block=$B, peers=$P; see $NET\node1.log)" }
  Log "Network running: $($V.Count) validators, block $B, $P peers"

  Log 'Benchmark: deployment, then 30 sequential and 100 burst transactions (about 5 minutes)'
  & cmd.exe /c "npx hardhat run scripts/benchmark-latency.js --network besu > $OUT\benchmark.log 2>&1"
  if ($LASTEXITCODE -ne 0) { Fail 'benchmark (see results\benchmark.log)' }
  Copy-Item "$REPO\reports\latency-besu.json" $OUT
  Log 'Benchmark done'

  if (Test-Path "$REPO\reports\besu-fault") { Remove-Item -Recurse -Force "$REPO\reports\besu-fault" }
  Phase 'all-4'
  Stop-Node 4; Start-Sleep -Seconds 15
  Phase '3-of-4'
  Stop-Node 3; Start-Sleep -Seconds 15
  Phase '2-of-4' 3 60 $true
  Start-Node 3
  Phase 'recovered-3-of-4' 0 300
  Start-Node 4; Start-Sleep -Seconds 30
  Phase 'recovered-4-of-4'
  if (Test-Path "$OUT\besu-fault") { Remove-Item -Recurse -Force "$OUT\besu-fault" }
  Copy-Item -Recurse "$REPO\reports\besu-fault" "$OUT\besu-fault"

  $envLines = @(
    "date: $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')",
    "besu: $bver",
    "java: $jv",
    "node: $(& node.exe --version)",
    "platform: native Windows (no virtualisation layer)",
    "windows: $($os.Caption) $($os.Version)",
    "cpu: $($cpu.Name)",
    "cpu cores / logical processors: $($cpu.NumberOfCores) / $($cs.NumberOfLogicalProcessors)",
    "host memory GB: $memGB",
    "jvm heap per node: -Xmx$HEAP",
    "fault injection: validator process tree terminated with taskkill /F (crash stop), restarted from its data directory",
    "receipt polling: 500 ms (benchmark, Hardhat ethers provider) and 250 ms (phases)"
  )
  Set-Content -Path "$OUT\environment.txt" -Value $envLines -Encoding ASCII
  foreach ($n in 1, 2, 3, 4) { Get-Content "$NET\node$n.log" -Tail 300 | Set-Content "$OUT\node$n-tail.log" -Encoding ASCII }
  Log 'All phases done'
  Set-Content -Path $STATUS -Value 'DONE' -Encoding ASCII
} finally {
  Stop-All
}
