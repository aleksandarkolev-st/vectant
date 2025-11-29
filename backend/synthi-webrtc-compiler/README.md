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

## ICE servers / TURN

If you experience ICE failures (no connectivity established), configure a TURN server for relay capabilities. By default the system uses Google's public STUN server. You can provide custom ICE servers to both the frontend and the worker with the following environment variables:

- Frontend (Next.js, runtime available to browser):
   - `NEXT_PUBLIC_ICE_SERVERS` — JSON array of `RTCIceServer` objects. Example in `.env.local`:

```env
NEXT_PUBLIC_ICE_SERVERS='[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.com:3478"],"username":"turnuser","credential":"turnpass"}]'
```

- Worker (the compiler worker running in the backend):
   - `COMPILER_ICE_SERVERS` — same format as above (JSON array). Example in your shell:

```bash
export COMPILER_ICE_SERVERS='[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.com:3478"],"username":"turnuser","credential":"turnpass"}]'
```

We recommend deploying a secure TURN server (coturn) for production. A quick local setup example using Docker Compose:

```yaml
version: '3'
services:
   coturn:
      image: instrumentisto/coturn
      ports:
         - "3478:3478"
      environment:
         - REALM=localhost
         - LISTEN=0.0.0.0
         - DEFAULT_USER=turnuser:turnpass
```

Replace `turn.example.com`, `turnuser`, and `turnpass` with your TURN server details.

### Debugging ICE

- In Firefox, open `about:webrtc` to inspect ICE candidate pairs, logs, and connection stats.
- In Chrome, open `chrome://webrtc-internals` to inspect the PeerConnection, candidates, and RFC-ice webrtc internals.
- Watch console logs for `compilerClient ICE connection state:` and `Peer Connection State:` on the worker process.
- If you still see ICE failures after configuring a TURN server, ensure that the TURN server is reachable from both peers (frontend browser network and backend worker network), and that username/credentials are correct, and the TURN ports are open in your firewall.
