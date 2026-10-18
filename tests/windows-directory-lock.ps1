Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class AtlasDirectoryLock {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
}
'@
# FILE_LIST_DIRECTORY, SHARE_READ|SHARE_WRITE, OPEN_EXISTING,
# FILE_FLAG_BACKUP_SEMANTICS; deliberately omit FILE_SHARE_DELETE.
$atlasTestHandle = [AtlasDirectoryLock]::CreateFile($env:ATLAS_LOCK_FIXTURE, 1, 3, [IntPtr]::Zero, 3, 0x02000000, [IntPtr]::Zero)
if ($atlasTestHandle.IsInvalid) { throw "CreateFile failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
try { [Console]::WriteLine('READY'); [Console]::ReadLine() | Out-Null }
finally { $atlasTestHandle.Dispose() }
