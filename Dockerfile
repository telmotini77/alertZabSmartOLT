FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies by copying package.json and package-lock.json
COPY package*.json ./

RUN npm ci --only=production

# Bundle app source
COPY src ./src
COPY data ./data

# Expose server port
EXPOSE 3000

# Start server
CMD [ "npm", "start" ]
