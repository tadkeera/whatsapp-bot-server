FROM node:18-slim

# Install system dependencies for Puppeteer & headless Chromium running inside Debian
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer executable path to the installed chromium binary
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Create and define workspace
WORKDIR /usr/src/app

# Copy configuration files and install dependencies
COPY package*.json ./
RUN npm install

# Copy application source code
COPY . .

# Expose default port (7860 is the Hugging Face Spaces default)
EXPOSE 7860
ENV PORT=7860

# Start custom server
CMD ["node", "server.js"]
