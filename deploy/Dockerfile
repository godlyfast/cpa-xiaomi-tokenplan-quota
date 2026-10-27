# Proposal only. Resolve and record the official image digest before production approval.
FROM oven/bun:1.3.14
WORKDIR /app
COPY src ./src
USER 1000:1000
EXPOSE 8787
CMD ["bun", "src/main.ts"]
