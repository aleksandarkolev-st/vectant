$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

function New-RefusalResult {
    param([Parameter(Mandatory = $true)][string] $Code)

    return [ordered]@{
        schemaVersion = 'synthi.native_windows_artifact_cas_snapshot.v1'
        authority = 'synthi.native_windows_cas_snapshot_only.v1'
        acceptedAsSnapshotEvidence = $false
        acceptedForGpuHmr = $false
        gpuHmrSuccess = $false
        canSatisfyRuntimeProof = $false
        canSatisfyDispatchProof = $false
        failures = @([ordered]@{
            code = $Code
            componentIndex = $null
            nativeStatus = $null
        })
        normalizedSupportPath = $null
        rootIdentity = $null
        componentIdentityChain = @()
        finalIdentity = $null
        byteLength = $null
        sha256 = $null
        finalObservation = $null
    }
}

function Write-ResultAndExit {
    param(
        [Parameter(Mandatory = $true)] $Result,
        [Parameter(Mandatory = $true)][int] $ExitCode
    )

    [Console]::Out.WriteLine(($Result | ConvertTo-Json -Compress -Depth 12))
    exit $ExitCode
}

# Parse a deliberately small CLI here so malformed input still produces exactly one JSON object.
$allowedArguments = @{
    '-AllowedRoot' = 'allowedRoot'
    '-RelativePath' = 'relativePath'
    '-ExpectedSha256' = 'expectedSha256'
    '-ExpectedByteLength' = 'expectedByteLength'
    '-MaxByteLength' = 'maxByteLength'
    '-TestPipeName' = 'testPipeName'
    '-TestHoldFinalHandleMilliseconds' = 'testHoldFinalHandleMilliseconds'
}
$parsed = @{}
for ($index = 0; $index -lt $args.Count; $index += 2) {
    if ($index + 1 -ge $args.Count) {
        Write-ResultAndExit (New-RefusalResult 'argument_value_missing') 2
    }
    $name = [string]$args[$index]
    if (-not $allowedArguments.ContainsKey($name)) {
        Write-ResultAndExit (New-RefusalResult 'argument_unknown') 2
    }
    $key = $allowedArguments[$name]
    if ($parsed.ContainsKey($key)) {
        Write-ResultAndExit (New-RefusalResult 'argument_duplicate') 2
    }
    $parsed[$key] = [string]$args[$index + 1]
}

if (-not $parsed.ContainsKey('allowedRoot') -or -not $parsed.ContainsKey('relativePath')) {
    Write-ResultAndExit (New-RefusalResult 'required_argument_missing') 2
}

if ($parsed.allowedRoot.Length -eq 0 -or $parsed.allowedRoot.Length -gt 32767) {
    Write-ResultAndExit (New-RefusalResult 'allowed_root_length_invalid') 2
}
if ($parsed.relativePath.Length -eq 0 -or $parsed.relativePath.Length -gt 32767) {
    Write-ResultAndExit (New-RefusalResult 'relative_path_length_invalid') 2
}

$expectedSha256 = $null
if ($parsed.ContainsKey('expectedSha256')) {
    if ($parsed.expectedSha256 -notmatch '^(?:sha256:)?[0-9A-Fa-f]{64}$') {
        Write-ResultAndExit (New-RefusalResult 'expected_sha256_invalid') 2
    }
    $expectedSha256 = $parsed.expectedSha256.ToLowerInvariant()
    if (-not $expectedSha256.StartsWith('sha256:', [StringComparison]::Ordinal)) {
        $expectedSha256 = 'sha256:' + $expectedSha256
    }
}

$expectedByteLength = $null
if ($parsed.ContainsKey('expectedByteLength')) {
    if ($parsed.expectedByteLength -notmatch '^(?:0|[1-9][0-9]{0,9})$') {
        Write-ResultAndExit (New-RefusalResult 'expected_byte_length_invalid') 2
    }
    $expectedByteLength = [long]::Parse($parsed.expectedByteLength, [Globalization.CultureInfo]::InvariantCulture)
    if ($expectedByteLength -gt 1073741824) {
        Write-ResultAndExit (New-RefusalResult 'expected_byte_length_out_of_range') 2
    }
}

$maxByteLength = 268435456L
if ($parsed.ContainsKey('maxByteLength')) {
    if ($parsed.maxByteLength -notmatch '^[1-9][0-9]{0,9}$') {
        Write-ResultAndExit (New-RefusalResult 'max_byte_length_invalid') 2
    }
    $maxByteLength = [long]::Parse($parsed.maxByteLength, [Globalization.CultureInfo]::InvariantCulture)
    if ($maxByteLength -gt 1073741824) {
        Write-ResultAndExit (New-RefusalResult 'max_byte_length_out_of_range') 2
    }
}
if ($null -ne $expectedByteLength -and $expectedByteLength -gt $maxByteLength) {
    Write-ResultAndExit (New-RefusalResult 'expected_byte_length_exceeds_maximum') 2
}

