This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.js`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Gateway integration

The workspace now connects to the AI Engine via the Node gateway’s WebSocket interface. Configure the URL that the Next.js app should use by setting `NEXT_PUBLIC_GATEWAY_WS_URL` in `synthi/.env.local`, for example:

```bash
NEXT_PUBLIC_GATEWAY_WS_URL=ws://localhost:7070/ws
```

Make sure the FastAPI AI engine is running (default `http://127.0.0.1:8000`) and start the gateway from `ai-backend/gateway`:

```bash
cd ai-backend/gateway
npm install
npm run dev
```

With both services online, the **Run** button in the workspace editor will stream analysis requests through the gateway and surface the diagnostics/LLM suggestions inside the editor.

## WebRTC and ICE servers

For WebRTC compiler connections, you may need TURN servers to ensure connectivity between the browser and backend workers (especially when NATs or restrictive networks are involved). By default, the client and worker will use Google's public STUN server.

To configure your own ICE / TURN servers for the frontend and worker, set the following environment variables:

- `NEXT_PUBLIC_ICE_SERVERS` (frontend) — JSON array, available client-side in Next.js:
	- Example `.env.local` entry:

```bash
NEXT_PUBLIC_ICE_SERVERS='[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.com:3478"],"username":"turnuser","credential":"turnpass"}]'
```

- `COMPILER_ICE_SERVERS` (worker) — same format; set in the environment where the worker runs.

If you still see ICE failures after setting TURN, use browser internals to debug:
- Firefox: open `about:webrtc` and inspect the candidate pairs and logs
- Chrome: open `chrome://webrtc-internals`

Also ensure the TURN server is reachable from both the browser network (internet or local network) and the backend worker's network, credentials are correct, and ports (3478/5349) are open.
