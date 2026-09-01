# One container image for AWS App Runner — see server/README.md "AWS deployment" for the exact
# build/push/deploy commands. Multi-stage: builds the React frontend in a throwaway stage, then
# copies just the built static files (frontend/dist) into the backend image as server/public —
# server.js serves them directly (see its serveStatic() function), so one App Runner service
# serves both the site and its API from the same origin. Build this from the REPO ROOT (not
# server/), since it needs both frontend/ and server/ in its build context:
#   docker build -t atm-scheduler .

# ---- Stage 1: build the frontend ----
FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# ---- Stage 2: the backend, serving the frontend's build output ----
FROM node:22-slim
WORKDIR /app

# Install deps first so this layer only rebuilds when package.json changes, not on every code edit.
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev

COPY server/ .
COPY --from=frontend-build /app/frontend/dist ./public

# App Runner sets PORT itself and expects the container to listen on it — server.js already reads
# process.env.PORT (default 8787 otherwise). Configure App Runner's own "Port" setting to whatever
# this ends up being (8787, if you don't override PORT via an App Runner env var).
EXPOSE 8787

CMD ["node", "start.js"]
