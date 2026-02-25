FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
CMD ["npm","start"]
