FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies by copying package.json and package-lock.json
COPY package*.json ./

RUN npm ci --only=production

# Bundle app source
COPY src ./src
COPY data ./data

# Keep the image metadata aligned with the default PORT in .env.example.
# Docker Compose can still override it through the PORT environment variable.
EXPOSE 3010

# Start server
CMD [ "npm", "start" ]
