// ============================================================
// PTXAS INFO PARSER (GPU_HMR_ULTRAPLAN §11.2)
// ============================================================
//
// `nvcc --ptxas-options=-v` emits structured info/warning lines on
// stderr. We parse those into discrete records so the GPU error triage
// agent (§5.6 item 7) can promote them to Tier-2 heal triggers when
// they cross a threshold (register pressure, spill stores, shared/
// constant memory exhaustion) and so the IDE can show advisory
// badges for sub-threshold records.
//
// Phase 0 ships the parser as a standalone module with the record
// types and a regex-based extractor. The triage tier-promotion logic
// and the threshold checks live alongside the agents and the runtime
// watchdog (`gpu_runtime_watchdog.rs`); this file owns only the
// stderr → records mapping so it's straightforward to unit-test.
//
// Examples (taken from real nvcc stderr):
//
//     ptxas info    : 0 bytes gmem
//     ptxas info    : Compiling entry function '_Z7vec_addPKfS0_Pfi' for 'sm_80'
//     ptxas info    : Function properties for _Z7vec_addPKfS0_Pfi
//                     0 bytes stack frame, 0 bytes spill stores, 0 bytes spill loads
//     ptxas info    : Used 18 registers, 0 bytes cumulative stack size, 360 bytes cmem[0]
//     ptxas warning : Stack size for entry function '_Z3fooPi' cannot be statically determined
//     nvlink error  : Undefined reference to '_Z3fooi' in '/tmp/foo.o'
//
// We extract the fields that drive triage decisions: per-kernel
// register count, spill bytes, cmem total, shared-memory warning,
// and any nvlink-level undefined references.

use serde::{Deserialize, Serialize};

/// Per-kernel register-pressure record. Triage promotes to Tier-2 when
/// the count exceeds 75 % of the arch's max for the launch's block size
/// (the launch-graph extractor knows the block size; here we just
/// surface the raw count).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RegisterPressureRecord {
    pub kernel_mangled: String,
    pub registers: u32,
    pub spill_stores_bytes: u32,
    pub spill_loads_bytes: u32,
    pub stack_frame_bytes: u32,
}

/// Per-kernel constant memory usage record. `cmem[0]` is the default
/// constant bank; bank index is parsed from `cmem[N]`. Triage promotes
/// when total cmem > 90 % of 64 KiB.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConstantMemUsageRecord {
    pub kernel_mangled: String,
    pub bank: u32,
    pub bytes: u32,
}

/// Shared-memory exhaustion warning (ptxas-level). Triage promotes
/// unconditionally — the kernel will fail to launch with the requested
/// block size.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SharedMemWarningRecord {
    pub kernel_mangled: String,
    pub message: String,
}

/// nvlink-level undefined reference. Same shape as the host's
/// undefined-reference error path: the symbol name plus the
/// translation unit that referenced it. Surfaces as a Tier-1 heal.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LinkErrorRecord {
    pub symbol: String,
    pub referenced_in: String,
}

/// All toolchain diagnostics extracted from one compile invocation.
/// Empty fields are normal — most well-formed compiles produce
/// register/cmem info but no warnings.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct GpuToolchainDiagnostics {
    pub register_pressure: Vec<RegisterPressureRecord>,
    pub constant_mem_usage: Vec<ConstantMemUsageRecord>,
    pub shared_mem_warnings: Vec<SharedMemWarningRecord>,
    pub link_errors: Vec<LinkErrorRecord>,
}

impl GpuToolchainDiagnostics {
    pub fn is_empty(&self) -> bool {
        self.register_pressure.is_empty()
            && self.constant_mem_usage.is_empty()
            && self.shared_mem_warnings.is_empty()
            && self.link_errors.is_empty()
    }
}

