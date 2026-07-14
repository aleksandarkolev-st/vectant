//go:build linux

package main

import (
	"bufio"
	stdbytes "bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	launcherSchema        = "synthi.gpu_hmr.cold_build_static_launcher.v3"
	specSchema            = "synthi.gpu_hmr.cold_build_launcher_spec.v3"
	identitySchema        = "synthi.gpu_hmr.cold_build_child_identity.v1"
	readySchema           = "synthi.gpu_hmr.cold_build_ready_receipt.v2"
	collectorSchema       = "synthi.gpu_hmr.cold_build_collector_receipt.v1"
	collectorDoneSchema   = "synthi.gpu_hmr.cold_build_collector_completion.v1"
	releaseSchema         = "synthi.gpu_hmr.cold_build_release_receipt.v1"
	diagnosticAckSchema   = "synthi.gpu_hmr.cold_build_diagnostic_ack.v1"
	finalSchema           = "synthi.gpu_hmr.cold_build_final_receipt.v1"
	finalAckSchema        = "synthi.gpu_hmr.cold_build_final_ack.v1"
	frameMagic            = "SYNTHI-COLD-BUILD-COLLECT-V1\n"
	controlFrameMagic     = "SYNTHI-COLD-BUILD-CONTROL-V1\n"
	defaultSpecPath       = "/synthi-spec/spec.json"
	sourceRoot            = "/workspace/source"
	outputRoot            = "/workspace/build"
	controlRoot           = "/synthi-control"
	releaseRoot           = "/synthi-release"
	outputManifestPath    = "synthi-cold-build-output-manifest.json"
	outputManifestSchema  = "synthi.gpu_hmr.cold_build_output_manifest.v1"
	commandProvidedMode   = "command_provided"
	launcherGeneratedMode = "launcher_generated"
	readyControlName      = "ready.json"
	collectorControlName  = "collector-complete.json"
	finalControlName      = "final.json"
	stdoutDiagnosticName  = "command-stdout.tail"
	stderrDiagnosticName  = "command-stderr.tail"
	childUID              = 65532
	childGID              = 65532
	maxSpecBytes          = 1024 * 1024
	maxControlBytes       = 1024 * 1024
	maxDiagnosticBytes    = 64 * 1024
	maxOutputManifest     = 1024 * 1024
	maxOutputLabelBytes   = 160
	maxCollectorHeader    = 64 * 1024 * 1024
	diagnosticAckTimeout  = 2 * time.Second
	processTermGrace      = 500 * time.Millisecond
	processKillGrace      = 2 * time.Second
	processPollInterval   = 10 * time.Millisecond
	releasePollInterval   = 50 * time.Millisecond
	protocolFailureExit   = 125
	commandTimeoutExit    = 124
	commandNotFoundExit   = 127
	childReceiptFD        = 3
	prSetChildSubreaper   = 36
	prGetDumpable         = 3
	prSetDumpable         = 4
	prSetNoNewPrivs       = 38
	prCapBsetDrop         = 24
	prCapAmbient          = 47
	prCapAmbientClearAll  = 4
	queryFilesystemID     = ^uint32(0)
)

type launcherSpec struct {
	SchemaVersion                  string           `json:"schemaVersion"`
	ExecutionNonce                 string           `json:"executionNonce"`
	ExpectedLauncherExecutableHash string           `json:"expectedLauncherExecutableHash"`
	CommandSpecHash                string           `json:"commandSpecHash"`
	SourceBindingHash              string           `json:"sourceBindingHash"`
	Command                        []string         `json:"command"`
	Environment                    []string         `json:"environment"`
	WorkingDirectory               string           `json:"workingDirectory"`
	CommandUID                     int              `json:"commandUid"`
	CommandGID                     int              `json:"commandGid"`
	SourceRoot                     string           `json:"sourceRoot"`
	OutputRoot                     string           `json:"outputRoot"`
	ControlRoot                    string           `json:"controlRoot"`
	ReleaseRoot                    string           `json:"releaseRoot"`
	OutputManifestPath             string           `json:"outputManifestPath"`
	OutputManifestMode             string           `json:"outputManifestMode"`
	DeclaredOutputs                []declaredOutput `json:"declaredOutputs"`
	CommandTimeoutMillis           int64            `json:"commandTimeoutMillis"`
	ReleaseTimeoutMillis           int64            `json:"releaseTimeoutMillis"`
	WorkspaceByteLimit             int64            `json:"workspaceByteLimit"`
	WorkspaceEntryLimit            int              `json:"workspaceEntryLimit"`
	CollectedByteLimit             int64            `json:"collectedByteLimit"`
	CollectedEntryLimit            int              `json:"collectedEntryLimit"`
	ProcessTermGraceMillis         int64            `json:"processTermGraceMillis"`
	ProcessKillGraceMillis         int64            `json:"processKillGraceMillis"`
}

type diagnosticAck struct {
	SchemaVersion    string `json:"schemaVersion"`
	ExecutionNonce   string `json:"executionNonce"`
	SpecHash         string `json:"specHash"`
	ReadyReceiptHash string `json:"readyReceiptHash"`
}

type declaredOutput struct {
	Path         string `json:"path"`
	Role         string `json:"role"`
	ArtifactKind string `json:"artifactKind"`
	MediaType    string `json:"mediaType"`
}

type childIdentityReceipt struct {
	SchemaVersion  string   `json:"schemaVersion"`
	ExecutionNonce string   `json:"executionNonce"`
	UIDs           []int    `json:"uids"`
	GIDs           []int    `json:"gids"`
	Groups         []int    `json:"groups"`
	CapInheritable string   `json:"capInheritable"`
	CapPermitted   string   `json:"capPermitted"`
	CapEffective   string   `json:"capEffective"`
	CapBounding    string   `json:"capBounding"`
	CapAmbient     string   `json:"capAmbient"`
	NoNewPrivs     int      `json:"noNewPrivs"`
	Dumpable       int      `json:"dumpable"`
	Accepted       bool     `json:"accepted"`
	FailedChecks   []string `json:"failedChecks"`
}

type streamReceipt struct {
	ByteLength  int64  `json:"byteLength"`
	ContentHash string `json:"contentHash"`
}

type countingWriter struct {
	Writer     io.Writer
	ByteLength int64
}

func (writer *countingWriter) Write(bytes []byte) (int, error) {
	written, err := writer.Writer.Write(bytes)
	writer.ByteLength += int64(written)
	return written, err
}

type processTreeReceipt struct {
	DirectChildPID      int   `json:"directChildPid"`
	InitialResidualPIDs []int `json:"initialResidualPids"`
	TermSignalCount     int   `json:"termSignalCount"`
	KillSignalCount     int   `json:"killSignalCount"`
	ReapedChildCount    int   `json:"reapedChildCount"`
	FinalResidualPIDs   []int `json:"finalResidualPids"`
	Quiescent           bool  `json:"quiescent"`
}

type collectedEntry struct {
	Path        string `json:"path"`
	ByteLength  int64  `json:"byteLength"`
	ContentHash string `json:"contentHash"`
	Mode        uint32 `json:"mode"`
}

type outputSnapshot struct {
	SchemaVersion       string           `json:"schemaVersion"`
	ExecutionNonce      string           `json:"executionNonce"`
	SpecHash            string           `json:"specHash"`
	WorkspaceEntryCount int              `json:"workspaceEntryCount"`
	WorkspaceByteLength int64            `json:"workspaceByteLength"`
	CollectedByteLength int64            `json:"collectedByteLength"`
	Entries             []collectedEntry `json:"entries"`
}

type readyReceipt struct {
	SchemaVersion              string             `json:"schemaVersion"`
	LauncherSchemaVersion      string             `json:"launcherSchemaVersion"`
	LauncherExecutableSelfHash string             `json:"launcherExecutableSelfHash"`
	ExecutionNonce             string             `json:"executionNonce"`
	SpecHash                   string             `json:"specHash"`
	CommandSpecHash            string             `json:"commandSpecHash"`
	SourceBindingHash          string             `json:"sourceBindingHash"`
	ChildIdentityReceiptHash   string             `json:"childIdentityReceiptHash"`
	ChildIdentityAccepted      bool               `json:"childIdentityAccepted"`
	ChildExitCode              int                `json:"childExitCode"`
	CommandTimedOut            bool               `json:"commandTimedOut"`
	CommandStdout              streamReceipt      `json:"commandStdout"`
	CommandStderr              streamReceipt      `json:"commandStderr"`
	ProcessTree                processTreeReceipt `json:"processTree"`
	OutputSnapshotAccepted     bool               `json:"outputSnapshotAccepted"`
	OutputSnapshotHash         string             `json:"outputSnapshotHash"`
	OutputEntryCount           int                `json:"outputEntryCount"`
	OutputByteLength           int64              `json:"outputByteLength"`
	LauncherElapsedNanos       int64              `json:"launcherElapsedNanos"`
	ProtocolAccepted           bool               `json:"protocolAccepted"`
	BlockingGaps               []string           `json:"blockingGaps"`
}

type collectorReceipt struct {
	SchemaVersion       string           `json:"schemaVersion"`
	ExecutionNonce      string           `json:"executionNonce"`
	SpecHash            string           `json:"specHash"`
	ReadyReceiptHash    string           `json:"readyReceiptHash"`
	OutputSnapshotHash  string           `json:"outputSnapshotHash"`
	CollectedByteLength int64            `json:"collectedByteLength"`
	Entries             []collectedEntry `json:"entries"`
}

