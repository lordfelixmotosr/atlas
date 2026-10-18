# Windows runtime sync and recovery (0.2.26)

## What the evidence establishes

The original tool results contain EPERM at the candidate install rename and
at a rollback rename. The old implementation made each rename once. Its catch
block could throw the rollback exception instead of the installation exception.
It moved the only installed runtime out of Mods before attempting installation,
had no persistent transaction journal, and serialized only individual targets
inside one module instance. Sibling pruning and independent processes were not
covered by that queue. Staging inside Mods also exposed candidates/backups to
filesystem scans.

On the affected Windows installation, Mods and the affected existing mirrors
grant Authenticated Users Modify permission. A direct old-code refresh of
One-Piece Uniform succeeds with Atlas closed. A newly owned fixture under the
actual staging directory also passes both renames with a parent fs.watch active.
There is no evidence that Windows elevation is required. The historical log
does not record handles, the original exception during the rollback failure,
or a destination snapshot. It cannot identify which process held the original
lock. Claiming a particular watcher, antivirus or concurrent process caused all
three historical failures would go beyond the evidence.

Real Windows handles opened without FILE_SHARE_DELETE reproduce rename failures.
Tests cover persistent and transient DLL/directory locks, candidate installation,
blocked rollback, independent processes, and process death between renames.

## Transaction rules

- One reentrant queue covers the entire Mods root, including sibling pruning.
  An atomic directory lease also excludes independent processes. Dead leases
  are retired with a single reaper; their metadata is retained. Unknown/live
  leases time out after 60 seconds and report their path without being removed.
- Staging lives at `<RimWorld>/.atlas-release-stage/`, outside Mods. The candidate
  is copied and audited before changing the installed runtime. Its identity and
  the old identity are journaled before any rename.
- Sharing/permission/busy rename failures retry seven attempts over about 2.74
  seconds. Non-transient errors fail immediately. Logs include PID, operation,
  retry count and error code. Exhausted failures include the original error,
  rollback error, current destination identity and recovery directory.
- The previous copy remains in `mirror-*/previous` until installation and
  ownership/journal commit succeed. Failed candidates/journals are retained.
  If restoring by rename fails but reads remain allowed, a fresh copy restores
  the old runtime and the original backup stays in recovery storage.
- Recovery refuses to overwrite an independently changed destination. If the
  OS denies recovery reads/writes too, Atlas reports incomplete recovery and
  blocks the launch; it does not claim success or discard the backup.
- Startup/next sync recover journaled interrupted swaps. Old pre-journal
  backups are recovered only when their filesystem identity matches the
  recorded owned mirror. Missing recorded mirrors refresh before launch.
- Workspace scans during sync do not create or remove placeholder assets.
  A failed target installation cannot prune working sibling mirrors.

## Recovery paths

`mirror-*/transaction.json` records the source, destination, identities, phase,
original failure and rollback result. `previous` is the old runtime when it has
not already been renamed back; `runtime` is the staged or failed candidate.
Failed/recovered transactions are retained for inspection. Do not delete a
recovery directory until the runtime has been checked. Successful commits may
remove their superseded backup; cleanup failures retain and report it.

The affected machine also had an unmanaged, old AtlasBridge with 1.6 metadata
and a Harmony initialization failure on .NET 10. Its entire directory, including
its source/obj files, was retained outside Mods before installing the bundled
versioned runtime bridge. Managed bridge copies now refresh on test launch;
unmanaged and Workshop copies remain protected. This is separate from the
original mod-sync rename failure.

## Verification

82 regression checks passed on Windows, including real file/directory locks,
failed installation/rollback, cross-process serialization, crash recovery,
legacy recovery, runtime content filtering and managed bridge updates.
TypeScript checking passed. The release evidence records the actual
runRimworldTestCycle invocation, isolated savedata, game launch, bridge handshake,
diagnostic/log data and before/after preservation checks. This does not certify
every gameplay feature in the tested user mods or every older RimWorld version.

The actual Windows run used RimWorld 1.7.4981 and the real `runRimworldTestCycle` coordinator with `isolated: true` and `quicktest: true`. The bridge inventory confirmed House Targaryen, A Rim of Ice and Fire, Silvaran Order and One-Piece Uniform, plus Harmony and the installed DLCs. The real MonitorServer completed a handshake, produced mod snapshots and streamed performance diagnostics while ErrorBuffer was attached. The game log was read and retained as evidence. Workspace file hashes matched, Workshop size/mtime inventories matched, and normal ModsConfig.xml matched both before and after the owned test process exited. No model requests or Steam uploads were made.

An intermediate repeat compared against a stale Workshop snapshot and detected 174 changes in Embergarden (Workshop 3421959154). Steam workshop_log.txt records a new server manifest at 2026-10-18 16:41:11. No Atlas sync path writes that Workshop item. The final repeat used a fresh pre-launch inventory and passed the Workshop preservation check. Steam settings were not changed.
