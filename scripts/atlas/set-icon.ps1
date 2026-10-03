param([Parameter(Mandatory=$true)][string]$ExePath,[Parameter(Mandatory=$true)][string]$IconPath)
$ErrorActionPreference='Stop'
$atlasProductVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../package.json') -Raw | ConvertFrom-Json).version
Add-Type @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class AtlasIconResources {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr BeginUpdateResource(string file,bool deleteExisting);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateResource(IntPtr handle,IntPtr type,IntPtr name,ushort language,byte[] data,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool EndUpdateResource(IntPtr handle,bool discard);
 static void Align(MemoryStream stream) {while((stream.Length%4)!=0)stream.WriteByte(0);}
 static byte[] Block(string key,ushort valueLength,ushort kind,byte[] value,params byte[][] children) {
  using(var stream=new MemoryStream()) {
   stream.Write(new byte[6],0,6);byte[] keyBytes=Encoding.Unicode.GetBytes(key+"\0");stream.Write(keyBytes,0,keyBytes.Length);Align(stream);
   stream.Write(value,0,value.Length);foreach(var child in children){Align(stream);stream.Write(child,0,child.Length);}
   byte[] bytes=stream.ToArray();if(bytes.Length>65535)throw new InvalidDataException("Version resource too large");
   Buffer.BlockCopy(BitConverter.GetBytes((ushort)bytes.Length),0,bytes,0,2);Buffer.BlockCopy(BitConverter.GetBytes(valueLength),0,bytes,2,2);Buffer.BlockCopy(BitConverter.GetBytes(kind),0,bytes,4,2);return bytes;
  }
 }
 static byte[] Version(string version) {
  string[] pieces=version.Split('.');uint major=uint.Parse(pieces[0]),minor=uint.Parse(pieces[1]),patch=uint.Parse(pieces[2]);
  var strings=new List<byte[]>();
  foreach(var pair in new[]{new[]{"CompanyName","Felix"},new[]{"FileDescription","Atlas portable modding workbench"},new[]{"FileVersion",version+".0"},new[]{"InternalName","Atlas"},new[]{"OriginalFilename","Atlas.exe"},new[]{"ProductName","Atlas"},new[]{"ProductVersion",version},new[]{"LegalCopyright","Atlas modifications (C) 2026 Felix. Upstream notices in LICENSE and NOTICE."}}) {
   byte[] value=Encoding.Unicode.GetBytes(pair[1]+"\0");strings.Add(Block(pair[0],(ushort)(value.Length/2),1,value));
  }
  byte[] table=Block("040904b0",0,1,new byte[0],strings.ToArray());
  byte[] stringInfo=Block("StringFileInfo",0,1,new byte[0],table);
  byte[] translation=Block("Translation",4,0,new byte[]{0x09,0x04,0xb0,0x04});
  byte[] varInfo=Block("VarFileInfo",0,1,new byte[0],translation);
  uint[] fixedValues={0xfeef04bd,0x00010000,(major<<16)|minor,patch<<16,(major<<16)|minor,patch<<16,0x3f,0,0x00040004,1,0,0,0};
  byte[] fixedInfo=new byte[52];for(int i=0;i<fixedValues.Length;i++)Buffer.BlockCopy(BitConverter.GetBytes(fixedValues[i]),0,fixedInfo,i*4,4);
  return Block("VS_VERSION_INFO",52,0,fixedInfo,stringInfo,varInfo);
 }
 public static void Set(string file,string icon,string version) {
  byte[] bytes=File.ReadAllBytes(icon);
  ushort count=BitConverter.ToUInt16(bytes,4);
  byte[] group=new byte[6+14*count];Buffer.BlockCopy(bytes,0,group,0,6);
  IntPtr handle=BeginUpdateResource(file,false);if(handle==IntPtr.Zero)throw new Win32Exception();
  bool success=false;
  try { for(int i=0;i<count;i++){int source=6+i*16,target=6+i*14;Buffer.BlockCopy(bytes,source,group,target,12);ushort id=(ushort)(200+i);Buffer.BlockCopy(BitConverter.GetBytes(id),0,group,target+12,2);uint size=BitConverter.ToUInt32(bytes,source+8),offset=BitConverter.ToUInt32(bytes,source+12);byte[] image=new byte[size];Buffer.BlockCopy(bytes,(int)offset,image,0,(int)size);if(!UpdateResource(handle,(IntPtr)3,(IntPtr)id,1033,image,size))throw new Win32Exception();}
   if(!UpdateResource(handle,(IntPtr)14,(IntPtr)1,1033,group,(uint)group.Length))throw new Win32Exception();
   byte[] versionBytes=Version(version);if(!UpdateResource(handle,(IntPtr)16,(IntPtr)1,1033,versionBytes,(uint)versionBytes.Length))throw new Win32Exception();success=true;
  } finally {if(!EndUpdateResource(handle,!success))throw new Win32Exception();}
 }
}
'@
[AtlasIconResources]::Set([IO.Path]::GetFullPath($ExePath),[IO.Path]::GetFullPath($IconPath),$atlasProductVersion)
