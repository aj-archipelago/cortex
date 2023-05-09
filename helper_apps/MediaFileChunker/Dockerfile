FROM node:18-alpine

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

## following 3 lines are for installing ffmepg
RUN apk update
RUN apk add
RUN apk add ffmpeg

COPY . .

EXPOSE 7071

# RUN npm run build

CMD [ "node", "start.js" ]