type collectorCompletionReceipt struct {
	SchemaVersion        string `json:"schemaVersion"`
	ExecutionNonce       string `json:"executionNonce"`
	SpecHash             string `json:"specHash"`
	ReadyReceiptHash     string `json:"readyReceiptHash"`
	OutputSnapshotHash   string `json:"outputSnapshotHash"`
	CollectorReceiptHash string `json:"collectorReceiptHash"`
	CollectorFrameHash   string `json:"collectorFrameHash"`
	CollectorFrameBytes  int64  `json:"collectorFrameByteLength"`
}

type releaseReceipt struct {
	SchemaVersion                  string `json:"schemaVersion"`
	ExecutionNonce                 string `json:"executionNonce"`
	SpecHash                       string `json:"specHash"`
	ReadyReceiptHash               string `json:"readyReceiptHash"`
	OutputSnapshotHash             string `json:"outputSnapshotHash"`
	CollectorCompletionReceiptHash string `json:"collectorCompletionReceiptHash"`
	CollectorReceiptHash           string `json:"collectorReceiptHash"`
	CollectorFrameHash             string `json:"collectorFrameHash"`
	CollectorFrameBytes            int64  `json:"collectorFrameByteLength"`
	HostReceiptHash                string `json:"hostReceiptHash"`
}

type finalReceipt struct {
	SchemaVersion                  string `json:"schemaVersion"`
	ExecutionNonce                 string `json:"executionNonce"`
	SpecHash                       string `json:"specHash"`
	ReadyReceiptHash               string `json:"readyReceiptHash"`
	ReleaseReceiptHash             string `json:"releaseReceiptHash"`
	CollectorCompletionReceiptHash string `json:"collectorCompletionReceiptHash"`
	CollectorReceiptHash           string `json:"collectorReceiptHash"`
	CollectorFrameHash             string `json:"collectorFrameHash"`
	CollectorFrameBytes            int64  `json:"collectorFrameByteLength"`
	HostReceiptHash                string `json:"hostReceiptHash"`
	ChildExitCode                  int    `json:"childExitCode"`
	ProtocolAccepted               bool   `json:"protocolAccepted"`
}

type finalAck struct {
	SchemaVersion    string `json:"schemaVersion"`
	ExecutionNonce   string `json:"executionNonce"`
	SpecHash         string `json:"specHash"`
	FinalReceiptHash string `json:"finalReceiptHash"`
}

type outputManifestProjection struct {
	Outputs []struct {
		Path string `json:"path"`
	} `json:"outputs"`
}

type outputManifestEntry struct {
	Path         string `json:"path"`
	Role         string `json:"role"`
	ArtifactKind string `json:"artifactKind"`
	MediaType    string `json:"mediaType"`
	ContentHash  string `json:"contentHash"`
	ByteLength   int64  `json:"byteLength"`
}

type outputManifest struct {
	SchemaVersion          string                `json:"schemaVersion"`
	CommandSpecHash        string                `json:"commandSpecHash"`
	SourceBindingHash      string                `json:"sourceBindingHash"`
	AcceptedForGPUHMR      bool                  `json:"acceptedForGpuHmr"`
	GPUHMRSuccess          bool                  `json:"gpuHmrSuccess"`
	CanSatisfyRuntimeProof bool                  `json:"canSatisfyRuntimeProof"`
	Outputs                []outputManifestEntry `json:"outputs"`
}

func main() {
	if len(os.Args) < 2 {
		fatalf("mode missing")
	}
	mode := os.Args[1]
	var err error
	switch mode {
	case "version":
		var executableHash string
		executableHash, err = hashSelfExecutable()
		if err == nil {
			err = writeJSON(os.Stdout, map[string]any{
				"schemaVersion":       launcherSchema,
				"collectorFrameMagic": frameMagic,
				"executableSelfHash":  executableHash,
			})
		}
	case "run":
		err = runMain(specPathFromArgs(os.Args[2:]))
	case "child":
		err = childMain(specPathFromArgs(os.Args[2:]))
	case "read-control":
		err = readControlMain(specPathFromArgs(os.Args[2:]), valueFromArgs(os.Args[2:], "--name"))
	case "collect":
		err = collectMain(specPathFromArgs(os.Args[2:]))
	default:
		err = fmt.Errorf("unsupported mode %q", mode)
	}
	if err != nil {
		fatalf("%v", err)
	}
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "cold-build-launcher: "+format+"\n", args...)
	os.Exit(protocolFailureExit)
}

func specPathFromArgs(args []string) string {
	value := valueFromArgs(args, "--spec")
	if value == "" {
		return defaultSpecPath
	}
	return value
}

func valueFromArgs(args []string, name string) string {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == name {
			return args[index+1]
		}
	}
	return ""
}

func readSpec(specPath string) (launcherSpec, []byte, string, error) {
	var spec launcherSpec
	bytes, err := readBoundedRegularFile(specPath, maxSpecBytes)
	if err != nil {
		return spec, nil, "", fmt.Errorf("read spec: %w", err)
	}
	if err := decodeStrictJSON(bytes, &spec); err != nil {
		return spec, nil, "", fmt.Errorf("decode spec: %w", err)
	}
	if err := validateSpec(spec); err != nil {
		return spec, nil, "", err
	}
	return spec, bytes, hashBytes(bytes), nil
}

func validateSpec(spec launcherSpec) error {
	if spec.SchemaVersion != specSchema {
		return errors.New("spec schema invalid")
	}
	if !isHex(spec.ExecutionNonce, 32) {
		return errors.New("execution nonce invalid")
	}
	if !isSHA256(spec.ExpectedLauncherExecutableHash) ||
		!isSHA256(spec.CommandSpecHash) || !isSHA256(spec.SourceBindingHash) {
		return errors.New("spec proof binding invalid")
	}
	observedExecutableHash, err := hashSelfExecutable()
	if err != nil {
		return fmt.Errorf("hash launcher executable: %w", err)
	}
	if observedExecutableHash != spec.ExpectedLauncherExecutableHash {
		return errors.New("launcher executable hash mismatch")
	}
	if len(spec.Command) < 1 || len(spec.Command) > 257 {
		return errors.New("command argv count invalid")
	}
	for _, value := range spec.Command {
		if value == "" || strings.ContainsRune(value, '\x00') || len(value) > 32768 {
			return errors.New("command argv value invalid")
		}
	}
	if len(spec.Environment) > 160 {
		return errors.New("environment count invalid")
	}
	seenEnvironment := map[string]bool{}
	for _, value := range spec.Environment {
		separator := strings.IndexByte(value, '=')
		if separator < 1 || strings.ContainsRune(value, '\x00') || len(value) > 65536 {
			return errors.New("environment value invalid")
		}
		name := value[:separator]
		if seenEnvironment[name] || !isEnvironmentName(name) {
			return errors.New("environment name invalid or duplicated")
		}
		seenEnvironment[name] = true
	}
	if spec.CommandUID != childUID || spec.CommandGID != childGID {
		return errors.New("command identity invalid")
	}
	if spec.SourceRoot != sourceRoot || spec.OutputRoot != outputRoot ||
		spec.ControlRoot != controlRoot || spec.ReleaseRoot != releaseRoot ||
		spec.OutputManifestPath != outputManifestPath {
		return errors.New("protocol path invalid")
	}
	cleanWorkingDirectory := filepath.Clean(spec.WorkingDirectory)
	if cleanWorkingDirectory != spec.WorkingDirectory ||
		(cleanWorkingDirectory != sourceRoot && !strings.HasPrefix(cleanWorkingDirectory, sourceRoot+string(os.PathSeparator))) {
		return errors.New("working directory escapes source root")
	}
	if spec.CommandTimeoutMillis < 1000 || spec.CommandTimeoutMillis > 2*60*60*1000 {
		return errors.New("command timeout invalid")
	}
	if spec.ReleaseTimeoutMillis < 1000 || spec.ReleaseTimeoutMillis > 10*60*1000 {
		return errors.New("release timeout invalid")
	}
	if spec.WorkspaceByteLimit < 1024*1024 || spec.WorkspaceEntryLimit < 1 ||
		spec.CollectedByteLimit < 1 || spec.CollectedByteLimit > spec.WorkspaceByteLimit ||
		spec.CollectedEntryLimit < 2 || spec.CollectedEntryLimit > spec.WorkspaceEntryLimit {
		return errors.New("output bounds invalid")
	}
	switch spec.OutputManifestMode {
	case commandProvidedMode:
		if len(spec.DeclaredOutputs) != 0 {
			return errors.New("command-provided output manifest cannot have declared outputs")
		}
	case launcherGeneratedMode:
		if len(spec.DeclaredOutputs) < 1 || len(spec.DeclaredOutputs) > spec.CollectedEntryLimit-1 {
			return errors.New("declared output count invalid")
		}
		seenPaths := map[string]bool{spec.OutputManifestPath: true}
		for _, output := range spec.DeclaredOutputs {
			relativePath, err := validateRelativeOutputPath(output.Path, spec.OutputManifestPath)
			if err != nil {
				return fmt.Errorf("declared output path invalid: %w", err)
			}
			if seenPaths[relativePath] {
				return errors.New("declared output path duplicated")
			}
			seenPaths[relativePath] = true
			if !isBoundedOutputLabel(output.Role) ||
				!isBoundedOutputLabel(output.ArtifactKind) ||
				!isBoundedOutputLabel(output.MediaType) {
				return errors.New("declared output metadata invalid")
			}
		}
	default:
		return errors.New("output manifest mode invalid")
	}
	if spec.ProcessTermGraceMillis != processTermGrace.Milliseconds() ||
		spec.ProcessKillGraceMillis != processKillGrace.Milliseconds() {
		return errors.New("process cleanup policy invalid")
	}
	return nil
}

