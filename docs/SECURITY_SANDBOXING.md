# Synthi HMR Security Model & Sandboxing

> **CRITICAL WARNING**: This system executes arbitrary native code delivered over a network channel.
> This is RCE (Remote Code Execution) by design. Without proper sandboxing, this is UNSAFE outside
> a fully trusted local environment.

## Current Security Status

### What Exists
- Fork isolation for crash recovery (Linux only)
- Basic process separation (worker vs runner)
- Signal handlers for crash detection

### What's Missing (MUST FIX for production)
1. **Process sandboxing**: seccomp-bpf, AppArmor/SELinux
2. **Filesystem restrictions**: Restricted paths, read-only mounts
3. **Network isolation**: No network access from plugin code
4. **Resource limits**: CPU, memory, file size caps
5. **Capability dropping**: Remove dangerous capabilities

---

## Recommended Security Architecture

### 1. Execution Modes

```
┌─────────────────────────────────────────────────────────────────┐
│                     SECURITY MODES                               │
├─────────────────────────────────────────────────────────────────┤
│ MODE 1: Local Development (current)                             │
│   - No sandboxing                                               │
│   - User accepts full trust                                     │
│   - Fast iteration                                              │
├─────────────────────────────────────────────────────────────────┤
│ MODE 2: Sandboxed Local (recommended)                           │
│   - Process isolation                                           │
│   - Filesystem restrictions                                     │
│   - Resource limits                                             │
│   - No network from plugin                                      │
├─────────────────────────────────────────────────────────────────┤
│ MODE 3: Container Isolation (production)                        │
│   - Full container (Docker/Podman)                              │
│   - Namespaces: pid, net, mount, user                          │
│   - seccomp-bpf syscall filtering                              │
│   - AppArmor/SELinux MAC                                       │
│   - Read-only rootfs                                           │
└─────────────────────────────────────────────────────────────────┘
```

### 2. seccomp-bpf Filter (Syscall Whitelist)

Plugins should only be allowed these syscalls:

```rust
// ALLOWED syscalls for hot modules
const ALLOWED_SYSCALLS: &[&str] = &[
    // Memory
    "brk", "mmap", "munmap", "mprotect",
    
    // Basic I/O (stdin/stdout only, no file open)
    "read", "write", "writev",
    
    // Time
    "clock_gettime", "gettimeofday",
    
    // Threading (if explicitly allowed)
    "clone", "futex", "set_robust_list",
    
    // Exit
    "exit", "exit_group",
    
    // Required for dynamic linking
    "openat",  // Only for allowed paths
    "close", "fstat", "mmap",
    
    // SDL/GUI specific (if GUI mode)
    "poll", "ioctl",  // Restricted
];

// BLOCKED syscalls (examples)
const BLOCKED_SYSCALLS: &[&str] = &[
    "execve", "execveat",  // No spawning processes
    "fork", "vfork", "clone3",  // No forking (unless runner controls it)
    "socket", "connect", "bind", "listen", "accept",  // No network
    "ptrace",  // No debugging other processes
    "init_module", "delete_module",  // No kernel modules
    "mount", "umount",  // No filesystem mounting
    "chroot", "pivot_root",  // No namespace escapes
];
```

### 3. Filesystem Restrictions

```
ALLOWED PATHS (read-only):
  /lib/*, /lib64/*           - System libraries
  /usr/lib/*                 - System libraries
  <workspace>/output/*       - Compiled outputs (read for dlopen)
  
ALLOWED PATHS (read-write):
  /tmp/synthi-<session>/*    - Temp directory (isolated per session)
  
BLOCKED PATHS:
  Everything else, especially:
  - /etc/*
  - /home/*
  - /root/*
  - /proc/* (except /proc/self/fd)
  - /sys/*
```

### 4. Resource Limits (via setrlimit)

```rust
pub struct ResourceLimits {
    // Memory limit (2GB default)
    pub max_memory: u64 = 2 * 1024 * 1024 * 1024,
    
    // CPU time limit (0 = unlimited, but consider watchdog)
    pub max_cpu_time: u64 = 0,
    
    // Output file size (100MB)
    pub max_file_size: u64 = 100 * 1024 * 1024,
    
    // Open file descriptors
    pub max_open_files: u32 = 256,
    
    // Process count (prevent fork bombs)
    pub max_processes: u32 = 1,
}
```

