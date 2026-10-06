FROM node:20-slim

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860
CMD ["npm", "start"]
