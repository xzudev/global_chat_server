const WebSocket = require('ws');
const express = require('express');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = {};

function sanitize(text) {
  // Remove any tags
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
      const safeText = sanitize(message.text);
      for (const client of rooms[room]) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
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
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('WebSocket server running');
});
