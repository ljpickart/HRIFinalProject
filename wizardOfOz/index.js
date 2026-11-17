const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

// Participant page and transparency-window control (see windowHub.js).
const windowHub = require('./windowHub');

// Port used for both the webpage and WebSocket connections.
const PORT = process.env.PORT || 8080;

// Read the dashboard webpage from disk.
const pagePath = path.join(__dirname, 'index.html');

// Create one HTTP server for both normal webpage requests and WebSockets.
const httpServer = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end(fs.readFileSync(pagePath));
    return;
  }

  // /participant and /control pages.
  if (windowHub.handleHttp(request, response)) {
    return;
  }

  response.statusCode = 404;
  response.end('Not found');
});

// Allow WebSocket connections to share the HTTP server.
const socketServer = new WebSocket.Server({ noServer: true });

// WebSocket clients opened by the webpage.
const dashboardClients = new Set();

// WebSocket clients connected by the robot.
const robotClients = new Set();

// Send a JSON message to every open dashboard browser.
function sendToDashboards(message) {
  const data = JSON.stringify(message);

  for (const client of dashboardClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// Route dashboard messages to every connected robot.
function sendToRobots(text) {
  for (const socket of robotClients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(text);
    }
  }
}

// Handle WebSocket upgrades requested by the webpage or robot.
httpServer.on('upgrade', (request, socket, head) => {
  socketServer.handleUpgrade(request, socket, head, (webSocket) => {
    socketServer.emit('connection', webSocket, request);
  });
});

// A webpage uses ?dashboard=true so it can be separated from robot clients.
socketServer.on('connection', (socket, request) => {
  const isDashboard = new URL(request.url, `http://${request.headers.host}`)
    .searchParams.get('dashboard') === 'true';

  if (isDashboard) {
    dashboardClients.add(socket);
    console.log('Dashboard connected');

    socket.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (typeof data.text === 'string' && data.text.trim()) {
          const text = data.text.trim();
          sendToRobots(text);

          sendToDashboards({
            direction: 'sent',
            text,
            timestamp: new Date().toISOString(),
          });
        }
      } catch {
        console.log('Dashboard sent invalid JSON');
      }
    });

    socket.on('close', () => {
      dashboardClients.delete(socket);
      console.log('Dashboard disconnected');
    });

    return;
  }

  // Participant page (?role=participant) and control page (?role=control).
  if (windowHub.handleConnection(socket, request)) {
    return;
  }

  // All non-dashboard clients are treated as robot clients.
  robotClients.add(socket);
  console.log('Robot connected');

  socket.on('message', (message) => {
    const text = message.toString();
    console.log(`Received from robot: ${text}`);

    sendToDashboards({
      direction: 'received',
      text,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on('close', () => {
    robotClients.delete(socket);
    console.log('Robot disconnected');
  });
});

httpServer.listen(PORT, () => {
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`Participant page: http://localhost:${PORT}/participant`);
  console.log(`Control page: http://localhost:${PORT}/control`);
});
