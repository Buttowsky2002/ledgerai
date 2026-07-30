# Build context must be agentledger/ (not services/collector/) so we can
# COPY schemas/ — the canonical event schema lives at agentledger/schemas/,
# outside the collector package. The release workflow matrix and
# docker-compose both use context: agentledger for this image.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY services/collector/ ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /collector .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /collector /collector
COPY schemas/events/llm_call.schema.json /etc/agentledger/schemas/events/llm_call.schema.json
# Absolute in-image path — the relative ../../schemas/... default is for
# local `go run` from services/collector only and does not exist in the image.
ENV AGENTLEDGER_EVENT_SCHEMA=/etc/agentledger/schemas/events/llm_call.schema.json
EXPOSE 8090
USER nonroot
ENTRYPOINT ["/collector"]
