FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget jq vim nano htop less tree \
    unzip zip zstd pigz \
    build-essential python3 python-is-python3 python3-pip python3-venv \
    python3-numpy python3-pandas python3-pil python3-matplotlib \
    python3-scipy python3-sklearn python3-openpyxl \
    python3-requests python3-bs4 python3-lxml \
    procps net-tools fuse3 gnupg \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://registry.npmjs.org/npm/-/npm-11.14.1.tgz -o /tmp/npm-11.14.1.tgz \
    && mkdir -p /opt/npm-11.14.1 \
    && tar -xzf /tmp/npm-11.14.1.tgz -C /opt/npm-11.14.1 --strip-components=1 \
    && node /opt/npm-11.14.1/bin/npm-cli.js --version \
    && printf '%s\n' '#!/bin/sh' 'exec node /opt/npm-11.14.1/bin/npm-cli.js "$@"' > /usr/local/bin/npm \
    && printf '%s\n' '#!/bin/sh' 'exec node /opt/npm-11.14.1/bin/npx-cli.js "$@"' > /usr/local/bin/npx \
    && chmod +x /usr/local/bin/npm /usr/local/bin/npx \
    && rm /tmp/npm-11.14.1.tgz
# Install blobfuse2 for Azure Blob Storage FUSE mount
RUN curl -fsSL https://packages.microsoft.com/keys/microsoft.asc | gpg --dearmor -o /usr/share/keyrings/microsoft.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/repos/microsoft-debian-bookworm-prod bookworm main" \
       > /etc/apt/sources.list.d/microsoft.list \
    && apt-get update && apt-get install -y --no-install-recommends blobfuse2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY .npmrc package*.json ./
RUN npm ci --omit=dev
COPY . .

RUN mkdir -p /workspace /persist /cloud-files /blob-files /tmp/blobfuse2

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -sf http://localhost:3100/health || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "server.js"]
