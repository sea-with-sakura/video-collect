FROM node:latest

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data /app/exports

EXPOSE 4173

CMD ["node", "./src/server.js"]
