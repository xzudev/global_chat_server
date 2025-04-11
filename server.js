const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET || 'changeme';
const rooms = {};

// Rate limiting configuration
const BUCKET_CAPACITY = 5; // Maximum tokens a user can have
const BASE_REFILL_RATE = 1; // Base tokens per second
const MIN_REFILL_INTERVAL = 1000; // Minimum time between refills (ms)
const PENALTY_MULTIPLIER = 2; // How much to increase cooldown on spam
const PENALTY_DURATION = 30000; // How long penalties last (30 seconds)
const MAX_PENALTIES = 4; // Maximum number of penalty levels
const MAX_MESSAGE_LENGTH = 500;

class AdaptiveTokenBucket {
  constructor() {
    this.tokens = BUCKET_CAPACITY;
    this.lastRefill = Date.now();
    this.penaltyLevel = 0;
    this.lastPenaltyTime = 0;
    this.consecutiveFailures = 0;
  }

  getCurrentRefillRate() {
    const now = Date.now();
    // Reset penalty level if penalty duration has passed
    if (this.penaltyLevel > 0 && (now - this.lastPenaltyTime) > PENALTY_DURATION) {
      this.penaltyLevel = 0;
      this.consecutiveFailures = 0;
    }
    // Calculate current refill rate based on penalty level
    return BASE_REFILL_RATE / Math.pow(PENALTY_MULTIPLIER, this.penaltyLevel);
  }

  refill() {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000; // Convert to seconds
    const currentRate = this.getCurrentRefillRate();
    
    this.tokens = Math.min(
      BUCKET_CAPACITY,
      this.tokens + timePassed * currentRate
    );
    this.lastRefill = now;
  }

  tryConsume() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      // Reset consecutive failures on successful message
      this.consecutiveFailures = 0;
      return true;
    }
    
    // Increment penalty on failed attempt
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 3) {
      this.penaltyLevel = Math.min(this.penaltyLevel + 1, MAX_PENALTIES);
      this.lastPenaltyTime = Date.now();
      this.consecutiveFailures = 0;
    }
    
    return false;
  }

  getPenaltyInfo() {
    if (this.penaltyLevel === 0) return null;
    
    const currentRate = this.getCurrentRefillRate();
    const waitTime = Math.ceil(1 / currentRate);
    return {
      level: this.penaltyLevel,
      waitSeconds: waitTime
    };
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
  let username = 'Anonymous';
  
  // Create a new rate limiter for this connection
  rateLimiters.set(ws, new AdaptiveTokenBucket());

  ws.on('message', (data) => {
    const message = JSON.parse(data);

    if (message.type === 'join') {
      room = message.url;

      if (message.token) {
        try {
          const decoded = jwt.verify(message.token, JWT_SECRET);
          username = decoded.username || 'Anonymous';
        } catch (err) {
          console.warn('Invalid token:', err.message);
          ws.send(JSON.stringify({
            type: 'error',
            code: 'INVALID_TOKEN',
            message: 'Authentication failed.'
          }));
          return;
        }
      }

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
          user: username
        }));
        return;
      }

      // Check rate limit
      const rateLimiter = rateLimiters.get(ws);
      if (!rateLimiter.tryConsume()) {
        const penaltyInfo = rateLimiter.getPenaltyInfo();
        ws.send(JSON.stringify({
          type: 'error',
          code: 'RATE_LIMIT_EXCEEDED',
          user: username,
          penalty: penaltyInfo
        }));
        return;
      }

      const safeText = sanitize(message.text);
      for (const client of rooms[room]) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'chat',
            user: username,
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
