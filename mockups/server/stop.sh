#!/bin/bash

# Equaliser Upload Server - Stop Script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$SCRIPT_DIR/server.pid"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Stopping Equaliser Upload Server (PID: $PID)..."
        kill "$PID"
        sleep 1

        # Force kill if still running
        if ps -p "$PID" > /dev/null 2>&1; then
            echo "Force stopping..."
            kill -9 "$PID"
        fi

        rm "$PID_FILE"
        echo "Server stopped"
    else
        echo "Server not running (stale PID file)"
        rm "$PID_FILE"
    fi
else
    # Try to find and kill any running server on port 3001
    PID=$(lsof -ti :3001 2>/dev/null)
    if [ -n "$PID" ]; then
        echo "Found server running on port 3001 (PID: $PID)"
        echo "Stopping..."
        kill "$PID"
        sleep 1
        if ps -p "$PID" > /dev/null 2>&1; then
            kill -9 "$PID"
        fi
        echo "Server stopped"
    else
        echo "Server is not running"
    fi
fi
