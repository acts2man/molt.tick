# Playwright base image ships Chromium + every system dependency it needs,
# version-matched to our playwright-core. This is what makes the crawler
# "just work" on a server instead of fighting missing libs.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# install deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# app source
COPY . .

# the worker is the long-running process; it polls Supabase and runs migrations
CMD ["npm", "run", "worker"]
