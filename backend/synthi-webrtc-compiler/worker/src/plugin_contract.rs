use std::ffi::{c_void, c_double};

/// The opaque state pointer used for persistence.
/// The Host (Runner) holds this pointer but never dereferences it.
pub type StatePtr = *mut c_void;

/// C-ABI compatible function signatures that the dynamic library must export.
pub mod ffi {
    use super::StatePtr;
    use std::ffi::{c_double, c_uint};

    /// Symbol names expected by the host
    pub const ON_LOAD_SYMBOL: &[u8] = b"on_load\0";
    pub const ON_UPDATE_SYMBOL: &[u8] = b"on_update\0";
    pub const ON_UNLOAD_SYMBOL: &[u8] = b"on_unload\0";
    pub const GET_VERSION_SYMBOL: &[u8] = b"get_version\0";

    /// Initialize or migrate state.
    /// Takes the old state pointer (or null if first load).
    /// Returns the new state pointer.
    pub type OnLoadFn = unsafe extern "C" fn(StatePtr) -> StatePtr;

    /// Run logic for one frame.
    pub type OnUpdateFn = unsafe extern "C" fn(StatePtr, c_double);

    /// Prepare for code replacement.
    pub type OnUnloadFn = unsafe extern "C" fn(StatePtr);

    /// To verify the reload happened.
    pub type GetVersionFn = unsafe extern "C" fn() -> c_uint;
}

/// A standard trait that user code can implement.
/// Note: To use this, user code would need a shim to export the C-ABI symbols.
pub trait HostGuestContract {
    /// Initialize or migrate state.
    /// `prev_state` is the pointer from the previous version of the library, or null.
    /// Returns the pointer to the new (or preserved) state.
    unsafe fn on_load(prev_state: StatePtr) -> StatePtr;

    /// Run logic for one frame.
    unsafe fn on_update(state: StatePtr, delta_time: f64);

    /// Prepare for code replacement.
    unsafe fn on_unload(state: StatePtr);

    /// Return the version of this plugin.
    fn get_version() -> u32;
}
