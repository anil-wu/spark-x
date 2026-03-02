FROM ghcr.io/anomalyco/opencode:latest

RUN printf '%s\n' \
  'https://dl-cdn.alpinelinux.org/alpine/v3.23/main' \
  'https://dl-cdn.alpinelinux.org/alpine/v3.23/community' \
  > /etc/apk/repositories \
  && apk update \
  && apk add --no-cache \
  nodejs \
  npm

WORKDIR /app

COPY package.json ./package.json
COPY src ./src

ENV NODE_ENV=production
ENV PORT=7070

EXPOSE 7070

ENTRYPOINT ["node"]
CMD ["src/server.js"]

