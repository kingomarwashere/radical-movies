FROM node:22-alpine

RUN apk add --no-cache ffmpeg python3

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p downloads /data

EXPOSE 8080

CMD ["node", "server/index.js"]
