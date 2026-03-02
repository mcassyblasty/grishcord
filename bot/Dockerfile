FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY prompts ./prompts
CMD ["npm", "run", "start"]
