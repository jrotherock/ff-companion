# Nixpacks mounts a build cache inside node_modules, and `npm ci` deletes
# node_modules wholesale — it hits the mount point and fails with EBUSY before
# a line of this app is compiled. A Dockerfile sidesteps that and says exactly
# what runs, which is worth more than the few seconds nixpacks saves.
FROM node:22-alpine

WORKDIR /app

# Dependencies first, so a source change does not re-install them.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# tsx is a devDependency and the server runs TypeScript through it, so nothing
# is pruned here. NODE_ENV is set after the install for the same reason: an
# earlier one would have skipped the packages the build needs.
ENV NODE_ENV=production
ENV STATE_DIR=/app/state

# Railway supplies PORT; this is only the default for a local docker run.
EXPOSE 4600

CMD ["npm", "start"]
