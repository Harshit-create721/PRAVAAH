# Alpine keeps this near 60 MB. The droplet runs five other services in under
# 1 GB total, so image and resident size both matter here.
FROM node:22-alpine

WORKDIR /app

# Copy manifests first so a source-only change reuses the dependency layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=3040
ENV HOST=0.0.0.0
EXPOSE 3040

# Run unprivileged. The node image ships a `node` user for exactly this.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3040/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
