# Y-Sweet Server for Synthi

This directory contains the Docker configuration for the Y-Sweet CRDT server component of Synthi.

## Running with Docker

You can build and run the image directly:

```bash
# Build
docker build -t synthi-y-sweet .

# Run (maps port 8080 to host, persists data to a volume)
docker run -p 8080:8080 -v ysweet-data:/data synthi-y-sweet
```

This makes the Y-Sweet server available at `ws://localhost:8080` (or `http://localhost:8080` for REST calls).

## Running with Docker Compose

Add this service to your `docker-compose.yml`:

```yaml
services:
  y-sweet:
    build: ./backend/y-sweet
    ports:
      - "8080:8080"
    volumes:
      - ysweet-data:/data
    environment:
      - RUST_LOG=info

volumes:
  ysweet-data:
```

## Running in Kubernetes

Use the provided manifest in `k8s/y-sweet.yaml`. It uses the official `ghcr.io/jamsocket/y-sweet:latest` image by default, but you can update it to use your custom built image if needed.
