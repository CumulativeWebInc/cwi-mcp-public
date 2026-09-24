# Dockerfile: cwi-mcp-public (HF Spaces, sdk: docker)
FROM node:24-alpine
WORKDIR /app
COPY src/ ./src/
COPY data/ ./data/
COPY vendor/ ./vendor/
COPY package.json ./
# python3 for the vendored verdict/needledrop engines (stdlib-only)
RUN apk add --no-cache python3
ENV PORT=7860 BIND=0.0.0.0
# MCP_TOKEN must be set as a Space secret — the server refuses to start without it.
EXPOSE 7860
CMD ["node", "src/server-http.mjs"]
