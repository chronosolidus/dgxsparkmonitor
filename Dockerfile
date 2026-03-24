# DGX Spark Cluster Monitor
# Multi-stage build for production Node.js application

FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy application source code
COPY server.js ./
COPY public/ ./public/

# Copy data files with factory-reset defaults
COPY connections.json ./
COPY passcode.json ./
COPY weather.json ./

# Expose the application port
EXPOSE 9100

# Run as non-root user for security
RUN addgroup -g 1001 -S appgroup &&     adduser -S appuser -u 1001 -G appgroup &&     chown -R appuser:appgroup /app

USER appuser

# Start the server
CMD ["node", "server.js"]
