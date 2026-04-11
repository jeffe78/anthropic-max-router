# Stage 1: build TypeScript to dist/
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npx tsc

# Stage 2: runtime
FROM node:22-slim
WORKDIR /app

# Install Claude CLI binary directly (needed for BACKEND=cli mode)
RUN apt-get update && apt-get install -y curl && \
    GCS_BUCKET="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases" && \
    VERSION=$(curl -fsSL "$GCS_BUCKET/latest") && \
    curl -fsSL "$GCS_BUCKET/$VERSION/linux-x64/claude" -o /usr/local/bin/claude && \
    chmod +x /usr/local/bin/claude && \
    apt-get remove -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
EXPOSE 3000
CMD ["node", "dist/router/server.js", "--minimal", "--disable-bearer-passthrough"]
