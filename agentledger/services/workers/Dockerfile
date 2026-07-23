# Builds a single worker binary. Override the build target with:
#   docker build --build-arg CMD=ch-insert .
FROM golang:1.26-alpine AS build
ARG CMD=ch-insert
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /worker ./cmd/${CMD}

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /worker /worker
EXPOSE 8091
USER nonroot
ENTRYPOINT ["/worker"]
