const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = {};
const messageRateLimit = new Map(); // Store message timestamps for rate limiting

// Constants for rate limiting
const MAX_MESSAGE_LENGTH = 500;
const MAX_MESSAGES = 5;
const TIME_WINDOW = 5000; // 5 seconds in milliseconds

function sanitize(text) {
  // Remove any tags
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isRateLimited(ws) {
  const now = Date.now();
  if (!messageRateLimit.has(ws)) {
    messageRateLimit.set(ws, [now]);
    return false;
  }

  const timestamps = messageRateLimit.get(ws);
  // Remove timestamps older than TIME_WINDOW
  const recentTimestamps = timestamps.filter(time => now - time < TIME_WINDOW);
  messageRateLimit.set(ws, recentTimestamps);

  if (recentTimestamps.length >= MAX_MESSAGES) {
    return true;
  }

  recentTimestamps.push(now);
  return false;
}

wss.on('connection', (ws) => {
  let room = null;

  ws.on('message', (data) => {
    const message = JSON.parse(data);

    if (message.type === 'join') {
      room = message.url;
      rooms[room] = rooms[room] || new Set();
      rooms[room].add(ws);
      return;
    }

    if (message.type === 'chat' && room) {
      // Check message length
      if (!message.text || message.text.length > MAX_MESSAGE_LENGTH) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'MESSAGE_TOO_LONG',
          user: message.user || 'Anonymous'
        }));
        return;
      }

      // Check rate limit
      if (isRateLimited(ws)) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'RATE_LIMIT_EXCEEDED',
          user: message.user || 'Anonymous'
        }));
        return;
      }

      const safeText = sanitize(message.text);
      for (const client of rooms[room]) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'chat',
            user: message.user || 'Anonymous',
            text: safeText
          }));
        }
      }
    }
  });

  ws.on('close', () => {
    if (room && rooms[room]) {
      rooms[room].delete(ws);
      if (rooms[room].size === 0) delete rooms[room];
    }
    // Clean up rate limit data
    messageRateLimit.delete(ws);
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('WebSocket server running');
});
