FROM node:20-alpine

# Dependências para módulos nativos (ex: crypto libs)
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Instala dependências primeiro (aproveita cache do Docker)
COPY package*.json ./
RUN npm install --legacy-peer-deps

# Copia código fonte
COPY src/ ./src/

# Diretório para persistência da sessão (sobrescrito pelo volume)
RUN mkdir -p /app/auth

EXPOSE 3002

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD wget -q -O- http://127.0.0.1:3002/health || exit 1

CMD ["node", "src/server.js"]