$testPipeName = $null
$testHoldFinalHandleMilliseconds = 0
$hasTestPipeName = $parsed.ContainsKey('testPipeName')
$hasTestHold = $parsed.ContainsKey('testHoldFinalHandleMilliseconds')
if ($hasTestPipeName -ne $hasTestHold) {
    Write-ResultAndExit (New-RefusalResult 'test_hook_arguments_incomplete') 2
}
if ($hasTestPipeName) {
    if ($parsed.testPipeName -notmatch '^synthi-cas-test-[0-9a-f]{32}$') {
        Write-ResultAndExit (New-RefusalResult 'test_pipe_name_invalid') 2
    }
    if ($parsed.testHoldFinalHandleMilliseconds -notmatch '^[1-9][0-9]{0,3}$') {
        Write-ResultAndExit (New-RefusalResult 'test_hold_milliseconds_invalid') 2
    }
    $testHoldFinalHandleMilliseconds = [int]::Parse(
        $parsed.testHoldFinalHandleMilliseconds,
        [Globalization.CultureInfo]::InvariantCulture
    )
    if ($testHoldFinalHandleMilliseconds -gt 5000) {
        Write-ResultAndExit (New-RefusalResult 'test_hold_milliseconds_out_of_range') 2
    }
    $testPipeName = $parsed.testPipeName
}

if ($env:OS -ne 'Windows_NT') {
    Write-ResultAndExit (New-RefusalResult 'windows_native_api_unavailable') 2
}

