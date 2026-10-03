param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference='Stop'
$atlasLaunchRequest=Get-Content -LiteralPath $RequestPath -Raw|ConvertFrom-Json
$atlasLaunchRoot=[IO.Path]::GetFullPath($atlasLaunchRequest.root)
$atlasLaunchRunner=[IO.Path]::GetFullPath($PSScriptRoot)
if($atlasLaunchRequest.token -notmatch '^[a-f0-9-]{36}$' -or $atlasLaunchRunner -ine (Join-Path $atlasLaunchRoot ('data\updates\installer-'+$atlasLaunchRequest.token))){throw 'Invalid Atlas installer launcher.'}
$atlasLaunchPowerShell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$atlasLaunchHelper=Join-Path $atlasLaunchRunner 'apply-update.ps1'
# ShellExecute gives the helper a separate Windows lifetime. A direct Electron
# child is terminated on app exit; DETACHED_PROCESS prevents PowerShell startup.
Start-Process -FilePath $atlasLaunchPowerShell -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$atlasLaunchHelper+'"'),'-RequestPath',('"'+[IO.Path]::GetFullPath($RequestPath)+'"')) -WorkingDirectory $atlasLaunchRoot -WindowStyle Hidden