func runMain(specPath string) error {
	started := time.Now()
	os.Clearenv()
	spec, _, specHash, err := readSpec(specPath)
	if err != nil {
		return err
	}
	launcherExecutableHash, err := hashSelfExecutable()
	if err != nil {
		return fmt.Errorf("hash launcher executable: %w", err)
	}
	if os.Getpid() != 1 || os.Geteuid() != 0 || os.Getegid() != 0 {
		return errors.New("launcher must run as root PID 1")
	}
	if err := prctl(prSetChildSubreaper, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("enable subreaper: %w", err)
	}
	if err := prctl(prSetDumpable, 0, 0, 0, 0); err != nil {
		return fmt.Errorf("disable launcher dumpability: %w", err)
	}
	if err := os.MkdirAll(spec.ControlRoot, 0700); err != nil {
		return fmt.Errorf("prepare control root: %w", err)
	}
	if err := os.Chmod(spec.ControlRoot, 0700); err != nil {
		return fmt.Errorf("harden control root: %w", err)
	}

	receiptReader, receiptWriter, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("create child identity pipe: %w", err)
	}
	selfPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("resolve launcher executable: %w", err)
	}
	child := exec.Command(selfPath, "child", "--spec", specPath)
	child.ExtraFiles = []*os.File{receiptWriter}
	stdoutReader, stdoutWriter, err := os.Pipe()
	if err != nil {
		return fmt.Errorf("create child stdout pipe: %w", err)
	}
	stderrReader, stderrWriter, err := os.Pipe()
	if err != nil {
		stdoutReader.Close()
		stdoutWriter.Close()
		return fmt.Errorf("create child stderr pipe: %w", err)
	}
	devNull, err := os.OpenFile("/dev/null", os.O_RDONLY, 0)
	if err != nil {
		receiptReader.Close()
		receiptWriter.Close()
		stdoutReader.Close()
		stdoutWriter.Close()
		stderrReader.Close()
		stderrWriter.Close()
		return fmt.Errorf("open child stdin null device: %w", err)
	}
	defer devNull.Close()
	child.Stdin = devNull
	child.Stdout = stdoutWriter
	child.Stderr = stderrWriter
	child.Env = []string{}
	child.Dir = "/"
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		receiptReader.Close()
		receiptWriter.Close()
		stdoutReader.Close()
		stdoutWriter.Close()
		stderrReader.Close()
		stderrWriter.Close()
		return fmt.Errorf("start child launcher: %w", err)
	}
	stdoutChannel := hashStream(
		stdoutReader,
		filepath.Join(spec.ControlRoot, stdoutDiagnosticName),
	)
	stderrChannel := hashStream(
		stderrReader,
		filepath.Join(spec.ControlRoot, stderrDiagnosticName),
	)
	receiptWriter.Close()
	stdoutWriter.Close()
	stderrWriter.Close()
	receiptChannel := make(chan []byte, 1)
	go func() {
		bytes, _ := io.ReadAll(io.LimitReader(receiptReader, maxControlBytes+1))
		receiptReader.Close()
		receiptChannel <- bytes
	}()
	waitChannel := make(chan error, 1)
	go func() { waitChannel <- child.Wait() }()
	commandTimedOut := false
	var waitError error
	select {
	case waitError = <-waitChannel:
	case <-time.After(time.Duration(spec.CommandTimeoutMillis) * time.Millisecond):
		commandTimedOut = true
		_ = signalNamespace(syscall.SIGTERM)
		select {
		case waitError = <-waitChannel:
		case <-time.After(processTermGrace):
			_ = signalNamespace(syscall.SIGKILL)
			select {
			case waitError = <-waitChannel:
			case <-time.After(processKillGrace):
				waitError = errors.New("child wait exceeded post-kill bound")
			}
		}
	}
	childExitCode := processExitCode(waitError, commandTimedOut)
	processTree := quiesceNamespace(child.Process.Pid)
	identityBytes := awaitIdentityReceipt(receiptChannel, receiptReader, processKillGrace)
	identityReceipt, identityAccepted := validateChildIdentityReceipt(identityBytes, spec.ExecutionNonce)
	identityReceiptHash := hashBytes(identityBytes)
	if len(identityBytes) == 0 {
		identityReceiptHash = ""
	}
	stdoutReceipt := awaitStreamReceipt(stdoutChannel, stdoutReader, processKillGrace)
	stderrReceipt := awaitStreamReceipt(stderrChannel, stderrReader, processKillGrace)
	var snapshot outputSnapshot
	var snapshotHash string
	var snapshotErr error
	var generatedManifest outputManifest
	if processTree.Quiescent {
		if spec.OutputManifestMode == launcherGeneratedMode {
			generatedManifest, snapshotErr = publishLauncherGeneratedOutputManifest(spec)
		}
		if snapshotErr == nil {
			snapshot, snapshotHash, snapshotErr = buildOutputSnapshot(spec, specHash)
		}
		if snapshotErr == nil && spec.OutputManifestMode == launcherGeneratedMode {
			if err := validateGeneratedManifestSnapshot(spec, generatedManifest, snapshot); err != nil {
				snapshotHash = ""
				snapshotErr = err
			}
		}
	} else {
		snapshotErr = errors.New("output snapshot requires a quiescent process tree")
	}
	if snapshotErr != nil {
		fmt.Fprintf(os.Stderr, "cold-build output snapshot refused: %q\n", snapshotErr.Error())
	}
	blockingGaps := uniqueSorted([]string{
		gap(!identityAccepted, "child_identity_unproven"),
		gap(stdoutReceipt.ByteLength < 0 || !isSHA256(stdoutReceipt.ContentHash), "command_stdout_capture_failed"),
		gap(stderrReceipt.ByteLength < 0 || !isSHA256(stderrReceipt.ContentHash), "command_stderr_capture_failed"),
		gap(!processTree.Quiescent, "process_tree_not_quiescent"),
		gap(snapshotErr != nil, "output_snapshot_invalid"),
	})
	ready := readyReceipt{
		SchemaVersion:              readySchema,
		LauncherSchemaVersion:      launcherSchema,
		LauncherExecutableSelfHash: launcherExecutableHash,
		ExecutionNonce:             spec.ExecutionNonce,
		SpecHash:                   specHash,
		CommandSpecHash:            spec.CommandSpecHash,
		SourceBindingHash:          spec.SourceBindingHash,
		ChildIdentityReceiptHash:   identityReceiptHash,
		ChildIdentityAccepted:      identityAccepted,
		ChildExitCode:              childExitCode,
		CommandTimedOut:            commandTimedOut,
		CommandStdout:              stdoutReceipt,
		CommandStderr:              stderrReceipt,
		ProcessTree:                processTree,
		OutputSnapshotAccepted:     snapshotErr == nil,
		OutputSnapshotHash:         snapshotHash,
		LauncherElapsedNanos:       time.Since(started).Nanoseconds(),
		ProtocolAccepted:           len(blockingGaps) == 0,
		BlockingGaps:               blockingGaps,
	}
	if snapshotErr == nil {
		ready.OutputEntryCount = len(snapshot.Entries)
		ready.OutputByteLength = snapshot.CollectedByteLength
	}
	readyBytes, err := json.Marshal(ready)
	if err != nil {
		return fmt.Errorf("encode ready receipt: %w", err)
	}
	readyHash := hashBytes(readyBytes)
	if err := writeAtomic(filepath.Join(spec.ControlRoot, readyControlName), readyBytes, 0600); err != nil {
		return fmt.Errorf("write ready receipt: %w", err)
	}
	if err := writeFramedControlReceipt(os.Stdout, readyBytes); err != nil {
		return fmt.Errorf("publish ready receipt: %w", err)
	}
	var release releaseReceipt
	var releaseBytes []byte
	var releaseErr error
	if ready.ProtocolAccepted {
		release, releaseBytes, releaseErr = waitForRelease(
			spec,
			specHash,
			readyHash,
			snapshotHash,
		)
	} else {
		// Keep the stopped command namespace available briefly so the host can
		// retrieve root-owned, bounded diagnostics before container shutdown.
		_ = waitForDiagnosticAck(spec, specHash, readyHash)
		releaseErr = errors.New("ready receipt refused")
	}
	protocolAccepted := ready.ProtocolAccepted && releaseErr == nil
	final := finalReceipt{
		SchemaVersion:    finalSchema,
		ExecutionNonce:   spec.ExecutionNonce,
		SpecHash:         specHash,
		ReadyReceiptHash: readyHash,
		ChildExitCode:    childExitCode,
		ProtocolAccepted: protocolAccepted,
	}
	if releaseErr == nil {
		final.ReleaseReceiptHash = hashBytes(releaseBytes)
		final.CollectorCompletionReceiptHash = release.CollectorCompletionReceiptHash
		final.CollectorReceiptHash = release.CollectorReceiptHash
		final.CollectorFrameHash = release.CollectorFrameHash
		final.CollectorFrameBytes = release.CollectorFrameBytes
		final.HostReceiptHash = release.HostReceiptHash
	}
	finalBytes, marshalErr := json.Marshal(final)
	if marshalErr != nil {
		return fmt.Errorf("encode final receipt: %w", marshalErr)
	}
	if err := writeAtomic(filepath.Join(spec.ControlRoot, finalControlName), finalBytes, 0600); err != nil {
		return fmt.Errorf("write final receipt: %w", err)
	}
	_ = identityReceipt
	if !protocolAccepted {
		if releaseErr != nil {
			fmt.Fprintf(os.Stderr, "cold-build-launcher: release refused: %v\n", releaseErr)
		}
		os.Exit(protocolFailureExit)
	}
	if err := waitForFinalAck(spec, specHash, hashBytes(finalBytes)); err != nil {
		fmt.Fprintf(os.Stderr, "cold-build-launcher: final ack refused: %v\n", err)
		os.Exit(protocolFailureExit)
	}
	os.Exit(childExitCode)
	return nil
}

