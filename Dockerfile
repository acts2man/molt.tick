# Playwright base image ships Chromium + every system dependency it needs,
# version-matched to our playwright-core. This is what makes the crawler
# "just work" on a server instead of fighting missing libs.
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

# --- pre-baked render toolchain (Step 1) ---------------------------------
# The pixel-render step builds each synthesized site. Installing React/Vite/
# Tailwind per migration costs minutes. Instead we install them ONCE here into
# /opt/molt-render; render.ts symlinks this node_modules into each generated
# project, so migrations do zero npm install.
WORKDIR /opt/molt-render
COPY render-toolchain/package.json ./package.json
RUN npm install --no-audit --no-fund

# --- the engine ----------------------------------------------------------
WORKDIR /app

# install engine deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci

# app source
COPY . .

# the worker is the long-running process; it polls Supabase and runs migrations
CMD ["npm", "run", "worker"]
