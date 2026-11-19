FROM node:24-alpine

RUN apk add --no-cache git

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data /app/public

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]