func childMain(specPath string) error {
	// Linux capability and no_new_privs state is thread-local until exec.
	runtime.LockOSThread()
	spec, _, _, err := readSpec(specPath)
	if err != nil {
		return err
	}
	receiptFile := os.NewFile(childReceiptFD, "child-identity-receipt")
	if receiptFile == nil {
		return errors.New("child identity receipt descriptor missing")
	}
	if err := dropChildPrivileges(spec.CommandUID, spec.CommandGID); err != nil {
		return err
	}
	_, resolvedWorkingDirectory, err := resolveDirectoryWithin(
		spec.SourceRoot,
		spec.WorkingDirectory,
	)
	if err != nil {
		return fmt.Errorf("resolve command working directory: %w", err)
	}
	receipt, err := currentIdentityReceipt(spec.ExecutionNonce)
	if err != nil {
		return err
	}
	bytes, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if _, err := receiptFile.Write(bytes); err != nil {
		return fmt.Errorf("write child identity receipt: %w", err)
	}
	if err := receiptFile.Close(); err != nil {
		return fmt.Errorf("close child identity receipt: %w", err)
	}
	if !receipt.Accepted {
		return fmt.Errorf("child identity checks failed: %s", strings.Join(receipt.FailedChecks, ","))
	}
	if err := os.Chdir(resolvedWorkingDirectory); err != nil {
		return fmt.Errorf("enter command working directory: %w", err)
	}
	executable, err := lookPath(spec.Command[0], spec.Environment)
	if err != nil {
		fmt.Fprintf(os.Stderr, "cold-build-launcher: command resolution failed: %v\n", err)
		os.Exit(commandNotFoundExit)
	}
	return syscall.Exec(executable, spec.Command, spec.Environment)
}

func resolveDirectoryWithin(rootPath, candidatePath string) (string, string, error) {
	resolvedRoot, err := filepath.EvalSymlinks(rootPath)
	if err != nil {
		return "", "", err
	}
	resolvedCandidate, err := filepath.EvalSymlinks(candidatePath)
	if err != nil {
		return "", "", err
	}
	rootMetadata, err := os.Stat(resolvedRoot)
	if err != nil || !rootMetadata.IsDir() {
		return "", "", errors.New("source root is not a directory")
	}
	candidateMetadata, err := os.Stat(resolvedCandidate)
	if err != nil || !candidateMetadata.IsDir() {
		return "", "", errors.New("working directory is not a directory")
	}
	relative, err := filepath.Rel(resolvedRoot, resolvedCandidate)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return "", "", errors.New("working directory resolves outside source root")
	}
	return resolvedRoot, resolvedCandidate, nil
}

func dropChildPrivileges(uid, gid int) error {
	lastCapabilityBytes, err := os.ReadFile("/proc/sys/kernel/cap_last_cap")
	if err != nil {
		return fmt.Errorf("read cap_last_cap: %w", err)
	}
	lastCapability, err := strconv.Atoi(strings.TrimSpace(string(lastCapabilityBytes)))
	if err != nil || lastCapability < 0 || lastCapability > 255 {
		return errors.New("cap_last_cap invalid")
	}
	if err := prctl(prCapAmbient, prCapAmbientClearAll, 0, 0, 0); err != nil && !errors.Is(err, syscall.EINVAL) {
		return fmt.Errorf("clear ambient capabilities: %w", err)
	}
	for capability := 0; capability <= lastCapability; capability++ {
		if err := prctl(prCapBsetDrop, uintptr(capability), 0, 0, 0); err != nil {
			return fmt.Errorf("drop capability %d from bounding set: %w", capability, err)
		}
	}
	if err := syscall.Setgroups([]int{}); err != nil {
		return fmt.Errorf("clear supplementary groups: %w", err)
	}
	if err := prctl(prSetNoNewPrivs, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("set no_new_privs: %w", err)
	}
	if err := syscall.Setresgid(gid, gid, gid); err != nil {
		return fmt.Errorf("set child gid: %w", err)
	}
	if err := syscall.Setresuid(uid, uid, uid); err != nil {
		return fmt.Errorf("set child uid: %w", err)
	}
	if err := prctl(prSetDumpable, 0, 0, 0, 0); err != nil {
		return fmt.Errorf("disable child dumpability: %w", err)
	}
	syscall.Umask(0022)
	return nil
}

func currentIdentityReceipt(nonce string) (childIdentityReceipt, error) {
	status, err := parseProcStatus("/proc/thread-self/status")
	if err != nil {
		return childIdentityReceipt{}, err
	}
	receipt := childIdentityReceipt{
		SchemaVersion:  identitySchema,
		ExecutionNonce: nonce,
		UIDs:           parseIntegerFields(status["Uid"]),
		GIDs:           parseIntegerFields(status["Gid"]),
		Groups:         parseIntegerFields(status["Groups"]),
		CapInheritable: status["CapInh"],
		CapPermitted:   status["CapPrm"],
		CapEffective:   status["CapEff"],
		CapBounding:    status["CapBnd"],
		CapAmbient:     status["CapAmb"],
		NoNewPrivs:     firstIntegerField(status["NoNewPrivs"]),
	}
	receipt.Dumpable, err = prctlResult(prGetDumpable, 0, 0, 0, 0)
	if err != nil {
		return childIdentityReceipt{}, fmt.Errorf("read child dumpability: %w", err)
	}
	receipt.FailedChecks = uniqueSorted([]string{
		gap(!allIntegersEqual(receipt.UIDs, childUID, 4), "uid_not_dropped"),
		gap(!allIntegersEqual(receipt.GIDs, childGID, 4), "gid_not_dropped"),
		gap(len(receipt.Groups) != 0, "supplementary_groups_present"),
		gap(!allZeroCapabilityFields(receipt), "capabilities_present"),
		gap(receipt.NoNewPrivs != 1, "no_new_privs_missing"),
		gap(receipt.Dumpable != 0, "process_dumpable"),
	})
	receipt.Accepted = len(receipt.FailedChecks) == 0
	return receipt, nil
}

func validateChildIdentityReceipt(bytes []byte, nonce string) (childIdentityReceipt, bool) {
	var receipt childIdentityReceipt
	if len(bytes) == 0 || len(bytes) > maxControlBytes || json.Unmarshal(bytes, &receipt) != nil {
		return receipt, false
	}
	accepted := receipt.SchemaVersion == identitySchema &&
		receipt.ExecutionNonce == nonce &&
		receipt.Accepted &&
		len(receipt.FailedChecks) == 0 &&
		allIntegersEqual(receipt.UIDs, childUID, 4) &&
		allIntegersEqual(receipt.GIDs, childGID, 4) &&
		len(receipt.Groups) == 0 &&
		allZeroCapabilityFields(receipt) &&
		receipt.NoNewPrivs == 1 &&
		receipt.Dumpable == 0
	return receipt, accepted
}

type boundedTailWriter struct {
	bytes    []byte
	maxBytes int
}

func (writer *boundedTailWriter) Write(bytes []byte) (int, error) {
	written := len(bytes)
	if writer.maxBytes <= 0 || written == 0 {
		return written, nil
	}
	if written >= writer.maxBytes {
		writer.bytes = append(writer.bytes[:0], bytes[written-writer.maxBytes:]...)
		return written, nil
	}
	overflow := len(writer.bytes) + written - writer.maxBytes
	if overflow > 0 {
		copy(writer.bytes, writer.bytes[overflow:])
		writer.bytes = writer.bytes[:len(writer.bytes)-overflow]
	}
	writer.bytes = append(writer.bytes, bytes...)
	return written, nil
}

func (writer *boundedTailWriter) snapshot() []byte {
	return append([]byte(nil), writer.bytes...)
}

func hashStream(reader *os.File, diagnosticPath string) <-chan streamReceipt {
	result := make(chan streamReceipt, 1)
	go func() {
		defer reader.Close()
		hasher := sha256.New()
		tail := &boundedTailWriter{maxBytes: maxDiagnosticBytes}
		byteLength, err := io.Copy(io.MultiWriter(hasher, tail), reader)
		if err != nil {
			result <- streamReceipt{ByteLength: -1, ContentHash: ""}
			return
		}
		// Diagnostics are support-only. Failure to publish them must not change the
		// authoritative full-stream receipt or cold-build acceptance semantics.
		_ = writeAtomic(diagnosticPath, tail.snapshot(), 0600)
		result <- streamReceipt{
			ByteLength:  byteLength,
			ContentHash: "sha256:" + hex.EncodeToString(hasher.Sum(nil)),
		}
	}()
	return result
}

func awaitIdentityReceipt(
	channel <-chan []byte,
	reader *os.File,
	timeout time.Duration,
) []byte {
	select {
	case bytes := <-channel:
		return bytes
	case <-time.After(timeout):
		reader.Close()
		select {
		case bytes := <-channel:
			return bytes
		case <-time.After(processPollInterval * 10):
			return nil
		}
	}
}

func awaitStreamReceipt(
	channel <-chan streamReceipt,
	reader *os.File,
	timeout time.Duration,
) streamReceipt {
	select {
	case receipt := <-channel:
		return receipt
	case <-time.After(timeout):
		reader.Close()
		select {
		case receipt := <-channel:
			return receipt
		case <-time.After(processPollInterval * 10):
			return streamReceipt{ByteLength: -1, ContentHash: ""}
		}
	}
}

func allZeroCapabilityFields(receipt childIdentityReceipt) bool {
	for _, value := range []string{
		receipt.CapInheritable,
		receipt.CapPermitted,
		receipt.CapEffective,
		receipt.CapBounding,
		receipt.CapAmbient,
	} {
		if value == "" || strings.TrimLeft(value, "0") != "" {
			return false
		}
	}
	return true
}

