#!/bin/bash

# Equaliser Upload Server - Start Script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/server.pid"

# Check if already running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Server is already running (PID: $PID)"
        echo "Use ./stop.sh to stop it first"
        exit 1
    else
        rm "$PID_FILE"
    fi
fi

# Start the server
cd "$SCRIPT_DIR"
echo "Starting Equaliser Upload Server..."
node server.js &
echo $! > "$PID_FILE"

sleep 1

if ps -p $(cat "$PID_FILE") > /dev/null 2>&1; then
    echo "Server started successfully (PID: $(cat $PID_FILE))"
    echo ""
    echo "Access at:"
    echo "  Local:   http://localhost:3001"
    echo "  Network: http://$(ipconfig getifaddr en0 2>/dev/null || echo 'YOUR_IP'):3001"
    echo ""
    echo "Run ./stop.sh to stop the server"
else
    echo "Failed to start server"
    rm -f "$PID_FILE"
    exit 1
fi