### 5. Network Isolation

For GUI applications that legitimately need network (HTTP APIs, etc.):
- Use a **network proxy** in the supervisor
- Plugin requests go through IPC → supervisor → network
- Supervisor can filter/audit requests
- No direct socket access from plugin

---

## Implementation Path

### Phase 1: Process Isolation (IMPLEMENTED - see process_isolation.rs)
- [x] Supervisor/worker split
- [x] IPC protocol design (binary framing, MsgPack)
- [x] Crash recovery via restart with hard timeouts
- [x] State snapshot via IPC
- [x] **Process isolation is now DEFAULT** - in-process requires SYNTHI_UNSAFE_INPROCESS=1
- [x] Binary IPC protocol (length-prefixed MsgPack, not JSON)
- [x] Hard timeouts with SIGKILL policy (no "wait forever")
- [x] Memcpy blocked without layout_hash (forces serialization or cold reload)

### Phase 1.5: ABI Safety (IMPLEMENTED - see enhanced_fingerprint.rs, runner_bin.rs)
- [x] Enhanced ABI fingerprinting (compiler, target, layout_hash)
- [x] **No memcpy without layout_hash** - prevents silent memory corruption
- [x] Serialization-based migration preferred over raw pointer casting
- [ ] Layout hash extraction from DWARF/debug info (stubbed, returns None)

### Phase 2: Basic Sandboxing (TODO)
- [ ] setrlimit for resource limits
- [ ] chroot/pivot_root to restricted filesystem
- [ ] Drop capabilities after setup
- [ ] Whitelist environment variables

### Phase 3: seccomp-bpf (TODO)
- [ ] Build syscall whitelist
- [ ] Handle GUI vs non-GUI modes differently
- [ ] Test with real plugins
- [ ] Graceful failure on blocked syscalls

### Phase 4: Container Integration (TODO)
- [ ] Dockerfile/Containerfile for runner
- [ ] Podman/Docker runtime integration
- [ ] Namespace configuration
- [ ] Volume mounts for workspace

---

## Code Location

Security-related modules:
- `process_isolation.rs` - Process supervisor, IPC
- `strict_contract.rs` - Plugin contract enforcement
- `enhanced_fingerprint.rs` - ABI safety
- `crash_recovery.rs` - Signal handling, fork isolation

Future modules (not yet implemented):
- `sandbox.rs` - seccomp-bpf, capability dropping
- `network_proxy.rs` - Filtered network access
- `container.rs` - Container runtime integration

---

## Threat Model

### Attacker Goals
1. Execute arbitrary code on host
2. Access sensitive files
3. Network exfiltration
4. DoS via resource exhaustion
5. Escape sandbox

### Mitigations
| Threat | Mitigation |
|--------|------------|
| Arbitrary code | Already allowed (by design), but sandboxed |
| File access | Filesystem restrictions, chroot |
| Network exfiltration | No direct sockets, proxy only |
| Resource DoS | setrlimit, watchdog |
| Sandbox escape | seccomp-bpf, namespaces, MAC |

### Residual Risks
- Kernel exploits (mitigate: keep kernel updated, gVisor)
- Side-channel attacks (accept for now)
- Social engineering (out of scope)

---

## Recommended Deployment Configurations

### Development (Local Machine)
```yaml
security_mode: local_development
sandbox: none
trust_level: full
warning: "Only run code you trust"
```

### Shared Development Server
```yaml
security_mode: sandboxed_local
sandbox:
  seccomp: enabled
  filesystem: restricted
  network: none
  resources:
    max_memory: 2GB
    max_cpu_time: 60s
```

### Production/Multi-tenant
```yaml
security_mode: container_isolation
container:
  runtime: podman  # rootless
  image: synthi-runner:hardened
  namespaces: [pid, net, mount, user]
  seccomp: strict
  apparmor: synthi-runner-profile
  readonly_rootfs: true
  no_new_privileges: true
```

---

## References

- [seccomp-bpf](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html)
- [Linux namespaces](https://man7.org/linux/man-pages/man7/namespaces.7.html)
- [AppArmor](https://apparmor.net/)
- [gVisor](https://gvisor.dev/) - Kernel-level sandboxing
- [Firecracker](https://firecracker-microvm.github.io/) - microVM isolation
