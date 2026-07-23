# OpenReply — shared image for the web app and the DM worker.
# The app service runs the default CMD (migrate + serve); the worker service
# overrides CMD to run the queue consumer. Both need the same code + deps.
FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build-time placeholders only. next build never talks to the database or
# Redis (the Prisma client is lazily constructed), but the env validators
# require values to be present. Real values are injected at runtime by compose.
ENV NEXTAUTH_URL=http://localhost:3000 \
    NEXTAUTH_SECRET=build-placeholder-secret-not-real \
    ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    DATABASE_URL=postgresql://build:build@localhost:5432/build \
    REDIS_URL=redis://localhost:6379 \
    INSTAGRAM_APP_ID=build-placeholder \
    INSTAGRAM_APP_SECRET=build-placeholder \
    FACEBOOK_APP_SECRET=build-placeholder \
    WEBHOOK_VERIFY_TOKEN=build-placeholder

RUN npm run build

EXPOSE 3000

# Apply pending migrations, then serve. The worker overrides this CMD.
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
