FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=10000 \
    FRAMER_STATE_DIR=/tmp/framer-cli-mcp
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
RUN chown -R node:node /app
USER node

EXPOSE 10000
CMD ["node", "src/server.js"]
