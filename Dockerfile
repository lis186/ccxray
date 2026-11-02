FROM node:22-slim

WORKDIR /app

# Install production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy application code
COPY server/ server/
COPY public/ public/
COPY shared/ shared/

# Default port
ENV PROXY_PORT=5577
# ccxray listens on loopback by default; listen on all interfaces so -p works
ENV PROXY_HOST=0.0.0.0

EXPOSE 5577

CMD ["node", "server/index.js"]