func quiesceNamespace(directChildPID int) processTreeReceipt {
	receipt := processTreeReceipt{DirectChildPID: directChildPID}
	reapChildren(&receipt)
	receipt.InitialResidualPIDs = listNamespacePIDs(os.Getpid())
	receipt.TermSignalCount = signalNamespaceUntil(
		syscall.SIGTERM,
		time.Now().Add(processTermGrace),
		&receipt,
	)
	receipt.KillSignalCount = signalNamespaceUntil(
		syscall.SIGKILL,
		time.Now().Add(processKillGrace),
		&receipt,
	)
	reapChildren(&receipt)
	receipt.FinalResidualPIDs = listNamespacePIDs(os.Getpid())
	receipt.Quiescent = len(receipt.FinalResidualPIDs) == 0
	return receipt
}

func signalNamespaceUntil(signal syscall.Signal, deadline time.Time, receipt *processTreeReceipt) int {
	signalCount := 0
	emptyObservations := 0
	for {
		reapChildren(receipt)
		pids := listNamespacePIDs(os.Getpid())
		if len(pids) == 0 {
			emptyObservations++
			if emptyObservations >= 2 {
				return signalCount
			}
		} else {
			emptyObservations = 0
			signalCount += signalNamespace(signal)
		}
		if !time.Now().Before(deadline) {
			return signalCount
		}
		time.Sleep(processPollInterval)
	}
}

func reapChildren(receipt *processTreeReceipt) {
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if pid > 0 {
			receipt.ReapedChildCount++
			continue
		}
		if err == syscall.EINTR {
			continue
		}
		return
	}
}

func listNamespacePIDs(excludePID int) []int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return []int{-1}
	}
	pids := []int{}
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err == nil && pid > 0 && pid != excludePID {
			pids = append(pids, pid)
		}
	}
	sort.Ints(pids)
	return pids
}

func signalPIDSet(pids []int, signal syscall.Signal) int {
	count := 0
	for _, pid := range pids {
		if pid > 0 && syscall.Kill(pid, signal) == nil {
			count++
		}
	}
	return count
}

func signalNamespace(signal syscall.Signal) int {
	pids := listNamespacePIDs(os.Getpid())
	if len(pids) == 0 {
		return 0
	}
	if err := syscall.Kill(-1, signal); err == nil {
		return len(pids)
	}
	return signalPIDSet(pids, signal)
}

func publishLauncherGeneratedOutputManifest(spec launcherSpec) (outputManifest, error) {
	var manifest outputManifest
	manifestAbsolutePath := filepath.Join(spec.OutputRoot, spec.OutputManifestPath)
	if err := requirePathAbsent(manifestAbsolutePath); err != nil {
		return manifest, fmt.Errorf("refuse preexisting output manifest: %w", err)
	}

	entries := make([]outputManifestEntry, 0, len(spec.DeclaredOutputs))
	var outputByteLength int64
	for _, declaration := range spec.DeclaredOutputs {
		remainingBytes := spec.CollectedByteLimit - outputByteLength
		byteLength, contentHash, err := hashRegularFileBeneath(
			spec.OutputRoot,
			declaration.Path,
			remainingBytes,
		)
		if err != nil {
			return manifest, fmt.Errorf("hash declared output %q: %w", declaration.Path, err)
		}
		if outputByteLength > spec.CollectedByteLimit-byteLength {
			return manifest, errors.New("declared output byte limit exceeded")
		}
		outputByteLength += byteLength
		// Declaration labels are serialized verbatim as advisory metadata only.
		entries = append(entries, outputManifestEntry{
			Path:         declaration.Path,
			Role:         declaration.Role,
			ArtifactKind: declaration.ArtifactKind,
			MediaType:    declaration.MediaType,
			ContentHash:  contentHash,
			ByteLength:   byteLength,
		})
	}

	manifest = outputManifest{
		SchemaVersion:          outputManifestSchema,
		CommandSpecHash:        spec.CommandSpecHash,
		SourceBindingHash:      spec.SourceBindingHash,
		AcceptedForGPUHMR:      false,
		GPUHMRSuccess:          false,
		CanSatisfyRuntimeProof: false,
		Outputs:                entries,
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return manifest, fmt.Errorf("encode generated output manifest: %w", err)
	}
	manifestByteLength := int64(len(manifestBytes))
	if manifestByteLength < 1 || manifestByteLength > maxOutputManifest ||
		outputByteLength > spec.CollectedByteLimit-manifestByteLength {
		return manifest, errors.New("generated output manifest exceeds collection byte bounds")
	}

	for _, entry := range entries {
		observedByteLength, observedContentHash, err := hashRegularFileBeneath(
			spec.OutputRoot,
			entry.Path,
			entry.ByteLength,
		)
		if err != nil {
			return manifest, fmt.Errorf("rehash declared output %q: %w", entry.Path, err)
		}
		if observedByteLength != entry.ByteLength || observedContentHash != entry.ContentHash {
			return manifest, fmt.Errorf("declared output changed before manifest publication: %s", entry.Path)
		}
	}
	if err := requirePathAbsent(manifestAbsolutePath); err != nil {
		return manifest, fmt.Errorf("refuse preexisting output manifest: %w", err)
	}
	if err := writeAtomicExclusiveAsCommandIdentity(
		manifestAbsolutePath,
		manifestBytes,
		0644,
		spec.CommandUID,
		spec.CommandGID,
	); err != nil {
		return manifest, fmt.Errorf("publish generated output manifest: %w", err)
	}
	observedByteLength, observedContentHash, err := hashRegularFileBeneath(
		spec.OutputRoot,
		spec.OutputManifestPath,
		maxOutputManifest,
	)
	if err != nil {
		return manifest, fmt.Errorf("verify generated output manifest: %w", err)
	}
	if observedByteLength != manifestByteLength || observedContentHash != hashBytes(manifestBytes) {
		return manifest, errors.New("generated output manifest changed after publication")
	}
	return manifest, nil
}

func validateGeneratedManifestSnapshot(
	spec launcherSpec,
	manifest outputManifest,
	snapshot outputSnapshot,
) error {
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return fmt.Errorf("encode generated output manifest snapshot binding: %w", err)
	}
	expectedEntries := map[string]streamReceipt{
		spec.OutputManifestPath: {
			ByteLength:  int64(len(manifestBytes)),
			ContentHash: hashBytes(manifestBytes),
		},
	}
	for _, entry := range manifest.Outputs {
		if _, exists := expectedEntries[entry.Path]; exists {
			return errors.New("generated output manifest snapshot path duplicated")
		}
		expectedEntries[entry.Path] = streamReceipt{
			ByteLength:  entry.ByteLength,
			ContentHash: entry.ContentHash,
		}
	}
	if len(snapshot.Entries) != len(expectedEntries) {
		return errors.New("generated output manifest snapshot entry count changed")
	}
	for _, entry := range snapshot.Entries {
		expected, exists := expectedEntries[entry.Path]
		if !exists || entry.ByteLength != expected.ByteLength || entry.ContentHash != expected.ContentHash {
			return fmt.Errorf("generated output changed before snapshot: %s", entry.Path)
		}
		delete(expectedEntries, entry.Path)
	}
	if len(expectedEntries) != 0 {
		return errors.New("generated output missing from snapshot")
	}
	return nil
}

func buildOutputSnapshot(spec launcherSpec, specHash string) (outputSnapshot, string, error) {
	snapshot := outputSnapshot{
		SchemaVersion:  collectorSchema,
		ExecutionNonce: spec.ExecutionNonce,
		SpecHash:       specHash,
		Entries:        []collectedEntry{},
	}
	manifestAbsolutePath := filepath.Join(spec.OutputRoot, spec.OutputManifestPath)
	manifestBytes, err := readBoundedRegularFile(manifestAbsolutePath, maxOutputManifest)
	if err != nil {
		return snapshot, "", fmt.Errorf("read output manifest: %w", err)
	}
	var manifest outputManifestProjection
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		return snapshot, "", fmt.Errorf("decode output manifest: %w", err)
	}
	// The collection frame includes the manifest itself in the total entry bound.
	if len(manifest.Outputs) < 1 || len(manifest.Outputs) > spec.CollectedEntryLimit-1 {
		return snapshot, "", errors.New("collected output count invalid")
	}
	requestedPaths := map[string]bool{spec.OutputManifestPath: true}
	for _, output := range manifest.Outputs {
		relativePath, err := validateRelativeOutputPath(output.Path, spec.OutputManifestPath)
		if err != nil {
			return snapshot, "", err
		}
		if requestedPaths[relativePath] {
			return snapshot, "", errors.New("collected output path duplicated")
		}
		requestedPaths[relativePath] = true
	}
	err = filepath.WalkDir(spec.OutputRoot, func(currentPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if currentPath == spec.OutputRoot {
			return nil
		}
		snapshot.WorkspaceEntryCount++
		if snapshot.WorkspaceEntryCount > spec.WorkspaceEntryLimit {
			return errors.New("workspace entry limit exceeded")
		}
		metadata, err := os.Lstat(currentPath)
		if err != nil {
			return err
		}
		mode := metadata.Mode()
		if mode&os.ModeSymlink != 0 || (!mode.IsDir() && !mode.IsRegular()) {
			return errors.New("workspace contains unsupported file type")
		}
		if mode.IsRegular() {
			if metadata.Size() < 0 || snapshot.WorkspaceByteLength > spec.WorkspaceByteLimit-metadata.Size() {
				return errors.New("workspace logical byte limit exceeded")
			}
			snapshot.WorkspaceByteLength += metadata.Size()
		}
		return nil
	})
	if err != nil {
		return snapshot, "", err
	}
	paths := make([]string, 0, len(requestedPaths))
	for relativePath := range requestedPaths {
		paths = append(paths, relativePath)
	}
	sort.Strings(paths)
	for _, relativePath := range paths {
		absolutePath := filepath.Join(spec.OutputRoot, filepath.FromSlash(relativePath))
		metadata, err := os.Lstat(absolutePath)
		if err != nil || !metadata.Mode().IsRegular() || metadata.Mode()&os.ModeSymlink != 0 {
			return snapshot, "", fmt.Errorf("collected output is not a regular file: %s", relativePath)
		}
		if metadata.Size() < 0 || snapshot.CollectedByteLength > spec.CollectedByteLimit-metadata.Size() {
			return snapshot, "", errors.New("collected output byte limit exceeded")
		}
		contentHash, err := hashFileBoundedBeneath(spec.OutputRoot, relativePath, metadata.Size())
		if err != nil {
			return snapshot, "", err
		}
		snapshot.CollectedByteLength += metadata.Size()
		snapshot.Entries = append(snapshot.Entries, collectedEntry{
			Path:        relativePath,
			ByteLength:  metadata.Size(),
			ContentHash: contentHash,
			Mode:        uint32(metadata.Mode().Perm()),
		})
	}
	bytes, err := json.Marshal(snapshot)
	if err != nil {
		return snapshot, "", err
	}
	return snapshot, hashBytes(bytes), nil
}

