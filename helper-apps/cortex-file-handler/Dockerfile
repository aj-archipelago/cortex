FROM node:22-alpine

RUN wget -qO /tmp/npm-11.14.1.tgz https://registry.npmjs.org/npm/-/npm-11.14.1.tgz \
    && mkdir -p /opt/npm-11.14.1 \
    && tar -xzf /tmp/npm-11.14.1.tgz -C /opt/npm-11.14.1 --strip-components=1 \
    && node /opt/npm-11.14.1/bin/npm-cli.js --version \
    && printf '%s\n' '#!/bin/sh' 'exec node /opt/npm-11.14.1/bin/npm-cli.js "$@"' > /usr/local/bin/npm \
    && printf '%s\n' '#!/bin/sh' 'exec node /opt/npm-11.14.1/bin/npx-cli.js "$@"' > /usr/local/bin/npx \
    && chmod +x /usr/local/bin/npm /usr/local/bin/npx \
    && rm /tmp/npm-11.14.1.tgz
WORKDIR /usr/src/app

COPY .npmrc package*.json ./

RUN npm install

## installing ffmepg
RUN apk update && \
    apk add ffmpeg

COPY . .

EXPOSE 7071

# RUN npm run build

CMD [ "npm", "start" ]
