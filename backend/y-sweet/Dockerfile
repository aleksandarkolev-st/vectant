# Use the official Y-Sweet image as the base
FROM ghcr.io/jamsocket/y-sweet:latest

# Expose the default port
EXPOSE 8080

# Set up a volume for persistent data
VOLUME ["/data"]

# Run the server by default (override with generic args if needed)
# Bind to 0.0.0.0 to allow external access within container network
CMD ["y-sweet", "serve", "/data", "--host", "0.0.0.0", "--port", "8080"]
