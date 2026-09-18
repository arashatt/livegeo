# The service is plain Node with no build step, so there is nothing to compile
# and nothing to carry over from a builder stage — just the runtime deps.
FROM node:22-alpine

WORKDIR /app

# Copied first so that a change to the source does not invalidate the layer
# holding the dependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY sql ./sql
COPY public ./public
COPY bin ./bin

# Inside a container the loopback default would only be reachable from the
# container itself. Publishing the port is what decides who can reach it.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080
USER node

# /healthz is the one route that needs no token, which is exactly what makes
# it usable here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
