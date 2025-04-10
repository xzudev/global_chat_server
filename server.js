const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = {};

// Rate limiting configuration
const BUCKET_CAPACITY = 5; // Maximum tokens a user can have
const REFILL_RATE = 1; // Tokens per second
const REFILL_INTERVAL = 1000; // Check every 1 second
const MAX_MESSAGE_LENGTH = 500;

class TokenBucket {
  constructor() {
    this.tokens = BUCKET_CAPACITY;
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000; // Convert to seconds
    this.tokens = Math.min(
      BUCKET_CAPACITY,
      this.tokens + timePassed * REFILL_RATE
    );
    this.lastRefill = now;
  }

  tryConsume() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

// Store rate limiters for each connection
const rateLimiters = new Map();

function sanitize(text) {
  // Remove any tags
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

wss.on('connection', (ws) => {
  let room = null;
  
  // Create a new rate limiter for this connection
  rateLimiters.set(ws, new TokenBucket());

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
      const rateLimiter = rateLimiters.get(ws);
      if (!rateLimiter.tryConsume()) {
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
    // Clean up rate limiter
    rateLimiters.delete(ws);
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('WebSocket server running');
});
