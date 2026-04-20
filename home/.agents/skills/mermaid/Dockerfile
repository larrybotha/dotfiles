FROM node:22-alpine

RUN apk add --no-cache chromium

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN npm install -g @mermaid-js/mermaid-cli beautiful-mermaid

COPY scripts/ascii-preview.mjs /usr/local/bin/ascii-preview.mjs
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workdir

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]