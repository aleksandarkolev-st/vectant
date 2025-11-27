# Synthi WebRTC Compiler

## Steps
1. Build deps: install Rust toolchain and ensure `g++`, `rustc`, and `tsc` are available on PATH (verify with `g++ --version`, `rustc --version`, `tsc --version`).
2. Start signaling server:
   - `cd signaling-server`
   - `cargo run`
3. Start worker:
   - `cd worker`
   - `cargo run`
4. Start the front end:
   - `cd synthi`
   - `npm run dev`
5. To test click the RUN button in a .cpp file.
