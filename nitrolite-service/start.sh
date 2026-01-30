#!/bin/bash

# Nitrolite Service Quick Start Script

echo "🚀 Starting Nitrolite Keeper Service..."
echo ""

# Check if MongoDB is running
if ! mongosh --eval "db.version()" --quiet &>/dev/null; then
    echo "⚠️  MongoDB is not running!"
    echo "Starting MongoDB..."
    brew services start mongodb-community
    sleep 2
fi

# Navigate to service directory
cd "$(dirname "$0")"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Start the service
echo "✅ Starting keeper service..."
echo ""
npm start