$nativeSource = @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Synthi.NativeWindowsArtifactCas
{
    public sealed class Failure
    {
        public string code { get; set; }
        public int? componentIndex { get; set; }
        public string nativeStatus { get; set; }
    }

    public class Identity
    {
        public string volumeSerialNumber { get; set; }
        public string fileId128 { get; set; }
    }

    public sealed class ChainIdentity : Identity
    {
        public int componentIndex { get; set; }
        public string component { get; set; }
        public bool directory { get; set; }
    }

    public sealed class State
    {
        public string endOfFile { get; set; }
        public string allocationSize { get; set; }
        public string creationTime { get; set; }
        public string lastAccessTime { get; set; }
        public string lastWriteTime { get; set; }
        public string changeTime { get; set; }
        public uint fileAttributes { get; set; }
        public uint numberOfLinks { get; set; }
        public bool deletePending { get; set; }
        public bool directory { get; set; }
    }

    public sealed class FinalObservation
    {
        public State before { get; set; }
        public State after { get; set; }
    }

    public sealed class SnapshotResult
    {
        public string schemaVersion { get; set; }
        public string authority { get; set; }
        public bool acceptedAsSnapshotEvidence { get; set; }
        public bool acceptedForGpuHmr { get; set; }
        public bool gpuHmrSuccess { get; set; }
        public bool canSatisfyRuntimeProof { get; set; }
        public bool canSatisfyDispatchProof { get; set; }
        public List<Failure> failures { get; set; }
        public string normalizedSupportPath { get; set; }
        public Identity rootIdentity { get; set; }
        public List<ChainIdentity> componentIdentityChain { get; set; }
        public Identity finalIdentity { get; set; }
        public long? byteLength { get; set; }
        public string sha256 { get; set; }
        public FinalObservation finalObservation { get; set; }
    }

    internal sealed class HandleObservation
    {
        internal Identity Identity;
        internal FILE_BASIC_INFO Basic;
        internal FILE_STANDARD_INFO Standard;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct UNICODE_STRING
    {
        internal ushort Length;
        internal ushort MaximumLength;
        internal IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct OBJECT_ATTRIBUTES
    {
        internal uint Length;
        internal IntPtr RootDirectory;
        internal IntPtr ObjectName;
        internal uint Attributes;
        internal IntPtr SecurityDescriptor;
        internal IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IO_STATUS_BLOCK
    {
        internal IntPtr Status;
        internal UIntPtr Information;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FILE_ATTRIBUTE_TAG_INFO
    {
        internal uint FileAttributes;
        internal uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FILE_ID_128
    {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)]
        internal byte[] Identifier;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FILE_ID_INFO
    {
        internal ulong VolumeSerialNumber;
        internal FILE_ID_128 FileId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FILE_BASIC_INFO
    {
        internal long CreationTime;
        internal long LastAccessTime;
        internal long LastWriteTime;
        internal long ChangeTime;
        internal uint FileAttributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct FILE_STANDARD_INFO
    {
        internal long AllocationSize;
        internal long EndOfFile;
        internal uint NumberOfLinks;
        [MarshalAs(UnmanagedType.U1)] internal bool DeletePending;
        [MarshalAs(UnmanagedType.U1)] internal bool Directory;
    }

    internal static class NativeMethods
    {
        internal const uint FILE_READ_ATTRIBUTES = 0x00000080;
        internal const uint FILE_TRAVERSE = 0x00000020;
        internal const uint SYNCHRONIZE = 0x00100000;
        internal const uint GENERIC_READ = 0x80000000;
        internal const uint FILE_SHARE_READ = 0x00000001;
        internal const uint FILE_SHARE_WRITE = 0x00000002;
        internal const uint FILE_SHARE_DELETE = 0x00000004;
        internal const uint OPEN_EXISTING = 3;
        internal const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        internal const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        internal const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        internal const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
        internal const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        internal const uint FILE_ATTRIBUTE_DEVICE = 0x00000040;
        internal const uint OBJ_CASE_INSENSITIVE = 0x00000040;
        internal const uint FILE_OPEN = 1;
        internal const uint FILE_DIRECTORY_FILE = 0x00000001;
        internal const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
        internal const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
        internal const uint FILE_TYPE_DISK = 1;
        internal const uint DRIVE_UNKNOWN = 0;
        internal const uint DRIVE_NO_ROOT_DIR = 1;
        internal const uint DRIVE_REMOTE = 4;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("ntdll.dll")]
        internal static extern int NtCreateFile(
            out SafeFileHandle fileHandle,
            uint desiredAccess,
            ref OBJECT_ATTRIBUTES objectAttributes,
            out IO_STATUS_BLOCK ioStatusBlock,
            IntPtr allocationSize,
            uint fileAttributes,
            uint shareAccess,
            uint createDisposition,
            uint createOptions,
            IntPtr eaBuffer,
            uint eaLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetFileInformationByHandleEx(
            SafeFileHandle fileHandle,
            int fileInformationClass,
            IntPtr fileInformation,
            uint bufferSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetFilePointerEx(
            SafeFileHandle fileHandle,
            long distanceToMove,
            out long newFilePointer,
            uint moveMethod);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool ReadFile(
            SafeFileHandle fileHandle,
            byte[] buffer,
            uint numberOfBytesToRead,
            out uint numberOfBytesRead,
            IntPtr overlapped);

        [DllImport("kernel32.dll")]
        internal static extern uint GetFileType(SafeFileHandle fileHandle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        internal static extern uint GetDriveTypeW(string rootPathName);
    }

    public static class Verifier
    {
        private const int FileBasicInfo = 0;
        private const int FileStandardInfo = 1;
        private const int FileAttributeTagInfo = 9;
        private const int FileIdInfo = 18;
        private const int MaxComponents = 1024;

        public static SnapshotResult Verify(
            string allowedRoot,
            string relativePath,
            string expectedSha256,
            long? expectedByteLength,
            long maxByteLength,
            string testPipeName,
            int testHoldFinalHandleMilliseconds)
        {
            if (String.IsNullOrEmpty(expectedSha256)) expectedSha256 = null;
            SnapshotResult result = EmptyResult();
            string[] components;
            string normalized;
            string lexicalFailure = ValidateRelativePath(relativePath, out components, out normalized);
            if (lexicalFailure != null)
            {
                AddFailure(result, lexicalFailure, null, null);
                return result;
            }
            result.normalizedSupportPath = normalized;

            string driveRoot;
            string[] allowedRootComponents;
            string rootFailure = ValidateRootPath(allowedRoot, out driveRoot, out allowedRootComponents);
            if (rootFailure != null)
            {
                AddFailure(result, rootFailure, null, null);
                return result;
            }

            List<SafeFileHandle> rootHandles = new List<SafeFileHandle>();
            List<HandleObservation> rootBefore = new List<HandleObservation>();
            List<SafeFileHandle> handles = new List<SafeFileHandle>();
            List<HandleObservation> before = new List<HandleObservation>();
            try
            {
                SafeFileHandle drive = NativeMethods.CreateFileW(
                    driveRoot,
                    NativeMethods.FILE_READ_ATTRIBUTES | NativeMethods.FILE_TRAVERSE | NativeMethods.SYNCHRONIZE,
                    NativeMethods.FILE_SHARE_READ | NativeMethods.FILE_SHARE_WRITE | NativeMethods.FILE_SHARE_DELETE,
                    IntPtr.Zero,
                    NativeMethods.OPEN_EXISTING,
                    NativeMethods.FILE_FLAG_BACKUP_SEMANTICS | NativeMethods.FILE_FLAG_OPEN_REPARSE_POINT,
                    IntPtr.Zero);
                if (drive == null || drive.IsInvalid)
                {
                    if (drive != null) drive.Dispose();
                    AddFailure(result, "allowed_root_open_failed", null, Win32Status());
                    return result;
                }
                rootHandles.Add(drive);

                string rootTagFailure = ReparseFailure(drive);
                if (rootTagFailure != null)
                {
                    AddFailure(result, "allowed_root_" + rootTagFailure, null, null);
                    return result;
                }
                HandleObservation driveObservation;
                string observationFailure = Observe(drive, out driveObservation);
                if (observationFailure != null)
                {
                    AddFailure(result, "allowed_root_" + observationFailure, null, Win32Status());
                    return result;
                }
                if (!driveObservation.Standard.Directory)
                {
                    AddFailure(result, "allowed_root_not_directory", null, null);
                    return result;
                }
                rootBefore.Add(driveObservation);

                for (int rootIndex = 0; rootIndex < allowedRootComponents.Length; rootIndex++)
                {
                    SafeFileHandle rootChild;
                    int rootStatus = OpenRelative(
                        rootHandles[rootHandles.Count - 1],
                        allowedRootComponents[rootIndex],
                        true,
                        out rootChild);
                    if (rootStatus != 0 || rootChild == null || rootChild.IsInvalid)
                    {
                        if (rootChild != null) rootChild.Dispose();
                        AddFailure(result, "allowed_root_component_open_failed", rootIndex, NtStatus(rootStatus));
                        return result;
                    }
                    rootHandles.Add(rootChild);
                    rootTagFailure = ReparseFailure(rootChild);
                    if (rootTagFailure != null)
                    {
                        AddFailure(result, "allowed_root_component_" + rootTagFailure, rootIndex, null);
                        return result;
                    }
                    HandleObservation rootChildObservation;
                    observationFailure = Observe(rootChild, out rootChildObservation);
                    if (observationFailure != null)
                    {
                        AddFailure(result, "allowed_root_component_" + observationFailure, rootIndex, Win32Status());
                        return result;
                    }
                    if (!rootChildObservation.Standard.Directory)
                    {
                        AddFailure(result, "allowed_root_component_not_directory", rootIndex, null);
                        return result;
                    }
                    if (rootChildObservation.Identity.volumeSerialNumber != driveObservation.Identity.volumeSerialNumber)
                    {
                        AddFailure(result, "allowed_root_component_volume_mismatch", rootIndex, null);
                        return result;
                    }
                    rootBefore.Add(rootChildObservation);
                }

                SafeFileHandle root = rootHandles[rootHandles.Count - 1];
                HandleObservation rootObservation = rootBefore[rootBefore.Count - 1];
                result.rootIdentity = rootObservation.Identity;

                for (int componentIndex = 0; componentIndex < components.Length; componentIndex++)
                {
                    bool directory = componentIndex < components.Length - 1;
                    SafeFileHandle child;
                    SafeFileHandle parent = componentIndex == 0 ? root : handles[componentIndex - 1];
                    int status = OpenRelative(parent, components[componentIndex], directory, out child);
                    if (status != 0 || child == null || child.IsInvalid)
                    {
                        if (child != null) child.Dispose();
                        AddFailure(result, "component_open_failed", componentIndex, NtStatus(status));
                        return result;
                    }
                    handles.Add(child);

                    string tagFailure = ReparseFailure(child);
                    if (tagFailure != null)
                    {
                        AddFailure(result, "component_" + tagFailure, componentIndex, null);
                        return result;
                    }
                    HandleObservation observation;
                    observationFailure = Observe(child, out observation);
                    if (observationFailure != null)
                    {
                        AddFailure(result, "component_" + observationFailure, componentIndex, Win32Status());
                        return result;
                    }
                    if (observation.Standard.Directory != directory)
                    {
                        AddFailure(result, directory ? "component_not_directory" : "final_not_regular_file", componentIndex, null);
                        return result;
                    }
                    if (!directory)
                    {
                        string finalTypeFailure = FinalRegularDiskFailure(child, observation);
                        if (finalTypeFailure != null)
                        {
                            AddFailure(result, finalTypeFailure, componentIndex, null);
                            return result;
                        }
                        if (observation.Standard.NumberOfLinks != 1)
                        {
                            AddFailure(result, "final_link_count_invalid", componentIndex, null);
                        }
                    }
                    if (observation.Identity.volumeSerialNumber != rootObservation.Identity.volumeSerialNumber)
                    {
                        AddFailure(result, "component_volume_mismatch", componentIndex, null);
                        return result;
                    }

                    before.Add(observation);
                    ChainIdentity chain = new ChainIdentity();
                    chain.componentIndex = componentIndex;
                    chain.component = components[componentIndex];
                    chain.directory = directory;
                    chain.volumeSerialNumber = observation.Identity.volumeSerialNumber;
                    chain.fileId128 = observation.Identity.fileId128;
                    result.componentIdentityChain.Add(chain);
                }

                SafeFileHandle finalHandle = handles[handles.Count - 1];
                HandleObservation finalBefore = before[before.Count - 1];
                result.finalIdentity = finalBefore.Identity;
                result.finalObservation = new FinalObservation();
                result.finalObservation.before = ToState(finalBefore);

                string testHookFailure = RunTestHandleHold(testPipeName, testHoldFinalHandleMilliseconds);
                if (testHookFailure != null)
                {
                    AddFailure(result, testHookFailure, components.Length - 1, null);
                    return result;
                }
                if (!String.IsNullOrEmpty(testPipeName))
                    AddFailure(result, "test_hook_active_non_authoritative", components.Length - 1, null);

                if (finalBefore.Standard.EndOfFile < 0 || finalBefore.Standard.EndOfFile > maxByteLength)
                {
                    AddFailure(result, "final_byte_length_exceeds_maximum", components.Length - 1, null);
                    return result;
                }

                long byteLength;
                string hash;
                string readFailure = HashHandle(finalHandle, maxByteLength, out byteLength, out hash);
                if (readFailure != null)
                {
                    AddFailure(result, readFailure, components.Length - 1, Win32Status());
                    return result;
                }
                result.byteLength = byteLength;
                result.sha256 = hash;

                if (expectedByteLength.HasValue && expectedByteLength.Value != byteLength)
                    AddFailure(result, "expected_byte_length_mismatch", components.Length - 1, null);
                if (expectedSha256 != null && !String.Equals(expectedSha256, hash, StringComparison.Ordinal))
                    AddFailure(result, "expected_sha256_mismatch", components.Length - 1, null);

                for (int rootHandleIndex = 0; rootHandleIndex < rootHandles.Count; rootHandleIndex++)
                {
                    string retainedRootTagFailure = ReparseFailure(rootHandles[rootHandleIndex]);
                    if (retainedRootTagFailure != null)
                    {
                        AddFailure(result, "post_read_allowed_root_" + retainedRootTagFailure, null, null);
                        continue;
                    }
                    HandleObservation rootAfter;
                    observationFailure = Observe(rootHandles[rootHandleIndex], out rootAfter);
                    if (observationFailure != null)
                    {
                        AddFailure(result, "post_read_allowed_root_" + observationFailure, null, Win32Status());
                        continue;
                    }
                    if (!SameIdentity(rootBefore[rootHandleIndex].Identity, rootAfter.Identity))
                        AddFailure(result, "allowed_root_retained_handle_identity_changed", null, null);
                }

                for (int handleIndex = 0; handleIndex < handles.Count; handleIndex++)
                {
                    int? component = handleIndex;
                    string retainedTagFailure = ReparseFailure(handles[handleIndex]);
                    if (retainedTagFailure != null)
                    {
                        AddFailure(result, "post_read_" + retainedTagFailure, component, null);
                        continue;
                    }
                    HandleObservation after;
                    observationFailure = Observe(handles[handleIndex], out after);
                    if (observationFailure != null)
                    {
                        AddFailure(result, "post_read_" + observationFailure, component, Win32Status());
                        continue;
                    }
                    if (handleIndex == handles.Count - 1)
                        result.finalObservation.after = ToState(after);
                    if (!SameIdentity(before[handleIndex].Identity, after.Identity))
                        AddFailure(result, "retained_handle_identity_changed", component, null);
                    if (!SameStableMetadata(before[handleIndex], after))
                        AddFailure(result, "retained_handle_metadata_changed", component, null);
                    if (handleIndex == handles.Count - 1)
                    {
                        string finalTypeFailure = FinalRegularDiskFailure(finalHandle, after);
                        if (finalTypeFailure != null)
                            AddFailure(result, finalTypeFailure, component, null);
                        if (after.Standard.NumberOfLinks != 1)
                            AddFailure(result, "final_link_count_invalid", component, null);
                        if (after.Standard.EndOfFile != byteLength)
                            AddFailure(result, "final_size_changed_during_snapshot", component, null);
                    }
                }

                // Re-resolve every name from its retained parent. No cumulative pathname is reopened.
                for (int rootIndex = 0; rootIndex < allowedRootComponents.Length; rootIndex++)
                {
                    SafeFileHandle reopenedRoot;
                    int rootStatus = OpenRelative(
                        rootHandles[rootIndex],
                        allowedRootComponents[rootIndex],
                        true,
                        out reopenedRoot);
                    if (rootStatus != 0 || reopenedRoot == null || reopenedRoot.IsInvalid)
                    {
                        if (reopenedRoot != null) reopenedRoot.Dispose();
                        AddFailure(result, "allowed_root_component_reopen_failed", rootIndex, NtStatus(rootStatus));
                        continue;
                    }
                    using (reopenedRoot)
                    {
                        string rootReopenTagFailure = ReparseFailure(reopenedRoot);
                        if (rootReopenTagFailure != null)
                        {
                            AddFailure(result, "allowed_root_component_reopen_" + rootReopenTagFailure, rootIndex, null);
                            continue;
                        }
                        HandleObservation reopenedRootObservation;
                        observationFailure = Observe(reopenedRoot, out reopenedRootObservation);
                        if (observationFailure != null)
                        {
                            AddFailure(result, "allowed_root_component_reopen_" + observationFailure, rootIndex, Win32Status());
                            continue;
                        }
                        if (!SameIdentity(rootBefore[rootIndex + 1].Identity, reopenedRootObservation.Identity))
                            AddFailure(result, "allowed_root_component_entry_identity_changed", rootIndex, null);
                        if (!reopenedRootObservation.Standard.Directory)
                            AddFailure(result, "allowed_root_component_reopen_not_directory", rootIndex, null);
                    }
                }

                for (int componentIndex = 0; componentIndex < components.Length; componentIndex++)
                {
                    bool directory = componentIndex < components.Length - 1;
                    SafeFileHandle reopened;
                    SafeFileHandle parent = componentIndex == 0
                        ? rootHandles[rootHandles.Count - 1]
                        : handles[componentIndex - 1];
                    int status = OpenRelative(parent, components[componentIndex], directory, out reopened);
                    if (status != 0 || reopened == null || reopened.IsInvalid)
                    {
                        if (reopened != null) reopened.Dispose();
                        AddFailure(result, "component_reopen_failed", componentIndex, NtStatus(status));
                        continue;
                    }
                    using (reopened)
                    {
                        string tagFailure = ReparseFailure(reopened);
                        if (tagFailure != null)
                        {
                            AddFailure(result, "component_reopen_" + tagFailure, componentIndex, null);
                            continue;
                        }
                        HandleObservation reopenedObservation;
                        observationFailure = Observe(reopened, out reopenedObservation);
                        if (observationFailure != null)
                        {
                            AddFailure(result, "component_reopen_" + observationFailure, componentIndex, Win32Status());
                            continue;
                        }
                        if (!SameIdentity(before[componentIndex].Identity, reopenedObservation.Identity))
                            AddFailure(result, "component_entry_identity_changed", componentIndex, null);
                        if (!SameStableMetadata(before[componentIndex], reopenedObservation))
                            AddFailure(result, "component_entry_metadata_changed", componentIndex, null);
                        if (directory != reopenedObservation.Standard.Directory)
                            AddFailure(result, directory ? "component_reopen_not_directory" : "final_not_regular_file", componentIndex, null);
                        if (!directory)
                        {
                            string finalTypeFailure = FinalRegularDiskFailure(reopened, reopenedObservation);
                            if (finalTypeFailure != null)
                                AddFailure(result, finalTypeFailure, componentIndex, null);
                            if (reopenedObservation.Standard.NumberOfLinks != 1)
                                AddFailure(result, "final_link_count_invalid", componentIndex, null);
                        }
                    }
                }

                if (result.failures.Count == 0)
                    result.acceptedAsSnapshotEvidence = true;
                return result;
            }
            catch
            {
                AddFailure(result, "native_verifier_internal_failure", null, null);
                return result;
            }
            finally
            {
                for (int index = handles.Count - 1; index >= 0; index--)
                    handles[index].Dispose();
                for (int index = rootHandles.Count - 1; index >= 0; index--)
                    rootHandles[index].Dispose();
            }
        }

        private static SnapshotResult EmptyResult()
        {
            SnapshotResult result = new SnapshotResult();
            result.schemaVersion = "synthi.native_windows_artifact_cas_snapshot.v1";
            result.authority = "synthi.native_windows_cas_snapshot_only.v1";
            result.acceptedAsSnapshotEvidence = false;
            result.acceptedForGpuHmr = false;
            result.gpuHmrSuccess = false;
            result.canSatisfyRuntimeProof = false;
            result.canSatisfyDispatchProof = false;
            result.failures = new List<Failure>();
            result.componentIdentityChain = new List<ChainIdentity>();
            return result;
        }

        private static void AddFailure(SnapshotResult result, string code, int? componentIndex, string nativeStatus)
        {
            Failure failure = new Failure();
            failure.code = code;
            failure.componentIndex = componentIndex;
            failure.nativeStatus = nativeStatus;
            result.failures.Add(failure);
        }

        private static string ValidateRootPath(
            string root,
            out string driveRoot,
            out string[] components)
        {
            driveRoot = null;
            components = null;
            if (String.IsNullOrEmpty(root) || root.Length > 32767 || root.IndexOf('\0') >= 0)
                return "allowed_root_invalid";
            bool driveAbsolute = root.Length >= 3 && Char.IsLetter(root[0]) && root[1] == ':' &&
                (root[2] == '\\' || root[2] == '/');
            bool uncAbsolute = root.StartsWith(@"\\", StringComparison.Ordinal) &&
                root.Length > 2 && root[2] != '\\' && root[2] != '/';
            if (uncAbsolute)
                return "allowed_root_unc_rejected";
            if (!driveAbsolute)
                return "allowed_root_not_absolute";
            if (root.StartsWith(@"\\?\", StringComparison.Ordinal) ||
                root.StartsWith(@"\\.\", StringComparison.Ordinal) ||
                root.StartsWith(@"\??\", StringComparison.Ordinal))
                return "allowed_root_device_path_rejected";
            string normalized;
            try
            {
                normalized = Path.GetFullPath(root).Replace('/', '\\');
                driveRoot = Path.GetPathRoot(normalized);
            }
            catch
            {
                return "allowed_root_invalid";
            }
            if (String.IsNullOrEmpty(driveRoot) || driveRoot.Length != 3 ||
                !Char.IsLetter(driveRoot[0]) || driveRoot[1] != ':' || driveRoot[2] != '\\')
                return "allowed_root_drive_root_invalid";
            uint driveType = NativeMethods.GetDriveTypeW(driveRoot);
            if (driveType == NativeMethods.DRIVE_REMOTE)
                return "allowed_root_remote_drive_rejected";
            if (driveType == NativeMethods.DRIVE_UNKNOWN || driveType == NativeMethods.DRIVE_NO_ROOT_DIR)
                return "allowed_root_drive_type_unavailable";

            string relative = normalized.Substring(driveRoot.Length).TrimEnd('\\');
            if (relative.Length == 0)
            {
                components = new string[0];
                return null;
            }
            components = relative.Split(new char[] { '\\' }, StringSplitOptions.None);
            if (components.Length > MaxComponents)
                return "allowed_root_component_count_invalid";
            foreach (string component in components)
            {
                if (component.Length == 0 || component == "." || component == "..")
                    return "allowed_root_component_invalid";
                if (component.Length > 255)
                    return "allowed_root_component_too_long";
                if (component.IndexOf(':') >= 0 || IsReservedDosDeviceName(component))
                    return "allowed_root_component_ambiguous";
                char last = component[component.Length - 1];
                if (last == '.' || last == ' ')
                    return "allowed_root_component_ambiguous_suffix_rejected";
                foreach (char value in component)
                {
                    if (value < 32 || value == '"' || value == '<' || value == '>' ||
                        value == '|' || value == '*' || value == '?')
                        return "allowed_root_component_escaping_syntax_rejected";
                }
            }
            return null;
        }

        private static string ValidateRelativePath(string path, out string[] components, out string normalized)
        {
            components = null;
            normalized = null;
            if (String.IsNullOrEmpty(path) || path.Length > 32767)
                return "relative_path_invalid";
            if (path.IndexOf('\0') >= 0)
                return "relative_path_nul_rejected";
            if (Path.IsPathRooted(path) || path[0] == '\\' || path[0] == '/' ||
                (path.Length >= 2 && Char.IsLetter(path[0]) && path[1] == ':'))
                return "relative_path_absolute_rejected";
            if (path.IndexOf(':') >= 0)
                return "relative_path_ads_rejected";

            components = path.Split(new char[] { '\\', '/' }, StringSplitOptions.None);
            if (components.Length == 0 || components.Length > MaxComponents)
                return "relative_path_component_count_invalid";
            foreach (string component in components)
            {
                if (component.Length == 0)
                    return "relative_path_empty_component_rejected";
                if (component == "." || component == "..")
                    return "relative_path_traversal_rejected";
                if (component.Length > 255)
                    return "relative_path_component_too_long";
                if (IsReservedDosDeviceName(component))
                    return "relative_path_reserved_name_rejected";
                char last = component[component.Length - 1];
                if (last == '.' || last == ' ')
                    return "relative_path_ambiguous_suffix_rejected";
                foreach (char value in component)
                {
                    if (value < 32 || value == '"' || value == '<' || value == '>' ||
                        value == '|' || value == '*' || value == '?')
                        return "relative_path_escaping_syntax_rejected";
                }
            }
            normalized = String.Join("/", components);
            return null;
        }

        private static bool IsReservedDosDeviceName(string component)
        {
            int dot = component.IndexOf('.');
            string baseName = dot < 0 ? component : component.Substring(0, dot);
            string upper = baseName.ToUpperInvariant();
            if (upper == "CON" || upper == "PRN" || upper == "AUX" || upper == "NUL")
                return true;
            if (upper.Length == 4 && (upper.StartsWith("COM", StringComparison.Ordinal) || upper.StartsWith("LPT", StringComparison.Ordinal)))
                return upper[3] >= '1' && upper[3] <= '9';
            return false;
        }

        private static int OpenRelative(SafeFileHandle parent, string component, bool directory, out SafeFileHandle child)
        {
            child = null;
            IntPtr nameBuffer = IntPtr.Zero;
            IntPtr unicodePointer = IntPtr.Zero;
            try
            {
                byte[] bytes = Encoding.Unicode.GetBytes(component);
                nameBuffer = Marshal.AllocHGlobal(bytes.Length + 2);
                Marshal.Copy(bytes, 0, nameBuffer, bytes.Length);
                Marshal.WriteInt16(nameBuffer, bytes.Length, 0);
                UNICODE_STRING unicode = new UNICODE_STRING();
                unicode.Length = checked((ushort)bytes.Length);
                unicode.MaximumLength = checked((ushort)(bytes.Length + 2));
                unicode.Buffer = nameBuffer;
                unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
                Marshal.StructureToPtr(unicode, unicodePointer, false);

                OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES();
                attributes.Length = (uint)Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));
                attributes.RootDirectory = parent.DangerousGetHandle();
                attributes.ObjectName = unicodePointer;
                attributes.Attributes = NativeMethods.OBJ_CASE_INSENSITIVE;

                IO_STATUS_BLOCK io;
                uint access = NativeMethods.FILE_READ_ATTRIBUTES | NativeMethods.SYNCHRONIZE;
                uint options = NativeMethods.FILE_SYNCHRONOUS_IO_NONALERT | NativeMethods.FILE_OPEN_REPARSE_POINT;
                if (directory)
                {
                    access |= NativeMethods.FILE_TRAVERSE;
                    options |= NativeMethods.FILE_DIRECTORY_FILE;
                }
                else
                {
                    access |= NativeMethods.GENERIC_READ;
                }
                uint shareAccess = directory
                    ? NativeMethods.FILE_SHARE_READ | NativeMethods.FILE_SHARE_WRITE | NativeMethods.FILE_SHARE_DELETE
                    : NativeMethods.FILE_SHARE_READ;
                return NativeMethods.NtCreateFile(
                    out child,
                    access,
                    ref attributes,
                    out io,
                    IntPtr.Zero,
                    NativeMethods.FILE_ATTRIBUTE_NORMAL,
                    shareAccess,
                    NativeMethods.FILE_OPEN,
                    options,
                    IntPtr.Zero,
                    0);
            }
            finally
            {
                if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
                if (nameBuffer != IntPtr.Zero) Marshal.FreeHGlobal(nameBuffer);
            }
        }

        private static string RunTestHandleHold(string pipeName, int holdMilliseconds)
        {
            if (String.IsNullOrEmpty(pipeName) && holdMilliseconds == 0) return null;
            if (String.IsNullOrEmpty(pipeName) || holdMilliseconds < 1 || holdMilliseconds > 5000)
                return "test_hook_arguments_invalid";
            try
            {
                using (NamedPipeServerStream ready = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.Out,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous))
                {
                    IAsyncResult connection = ready.BeginWaitForConnection(null, null);
                    if (!connection.AsyncWaitHandle.WaitOne(5000))
                        return "test_ready_signal_timeout";
                    ready.EndWaitForConnection(connection);
                    ready.WriteByte(1);
                    ready.Flush();
                    Thread.Sleep(holdMilliseconds);
                }
            }
            catch
            {
                return "test_ready_signal_failed";
            }
            return null;
        }

        private static string ReparseFailure(SafeFileHandle handle)
        {
            FILE_ATTRIBUTE_TAG_INFO info;
            if (!Query(handle, FileAttributeTagInfo, out info))
                return "reparse_info_query_failed";
            if ((info.FileAttributes & NativeMethods.FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.ReparseTag != 0)
                return "reparse_point_rejected";
            return null;
        }

        private static string FinalRegularDiskFailure(SafeFileHandle handle, HandleObservation observation)
        {
            if (observation.Standard.Directory ||
                (observation.Basic.FileAttributes & (NativeMethods.FILE_ATTRIBUTE_DIRECTORY | NativeMethods.FILE_ATTRIBUTE_DEVICE)) != 0 ||
                NativeMethods.GetFileType(handle) != NativeMethods.FILE_TYPE_DISK)
                return "final_not_regular_file";
            return null;
        }

        private static string Observe(SafeFileHandle handle, out HandleObservation observation)
        {
            observation = null;
            FILE_ID_INFO id;
            if (!Query(handle, FileIdInfo, out id)) return "file_id_query_failed";
            FILE_BASIC_INFO basic;
            if (!Query(handle, FileBasicInfo, out basic)) return "basic_info_query_failed";
            FILE_STANDARD_INFO standard;
            if (!Query(handle, FileStandardInfo, out standard)) return "standard_info_query_failed";
            if (id.FileId.Identifier == null || id.FileId.Identifier.Length != 16)
                return "file_id_128_invalid";

            observation = new HandleObservation();
            observation.Identity = new Identity();
            observation.Identity.volumeSerialNumber = id.VolumeSerialNumber.ToString("x16", CultureInfo.InvariantCulture);
            observation.Identity.fileId128 = Hex(id.FileId.Identifier);
            observation.Basic = basic;
            observation.Standard = standard;
            return null;
        }

        private static bool Query<T>(SafeFileHandle handle, int informationClass, out T value) where T : struct
        {
            int size = Marshal.SizeOf(typeof(T));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                for (int index = 0; index < size; index++) Marshal.WriteByte(buffer, index, 0);
                if (!NativeMethods.GetFileInformationByHandleEx(handle, informationClass, buffer, (uint)size))
                {
                    value = default(T);
                    return false;
                }
                value = (T)Marshal.PtrToStructure(buffer, typeof(T));
                return true;
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }

        private static string HashHandle(SafeFileHandle handle, long maximum, out long byteLength, out string hash)
        {
            byteLength = 0;
            hash = null;
            long position;
            if (!NativeMethods.SetFilePointerEx(handle, 0, out position, 0))
                return "final_seek_failed";
            byte[] buffer = new byte[65536];
            using (SHA256 sha = SHA256.Create())
            {
                while (true)
                {
                    uint read;
                    if (!NativeMethods.ReadFile(handle, buffer, (uint)buffer.Length, out read, IntPtr.Zero))
                        return "final_read_failed";
                    if (read == 0) break;
                    byteLength = checked(byteLength + read);
                    if (byteLength > maximum)
                        return "final_byte_length_exceeds_maximum";
                    sha.TransformBlock(buffer, 0, (int)read, null, 0);
                }
                sha.TransformFinalBlock(new byte[0], 0, 0);
                hash = "sha256:" + Hex(sha.Hash);
            }
            return null;
        }

        private static State ToState(HandleObservation observation)
        {
            State state = new State();
            state.endOfFile = observation.Standard.EndOfFile.ToString(CultureInfo.InvariantCulture);
            state.allocationSize = observation.Standard.AllocationSize.ToString(CultureInfo.InvariantCulture);
            state.creationTime = observation.Basic.CreationTime.ToString(CultureInfo.InvariantCulture);
            state.lastAccessTime = observation.Basic.LastAccessTime.ToString(CultureInfo.InvariantCulture);
            state.lastWriteTime = observation.Basic.LastWriteTime.ToString(CultureInfo.InvariantCulture);
            state.changeTime = observation.Basic.ChangeTime.ToString(CultureInfo.InvariantCulture);
            state.fileAttributes = observation.Basic.FileAttributes;
            state.numberOfLinks = observation.Standard.NumberOfLinks;
            state.deletePending = observation.Standard.DeletePending;
            state.directory = observation.Standard.Directory;
            return state;
        }

        private static bool SameIdentity(Identity left, Identity right)
        {
            return left != null && right != null &&
                String.Equals(left.volumeSerialNumber, right.volumeSerialNumber, StringComparison.Ordinal) &&
                String.Equals(left.fileId128, right.fileId128, StringComparison.Ordinal);
        }

        private static bool SameStableMetadata(HandleObservation left, HandleObservation right)
        {
            // ReadFile may advance LastAccessTime; every other reported basic and standard field is immutable here.
            return left != null && right != null &&
                left.Basic.CreationTime == right.Basic.CreationTime &&
                left.Basic.LastWriteTime == right.Basic.LastWriteTime &&
                left.Basic.ChangeTime == right.Basic.ChangeTime &&
                left.Basic.FileAttributes == right.Basic.FileAttributes &&
                left.Standard.AllocationSize == right.Standard.AllocationSize &&
                left.Standard.EndOfFile == right.Standard.EndOfFile &&
                left.Standard.NumberOfLinks == right.Standard.NumberOfLinks &&
                left.Standard.DeletePending == right.Standard.DeletePending &&
                left.Standard.Directory == right.Standard.Directory;
        }

        private static string Hex(byte[] bytes)
        {
            StringBuilder builder = new StringBuilder(bytes.Length * 2);
            foreach (byte value in bytes) builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            return builder.ToString();
        }

        private static string NtStatus(int status)
        {
            return "ntstatus:0x" + unchecked((uint)status).ToString("x8", CultureInfo.InvariantCulture);
        }

        private static string Win32Status()
        {
            return "win32:" + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture);
        }
    }
}
'@

try {
    if ($null -eq ('Synthi.NativeWindowsArtifactCas.Verifier' -as [type])) {
        Add-Type -TypeDefinition $nativeSource -Language CSharp -ErrorAction Stop
    }
    $nativeResult = [Synthi.NativeWindowsArtifactCas.Verifier]::Verify(
        $parsed.allowedRoot,
        $parsed.relativePath,
        $expectedSha256,
        $expectedByteLength,
        $maxByteLength,
        $testPipeName,
        $testHoldFinalHandleMilliseconds
    )
    Write-ResultAndExit $nativeResult $(if ($nativeResult.acceptedAsSnapshotEvidence) { 0 } else { 2 })
} catch {
    Write-ResultAndExit (New-RefusalResult 'native_verifier_initialization_failed') 2
}
