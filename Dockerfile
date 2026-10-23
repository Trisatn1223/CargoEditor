# Tests run at build time only. The runtime serves static files, no Node server.
FROM node:24-alpine AS checked
WORKDIR /app
COPY package.json ./
COPY public/ public/
COPY tests/editor.test.mjs tests/editor.test.mjs
RUN node --test tests/*.test.mjs

FROM nginxinc/nginx-unprivileged:stable-alpine
ARG BUILD_COMMIT=local
LABEL org.opencontainers.image.source="https://github.com/Trisatn1223/CargoEditor" \
      org.opencontainers.image.revision="${BUILD_COMMIT}"
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=checked /app/public/ /usr/share/nginx/html/
USER root
RUN printf '{"commit":"%s"}\\n' "$BUILD_COMMIT" > /usr/share/nginx/html/version.json \
    && chmod 644 /etc/nginx/conf.d/default.conf \
    && chmod -R a+rX /usr/share/nginx/html
# Source checkouts with umask 077 have 0600/0700 permissions. The runtime
# uses uid 101, so explicitly grant read/search access to static content.
USER 101
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
