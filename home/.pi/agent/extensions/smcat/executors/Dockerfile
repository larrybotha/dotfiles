FROM node:22-alpine

# Native Graphviz: required for png/pdf output types (svg/dot are pure-node).
RUN apk add --no-cache graphviz

RUN npm install -g state-machine-cat@15.0.10

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workdir

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
