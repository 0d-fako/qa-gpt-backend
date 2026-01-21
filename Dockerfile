# Use the official Playwright image which comes with all necessary browsers and dependencies installed.
# Using jammy (Ubuntu 22.04) as the base.
FROM mcr.microsoft.com/playwright:v1.57.0-jammy

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json first to leverage Docker cache
COPY package*.json ./

# Install project dependencies
# We use npm ci for reliable builds
RUN npm ci

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Command to run the application
CMD ["node", "server.js"]
