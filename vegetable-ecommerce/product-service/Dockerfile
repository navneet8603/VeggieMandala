FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY src ./src

EXPOSE ${PORT}

USER node

CMD ["node", "src/index.js"]
