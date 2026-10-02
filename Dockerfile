# One image, three commands: docker-compose.yml runs Roast Judge, pub-guide and model-replay
# from this same image, each with its own `command`.
FROM node:22.22.0-alpine
WORKDIR /app

# Dependencies first, so this layer stays cached until package.json / package-lock.json change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Then the sources. Under compose they are bind-mounted over /app anyway (for node --watch);
# the copy makes the image runnable on its own. Secrets stay out: .env is in .dockerignore.
COPY . .

CMD ["npm", "start"]
