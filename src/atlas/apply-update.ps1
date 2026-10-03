param([Parameter(Mandatory=$true)][string]$RequestPath,[switch]$ValidateOnly,[switch]$NoRestart)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling',$false)
[AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths',$false)
function AtlasLongPath([string]$Path){$full=[IO.Path]::GetFullPath($Path);if($full.StartsWith('\\?\')){return $full};if($full.StartsWith('\\')){return '\\?\UNC\'+$full.Substring(2)};return '\\?\'+$full}
$atlasRequest=Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
$atlasRoot=[IO.Path]::GetFullPath($atlasRequest.root)
$atlasZip=[IO.Path]::GetFullPath($atlasRequest.zip)
$atlasPrefix=$atlasRoot.TrimEnd('\')+'\'
if (!$atlasZip.StartsWith($atlasPrefix,[StringComparison]::OrdinalIgnoreCase) -or $atlasRequest.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Atlas update request.' }
$atlasHash=[Security.Cryptography.SHA256]::Create()
$atlasStream=[IO.File]::OpenRead($atlasZip)
try {$atlasDigest=[BitConverter]::ToString($atlasHash.ComputeHash($atlasStream)).Replace('-','').ToLowerInvariant()} finally {$atlasStream.Dispose();$atlasHash.Dispose()}
if ($atlasDigest -ne $atlasRequest.sha256) { throw 'Update checksum changed.' }
$atlasOld=Get-Process -Id ([int]$atlasRequest.pid) -ErrorAction SilentlyContinue
if (!$ValidateOnly -and $atlasOld -and !$atlasOld.WaitForExit(60000)) { throw 'Atlas is still running.' }
$atlasSuffix=[Guid]::NewGuid().ToString('N')
$atlasStage=Join-Path $atlasRoot ('data\updates\stage-'+$atlasRequest.version+'-'+$atlasSuffix)
$atlasBackup=Join-Path $atlasRoot ('backups\app-'+[DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')+'-'+$atlasSuffix)
New-Item -ItemType Directory -Path $atlasStage -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $atlasBackup -ErrorAction Stop | Out-Null
$atlasArchive=[IO.Compression.ZipFile]::OpenRead($atlasZip)
$atlasFiles=[Collections.Generic.List[string]]::new()
$atlasSeen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$atlasTotal=0L
try {
 foreach ($atlasEntry in $atlasArchive.Entries) {
  $atlasRelative=$atlasEntry.FullName.Replace('/','\')
  if ($atlasRelative.StartsWith('Atlas\',[StringComparison]::Ordinal)) { $atlasRelative=$atlasRelative.Substring(6) }
  if (!$atlasRelative -or $atlasRelative.EndsWith('\')) { continue }
  if ($atlasRelative.Contains(':') -or $atlasRelative.StartsWith('\') -or $atlasRelative -match '(^|\\)\.\.?(\\|$)' -or $atlasRelative -match '^(data|custom|library|updates|backups)(\\|$)' -or $atlasRelative -match '[<>"|?*]' -or !$atlasSeen.Add($atlasRelative)) { throw 'Unsafe or duplicate application update path.' }
  foreach($atlasPart in $atlasRelative.Split('\')) {if(!$atlasPart -or $atlasPart -match '[. ]$' -or $atlasPart -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)' -or $atlasPart -match '[\x00-\x1f]'){throw 'Unsafe Windows application update path.'}}
  $atlasTarget=[IO.Path]::GetFullPath((Join-Path $atlasStage $atlasRelative))
  if (!$atlasTarget.StartsWith($atlasStage.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Update escapes staging folder.' }
  $atlasTotal+=$atlasEntry.Length
  if ($atlasTotal -gt 3GB -or $atlasEntry.Length -gt 1500MB -or $atlasFiles.Count -gt 60000) { throw 'Application update exceeds extraction limits.' }
  if($atlasRelative -eq 'atlas-build.json'){$atlasReader=[IO.StreamReader]::new($atlasEntry.Open());try{$atlasBuild=$atlasReader.ReadToEnd()|ConvertFrom-Json}finally{$atlasReader.Dispose()}}
  $atlasFiles.Add($atlasRelative)
  if($ValidateOnly){continue}
  [IO.Directory]::CreateDirectory((AtlasLongPath ([IO.Path]::GetDirectoryName($atlasTarget))))|Out-Null
  [IO.Compression.ZipFileExtensions]::ExtractToFile($atlasEntry,(AtlasLongPath $atlasTarget),$false)
 }
} finally { $atlasArchive.Dispose() }
if (!$atlasSeen.Contains('Atlas.exe') -or !$atlasSeen.Contains('resources\app.asar') -or !$atlasSeen.Contains('atlas-build.json')) { throw 'Update is not an Atlas portable application.' }
if($atlasBuild.version -ne $atlasRequest.version){throw 'Application version does not match its signed update metadata.'}
if($ValidateOnly){[pscustomobject]@{valid=$true;files=$atlasFiles.Count;version=$atlasBuild.version}|ConvertTo-Json -Compress;return}
$atlasMoved=[Collections.Generic.List[string]]::new()
try {
 foreach($atlasRelative in $atlasFiles) {
  $atlasTarget=[IO.Path]::GetFullPath((Join-Path $atlasRoot $atlasRelative))
  $atlasCheck=[IO.Path]::GetDirectoryName($atlasTarget)
  while($atlasCheck -and $atlasCheck -ne $atlasRoot) {
   if ([IO.Directory]::Exists((AtlasLongPath $atlasCheck)) -and ([IO.File]::GetAttributes((AtlasLongPath $atlasCheck)) -band [IO.FileAttributes]::ReparsePoint)) { throw 'Update destination contains a junction.' }
   $atlasCheck=[IO.Path]::GetDirectoryName($atlasCheck)
  }
  if ([IO.File]::Exists((AtlasLongPath $atlasTarget))) {
   if ([IO.File]::GetAttributes((AtlasLongPath $atlasTarget)) -band [IO.FileAttributes]::ReparsePoint) { throw 'Update destination contains a link.' }
   $atlasSaved=Join-Path $atlasBackup $atlasRelative
   [IO.Directory]::CreateDirectory((AtlasLongPath ([IO.Path]::GetDirectoryName($atlasSaved))))|Out-Null
   [IO.File]::Copy((AtlasLongPath $atlasTarget),(AtlasLongPath $atlasSaved),$false)
  }
  [IO.Directory]::CreateDirectory((AtlasLongPath ([IO.Path]::GetDirectoryName($atlasTarget))))|Out-Null
  $atlasMoved.Add($atlasRelative)
  [IO.File]::Copy((AtlasLongPath (Join-Path $atlasStage $atlasRelative)),(AtlasLongPath $atlasTarget),$true)
 }
} catch {
 foreach($atlasRelative in $atlasMoved) {
  $atlasSaved=Join-Path $atlasBackup $atlasRelative
  $atlasTarget=Join-Path $atlasRoot $atlasRelative
  if([IO.File]::Exists((AtlasLongPath $atlasSaved))){[IO.File]::Copy((AtlasLongPath $atlasSaved),(AtlasLongPath $atlasTarget),$true)}
  else{[IO.File]::Delete((AtlasLongPath $atlasTarget))}
 }
 throw
}
Set-Content -LiteralPath (Join-Path $atlasRoot 'data\updates\last-update.json') -Value ($atlasRequest | ConvertTo-Json)
if(!$NoRestart){
 $atlasPendingPath=Join-Path $atlasRoot 'data\updates\pending-startup.json'
 $atlasPending=@{root=$atlasRoot;backup=$atlasBackup;files=@($atlasFiles);version=$atlasRequest.version;token=[Guid]::NewGuid().ToString()}
 $atlasPending|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $atlasPendingPath
 $atlasLaunch=Start-Process -FilePath (Join-Path $atlasRoot 'Atlas.exe') -WindowStyle Hidden -PassThru
 $atlasWatcher=Join-Path $atlasRoot 'resources\atlas\watch-update.ps1'
 if(Test-Path -LiteralPath $atlasWatcher){Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$atlasWatcher+'"'),'-PendingPath',('"'+$atlasPendingPath+'"'),'-LaunchPid',$atlasLaunch.Id) -WindowStyle Hidden}
}
