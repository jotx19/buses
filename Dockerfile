# OC Next — one image with the Rust server and the built React pages.
# Render: Runtime "Docker", no build/start command needed (see readme).

# 1) Build the React homepage + 3D map → static/map
FROM node:24-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 2) Build the Rust server (same Debian release as the runtime image → matching glibc)
FROM rust:1-slim-bookworm AS server
WORKDIR /app
# Cache dependencies: build them once against a stub main, then build the real app.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src
COPY src ./src
COPY templates ./templates
RUN touch src/main.rs && cargo build --release && mkdir /app/data-empty

# 3) Minimal runtime: distroless (glibc + CA certs, no shell / package manager),
#    running as the non-root "nonroot" user. Time zones are compiled into the binary.
FROM gcr.io/distroless/cc-debian12:nonroot
WORKDIR /app
COPY --from=server /app/target/release/bus-service ./bus-service
COPY --from=web /app/static/map ./static/map
# Writable cache for the OC Transpo schedule (downloaded at startup, refreshed daily).
COPY --from=server --chown=nonroot:nonroot /app/data-empty ./data
ENV PORT=8080 RUST_LOG=info
EXPOSE 8080
CMD ["./bus-service"]
