FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /collector .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /collector /collector
EXPOSE 8090
ENTRYPOINT ["/collector"]