func collectMain(specPath string) error {
	os.Clearenv()
	spec, _, specHash, err := readSpec(specPath)
	if err != nil {
		return err
	}
	readyPath := filepath.Join(spec.ControlRoot, readyControlName)
	readyBytes, err := readBoundedRegularFile(readyPath, maxControlBytes)
	if err != nil {
		return fmt.Errorf("read ready receipt: %w", err)
	}
	var ready readyReceipt
	if err := decodeStrictJSON(readyBytes, &ready); err != nil {
		return fmt.Errorf("decode ready receipt: %w", err)
	}
	if ready.SchemaVersion != readySchema || ready.ExecutionNonce != spec.ExecutionNonce ||
		ready.SpecHash != specHash || !ready.ProtocolAccepted || !ready.ProcessTree.Quiescent ||
		!ready.ChildIdentityAccepted || !ready.OutputSnapshotAccepted {
		return errors.New("ready receipt is not collector-eligible")
	}
	snapshot, snapshotHash, err := buildOutputSnapshot(spec, specHash)
	if err != nil {
		return err
	}
	if snapshotHash != ready.OutputSnapshotHash {
		return errors.New("output snapshot changed after ready")
	}
	receipt := collectorReceipt{
		SchemaVersion:       collectorSchema,
		ExecutionNonce:      spec.ExecutionNonce,
		SpecHash:            specHash,
		ReadyReceiptHash:    hashBytes(readyBytes),
		OutputSnapshotHash:  snapshotHash,
		CollectedByteLength: snapshot.CollectedByteLength,
		Entries:             snapshot.Entries,
	}
	headerBytes, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	if len(headerBytes) > maxCollectorHeader {
		return errors.New("collector header exceeds limit")
	}
	frameHasher := sha256.New()
	frameSink := &countingWriter{Writer: io.MultiWriter(os.Stdout, frameHasher)}
	writer := bufio.NewWriterSize(frameSink, 1024*1024)
	if _, err := writer.WriteString(frameMagic); err != nil {
		return err
	}
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(headerBytes)))
	if _, err := writer.Write(length[:]); err != nil {
		return err
	}
	if _, err := writer.Write(headerBytes); err != nil {
		return err
	}
	for _, entry := range snapshot.Entries {
		observedHash, observedBytes, err := copyFileAndHashBeneath(
			writer,
			spec.OutputRoot,
			entry.Path,
			entry.ByteLength,
		)
		if err != nil {
			return err
		}
		if observedBytes != entry.ByteLength || observedHash != entry.ContentHash {
			return errors.New("collected output changed during stream")
		}
	}
	if err := writer.Flush(); err != nil {
		return err
	}
	completion := collectorCompletionReceipt{
		SchemaVersion:        collectorDoneSchema,
		ExecutionNonce:       spec.ExecutionNonce,
		SpecHash:             specHash,
		ReadyReceiptHash:     hashBytes(readyBytes),
		OutputSnapshotHash:   snapshotHash,
		CollectorReceiptHash: hashBytes(headerBytes),
		CollectorFrameHash:   "sha256:" + hex.EncodeToString(frameHasher.Sum(nil)),
		CollectorFrameBytes:  frameSink.ByteLength,
	}
	completionBytes, err := json.Marshal(completion)
	if err != nil {
		return fmt.Errorf("encode collector completion: %w", err)
	}
	if err := writeAtomicExclusive(
		filepath.Join(spec.ControlRoot, collectorControlName),
		completionBytes,
		0600,
	); err != nil {
		return fmt.Errorf("write collector completion: %w", err)
	}
	return nil
}

func readControlMain(specPath, name string) error {
	os.Clearenv()
	spec, _, _, err := readSpec(specPath)
	if err != nil {
		return err
	}
	if name != readyControlName &&
		name != collectorControlName &&
		name != finalControlName &&
		name != stdoutDiagnosticName &&
		name != stderrDiagnosticName {
		return errors.New("control receipt name invalid")
	}
	bytes, err := readBoundedRegularFile(filepath.Join(spec.ControlRoot, name), maxControlBytes)
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(bytes)
	return err
}

func waitForDiagnosticAck(spec launcherSpec, specHash, readyHash string) error {
	deadline := time.Now().Add(diagnosticAckTimeout)
	ackPath := filepath.Join(spec.ReleaseRoot, "diagnostic-ack.json")
	for time.Now().Before(deadline) {
		bytes, err := readBoundedRegularFile(ackPath, maxControlBytes)
		if errors.Is(err, os.ErrNotExist) {
			time.Sleep(releasePollInterval)
			continue
		}
		if err != nil {
			return err
		}
		var ack diagnosticAck
		if err := decodeStrictJSON(bytes, &ack); err != nil {
			return err
		}
		if ack.SchemaVersion != diagnosticAckSchema ||
			ack.ExecutionNonce != spec.ExecutionNonce ||
			ack.SpecHash != specHash ||
			ack.ReadyReceiptHash != readyHash {
			return errors.New("diagnostic ack binding invalid")
		}
		return nil
	}
	return errors.New("diagnostic ack timeout")
}

func waitForRelease(spec launcherSpec, specHash, readyHash, snapshotHash string) (releaseReceipt, []byte, error) {
	deadline := time.Now().Add(time.Duration(spec.ReleaseTimeoutMillis) * time.Millisecond)
	releasePath := filepath.Join(spec.ReleaseRoot, "release.json")
	completionPath := filepath.Join(spec.ControlRoot, collectorControlName)
	for time.Now().Before(deadline) {
		releaseBytes, releaseErr := readBoundedRegularFile(releasePath, maxControlBytes)
		if releaseErr == nil {
			completionBytes, completionErr := readBoundedRegularFile(completionPath, maxControlBytes)
			if errors.Is(completionErr, os.ErrNotExist) {
				time.Sleep(releasePollInterval)
				continue
			}
			if completionErr != nil {
				return releaseReceipt{}, nil, completionErr
			}
			var completion collectorCompletionReceipt
			if decodeErr := decodeStrictJSON(completionBytes, &completion); decodeErr != nil {
				return releaseReceipt{}, nil, decodeErr
			}
			if completion.SchemaVersion != collectorDoneSchema ||
				completion.ExecutionNonce != spec.ExecutionNonce ||
				completion.SpecHash != specHash ||
				completion.ReadyReceiptHash != readyHash ||
				completion.OutputSnapshotHash != snapshotHash ||
				!isSHA256(completion.CollectorReceiptHash) ||
				!isSHA256(completion.CollectorFrameHash) ||
				completion.CollectorFrameBytes < int64(len(frameMagic)+8+2) {
				return releaseReceipt{}, nil, errors.New("collector completion binding invalid")
			}
			var receipt releaseReceipt
			if decodeErr := decodeStrictJSON(releaseBytes, &receipt); decodeErr != nil {
				return releaseReceipt{}, nil, decodeErr
			}
			if receipt.SchemaVersion != releaseSchema || receipt.ExecutionNonce != spec.ExecutionNonce ||
				receipt.SpecHash != specHash || receipt.ReadyReceiptHash != readyHash ||
				receipt.OutputSnapshotHash != snapshotHash ||
				receipt.CollectorCompletionReceiptHash != hashBytes(completionBytes) ||
				receipt.CollectorReceiptHash != completion.CollectorReceiptHash ||
				receipt.CollectorFrameHash != completion.CollectorFrameHash ||
				receipt.CollectorFrameBytes != completion.CollectorFrameBytes ||
				!isSHA256(receipt.HostReceiptHash) {
				return releaseReceipt{}, nil, errors.New("release receipt binding invalid")
			}
			return receipt, releaseBytes, nil
		}
		if !errors.Is(releaseErr, os.ErrNotExist) {
			return releaseReceipt{}, nil, releaseErr
		}
		time.Sleep(releasePollInterval)
	}
	return releaseReceipt{}, nil, errors.New("release receipt timeout")
}

