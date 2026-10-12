FROM node:22-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

COPY package.json package-lock.json* ./

# Build tools (vite) are dev dependencies: install everything, build, then drop them
RUN npm ci && npm cache clean --force

COPY . .

RUN npx prisma generate && npm run build && npm prune --omit=dev

ENV NODE_ENV=production

# One image, two services:
#   web:    npm run docker-start   (runs database migrations, then the app)
#   worker: npm run worker         (runs jobs; set this as the start command of the second service)
CMD ["npm", "run", "docker-start"]
