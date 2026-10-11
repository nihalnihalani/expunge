FROM node:24.18.1-alpine
WORKDIR /app
COPY candidate-proxy.mjs ./
USER node
EXPOSE 4314
CMD ["node", "candidate-proxy.mjs"]
