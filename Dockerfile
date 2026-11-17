FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server.mjs ./
ENV PORT=5182
EXPOSE 5182
USER node
CMD ["node","server.mjs"]
