// Server-Sent Events (SSE) Manager for Live Cross-Device Sync

const clients = new Set();

/**
 * Registers a new SSE client connection
 */
function addClient(req, res) {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // For reverse proxies like Nginx
  });

  // Send initial connected event
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  clients.add(res);

  // Remove client on disconnect
  req.on('close', () => {
    clients.delete(res);
  });
}

/**
 * Broadcasts an event to all connected clients
 */
function broadcast(eventType, data = {}) {
  const payload = JSON.stringify({
    type: eventType,
    data,
    timestamp: Date.now()
  });

  const message = `event: ${eventType}\ndata: ${payload}\n\n`;

  for (const client of clients) {
    try {
      client.write(message);
    } catch {
      clients.delete(client);
    }
  }
}

// Send periodic heartbeat ping every 25 seconds to keep connection alive through firewalls/proxies
setInterval(() => {
  for (const client of clients) {
    try {
      client.write(': ping\n\n');
    } catch {
      clients.delete(client);
    }
  }
}, 25000);

module.exports = {
  addClient,
  broadcast,
  getClientCount: () => clients.size
};
