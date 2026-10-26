#!/bin/bash

# Docker-first startup script for Tailscale Network Dashboard.
# Picks a free host port (starting at $HOST_PORT, default 5000) so a
# `docker compose up` never fails just because the port is occupied.

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Please install Docker first."
    exit 1
fi

# --- Find a free host port, incrementing until one is available ---
DEFAULT_HOST_PORT="${HOST_PORT:-5000}"
MAX_PORT_ATTEMPTS=100

# Guard against non-numeric HOST_PORT values (would break arithmetic below)
if ! [[ "$DEFAULT_HOST_PORT" =~ ^[0-9]+$ ]]; then
    echo "⚠️  Ignoring non-numeric HOST_PORT='$DEFAULT_HOST_PORT', using 5000."
    DEFAULT_HOST_PORT=5000
fi

port_in_use() {
    local port="$1"
    if command -v python3 &> /dev/null; then
        python3 -c "import socket,sys; sys.exit(0 if socket.socket().connect_ex(('127.0.0.1', $port)) == 0 else 1)" 2>/dev/null
        return $?
    else
        # bash /dev/tcp fallback (no external dependencies)
        (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null
        return $?
    fi
}

HOST_PORT="$DEFAULT_HOST_PORT"
attempts=0
while port_in_use "$HOST_PORT"; do
    echo "⚠️  Port $HOST_PORT is already occupied, trying $((HOST_PORT + 1))..."
    HOST_PORT=$((HOST_PORT + 1))
    attempts=$((attempts + 1))
    if [ "$attempts" -ge "$MAX_PORT_ATTEMPTS" ]; then
        echo "❌ No free port found after $MAX_PORT_ATTEMPTS attempts starting from $DEFAULT_HOST_PORT."
        exit 1
    fi
done
export HOST_PORT

echo "🐳 Starting Tailscale Network Dashboard on port $HOST_PORT"
echo "================================================="

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    echo "📄 Creating .env file from template..."
    cp .env.example .env
    echo "✅ Created .env file"
    echo ""
    echo "⚠️  Configure your .env file with Tailscale credentials:"
    echo "   - TAILSCALE_API_KEY: Get from https://login.tailscale.com/admin/settings/keys"
    echo "   - TAILSCALE_TAILNET: Your tailnet name"
    echo ""
    echo "📝 Without credentials, the app will run in demo mode with sample data"
    echo ""
fi

# Build and start the container
echo "🏗️  Building Docker image..."
docker compose build

echo "🚀 Starting container..."
docker compose up -d

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Dashboard is running!"
    echo "🌐 Access at: http://localhost:$HOST_PORT"
    echo "📊 Metrics at: http://localhost:$HOST_PORT/metrics"
    echo ""
    echo "📋 Commands:"
    echo "   Stop:     docker compose down"
    echo "   Logs:     docker compose logs -f"
    echo "   Restart:  docker compose restart"
    echo "   Rebuild:  docker compose build --no-cache"
else
    echo "❌ Failed to start container"
    exit 1
fi
