FROM node:20-bookworm-slim AS dependencies

WORKDIR /usr/src/app

# sqlite3 is a native Node module. Keep a compiler toolchain available in the
# dependency stage so npm can build it when a matching prebuilt binary is not
# available for the current Node/Docker platform.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm_config_build_from_source=true npm ci --omit=dev \
    && node -e "require('sqlite3'); console.log('sqlite3 dependency verified')" \
    && npm cache clean --force

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /usr/src/app

COPY --from=dependencies --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node data ./data

USER node

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3010) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["npm", "start"]
