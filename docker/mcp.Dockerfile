# aster-guard-mcp 镜像（aster-api ADR 0054 §12 D5）：linux/arm64，以非 root、只读根文件系统运行。
# 构建：docker buildx build --platform linux/arm64 -f docker/mcp.Dockerfile .
# 基础镜像按多架构索引 digest 固定（renovate 维护），构建与运行阶段同一 digest。
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY examples/http-demo-tool/package.json examples/http-demo-tool/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src src
COPY examples/http-demo-tool examples/http-demo-tool
# -r 不含 workspace 根包：先构建根包（示例依赖其 dist），再构建 examples。
RUN pnpm run build && pnpm -r build
# 只带生产依赖与 dist 的独立目录（pnpm deploy 按 files 字段取包内容；--legacy 原因见 demo-tool.Dockerfile）。
RUN pnpm --filter @aster-cloud/aster-guard deploy --legacy --prod /out

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=0:0 /out /app
# 入口不依赖 shell；进程不写文件系统（日志走 stderr），可在 readOnlyRootFilesystem 下运行。
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/mcp/cli.js"]