/// Parse ptxas / nvlink stderr into a `GpuToolchainDiagnostics`.
///
/// The implementation is deliberately line-oriented and tolerant of
/// minor format variations: ptxas's output format has changed across
/// CUDA versions and the regex set targets the stable fragments.
/// Anything we don't recognise is dropped silently rather than failing
/// the parse — the raw stderr is preserved separately by the compile
/// stage so the user always has the unparsed truth.
pub fn parse(stderr: &str) -> GpuToolchainDiagnostics {
    let mut out = GpuToolchainDiagnostics::default();
    let mut current_kernel: Option<String> = None;
    let mut current_props_kernel: Option<String> = None;
    let mut current_props: Option<RegisterPressureRecord> = None;

    for raw_line in stderr.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }

        // "Compiling entry function 'mangled' for 'sm_80'"
        if let Some(rest) = line.strip_prefix("ptxas info    : Compiling entry function '") {
            if let Some(end) = rest.find('\'') {
                let mangled = &rest[..end];
                current_kernel = Some(mangled.to_string());
            }
            continue;
        }

        // "Function properties for mangled"
        if let Some(rest) = line.strip_prefix("ptxas info    : Function properties for ") {
            let mangled = rest.trim().to_string();
            current_props_kernel = Some(mangled);
            current_props = Some(RegisterPressureRecord {
                kernel_mangled: current_props_kernel.clone().unwrap_or_default(),
                registers: 0,
                spill_stores_bytes: 0,
                spill_loads_bytes: 0,
                stack_frame_bytes: 0,
            });
            continue;
        }

        // The "X bytes stack frame, Y bytes spill stores, Z bytes spill loads"
        // line. Comes on the next line after "Function properties" without a
        // "ptxas info" prefix in some CUDA versions.
        if line.contains("stack frame") && line.contains("spill stores") {
            if let Some(record) = current_props.as_mut() {
                record.stack_frame_bytes = extract_bytes_before(line, "stack frame").unwrap_or(0);
                record.spill_stores_bytes = extract_bytes_before(line, "spill stores").unwrap_or(0);
                record.spill_loads_bytes = extract_bytes_before(line, "spill loads").unwrap_or(0);
            }
            continue;
        }

        // "Used N registers, ... K bytes cmem[B]"
        if let Some(rest) = line.strip_prefix("ptxas info    : Used ") {
            let registers = extract_leading_u32(rest).unwrap_or(0);
            let kernel = current_props_kernel
                .clone()
                .or_else(|| current_kernel.clone())
                .unwrap_or_default();
            // Finalise any open Function-properties record (we may not have
            // seen a stack/spill line if all values were zero and the CUDA
            // version omitted the line entirely — common on simple kernels).
            let mut props = current_props.take().unwrap_or(RegisterPressureRecord {
                kernel_mangled: kernel.clone(),
                registers: 0,
                spill_stores_bytes: 0,
                spill_loads_bytes: 0,
                stack_frame_bytes: 0,
            });
            props.kernel_mangled = kernel.clone();
            props.registers = registers;
            out.register_pressure.push(props);

            for cmem in extract_cmem_records(rest, &kernel) {
                out.constant_mem_usage.push(cmem);
            }
            // Reset the props sub-state but keep current_kernel so we can
            // attribute follow-up warnings to the right symbol.
            current_props_kernel = None;
            continue;
        }

        if let Some(rest) = line.strip_prefix("ptxas warning : ") {
            // shared-memory exhaustion is the most common Tier-2 promoter
            // we care about. Other warnings are kept verbatim under the
            // same record so triage can decide.
            out.shared_mem_warnings.push(SharedMemWarningRecord {
                kernel_mangled: current_kernel.clone().unwrap_or_default(),
                message: rest.to_string(),
            });
            continue;
        }

        if let Some(rest) = line.strip_prefix("nvlink error   : Undefined reference to '") {
            if let Some(end) = rest.find('\'') {
                let symbol = rest[..end].to_string();
                let referenced_in = rest[end..]
                    .trim_start_matches('\'')
                    .trim_start_matches(" in '")
                    .trim_end_matches('\'')
                    .trim()
                    .to_string();
                out.link_errors.push(LinkErrorRecord {
                    symbol,
                    referenced_in,
                });
            }
            continue;
        }
    }

    out
}

/// Read the integer that prefixes `s` (digits + optional unit).
fn extract_leading_u32(s: &str) -> Option<u32> {
    let s = s.trim_start();
    let end = s
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(s.len());
    if end == 0 {
        return None;
    }
    s[..end].parse::<u32>().ok()
}

/// In `"... X bytes stack frame, Y bytes spill stores, ..."`, pull out
/// X for a given anchor like "stack frame".
fn extract_bytes_before(line: &str, anchor: &str) -> Option<u32> {
    let idx = line.find(anchor)?;
    let prefix = &line[..idx];
    // Walk back past whitespace and "bytes" to find the digits.
    let trimmed = prefix.trim_end();
    let trimmed = trimmed.strip_suffix("bytes")?.trim_end();
    // Now grab the trailing digits.
    let last_digit_run = trimmed
        .rsplit(|c: char| !c.is_ascii_digit())
        .find(|s| !s.is_empty())?;
    last_digit_run.parse::<u32>().ok()
}

