# 演示 HTTP 工具镜像（aster-api ADR 0054 §12 D5/D6）：linux/arm64，以非 root、只读根文件系统运行。
# 构建：docker buildx build --platform linux/arm64 -f docker/demo-tool.Dockerfile .
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
# pnpm 10 的 deploy 缺省要求 inject-workspace-packages；本仓开发期依赖符号链接到根包 dist，故用 --legacy：
# 根包按其 files 字段（dist）复制进 node_modules，产物目录可整体拷贝。
RUN pnpm --filter @aster-cloud/aster-guard-demo-tool deploy --legacy --prod /out

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
ENV NODE_ENV=production
WORKDIR /app/examples/http-demo-tool
COPY --from=build --chown=0:0 /out /app/examples/http-demo-tool
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/examples/http-demo-tool/dist/server.js"]
