# Mobile Build Architecture for Synthi Cloud Workers

**Version:** 1.0  
**Date:** December 16, 2025  
**Status:** Architecture Decision Record (ADR)

---

## Phase 1: Mobile Stack Selection

### Decision: **Flutter (WINNER)**

### Comparative Evaluation Matrix

| Criterion | Flutter | React Native | Native (Android/iOS) |
|-----------|---------|--------------|----------------------|
| Cloud Compilation Feasibility | ✅ Single `flutter build` command, deterministic output | ⚠️ Metro bundler + native build required, complex orchestration | ❌ Requires full Android Studio / Xcode headless, massive toolchain |
| Toolchain Weight | ~2.5GB (Flutter SDK + Android SDK) | ~4GB (Node + Android SDK + native deps) | ~8GB+ (Full Android Studio + Gradle daemons) |
| Worker Startup Time | Fast (Dart AOT, no JIT warmup) | Slow (Metro bundler + Gradle warm-up) | Very Slow (Gradle daemon boot, 30s+ cold start) |
| Worker Image Complexity | Medium (Flutter SDK, Android SDK) | High (Node, Metro, native toolchains, Hermes) | Very High (Full IDEs headless) |
| Build Determinism | ✅ Excellent (Dart AOT, reproducible) | ⚠️ Poor (Metro caching issues, native bridge variability) | ⚠️ Medium (Gradle caching flaky) |
| OS Constraints | Linux for Android, macOS for iOS | Same | Same |
| Multi-Platform Scalability | ✅ Single codebase → APK, IPA, Web, Desktop | ⚠️ Separate native code per platform | ❌ Completely separate codebases |
| User Accessibility | Wide (Dart is approachable) | Wide (JavaScript ecosystem) | Narrow (requires platform expertise) |
| Disk Footprint (Worker) | ~6GB total | ~10GB total | ~15GB+ total |
| RAM (Build) | ~2GB | ~4GB | ~6GB+ |
| Build Time (Hello World) | ~45s cold, ~8s hot | ~90s cold, ~25s hot | ~120s cold, ~40s hot |

### Rejection Reasons

**React Native — REJECTED:**
- Metro bundler is a stateful process unsuited for ephemeral workers
- Native bridge requires separate Android/iOS builds with platform-specific code
- Hermes bytecode generation adds complexity
- Build determinism is poor due to native module linking variability
- Higher operational cost with no offsetting benefit over Flutter

**Native (Android/iOS) — REJECTED:**
- Toolchain size is prohibitive (8GB+ per platform)
- No code sharing between platforms
- Requires separate worker pools with duplicate capabilities
- Build times unacceptable for cloud IDE use case
- Gradle daemon management is operationally complex
- Users must maintain two codebases — not aligned with Synthi's unified IDE vision

### Assumptions Made