func waitForFinalAck(spec launcherSpec, specHash, finalReceiptHash string) error {
	deadline := time.Now().Add(time.Duration(spec.ReleaseTimeoutMillis) * time.Millisecond)
	ackPath := filepath.Join(spec.ReleaseRoot, "final-ack.json")
	for time.Now().Before(deadline) {
		bytes, err := readBoundedRegularFile(ackPath, maxControlBytes)
		if err == nil {
			var ack finalAck
			if decodeErr := decodeStrictJSON(bytes, &ack); decodeErr != nil {
				return decodeErr
			}
			if ack.SchemaVersion != finalAckSchema || ack.ExecutionNonce != spec.ExecutionNonce ||
				ack.SpecHash != specHash || ack.FinalReceiptHash != finalReceiptHash {
				return errors.New("final ack binding invalid")
			}
			return nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		time.Sleep(releasePollInterval)
	}
	return errors.New("final ack timeout")
}

func validateRelativeOutputPath(value, manifestPath string) (string, error) {
	if value == "" || len(value) > 32768 || strings.ContainsAny(value, "\\\x00\r\n") ||
		looksLikeWindowsAbsolutePath(value) {
		return "", errors.New("output path invalid")
	}
	clean := filepath.ToSlash(filepath.Clean(value))
	if clean != value || clean == "." || clean == manifestPath || strings.HasPrefix(clean, "../") || filepath.IsAbs(clean) {
		return "", errors.New("output path escapes output root")
	}
	return clean, nil
}

func isBoundedOutputLabel(value string) bool {
	return value != "" && len(value) <= maxOutputLabelBytes && !strings.ContainsAny(value, "\x00\r\n")
}

func looksLikeWindowsAbsolutePath(value string) bool {
	if len(value) < 3 || value[1] != ':' || value[2] != '/' {
		return false
	}
	return (value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')
}

func readBoundedRegularFile(filePath string, limit int64) ([]byte, error) {
	file, metadata, err := openRegularNoFollow(filePath)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if metadata.Size() < 0 || metadata.Size() > limit {
		return nil, errors.New("file boundary invalid")
	}
	bytes, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(bytes)) != metadata.Size() || int64(len(bytes)) > limit {
		return nil, errors.New("file changed during bounded read")
	}
	return bytes, nil
}

func requirePathAbsent(filePath string) error {
	_, err := os.Lstat(filePath)
	if err == nil {
		return errors.New("path already exists")
	}
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func hashRegularFileBeneath(rootPath, relativePath string, byteLimit int64) (int64, string, error) {
	if byteLimit < 0 {
		return 0, "", errors.New("file byte limit invalid")
	}
	file, before, err := openRegularBeneath(rootPath, relativePath)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	if before.Size() < 0 || before.Size() > byteLimit {
		return 0, "", errors.New("file exceeds byte limit")
	}
	hasher := sha256.New()
	observed, err := io.CopyN(hasher, file, before.Size())
	if err != nil || observed != before.Size() {
		return 0, "", errors.New("file changed during hash")
	}
	var extra [1]byte
	extraCount, extraErr := file.Read(extra[:])
	if extraCount != 0 {
		return 0, "", errors.New("file grew during hash")
	}
	if extraErr != nil && !errors.Is(extraErr, io.EOF) {
		return 0, "", fmt.Errorf("verify file hash boundary: %w", extraErr)
	}
	after, err := file.Stat()
	if err != nil {
		return 0, "", err
	}
	if !os.SameFile(before, after) || before.Size() != after.Size() || before.Mode() != after.Mode() ||
		!before.ModTime().Equal(after.ModTime()) {
		return 0, "", errors.New("file metadata changed during hash")
	}
	return before.Size(), "sha256:" + hex.EncodeToString(hasher.Sum(nil)), nil
}

func hashFileBoundedBeneath(rootPath, relativePath string, expectedSize int64) (string, error) {
	file, metadata, err := openRegularBeneath(rootPath, relativePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if metadata.Size() != expectedSize {
		return "", errors.New("file size changed before hash")
	}
	hasher := sha256.New()
	observed, err := io.CopyN(hasher, file, expectedSize)
	if err != nil || observed != expectedSize {
		return "", errors.New("file changed during hash")
	}
	var extra [1]byte
	if count, _ := file.Read(extra[:]); count != 0 {
		return "", errors.New("file grew during hash")
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil)), nil
}

func copyFileAndHashBeneath(
	writer io.Writer,
	rootPath,
	relativePath string,
	expectedSize int64,
) (string, int64, error) {
	file, metadata, err := openRegularBeneath(rootPath, relativePath)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	if metadata.Size() != expectedSize {
		return "", 0, errors.New("file size changed before collection")
	}
	hasher := sha256.New()
	observed, err := io.CopyN(io.MultiWriter(writer, hasher), file, expectedSize)
	if err != nil || observed != expectedSize {
		return "", observed, errors.New("file changed during collection")
	}
	var extra [1]byte
	if count, _ := file.Read(extra[:]); count != 0 {
		return "", observed, errors.New("file grew during collection")
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil)), observed, nil
}

func openRegularNoFollow(filePath string) (*os.File, fs.FileInfo, error) {
	fd, err := syscall.Open(filePath, syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, nil, err
	}
	file := os.NewFile(uintptr(fd), filePath)
	metadata, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	if !metadata.Mode().IsRegular() || metadata.Mode()&os.ModeSymlink != 0 {
		file.Close()
		return nil, nil, errors.New("file boundary invalid")
	}
	return file, metadata, nil
}

func openRegularBeneath(rootPath, relativePath string) (*os.File, fs.FileInfo, error) {
	components := strings.Split(filepath.ToSlash(relativePath), "/")
	if len(components) == 0 {
		return nil, nil, errors.New("relative file path missing")
	}
	for _, component := range components {
		if component == "" || component == "." || component == ".." || strings.ContainsRune(component, '\x00') {
			return nil, nil, errors.New("relative file path invalid")
		}
	}
	rootFD, err := syscall.Open(
		rootPath,
		syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW,
		0,
	)
	if err != nil {
		return nil, nil, err
	}
	currentFD := rootFD
	for index, component := range components {
		flags := syscall.O_RDONLY | syscall.O_CLOEXEC | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
		if index < len(components)-1 {
			flags |= syscall.O_DIRECTORY
		}
		nextFD, openErr := syscall.Openat(currentFD, component, flags, 0)
		if currentFD != rootFD {
			syscall.Close(currentFD)
		}
		if openErr != nil {
			syscall.Close(rootFD)
			return nil, nil, openErr
		}
		currentFD = nextFD
	}
	syscall.Close(rootFD)
	file := os.NewFile(uintptr(currentFD), relativePath)
	metadata, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, err
	}
	if !metadata.Mode().IsRegular() || metadata.Mode()&os.ModeSymlink != 0 {
		file.Close()
		return nil, nil, errors.New("collected path is not a regular file")
	}
	return file, metadata, nil
}

func decodeStrictJSON(data []byte, value any) error {
	decoder := json.NewDecoder(stdbytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return fmt.Errorf("trailing JSON data: %w", err)
	}
	return nil
}

func writeFramedControlReceipt(writer io.Writer, receiptBytes []byte) error {
	if len(receiptBytes) < 2 || len(receiptBytes) > maxControlBytes {
		return errors.New("control receipt frame length invalid")
	}
	buffered := bufio.NewWriterSize(writer, 64*1024)
	if _, err := buffered.WriteString(controlFrameMagic); err != nil {
		return err
	}
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(receiptBytes)))
	if _, err := buffered.Write(length[:]); err != nil {
		return err
	}
	if _, err := buffered.Write(receiptBytes); err != nil {
		return err
	}
	return buffered.Flush()
}

