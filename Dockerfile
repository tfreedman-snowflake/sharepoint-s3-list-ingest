# Dockerfile for SharePoint Sync Worker
# IMPORTANT: Snowflake SPCS requires linux/amd64 architecture
# Build with: docker build --platform linux/amd64 -t sharepoint-sync-worker .

FROM --platform=linux/amd64 node:22-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/

# Copy certificate (if using local cert file)
# COPY sharepoint-worker.key ./

# Run as non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app && \
    mkdir -p /tmp && \
    chown -R nodejs:nodejs /tmp

USER nodejs

# Snowflake SPCS will inject secrets as environment variables
# The entrypoint will write the certificate to /tmp at runtime
# No HEALTHCHECK needed for SPCS (Snowflake manages container health)

# Note: The service specification in Snowflake will override this CMD
# to write the certificate before starting the app
CMD ["node", "src/index.js"]

