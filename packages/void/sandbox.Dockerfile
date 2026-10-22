FROM node:26.12.1-trixie-slim
COPY --from=docker.io/cloudflare/sandbox:1.0.2 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
WORKDIR /workspace
CMD ["sleep", "infinity"]
