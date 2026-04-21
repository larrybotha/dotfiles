# Pi Extensions

Custom extensions for [pi](https://github.com/mariozechner/pi-coding-agent).

## Setup

Requires `@mariozechner/pi-coding-agent` installed globally (`npm i -g @mariozechner/pi-coding-agent`).

### Recreate package.json

Adjust the `file:` paths below to match your global npm root (`npm root -g`). The path below assumes nvm with node v24.7.0.

```sh
cat > package.json << 'EOF'
{
  "name": "pi-extensions",
  "private": true,
  "type": "module",
  "devDependencies": {
    "@mariozechner/pi-ai": "file:$(npm root -g)/@mariozechner/pi-ai",
    "@mariozechner/pi-coding-agent": "file:$(npm root -g)/@mariozechner/pi-coding-agent",
    "@mariozechner/pi-tui": "file:$(npm root -g)/@mariozechner/pi-tui"
  }
}
EOF
```

Then install and link:

```sh
npm install
npm link @mariozechner/pi-ai @mariozechner/pi-coding-agent @mariozechner/pi-tui
```