func writeAtomic(filePath string, bytes []byte, mode fs.FileMode) error {
	temporaryPath := filePath + ".tmp-" + strconv.Itoa(os.Getpid())
	file, err := os.OpenFile(temporaryPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	cleanup := func() {
		file.Close()
		os.Remove(temporaryPath)
	}
	if _, err := file.Write(bytes); err != nil {
		cleanup()
		return err
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(temporaryPath)
		return err
	}
	if err := os.Rename(temporaryPath, filePath); err != nil {
		os.Remove(temporaryPath)
		return err
	}
	return nil
}

type threadFilesystemIdentity struct {
	UIDs         []int
	GIDs         []int
	Groups       []int
	CapPermitted string
	CapEffective string
	FSUID        int
	FSGID        int
}

func writeAtomicExclusiveAsCommandIdentity(
	filePath string,
	bytes []byte,
	mode fs.FileMode,
	uid, gid int,
) (resultErr error) {
	if uid != childUID || gid != childGID {
		return errors.New("manifest publication filesystem identity invalid")
	}
	runtime.LockOSThread()
	safeToUnlock := true
	defer func() {
		if safeToUnlock {
			runtime.UnlockOSThread()
		}
	}()

	originalIdentity, err := readThreadFilesystemIdentity()
	if err != nil {
		return fmt.Errorf("read launcher filesystem identity: %w", err)
	}
	if !allIntegersEqual(originalIdentity.UIDs, 0, 4) ||
		!allIntegersEqual(originalIdentity.GIDs, 0, 4) {
		return errors.New("launcher filesystem identity is not root")
	}

	safeToUnlock = false
	defer func() {
		restoreErr := restoreThreadFilesystemIdentity(originalIdentity)
		if restoreErr == nil {
			safeToUnlock = true
			return
		}
		if resultErr == nil {
			resultErr = fmt.Errorf("restore launcher filesystem identity: %w", restoreErr)
			return
		}
		resultErr = fmt.Errorf("%v; restore launcher filesystem identity: %w", resultErr, restoreErr)
	}()

	previousFSGID, err := setFilesystemGID(gid)
	if err != nil {
		return fmt.Errorf("set manifest publication fsgid: %w", err)
	}
	if previousFSGID != originalIdentity.FSGID {
		return errors.New("manifest publication fsgid transition invalid")
	}
	previousFSUID, err := setFilesystemUID(uid)
	if err != nil {
		return fmt.Errorf("set manifest publication fsuid: %w", err)
	}
	if previousFSUID != originalIdentity.FSUID {
		return errors.New("manifest publication fsuid transition invalid")
	}
	publicationIdentity, err := readThreadFilesystemIdentity()
	if err != nil {
		return fmt.Errorf("verify manifest publication filesystem identity: %w", err)
	}
	if publicationIdentity.FSUID != uid || publicationIdentity.FSGID != gid ||
		!sameProcessIdentity(originalIdentity, publicationIdentity) {
		return errors.New("manifest publication filesystem identity not assumed")
	}
	return writeAtomicExclusive(filePath, bytes, mode)
}

func readThreadFilesystemIdentity() (threadFilesystemIdentity, error) {
	status, err := parseProcStatus("/proc/thread-self/status")
	if err != nil {
		return threadFilesystemIdentity{}, err
	}
	identity := threadFilesystemIdentity{
		UIDs:         parseIntegerFields(status["Uid"]),
		GIDs:         parseIntegerFields(status["Gid"]),
		Groups:       parseIntegerFields(status["Groups"]),
		CapPermitted: status["CapPrm"],
		CapEffective: status["CapEff"],
	}
	if len(identity.UIDs) != 4 || len(identity.GIDs) != 4 ||
		identity.CapPermitted == "" || identity.CapEffective == "" {
		return threadFilesystemIdentity{}, errors.New("thread filesystem identity shape invalid")
	}
	identity.FSUID, err = queryFilesystemUID()
	if err != nil {
		return threadFilesystemIdentity{}, err
	}
	identity.FSGID, err = queryFilesystemGID()
	if err != nil {
		return threadFilesystemIdentity{}, err
	}
	if identity.UIDs[3] != identity.FSUID || identity.GIDs[3] != identity.FSGID {
		return threadFilesystemIdentity{}, errors.New("thread filesystem identity observation mismatch")
	}
	return identity, nil
}

func restoreThreadFilesystemIdentity(expected threadFilesystemIdentity) error {
	failures := []string{}
	if _, err := setFilesystemUID(expected.FSUID); err != nil {
		failures = append(failures, "restore fsuid: "+err.Error())
	}
	if _, err := setFilesystemGID(expected.FSGID); err != nil {
		failures = append(failures, "restore fsgid: "+err.Error())
	}
	observed, err := readThreadFilesystemIdentity()
	if err != nil {
		failures = append(failures, "verify restored identity: "+err.Error())
	} else if !sameThreadFilesystemIdentity(expected, observed) {
		failures = append(failures, "restored filesystem identity mismatch")
	}
	if len(failures) != 0 {
		return errors.New(strings.Join(failures, "; "))
	}
	return nil
}

func sameProcessIdentity(expected, observed threadFilesystemIdentity) bool {
	return len(expected.UIDs) == 4 && len(observed.UIDs) == 4 &&
		len(expected.GIDs) == 4 && len(observed.GIDs) == 4 &&
		expected.UIDs[0] == observed.UIDs[0] &&
		expected.UIDs[1] == observed.UIDs[1] &&
		expected.UIDs[2] == observed.UIDs[2] &&
		expected.GIDs[0] == observed.GIDs[0] &&
		expected.GIDs[1] == observed.GIDs[1] &&
		expected.GIDs[2] == observed.GIDs[2] &&
		equalIntegerSlices(expected.Groups, observed.Groups) &&
		expected.CapPermitted == observed.CapPermitted
}

func sameThreadFilesystemIdentity(expected, observed threadFilesystemIdentity) bool {
	return sameProcessIdentity(expected, observed) &&
		equalIntegerSlices(expected.UIDs, observed.UIDs) &&
		equalIntegerSlices(expected.GIDs, observed.GIDs) &&
		expected.CapEffective == observed.CapEffective &&
		expected.FSUID == observed.FSUID &&
		expected.FSGID == observed.FSGID
}

func equalIntegerSlices(left, right []int) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func queryFilesystemUID() (int, error) {
	return rawSetFilesystemUID(queryFilesystemID)
}

func queryFilesystemGID() (int, error) {
	return rawSetFilesystemGID(queryFilesystemID)
}

func setFilesystemUID(uid int) (int, error) {
	if uid < 0 || uint64(uid) >= uint64(queryFilesystemID) {
		return 0, errors.New("fsuid invalid")
	}
	return rawSetFilesystemUID(uint32(uid))
}

func setFilesystemGID(gid int) (int, error) {
	if gid < 0 || uint64(gid) >= uint64(queryFilesystemID) {
		return 0, errors.New("fsgid invalid")
	}
	return rawSetFilesystemGID(uint32(gid))
}

func rawSetFilesystemUID(uid uint32) (int, error) {
	result, _, errno := syscall.RawSyscall(syscall.SYS_SETFSUID, uintptr(uid), 0, 0)
	if errno != 0 {
		return 0, errno
	}
	return int(uint32(result)), nil
}

func rawSetFilesystemGID(gid uint32) (int, error) {
	result, _, errno := syscall.RawSyscall(syscall.SYS_SETFSGID, uintptr(gid), 0, 0)
	if errno != 0 {
		return 0, errno
	}
	return int(uint32(result)), nil
}

func writeAtomicExclusive(filePath string, bytes []byte, mode fs.FileMode) error {
	temporaryPath := filePath + ".tmp-" + strconv.Itoa(os.Getpid()) + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	file, err := os.OpenFile(temporaryPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode)
	if err != nil {
		return err
	}
	cleanup := func() {
		file.Close()
		os.Remove(temporaryPath)
	}
	if _, err := file.Write(bytes); err != nil {
		cleanup()
		return err
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(temporaryPath)
		return err
	}
	if err := os.Link(temporaryPath, filePath); err != nil {
		os.Remove(temporaryPath)
		return err
	}
	return os.Remove(temporaryPath)
}

func parseProcStatus(filePath string) (map[string]string, error) {
	bytes, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(bytes), "\n") {
		separator := strings.IndexByte(line, ':')
		if separator > 0 {
			values[line[:separator]] = strings.TrimSpace(line[separator+1:])
		}
	}
	return values, nil
}

func parseIntegerFields(value string) []int {
	values := []int{}
	for _, field := range strings.Fields(value) {
		parsed, err := strconv.Atoi(field)
		if err != nil {
			return nil
		}
		values = append(values, parsed)
	}
	return values
}

func firstIntegerField(value string) int {
	values := parseIntegerFields(value)
	if len(values) == 0 {
		return -1
	}
	return values[0]
}

func allIntegersEqual(values []int, expected, expectedCount int) bool {
	if len(values) != expectedCount {
		return false
	}
	for _, value := range values {
		if value != expected {
			return false
		}
	}
	return true
}

func processExitCode(waitError error, timedOut bool) int {
	if timedOut {
		return commandTimeoutExit
	}
	if waitError == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(waitError, &exitError) {
		if status, ok := exitError.Sys().(syscall.WaitStatus); ok {
			if status.Signaled() {
				return 128 + int(status.Signal())
			}
			return status.ExitStatus()
		}
	}
	return protocolFailureExit
}

func lookPath(command string, environment []string) (string, error) {
	if strings.ContainsRune(command, os.PathSeparator) {
		return command, nil
	}
	pathValue := ""
	for _, value := range environment {
		if strings.HasPrefix(value, "PATH=") {
			pathValue = strings.TrimPrefix(value, "PATH=")
			break
		}
	}
	if pathValue == "" {
		return "", errors.New("PATH missing from canonical environment")
	}
	for _, directory := range filepath.SplitList(pathValue) {
		if directory == "" || !filepath.IsAbs(directory) {
			continue
		}
		candidate := filepath.Join(directory, command)
		metadata, err := os.Stat(candidate)
		if err == nil && metadata.Mode().IsRegular() && metadata.Mode().Perm()&0111 != 0 {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("command %q not found", command)
}

func prctl(option, argument2, argument3, argument4, argument5 uintptr) error {
	_, err := prctlResult(int(option), argument2, argument3, argument4, argument5)
	return err
}

func prctlResult(option int, argument2, argument3, argument4, argument5 uintptr) (int, error) {
	result, _, errno := syscall.RawSyscall6(syscall.SYS_PRCTL, uintptr(option), argument2, argument3, argument4, argument5, 0)
	if errno != 0 {
		return 0, errno
	}
	return int(result), nil
}

func hashBytes(bytes []byte) string {
	sum := sha256.Sum256(bytes)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func hashSelfExecutable() (string, error) {
	file, err := os.Open("/proc/self/exe")
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	if _, err := io.Copy(hasher, file); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil)), nil
}

func isSHA256(value string) bool {
	return strings.HasPrefix(value, "sha256:") && isHex(strings.TrimPrefix(value, "sha256:"), 64)
}

func isHex(value string, length int) bool {
	if len(value) != length {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil && value == strings.ToLower(value)
}

func isEnvironmentName(value string) bool {
	if value == "" {
		return false
	}
	for index, character := range value {
		if (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || character == '_' ||
			(index > 0 && character >= '0' && character <= '9') {
			continue
		}
		return false
	}
	return true
}

func uniqueSorted(values []string) []string {
	set := map[string]bool{}
	for _, value := range values {
		if value != "" {
			set[value] = true
		}
	}
	result := make([]string, 0, len(set))
	for value := range set {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func gap(condition bool, value string) string {
	if condition {
		return value
	}
	return ""
}

func writeJSON(writer io.Writer, value any) error {
	encoder := json.NewEncoder(writer)
	encoder.SetEscapeHTML(false)
	return encoder.Encode(value)
}
