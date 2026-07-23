FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
# Which cmd to build: connector-sync (provider costs) or outcome-sync (outcomes).
ARG CMD=connector-sync
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /app ./cmd/${CMD}

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /app /app
USER nonroot
ENTRYPOINT ["/app"]
