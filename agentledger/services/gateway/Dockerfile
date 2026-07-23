# Build context must be agentledger/ (not services/gateway/) so we can
# COPY pricing/ — the price book lives at agentledger/pricing/, outside the
# gateway package. The release workflow matrix and docker-compose both use
# context: agentledger for this image.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY services/gateway/ ./
COPY pricing/ ./pricing/
# Rewrite price_book_path for the in-image layout at /etc/agentledger/pricing.
# (config.example.json keeps the relative path for local non-container runs.)
RUN sed -i 's|"price_book_path": "[^"]*"|"price_book_path": "/etc/agentledger/pricing/pricebook.json"|' config.example.json
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /gateway .

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /gateway /gateway
COPY --from=build /src/config.example.json /etc/agentledger/config.json
COPY --from=build /src/pricing /etc/agentledger/pricing
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/gateway"]
