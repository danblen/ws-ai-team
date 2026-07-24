#!/bin/sh
# Auto-deploy: checks for new commits every 30s and updates if changed
# Usage: nohup sh scripts/auto-deploy.sh &

INTERVAL=30
DIR=/root/ws/aiteam

while true; do
  cd "$DIR" || sleep "$INTERVAL" && continue

  # fetch latest commit hash without merging
  old=$(git rev-parse HEAD)
  git fetch origin main 2>/dev/null || { sleep "$INTERVAL"; continue; }
  new=$(git rev-parse FETCH_HEAD)

  if [ "$old" != "$new" ]; then
    echo "[$(date +%T)] New commit: $(echo "$new" | cut -c1-7), deploying..."
    git merge --ff-only FETCH_HEAD 2>&1 || { echo "merge failed"; sleep "$INTERVAL"; continue; }
    docker run --rm -e NODE_ENV=development -v "$DIR:/app":Z -w /app aiteam sh -c "npm install && npm run build" 2>&1

    if docker inspect aiteam >/dev/null 2>&1; then
      docker restart aiteam
    else
      docker run -d --name aiteam --restart unless-stopped \
        -p 5110:5110 -m 1.4g \
        -v "$DIR:/app":Z \
        -v /root/ws/aiteamoutput:/aiteamoutput:Z \
        --env-file "$DIR/.env" aiteam
    fi
    echo "[$(date +%T)] Deploy done"
  fi

  sleep "$INTERVAL"
done
