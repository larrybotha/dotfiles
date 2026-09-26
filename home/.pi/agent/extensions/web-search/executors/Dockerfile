FROM node:22-alpine

RUN npm install -g @mozilla/readability jsdom turndown turndown-plugin-gfm

COPY search.js /usr/local/bin/brave-search.js
COPY content.js /usr/local/bin/brave-content.js

ENTRYPOINT ["node"]
