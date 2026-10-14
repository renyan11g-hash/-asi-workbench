#!/usr/bin/env bash
# 线上/生产单端口启动脚本（Express 同时托管前端 dist 与 /api）
set -e

cd /workspace/backend

export NODE_ENV=production
export PORT=${PORT:-4100}
export NODE_OPTIONS=--experimental-sqlite

exec node dist/index.js