1. Target users want cross-platform mobile development
2. iOS builds require macOS workers (Apple licensing)
3. Initial scope is debug APK/IPA, not release signing
4. Users will provide their own Flutter project structure (we don't scaffold)
5. Workers are ephemeral, not persistent (no warm Gradle daemons)

---

## Phase 2: Worker Capability Model

### Capability Classes

```
┌─────────────────────────────────────────────────────────────────┐
│                    WORKER CAPABILITY HIERARCHY                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  linux-basic          linux-flutter-android      macos-flutter  │
│  ┌──────────┐         ┌──────────────────┐      ┌─────────────┐ │
│  │ C/C++    │         │ linux-basic      │      │ linux-basic │ │
│  │ Rust     │ ──────► │ + Flutter SDK    │      │ + Flutter   │ │
│  │ TypeScript│         │ + Android SDK    │      │ + Xcode CLI │ │
│  │ Python   │         │ + OpenJDK 17     │      │ + CocoaPods │ │
│  └──────────┘         └──────────────────┘      └─────────────┘ │
│       │                       │                        │         │
│       ▼                       ▼                        ▼         │
│  [Web/Desktop]         [Android APK]            [iOS IPA]       │
│                        [Flutter Web]            [Android APK]   │
│                                                  [Flutter Web]  │
└─────────────────────────────────────────────────────────────────┘
```

### Class: `linux-basic` (Existing)

| Property | Value |
|----------|-------|
| **OS** | Ubuntu 22.04 LTS (or Debian 12) |
| **Toolchains** | g++ 11+, rustc 1.70+, node 20 LTS, tsc 5.x, python 3.11 |
| **Disk Footprint** | ~3GB |
| **RAM Requirement** | 2GB |
| **Can Build** | C/C++ (.so), Rust (native), TypeScript/JavaScript, Python scripts |
| **Cannot Build** | Mobile apps, iOS anything, Android APK |
| **Incremental Support** | Yes (existing HMR system) |

### Class: `linux-flutter-android`

| Property | Value |
|----------|-------|
| **OS** | Ubuntu 22.04 LTS |
| **Toolchains** | `linux-basic` + Flutter SDK 3.24+, Android SDK (cmdline-tools), OpenJDK 17, Android NDK (for native plugins) |
| **Disk Footprint** | ~8GB |
| **RAM Requirement** | 4GB (6GB recommended) |
| **Can Build** | Everything in `linux-basic` + Flutter Android APK (debug), Flutter Web, Flutter Linux Desktop |
| **Cannot Build** | iOS apps (requires macOS), Signed release APK (requires keystore — v2 scope) |
| **Incremental Support** | Yes (Flutter's incremental Dart compilation) |

**Required System Packages:**
```bash
apt-get install -y \
  openjdk-17-jdk \
  unzip \
  curl \
  git \
  libglu1-mesa \
  clang \
  cmake \
  ninja-build \
  pkg-config \
  libgtk-3-dev  # for Linux desktop builds
```

**Flutter SDK Setup:**
```bash
# Install Flutter SDK
git clone https://github.com/flutter/flutter.git -b stable /opt/flutter
export PATH="/opt/flutter/bin:$PATH"
flutter precache --android

# Android SDK (cmdline-tools only, no Studio)
mkdir -p /opt/android-sdk/cmdline-tools
curl -o cmdline-tools.zip https://dl.google.com/android/repository/commandlinetools-linux-10406996_latest.zip
unzip cmdline-tools.zip -d /opt/android-sdk/cmdline-tools
mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest

export ANDROID_HOME=/opt/android-sdk
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

# Accept licenses and install build tools
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

### Class: `macos-flutter`

| Property | Value |
|----------|-------|
| **OS** | macOS 14+ (Sonoma), ARM64 preferred |
| **Toolchains** | Xcode 15+ CLI tools, Flutter SDK 3.24+, CocoaPods 1.14+, Ruby 3.x (for CocoaPods) |
| **Disk Footprint** | ~25GB (Xcode is massive) |
| **RAM Requirement** | 8GB |
| **Can Build** | Everything in `linux-flutter-android` + iOS IPA (debug), macOS Desktop |
| **Cannot Build** | Signed release IPA (requires Apple Developer cert — v2 scope) |
| **Incremental Support** | Yes |

**Provisioning:**
```bash
# Xcode CLI (assumes Xcode installed via App Store or MDM)
xcode-select --install
sudo xcodebuild -license accept

# Flutter
git clone https://github.com/flutter/flutter.git -b stable /opt/flutter
export PATH="/opt/flutter/bin:$PATH"
flutter precache --ios --macos

# CocoaPods
sudo gem install cocoapods
pod setup
```

### Capability Manifest Schema

Each worker self-reports capabilities on registration:

```json
{
  "worker_id": "w-a1b2c3d4",
  "capability_class": "linux-flutter-android",
  "os": {
    "type": "linux",
    "distro": "ubuntu",
    "version": "22.04",
    "arch": "x86_64"
  },
  "toolchains": {
    "flutter": { "version": "3.24.3", "channel": "stable" },
    "dart": { "version": "3.5.3" },
    "android_sdk": { "version": "34", "build_tools": "34.0.0" },
    "java": { "version": "17.0.10", "vendor": "openjdk" },
    "gcc": { "version": "11.4.0" },
    "rustc": { "version": "1.75.0" }
  },
  "build_targets": [
    "cpp-native",
    "rust-native",
    "typescript",
    "flutter-android-debug",
    "flutter-web",
    "flutter-linux-desktop"
  ],
  "resources": {
    "disk_available_gb": 50,
    "ram_total_gb": 8,
    "cpu_cores": 4
  },
  "features": {
    "hmr": true,
    "incremental": true,
    "video_streaming": true
  },
  "registered_at": "2025-12-16T10:30:00Z",
  "health": "ready"
}
```

---

## Phase 3: Job Routing Schema

### 3.1 Conceptual Model

```
┌─────────────────────────────────────────────────────────────────────┐
│                         JOB ROUTING FLOW                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Client Request                                                      │
│       │                                                              │
│       ▼                                                              │
│  ┌─────────────────┐                                                │
│  │   Dispatcher    │◄──── Worker Registry (capability manifests)    │
│  └────────┬────────┘                                                │
│           │                                                          │
│           ▼                                                          │
│  ┌─────────────────┐     ┌─────────────────┐                        │
│  │ Target Resolver │────►│ Capability      │                        │
│  │ (parse request) │     │ Matcher         │                        │
│  └────────┬────────┘     └────────┬────────┘                        │
│           │                       │                                  │
│           ▼                       ▼                                  │
│  ┌─────────────────┐     ┌─────────────────┐                        │
│  │ Required Caps   │────►│ Worker Selection│                        │
│  │ [flutter-and.]  │     │ (load balance)  │                        │
│  └─────────────────┘     └────────┬────────┘                        │
│                                   │                                  │
│                    ┌──────────────┼──────────────┐                  │
│                    ▼              ▼              ▼                  │
│              ┌─────────┐   ┌─────────┐   ┌─────────┐               │
│              │Worker A │   │Worker B │   │Worker C │               │
│              │(linux)  │   │(linux)  │   │(macos)  │               │
│              └─────────┘   └─────────┘   └─────────┘               │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Formal Schema (TypeScript)

```typescript
// ============================================================
// BUILD TARGET DEFINITIONS
// ============================================================

/** Supported build targets */
type BuildTarget =
  | "cpp-native"
  | "rust-native"
  | "typescript"
  | "python"
  | "flutter-android-debug"
  | "flutter-android-release"
  | "flutter-ios-debug"
  | "flutter-ios-release"
  | "flutter-web"
  | "flutter-linux-desktop"
  | "flutter-macos-desktop"
  | "flutter-windows-desktop";

/** OS requirements */
type RequiredOS = "linux" | "macos" | "windows" | "any";

/** Target → Capability mapping */
const TARGET_REQUIREMENTS: Record<BuildTarget, {
  required_os: RequiredOS;
  required_capability_class: CapabilityClass[];
  min_ram_gb: number;
  min_disk_gb: number;
  estimated_build_time_seconds: number;
}> = {
  "cpp-native": {
    required_os: "any",
    required_capability_class: ["linux-basic", "linux-flutter-android", "macos-flutter"],
    min_ram_gb: 2,
    min_disk_gb: 1,
    estimated_build_time_seconds: 30
  },
  "flutter-android-debug": {
    required_os: "linux",  // Can also be macos, but linux preferred for cost
    required_capability_class: ["linux-flutter-android", "macos-flutter"],
    min_ram_gb: 4,
    min_disk_gb: 5,
    estimated_build_time_seconds: 120
  },
  "flutter-ios-debug": {
    required_os: "macos",  // HARD REQUIREMENT
    required_capability_class: ["macos-flutter"],
    min_ram_gb: 8,
    min_disk_gb: 10,
    estimated_build_time_seconds: 180
  },
  "flutter-web": {
    required_os: "any",
    required_capability_class: ["linux-flutter-android", "macos-flutter"],
    min_ram_gb: 2,
    min_disk_gb: 2,
    estimated_build_time_seconds: 60
  },
  // ... other targets
};

// ============================================================
// JOB REQUEST SCHEMA
// ============================================================

interface BuildJobRequest {
  /** Unique job identifier */
  job_id: string;
  
  /** User/workspace context */
  workspace_id: string;
  user_id: string;
  
  /** Build specification */
  build: {
    /** Primary build target */
    target: BuildTarget;
    
    /** Build variant */
    variant: "debug" | "release";
    
    /** Project root in workspace */
    project_root: string;
    
    /** Entry point file (e.g., lib/main.dart) */
    entry_point: string;
    
    /** Additional build arguments */
    extra_args?: string[];
    
    /** Environment variables to inject */
    env?: Record<string, string>;
  };
  
  /** Source files (for small projects) or GCS reference */
  source: 
    | { type: "inline"; files: Array<{ path: string; content: string }> }
    | { type: "gcs"; bucket: string; prefix: string };
  
  /** Routing hints (optional) */
  routing?: {
    /** Prefer specific worker (for cache affinity) */
    preferred_worker_id?: string;
    
    /** Require specific capability class */
    required_capability?: CapabilityClass;
    
    /** Maximum queue wait time before rejecting */
    max_queue_seconds?: number;
    
    /** Priority (0-100, higher = more urgent) */
    priority?: number;
  };
  
  /** Output configuration */
  output: {
    /** Where to store build artifacts */
    artifact_destination: 
      | { type: "gcs"; bucket: string; prefix: string }
      | { type: "presigned_url"; callback_url: string };
    
    /** Stream build logs via WebSocket */
    stream_logs: boolean;
    
    /** WebRTC session for live output (HMR mode) */
    webrtc_session_id?: string;
  };
  
  /** Timestamps */
  created_at: string;
  expires_at: string;
}

// ============================================================
// WORKER REGISTRY SCHEMA
// ============================================================

type CapabilityClass = 
  | "linux-basic"
  | "linux-flutter-android"
  | "macos-flutter";

type WorkerHealth = "ready" | "busy" | "draining" | "unhealthy" | "offline";

interface WorkerRegistration {
  worker_id: string;
  capability_class: CapabilityClass;
  
  os: {
    type: "linux" | "macos" | "windows";
    version: string;
    arch: "x86_64" | "arm64";
  };
  
  /** Available build targets this worker supports */
  build_targets: BuildTarget[];
  
  /** Resource availability */
  resources: {
    disk_available_gb: number;
    ram_total_gb: number;
    ram_available_gb: number;
    cpu_cores: number;
    cpu_load_percent: number;
  };
  
  /** Current state */
  state: {
    health: WorkerHealth;
    current_job_id: string | null;
    jobs_completed_total: number;
    last_heartbeat: string;
  };
  
  /** Warm caches (for affinity routing) */
  warm_caches: {
    workspace_ids: string[];        // Recently built workspaces
    flutter_version: string | null;  // Pre-cached Flutter version
    gradle_home_populated: boolean;  // Gradle deps cached
  };
}

// ============================================================
// ROUTING DECISION SCHEMA
// ============================================================

interface RoutingDecision {
  job_id: string;
  
  decision: 
    | { status: "routed"; worker_id: string; reason: string }
    | { status: "queued"; queue_position: number; estimated_wait_seconds: number }
    | { status: "rejected"; error_code: RoutingErrorCode; message: string };
  
  /** Audit trail */
  evaluated_workers: Array<{
    worker_id: string;
    eligible: boolean;
    rejection_reason?: string;
    score?: number;
  }>;
  
  decided_at: string;
}

type RoutingErrorCode =
  | "NO_CAPABLE_WORKERS"      // No workers have required capability
  | "ALL_WORKERS_BUSY"        // Capable workers exist but all busy
  | "OS_CONSTRAINT_FAILED"    // e.g., iOS build requested but no macOS workers
  | "RESOURCE_INSUFFICIENT"   // Workers exist but lack RAM/disk
  | "QUEUE_TIMEOUT"           // Job waited too long in queue
  | "INVALID_TARGET"          // Unknown build target
  | "WORKSPACE_NOT_FOUND";    // Source workspace doesn't exist
```

### 3.3 Routing Decision Flow

```
ROUTING ALGORITHM (executed by Dispatcher)
==========================================

INPUT: BuildJobRequest
OUTPUT: RoutingDecision

STEP 1: VALIDATE REQUEST
────────────────────────
  1.1. Validate job_id is unique
  1.2. Validate build.target is in TARGET_REQUIREMENTS
  1.3. Validate source exists (inline or GCS)
  
  IF validation fails:
    RETURN rejected(INVALID_TARGET, "Unknown build target: {target}")

STEP 2: RESOLVE HARD CONSTRAINTS
────────────────────────────────
  2.1. Lookup target requirements:
       required_os = TARGET_REQUIREMENTS[target].required_os
       required_classes = TARGET_REQUIREMENTS[target].required_capability_class
  
  2.2. IF required_os == "macos" AND no macos workers registered:
       RETURN rejected(OS_CONSTRAINT_FAILED, 
         "iOS builds require macOS workers. None available.")
  
  2.3. IF routing.required_capability specified:
       required_classes = [routing.required_capability]  // Override

STEP 3: FILTER ELIGIBLE WORKERS
───────────────────────────────
  eligible_workers = []
  
  FOR each worker in WorkerRegistry:
    // Capability check
    IF worker.capability_class NOT IN required_classes:
      RECORD(worker_id, ineligible, "capability mismatch")
      CONTINUE
    
    // OS check
    IF required_os != "any" AND worker.os.type != required_os:
      RECORD(worker_id, ineligible, "OS mismatch")
      CONTINUE
    
    // Health check
    IF worker.state.health NOT IN ["ready", "busy"]:
      RECORD(worker_id, ineligible, "unhealthy: {health}")
      CONTINUE
    
    // Resource check
    IF worker.resources.disk_available_gb < TARGET_REQUIREMENTS[target].min_disk_gb:
      RECORD(worker_id, ineligible, "insufficient disk")
      CONTINUE
    
    IF worker.resources.ram_available_gb < TARGET_REQUIREMENTS[target].min_ram_gb:
      RECORD(worker_id, ineligible, "insufficient RAM")
      CONTINUE
    
    ADD worker TO eligible_workers

STEP 4: CHECK FOR NO MATCHES
────────────────────────────
  IF eligible_workers is EMPTY:
    // Determine most helpful error
    IF no workers with required_os exist:
      RETURN rejected(OS_CONSTRAINT_FAILED, ...)
    ELSE IF all capable workers are offline:
      RETURN rejected(NO_CAPABLE_WORKERS, ...)
    ELSE:
      RETURN rejected(RESOURCE_INSUFFICIENT, ...)

STEP 5: SCORE AND RANK WORKERS
──────────────────────────────
  FOR each worker in eligible_workers:
    score = 0
    
    // Availability bonus (ready > busy)
    IF worker.state.health == "ready":
      score += 100
    
    // Cache affinity bonus
    IF workspace_id IN worker.warm_caches.workspace_ids:
      score += 50  // Major win for incremental builds
    
    // Resource headroom bonus
    score += (worker.resources.ram_available_gb / worker.resources.ram_total_gb) * 20
    score += (worker.resources.disk_available_gb / 100) * 10
    
    // Preferred worker bonus
    IF routing.preferred_worker_id == worker.worker_id:
      score += 200
    
    // Load balancing (prefer less loaded)
    score -= worker.resources.cpu_load_percent * 0.5
    
    worker.routing_score = score

STEP 6: SELECT WORKER OR QUEUE
──────────────────────────────
  ready_workers = eligible_workers.filter(w => w.state.health == "ready")
  
  IF ready_workers is NOT EMPTY:
    best_worker = ready_workers.sort_by(routing_score).first()
    RETURN routed(best_worker.worker_id, "Best available worker (score: {score})")
  
  // All capable workers are busy
  IF routing.max_queue_seconds is defined:
    estimated_wait = estimate_queue_wait(eligible_workers)
    
    IF estimated_wait > routing.max_queue_seconds:
      RETURN rejected(QUEUE_TIMEOUT, 
        "Estimated wait {wait}s exceeds max {max}s")
  
  // Queue the job
  queue_position = add_to_queue(job, priority=routing.priority ?? 50)
  RETURN queued(queue_position, estimated_wait)
```

### 3.4 Failure Mode Handling

| Failure Mode | Detection | Response | User Message |
|--------------|-----------|----------|--------------|
| **No capable workers registered** | `eligible_workers.length == 0` after filter | Reject immediately | "No workers available for {target} builds. Please try again later or contact support." |
| **iOS build on Linux-only cluster** | `required_os == "macos"` and no macOS workers | Reject immediately | "iOS builds require macOS workers. This cluster only has Linux workers." |
| **All workers busy** | All eligible workers have `health == "busy"` | Queue with timeout | "Build queued. Position: {n}. Estimated wait: {t}s." |
| **Worker dies mid-build** | Heartbeat timeout (30s) | Re-route job to another worker | "Build worker disconnected. Retrying on another worker..." |
| **Disk full on worker** | Worker reports `disk_available_gb < 1` | Mark unhealthy, exclude from routing | (Internal) Worker auto-excluded |
| **Build timeout** | Job exceeds `estimated_build_time * 3` | Kill job, return partial logs | "Build timed out after {n} minutes. Check for infinite loops or resource issues." |
| **Invalid project structure** | Flutter doctor fails | Return error with diagnostics | "Invalid Flutter project: {diagnostic output}" |

### 3.5 Cache Affinity Strategy

For incremental builds and HMR, cache affinity is critical:

```
CACHE AFFINITY ALGORITHM
========================

1. WORKSPACE AFFINITY (highest priority)
   - Track last 10 workspace_ids built by each worker
   - Score +50 for exact workspace match
   - Enables: Gradle cache reuse, Flutter incremental Dart compile, 
              node_modules caching

2. FLUTTER VERSION AFFINITY
   - Track Flutter SDK version cached on worker
   - Score +20 if requested Flutter version matches cached
   - Avoids: Flutter SDK download (2GB+)

3. GRADLE CACHE AFFINITY
   - Track if worker has populated ~/.gradle
   - Score +30 if gradle_home_populated == true
   - Avoids: Gradle dependency download (500MB+ per project)

4. NEGATIVE AFFINITY
   - If worker recently OOM'd on a workspace, score -100
   - If worker has build failure rate > 20%, score -50
```

---

## Phase 4: Non-Goals (v1 Scope Exclusions)

### 4.1 Emulators — EXCLUDED

**Reason:** Running Android emulators or iOS simulators in cloud workers is:
1. **Computationally prohibitive** — Emulators require hardware virtualization (KVM), 4GB+ RAM dedicated, and GPU passthrough for acceptable performance
2. **Not cloud-native** — Emulators are designed for developer workstations, not ephemeral containers
3. **Poor UX** — Streaming emulator video over WebRTC adds latency; users have better emulators locally
4. **Cost explosion** — A single emulator instance would consume an entire worker

**Alternative for v1:** Build APK/IPA, provide download link, user installs on their device or local emulator.

**Future consideration (v2+):** Partner with device cloud providers (Firebase Test Lab, AWS Device Farm) for on-device testing.

### 4.2 App Store Deployment — EXCLUDED

**Reason:**
1. **Credential management complexity** — Requires storing Apple Developer certificates, Google Play signing keys, and provisioning profiles securely
2. **Legal/compliance burden** — App Store submissions have legal requirements (EULA acceptance, export compliance) that cannot be automated without user verification
3. **Out of core value prop** — Synthi is a cloud IDE for development, not a CI/CD pipeline
4. **Existing solutions** — Fastlane, Codemagic, Bitrise already solve this well

**v1 deliverable:** Debug builds only. Users handle release signing and deployment externally.

### 4.3 Code Signing Automation — EXCLUDED (Deferred to v2)

**Reason:**
1. **Security risk** — Storing user signing keys (Android keystore, Apple certificates) requires HSM-grade security
2. **Scope creep** — Code signing is a deep rabbit hole (certificate expiry, provisioning profile management, key rotation)
3. **Debug builds are sufficient** — For development iteration, debug builds are adequate

**v2 path:** Integrate with Apple's cloud signing (App Store Connect API) and Google Play's managed signing.

### 4.4 Windows Desktop Builds — EXCLUDED

**Reason:**
1. **No Windows workers yet** — Windows Server licensing adds operational cost
2. **Flutter Windows requires MSVC** — Visual Studio Build Tools are heavyweight (10GB+)
3. **Low priority** — Mobile is primary use case; Linux desktop covers most desktop dev needs

**Reconsider when:** User demand materializes and Windows worker economics improve.

### 4.5 Hot Reload over WebRTC to Mobile Device — EXCLUDED

**Reason:**
1. **Requires Flutter daemon on device** — Hot reload requires `flutter attach` connected to a running app
2. **Network complexity** — Device must be reachable from worker (NAT traversal, USB-over-IP)
3. **Existing HMR is desktop-focused** — Current Synthi HMR streams video from worker-local SDL window

**v1 deliverable:** Cold builds only. User manually reinstalls APK on code change.

**v2 path:** Explore Flutter's `--machine` mode for headless hot reload coordination.

### 4.6 Gradle/Maven Dependency Proxy — EXCLUDED

**Reason:**
1. **Operational complexity** — Running a Nexus/Artifactory proxy adds infra burden
2. **Cache affinity mitigates** — By routing to same worker, Gradle cache is reused
3. **Network is cheap** — Downloading deps is slow but not a blocker for v1

**v2 optimization:** Consider shared Gradle cache volume or dependency proxy if build times are unacceptable.

---

## Implementation Checklist

### For Backend Engineer (Dispatcher)

- [ ] Implement `BuildJobRequest` validation
- [ ] Implement `TARGET_REQUIREMENTS` lookup table
- [ ] Implement worker capability filtering (Steps 2-3)
- [ ] Implement worker scoring algorithm (Step 5)
- [ ] Implement job queue with priority
- [ ] Implement routing decision audit logging
- [ ] Add WebSocket endpoint for job status streaming
- [ ] Add retry logic for worker failures

### For Infra Engineer (Worker Provisioning)

- [ ] Create `linux-flutter-android` Docker image with:
  - Flutter SDK 3.24+ (stable channel)
  - Android SDK cmdline-tools
  - OpenJDK 17
  - Android SDK platforms;android-34, build-tools;34.0.0
- [ ] Create capability self-report endpoint in worker
- [ ] Implement heartbeat (every 10s) to dispatcher
- [ ] Implement health checks (`flutter doctor`, disk space)
- [ ] Configure auto-scaling based on queue depth
- [ ] Set up artifact storage (GCS bucket)

### For Worker Implementation (Rust)

- [ ] Add `flutter build apk --debug` command execution
- [ ] Add `pubspec.yaml` detection for Flutter projects
- [ ] Implement Flutter-specific error parsing
- [ ] Stream build logs over existing WebSocket
- [ ] Upload APK to GCS and return presigned URL
- [ ] Report `flutter-android-debug` in capability manifest

---

## Appendix A: Worker Capability Registration Message

```rust
// In worker main.rs, extend SignalMessage or create new type

#[derive(Debug, Serialize, Deserialize)]
struct WorkerCapabilityReport {
    msg_type: String,  // "capability_report"
    worker_id: String,
    capability_class: String,
    os_type: String,
    os_version: String,
    arch: String,
    build_targets: Vec<String>,
    toolchains: HashMap<String, ToolchainInfo>,
    resources: ResourceInfo,
    warm_caches: WarmCacheInfo,
}

#[derive(Debug, Serialize, Deserialize)]
struct ToolchainInfo {
    version: String,
    path: String,
}

#[derive(Debug, Serialize, Deserialize)]  
struct ResourceInfo {
    disk_available_gb: f64,
    ram_total_gb: f64,
    cpu_cores: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct WarmCacheInfo {
    workspace_ids: Vec<String>,
    flutter_version: Option<String>,
    gradle_home_populated: bool,
}
```

## Appendix B: Flutter Build Command Templates

```bash
# Debug APK (v1 scope)
flutter build apk --debug \
  --target=lib/main.dart \
  --build-name=1.0.0 \
  --build-number=1

# Output: build/app/outputs/flutter-apk/app-debug.apk

# Flutter Web
flutter build web \
  --target=lib/main.dart \
  --release  # Web can be release, no signing needed

# Output: build/web/

# Pre-build validation
flutter pub get
flutter analyze --no-fatal-warnings
```

## Appendix C: Error Code Reference

| Code | HTTP Status | Retryable | Description |
|------|-------------|-----------|-------------|
| `NO_CAPABLE_WORKERS` | 503 | Yes (with backoff) | Scale up workers or wait |
| `ALL_WORKERS_BUSY` | 503 | Yes (queued) | Job will auto-retry from queue |
| `OS_CONSTRAINT_FAILED` | 400 | No | Wrong cluster for this build type |
| `RESOURCE_INSUFFICIENT` | 503 | Yes | Workers need more resources |
| `QUEUE_TIMEOUT` | 408 | Yes | Retry with higher priority or later |
| `INVALID_TARGET` | 400 | No | Client error, fix request |
| `WORKSPACE_NOT_FOUND` | 404 | No | Upload source first |

---

**End of Architecture Document**
