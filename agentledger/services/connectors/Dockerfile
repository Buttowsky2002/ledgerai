FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /connector-sync ./cmd/connector-sync

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /connector-sync /connector-sync
EXPOSE 8092
ENTRYPOINT ["/connector-sync"]
