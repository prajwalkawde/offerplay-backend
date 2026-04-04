#!/bin/bash
set -e

echo "🚀 Deploying OfferPlay Backend..."

cd /home/master/applications/xyvmkurmut/public_html

echo "📥 Pulling latest code..."
git pull origin main

echo "🔨 Building..."
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
npm install
npx prisma generate
npm run build

echo "🔄 Restarting server..."
pm2 restart offerplay-backend --update-env

echo "✅ Backend deployed successfully!"
