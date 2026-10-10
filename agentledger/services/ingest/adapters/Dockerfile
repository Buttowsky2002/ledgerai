FROM golang:1.26-alpine AS build
WORKDIR /src
COPY . .
# Which adapter to build. Today: litellm (LiteLLM spend-log webhook).
# Future spend-log normalizers (bifrost, portkey, openrouter) add cmd/<name>.
ARG CMD=litellm
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /app ./cmd/${CMD}

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /app /app
USER nonroot
ENTRYPOINT ["/app"]
