const http = require('http');

// Port used by the laptop dashboard. It can be changed with PORT=...
const PORT = process.env.PORT || 8000;

// Address of the robot. Change this in the dashboard to use a different robot.
let robotUrl = process.env.ROBOT_URL || 'http://reachy-mini.local:8001';

// Most recent LLM response staged for the operator to review.
let llmResponse = '';

// Dashboard browsers connected through server-sent events.
const clients = [];

// Send the latest dashboard data to every open browser.
function push(message) {
  const data = `data: ${JSON.stringify(message)}\n\n`;

  for (const client of clients) {
    client.write(data);
  }
}

function pushResponse() {
  push({
    type: 'response',
    response: llmResponse,
  });
}

// Send one piece of text to the robot's speech endpoint.
async function sendToRobot(text, kind) {
  try {
    await fetch(`${robotUrl}/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        kind,
      }),
    });
  } catch (error) {
    console.error(`Robot unreachable while sending ${kind}:`, error.message);
  }
}

// Read a JSON body from an incoming HTTP request.
function readJson(request) {
  return new Promise((resolve) => {
    let body = '';

    request.on('data', (chunk) => {
      body += chunk;
    });

    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

//Endpoints
const routes = {
  // LLM/robot sends the staged response to this laptop.
  'POST /incoming': async (body) => {
    llmResponse = body.response || '';
    pushResponse();
  },

  // Save a robot URL entered on the dashboard.
  'POST /api/settings': async (body) => {
    if (typeof body.robotUrl === 'string') {
      robotUrl = body.robotUrl.replace(/\/$/, '');
    }
  },
  // Send a status update immediately.
  'POST /api/status': async (body) => sendToRobot(body.text, 'status'),
  // Send the final LLM response immediately.
  'POST /api/final': async (body) => sendToRobot(body.text, 'final'),
  // Clear the staged response from the dashboard.
  'POST /api/clear': async () => {
    llmResponse = '';
    pushResponse();
  },
};

// Serve the dashboard page and handle browser API requests.
http
  .createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/') {
      // Return the operator dashboard HTML.
      response.setHeader('content-type', 'text/html');
      response.end(PAGE);
      return;
    }

    if (request.method === 'GET' && request.url === '/events') {
      // Keep an open connection so the server can update the browser.
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      clients.push(response);

      // Remove this browser if it disconnects.
      request.on('close', () => {
        const index = clients.indexOf(response);
        if (index !== -1) {
          clients.splice(index, 1);
        }
      });

      push({
        type: 'response',
        response: llmResponse,
        robotUrl,
      });
      return;
    }

    const handler = routes[`${request.method} ${request.url}`];
    if (!handler) {
      response.statusCode = 404;
      response.end();
      return;
    }

    await handler(await readJson(request));
    response.setHeader('content-type', 'application/json');
    response.end('{"ok":true}');
  })
  .listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
  });

const PAGE = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>HRI Operator</title>
  <style>
    body {
      font-family: system-ui;
      margin: 20px;
      max-width: 900px;
    }
    section {
      border: 1px solid #ccc;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
    }
    textarea, input[type=text] {
      width: 100%;
      box-sizing: border-box;
      font-size: 15px;
      padding: 6px;
    }
    button {
      font-size: 14px;
      padding: 6px 12px;
      margin: 3px 3px 3px 0;
      cursor: pointer;
    }
    .go {
      background: #2e7d32;
      color: #fff;
      border: 0;
      border-radius: 4px;
    }
    .stop {
      background: #c62828;
      color: #fff;
      border: 0;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <h2>HRI operator dashboard</h2>

  <section>
    <!-- The operator can change which robot receives messages. -->
    Robot URL
    <input type="text" id="robotUrl" style="width: 260px">
  </section>

  <section>
    <!-- This response stays here until the operator clears it. -->
    <b>Staged LLM response (editable)</b>
    <textarea id="resp" rows="4"></textarea>
    <button class="go" onclick="post('/api/final', { text: resp.value })">Send final now</button>
    <button onclick="post('/api/clear')">Clear response</button>
  </section>

  <section>
    <!-- Status updates can be sent without revealing the final response. -->
    <b>Status updates</b>
    <input type="text" id="custom" placeholder="Custom status text, press Enter to send">
  </section>

  <script>
    // Short helper for finding dashboard elements by their IDs.
    const $ = (id) => document.getElementById(id);

    // Short helper for sending JSON POST requests to this server.
    const post = (url, body) => fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

    let built = false;

    // Listen for new staged response data from the server.
    new EventSource('/events').onmessage = (event) => {
      const message = JSON.parse(event.data);

      if (!built) {
        built = true;

        // Fill the robot URL after the dashboard first connects.
        $('robotUrl').value = message.robotUrl || '';
      }

      // Keep the text area editable while receiving the latest staged response.
      $('resp').value = message.response || '';
    };

    // Save the robot URL whenever the operator changes it.
    const updateSettings = () => post('/api/settings', {
      robotUrl: $('robotUrl').value,
    });

    $('robotUrl').onchange = updateSettings;

    // Pressing Enter sends whatever text the operator typed.
    $('custom').onkeydown = (event) => {
      if (event.key === 'Enter' && event.target.value) {
        post('/api/status', { text: event.target.value });
        event.target.value = '';
      }
    };
  </script>
</body>
</html>`;
