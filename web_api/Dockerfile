FROM golang:1.23-alpine AS builder

ARG COMMIT_SHA=unknown
ENV GOPROXY=https://goproxy.cn,direct
ENV GOSUMDB=off

# Install goctl
RUN go install github.com/zeromicro/go-zero/tools/goctl@latest

WORKDIR /app
# Expecting build context to be the project root
COPY service/sparkx.api .

# Inject version
RUN sed -i "s/version: \"v1\"/version: \"v1-${COMMIT_SHA}\"/" sparkx.api

# Generate swagger.json
# Using built-in swagger command
RUN goctl api swagger -api sparkx.api -dir .

# Rename the generated file to swagger.json (it usually matches api name, e.g. sparkx.json)
# We find the generated json file and move it to ensure we have the right name.
RUN find . -maxdepth 1 -name "*.json" -print -exec mv {} swagger.json \;

FROM swaggerapi/swagger-ui

COPY --from=builder /app/swagger.json /usr/share/nginx/html/swagger.json

ENV SWAGGER_JSON_URL=swagger.json
