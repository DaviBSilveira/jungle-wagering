FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun install && bun run build
ENV PORT=3000
EXPOSE 3000
CMD ["bun", "dist/main.js"]