/// Extract `cmem[N]` records from a `Used N registers, ... K bytes cmem[B]`
/// line. There can be multiple cmem banks in a single line.
fn extract_cmem_records(line: &str, kernel: &str) -> Vec<ConstantMemUsageRecord> {
    let mut out = Vec::new();
    // Pattern: <bytes> bytes cmem[<bank>]
    // We scan manually rather than pulling in `regex` for a one-off
    // single-file parse — the module already has `regex` as a dep,
    // but staying allocation-free keeps the hot path tight.
    let mut rest = line;
    while let Some(idx) = rest.find("cmem[") {
        let pre = &rest[..idx];
        // Find the bytes count to the left of "cmem["
        let trimmed = pre.trim_end();
        let trimmed = trimmed.strip_suffix("bytes").unwrap_or(trimmed).trim_end();
        let bytes = trimmed
            .rsplit(|c: char| !c.is_ascii_digit())
            .find(|s| !s.is_empty())
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        // Parse the bank index inside `[...]`
        let after = &rest[idx + "cmem[".len()..];
        let bank = after
            .split(']')
            .next()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0);
        out.push(ConstantMemUsageRecord {
            kernel_mangled: kernel.to_string(),
            bank,
            bytes,
        });
        // Advance past this match.
        rest = &after[after.find(']').map(|i| i + 1).unwrap_or(after.len())..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_VEC_ADD: &str = r#"
ptxas info    : 0 bytes gmem
ptxas info    : Compiling entry function '_Z7vec_addPKfS0_Pfi' for 'sm_80'
ptxas info    : Function properties for _Z7vec_addPKfS0_Pfi
    0 bytes stack frame, 0 bytes spill stores, 0 bytes spill loads
ptxas info    : Used 18 registers, 360 bytes cmem[0]
"#;

    const SAMPLE_SPILL: &str = r#"
ptxas info    : Compiling entry function '_Z3fooPi' for 'sm_80'
ptxas info    : Function properties for _Z3fooPi
    32 bytes stack frame, 24 bytes spill stores, 16 bytes spill loads
ptxas info    : Used 96 registers, 384 bytes cmem[0], 8 bytes cmem[2]
ptxas warning : 'foo' uses too much shared data; consider rewriting
"#;

    const SAMPLE_LINK_ERROR: &str = r#"
nvlink error   : Undefined reference to '_Z3barPi' in '/tmp/main.o'
"#;

    #[test]
    fn parses_vec_add_clean_compile() {
        let diag = parse(SAMPLE_VEC_ADD);
        assert_eq!(diag.register_pressure.len(), 1);
        let r = &diag.register_pressure[0];
        assert_eq!(r.kernel_mangled, "_Z7vec_addPKfS0_Pfi");
        assert_eq!(r.registers, 18);
        assert_eq!(r.spill_stores_bytes, 0);
        assert_eq!(diag.constant_mem_usage.len(), 1);
        assert_eq!(diag.constant_mem_usage[0].bytes, 360);
        assert_eq!(diag.constant_mem_usage[0].bank, 0);
        assert!(diag.shared_mem_warnings.is_empty());
        assert!(diag.link_errors.is_empty());
    }

    #[test]
    fn parses_spilling_kernel() {
        let diag = parse(SAMPLE_SPILL);
        assert_eq!(diag.register_pressure.len(), 1);
        let r = &diag.register_pressure[0];
        assert_eq!(r.registers, 96);
        assert_eq!(r.spill_stores_bytes, 24);
        assert_eq!(r.spill_loads_bytes, 16);
        assert_eq!(r.stack_frame_bytes, 32);
        assert_eq!(diag.constant_mem_usage.len(), 2);
        let banks: Vec<u32> = diag.constant_mem_usage.iter().map(|c| c.bank).collect();
        assert!(banks.contains(&0));
        assert!(banks.contains(&2));
        assert_eq!(diag.shared_mem_warnings.len(), 1);
        assert!(diag.shared_mem_warnings[0].message.contains("shared data"));
    }

    #[test]
    fn parses_nvlink_undefined_reference() {
        let diag = parse(SAMPLE_LINK_ERROR);
        assert_eq!(diag.link_errors.len(), 1);
        assert_eq!(diag.link_errors[0].symbol, "_Z3barPi");
        assert!(diag.link_errors[0].referenced_in.contains("main.o"));
    }

    #[test]
    fn empty_stderr_is_empty_diagnostics() {
        let diag = parse("");
        assert!(diag.is_empty());
    }

    #[test]
    fn skips_unrecognised_lines() {
        let diag = parse("some random nvcc note that we don't care about\n");
        assert!(diag.is_empty());
    }
}
