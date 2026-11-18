FROM node:24-alpine

WORKDIR /app

COPY . .

RUN mkdir -p /app/data /app/public

EXPOSE 3000

ENV PORT=3000

CMD ["node", "server.js"]
