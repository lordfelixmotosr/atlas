param([Parameter(Mandatory=$true)][string]$AtlasRoot)
$ErrorActionPreference='Stop'
$atlasTestRoot=(Resolve-Path -LiteralPath $AtlasRoot).Path
$atlasTestExe=Join-Path $atlasTestRoot 'Atlas.exe'
$atlasTestUpdates=Join-Path $atlasTestRoot 'data/updates'
$atlasTestPending=Join-Path $atlasTestUpdates 'pending-startup.json'
$atlasTestHealthy=Join-Path $atlasTestUpdates 'startup-healthy.json'
if (Test-Path -LiteralPath $atlasTestPending) { throw 'Do not run this test during a pending application update.' }
$atlasTestToken=[Guid]::NewGuid().ToString('N')
$atlasTestVersion=(Get-Content -LiteralPath (Join-Path $atlasTestRoot 'atlas-build.json') -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Path $atlasTestUpdates -Force | Out-Null
@{root=$atlasTestRoot;version=$atlasTestVersion;token=$atlasTestToken} | ConvertTo-Json | Set-Content -LiteralPath $atlasTestPending
$atlasTestProcess=$null
try {
 $atlasTestProcess=Start-Process -FilePath $atlasTestExe -ArgumentList '--atlas-verify' -WorkingDirectory $atlasTestRoot -WindowStyle Hidden -PassThru
 $atlasTestDeadline=[DateTime]::UtcNow.AddSeconds(30)
 $atlasTestReceipt=$null
 while([DateTime]::UtcNow -lt $atlasTestDeadline) {
  if(Test-Path -LiteralPath $atlasTestHealthy) { $candidate=Get-Content -LiteralPath $atlasTestHealthy -Raw | ConvertFrom-Json; if($candidate.token -eq $atlasTestToken -and $candidate.pid -eq $atlasTestProcess.Id){$atlasTestReceipt=$candidate;break} }
  if($atlasTestProcess.HasExited){throw 'Atlas exited before confirming startup.'}
  Start-Sleep -Milliseconds 500
 }
 if(!$atlasTestReceipt){throw 'Atlas did not confirm a working renderer and app API.'}
 $atlasTestReceipt | ConvertTo-Json -Compress
} finally {
 if($atlasTestProcess) { $owned=Get-Process -Id $atlasTestProcess.Id -ErrorAction SilentlyContinue; if($owned -and $owned.Path -eq $atlasTestExe){Stop-Process -Id $owned.Id} }
 if((Get-Content -LiteralPath $atlasTestPending -Raw | ConvertFrom-Json).token -eq $atlasTestToken) { Remove-Item -LiteralPath $atlasTestPending }
}
