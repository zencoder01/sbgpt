# Use Node 20+ official image
FROM node:20-alpine

# Set working directory
WORKDIR app

# Copy package files first for better caching
COPY package.json .

# Install dependencies (without dev dependencies)
RUN npm install --omit=dev

# Copy the rest of your project files
COPY . .

# Railway expects a port to be exposed (Baileys doesn’t need it, but let’s avoid errors)
EXPOSE 3000

# Run your bot
CMD [node, index.js]
