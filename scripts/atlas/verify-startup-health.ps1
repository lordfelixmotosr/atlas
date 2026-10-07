param([Parameter(Mandatory=$true)][string]$AtlasRoot,[switch]$LockAgentSettings,[switch]$VerifySecondLaunch)
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
$atlasTestSettingsHandle=$null
$atlasTestSettingsBefore=$null
$atlasTestSecondProcess=$null
try {
 if($LockAgentSettings){
  $atlasTestSettingsPath=Join-Path $atlasTestRoot 'data/profile/pi-agent/settings.json'
  if(Test-Path -LiteralPath $atlasTestSettingsPath){throw 'Use a fresh verification profile for the locked settings test.'}
  New-Item -ItemType Directory -Path (Split-Path $atlasTestSettingsPath) -Force | Out-Null
  $atlasTestSettingsBefore='{"shellPath":"C:/missing-old-Atlas/bash.exe","retry":{"enabled":false},"fixturePreference":"preserve"}'
  [IO.File]::WriteAllText($atlasTestSettingsPath,$atlasTestSettingsBefore)
  $atlasTestSettingsHandle=[IO.File]::Open($atlasTestSettingsPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
 }
 $atlasTestProcess=Start-Process -FilePath $atlasTestExe -ArgumentList '--atlas-verify' -WorkingDirectory $atlasTestRoot -WindowStyle Hidden -PassThru
 $atlasTestDeadline=[DateTime]::UtcNow.AddSeconds(30)
 $atlasTestReceipt=$null
 while([DateTime]::UtcNow -lt $atlasTestDeadline) {
  if(Test-Path -LiteralPath $atlasTestHealthy) { $candidate=Get-Content -LiteralPath $atlasTestHealthy -Raw | ConvertFrom-Json; if($candidate.token -eq $atlasTestToken -and $candidate.pid -eq $atlasTestProcess.Id){$atlasTestReceipt=$candidate;break} }
  if($atlasTestProcess.HasExited){throw 'Atlas exited before confirming startup.'}
  Start-Sleep -Milliseconds 500
 }
 if(!$atlasTestReceipt){throw 'Atlas did not confirm a working renderer and app API.'}
 if($LockAgentSettings){
  if([IO.File]::ReadAllText($atlasTestSettingsPath) -ne $atlasTestSettingsBefore){throw 'Locked agent settings were changed.'}
  if(!(Get-Content -LiteralPath (Join-Path $atlasTestRoot 'data/logs/startup.log') -Raw).Contains('using the bundled shell for this launch')){throw 'The native test did not encounter the settings lock.'}
  $atlasTestReceipt | Add-Member -NotePropertyName lockedSettingsPreserved -NotePropertyValue $true
 }
 if($VerifySecondLaunch){
  $atlasTestSecondProcess=Start-Process -FilePath $atlasTestExe -ArgumentList '--atlas-verify' -WorkingDirectory $atlasTestRoot -WindowStyle Hidden -PassThru
  if(!$atlasTestSecondProcess.WaitForExit(10000) -or $atlasTestSecondProcess.ExitCode -ne 0){throw 'The second launch did not hand off to the running Atlas instance.'}
  if($atlasTestProcess.HasExited){throw 'The original Atlas instance exited during the second launch.'}
  $atlasTestReceipt | Add-Member -NotePropertyName secondLaunchHandedOff -NotePropertyValue $true
 }
 $atlasTestReceipt | ConvertTo-Json -Compress
} finally {
 if($atlasTestSettingsHandle){$atlasTestSettingsHandle.Dispose()}
 if($atlasTestSecondProcess) { $owned=Get-Process -Id $atlasTestSecondProcess.Id -ErrorAction SilentlyContinue; if($owned -and $owned.Path -eq $atlasTestExe){Stop-Process -Id $owned.Id} }
 if($atlasTestProcess) { $owned=Get-Process -Id $atlasTestProcess.Id -ErrorAction SilentlyContinue; if($owned -and $owned.Path -eq $atlasTestExe){Stop-Process -Id $owned.Id} }
 if((Get-Content -LiteralPath $atlasTestPending -Raw | ConvertFrom-Json).token -eq $atlasTestToken) { Remove-Item -LiteralPath $atlasTestPending }
}
