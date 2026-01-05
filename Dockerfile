FROM node:18-alpine

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Remove devDependencies build tools
RUN apk del python3 make g++

# Expose GraphQL port
EXPOSE 4000

# Health check - uses /healthcheck which bypasses API key auth
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:4000/healthcheck || exit 1

CMD ["npm", "start"]

