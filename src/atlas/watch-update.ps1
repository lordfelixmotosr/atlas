param([Parameter(Mandatory=$true)][string]$PendingPath,[Parameter(Mandatory=$true)][int]$LaunchPid,[switch]$NoRestart)
$ErrorActionPreference='Stop'
$atlasPending=Get-Content -LiteralPath $PendingPath -Raw|ConvertFrom-Json
$atlasRoot=[IO.Path]::GetFullPath($atlasPending.root)
$atlasBackup=[IO.Path]::GetFullPath($atlasPending.backup)
if(!$atlasBackup.StartsWith((Join-Path $atlasRoot 'backups')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Recovery backup is outside Atlas.'}
if(!([IO.Path]::GetFullPath($PendingPath)).StartsWith((Join-Path $atlasRoot 'data\updates')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Recovery request is outside Atlas.'}
foreach($atlasAnchor in @($atlasRoot,$atlasBackup)){if((Get-Item -LiteralPath $atlasAnchor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked recovery root rejected.'}}
$atlasStatus=Join-Path $atlasRoot 'data\updates\recovery-status.json'
$atlasHealthy=Join-Path $atlasRoot 'data\updates\startup-healthy.json'
$atlasSuccess=$false
for($atlasAttempt=0;$atlasAttempt -lt 120;$atlasAttempt++){
 if(Test-Path -LiteralPath $atlasHealthy){try{$atlasReceipt=Get-Content -LiteralPath $atlasHealthy -Raw|ConvertFrom-Json;if($atlasReceipt.token -eq $atlasPending.token -and $atlasReceipt.pid -eq $LaunchPid){$atlasSuccess=$true;break}}catch{}}
 if(!(Get-Process -Id $LaunchPid -ErrorAction SilentlyContinue)){break}
 Start-Sleep -Seconds 1
}
if($atlasSuccess){@{status='healthy';version=$atlasPending.version;checkedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $atlasStatus;Remove-Item -LiteralPath $PendingPath;exit}
$atlasProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$LaunchPid" -ErrorAction SilentlyContinue
if($atlasProcess){if($atlasProcess.ExecutablePath -ine (Join-Path $atlasRoot 'Atlas.exe')){throw 'Recovery process identity changed.'};Stop-Process -Id $LaunchPid -Force;Wait-Process -Id $LaunchPid -Timeout 15 -ErrorAction SilentlyContinue}
function AtlasLongPath([string]$Path){if($Path.StartsWith('\\')){return '\\?\UNC\'+$Path.Substring(2)};return '\\?\'+$Path}
foreach($atlasRelative in $atlasPending.files){
 if($atlasRelative -match '^(data|custom|library|updates|backups)(\\|$)' -or $atlasRelative.Contains(':') -or $atlasRelative -match '(^|\\)\.\.?(\\|$)'){throw 'Unsafe recovery path.'}
 $atlasTarget=[IO.Path]::GetFullPath((Join-Path $atlasRoot $atlasRelative));if(!$atlasTarget.StartsWith($atlasRoot+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Recovery target escapes Atlas.'}
 $atlasSaved=[IO.Path]::GetFullPath((Join-Path $atlasBackup $atlasRelative));if(!$atlasSaved.StartsWith($atlasBackup+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Recovery source escapes backup.'}
 $atlasWalk=$atlasBackup;foreach($atlasPart in $atlasRelative.Split('\')){$atlasWalk=Join-Path $atlasWalk $atlasPart;if(Test-Path -LiteralPath $atlasWalk){if((Get-Item -LiteralPath $atlasWalk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked recovery backup rejected.'}}}
 $atlasWalk=$atlasRoot;foreach($atlasPart in $atlasRelative.Split('\')){$atlasWalk=Join-Path $atlasWalk $atlasPart;if(Test-Path -LiteralPath $atlasWalk){if((Get-Item -LiteralPath $atlasWalk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Linked recovery path rejected.'}}}
 if([IO.File]::Exists((AtlasLongPath $atlasSaved))){[IO.File]::Copy((AtlasLongPath $atlasSaved),(AtlasLongPath $atlasTarget),$true)}else{[IO.File]::Delete((AtlasLongPath $atlasTarget))}
}
@{status='rolled-back';version=$atlasPending.version;reason='The updated app did not confirm a healthy startup. The previous application files were restored.';checkedAt=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $atlasStatus
Remove-Item -LiteralPath $PendingPath
if(!$NoRestart){Start-Process -FilePath (Join-Path $atlasRoot 'Atlas.exe') -WorkingDirectory $atlasRoot -WindowStyle Hidden}
