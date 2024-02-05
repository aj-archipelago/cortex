FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

## installing ffmepg
RUN apk update && \
    apk add ffmpeg

COPY . .

EXPOSE 7071

# RUN npm run build

CMD [ "node", "start.js" ]