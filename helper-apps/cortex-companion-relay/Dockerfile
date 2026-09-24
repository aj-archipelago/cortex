FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY relay.js server.js handoff.js ./
USER node
EXPOSE 8080
CMD ["node", "server.js"]
