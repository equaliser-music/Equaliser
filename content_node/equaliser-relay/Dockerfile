FROM golang:1.22-alpine AS builder

WORKDIR /app

# Download dependencies first (cacheable layer)
COPY go.mod go.sum ./
RUN go mod download

# Build the binary
COPY . .
RUN CGO_ENABLED=0 go build -o /relay ./cmd/relay

# Runtime image
FROM alpine:3.19

# Add wget for healthcheck
RUN apk add --no-cache wget

COPY --from=builder /relay /relay
COPY migrations/ /migrations/

EXPOSE 8080 8008

CMD ["/relay"]
