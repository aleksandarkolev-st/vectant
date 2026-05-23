# Use the official Y-Sweet image as the base. The binary reports version 0.9.1;
# GHCR currently publishes it under latest, so pin the digest for immutability.
FROM ghcr.io/jamsocket/y-sweet:latest@sha256:d61ba0fa5671cc522e3f4a4c0f6cafbccbfbe66561a9ddba40041e14a22bcff0

# Expose the default port
EXPOSE 8080

# Set up a volume for persistent data
VOLUME ["/data"]

# Run the server by default (override with generic args if needed)
# Bind to 0.0.0.0 to allow external access within container network
CMD ["y-sweet", "serve", "/data", "--host", "0.0.0.0", "--port", "8080"]
