FROM node:24.18.1-alpine
WORKDIR /app
COPY candidate-broker.mjs ./
USER node
EXPOSE 4320
CMD ["node", "candidate-broker.mjs"]
