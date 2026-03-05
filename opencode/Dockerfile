FROM ghcr.io/anomalyco/opencode:latest

RUN printf '%s\n' \
  'https://dl-cdn.alpinelinux.org/alpine/v3.23/main' \
  'https://dl-cdn.alpinelinux.org/alpine/v3.23/community' \
  > /etc/apk/repositories \
  && apk update \
  && apk add --no-cache \
  git \
  nodejs \
  npm \
  openssh-client

COPY workspace_manage /opt/workspace_manage
COPY start-all.sh /opt/start-all.sh
RUN sed -i 's/\r$//' /opt/start-all.sh && chmod +x /opt/start-all.sh
