const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const mysql = require('mysql');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const morgan = require('morgan');
const basicAuth = require('basic-auth');
const jwt = require('jsonwebtoken');

// Construct the MySQL client
const mysqlPool = mysql.createPool({
  host: process.env.HUNT_MYSQL_HOST,
  port: Number(process.env.HUNT_MYSQL_PORT),
  user: process.env.HUNT_MYSQL_USER,
  password: process.env.HUNT_MYSQL_PASSWORD,
  database: process.env.HUNT_MYSQL_DB,
});

// Set up redis pub/sub
const redis = require('./redisClient');
const pubsub = require('./pubsub')(process.env.HUNT_MYSQL_DB);

// Set up data stores
const teamData = require('./teamDataNode');
const sessionData = require('./sessionDataNode');

teamData.initDB(mysqlPool);
sessionData.initDB(mysqlPool);

// Set up the app
const app = express();
const server = http.createServer(app);

// First middleware: healthz returns 200 immediately without any other processing
app.use((req, res, next) => {
  if (req.path === '/healthz') {
    res.status(200).json({ ok: true });
  } else {
    next();
  }
});

// Add logging middleware
morgan.token('hunt-team', req => (req.huntTeamId ? `team: ${req.huntTeamId}` : 'unauthenticated'));
app.use(morgan(':method :url | :hunt-team | :status - :res[content-length] bytes - :response-time ms'));

// Parse JSON and URL-encoded bodies
app.use(bodyParser.json({ extended: false }));
app.use(bodyParser.urlencoded({ extended: false }));

// Assign session IDs
app.use(cookieSession({
  name: 'huntjs_sessionid',
  keys: [process.env.HUNT_SESSION_SECRET],
  maxAge: 365 * 24 * 60 * 60 * 1000, // 365 days
}));

app.use((req, res, next) => {
  if (!req.session.id) {
    crypto.randomBytes(16, (err, bytes) => {
      if (err) {
        console.error('Error getting random bytes for session:');
        console.error(err);
        res.status(500).json({ error: 'Server Error' });

        return;
      }
      req.session.id = bytes.toString('hex');
      next();
    });
  } else {
    next();
  }
});

// Add CORS middleware
const corsAllowAll = (process.env.HUNT_CORS_ORIGIN === '*');
const corsAllowedOrigins = process.env.HUNT_CORS_ORIGIN.split(',');
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (corsAllowAll) {
      callback(null, true);
    } else {
      callback(null, corsAllowedOrigins.includes(origin));
    }
  },
}));

// Auth authentication middleware
function validateAuth(username, password) {
  if (password === 'dev') {
    if (process.env.HUNT_AUTH_ALLOW_DEV !== 'true') {
      throw new Error('Dev login forbidden');
    }

    return;
  } else if (password.startsWith('jwt/')) {
    const reqJWT = password.slice(4);
    const decodedJWT = jwt.verify(reqJWT, process.env.HUNT_AUTH_JWT_SECRET, {
      algorithms: ['HS256'],
    });

    if (decodedJWT.username !== username) {
      throw new Error('JWT username did not match request username');
    }

    if (decodedJWT.puzzle !== process.env.HUNT_CANONICAL_PUZZLE_ID) {
      throw new Error('JWT puzzle did not match this puzzle\'s ID');
    }

    return;
  } else if (password.startsWith('admin/')) {
    const submittedPW = password.slice(6);

    if (!process.env.HUNT_AUTH_ADMIN_PW) {
      throw new Error('Admin login disabled');
    }

    if (process.env.HUNT_AUTH_ADMIN_PW !== submittedPW) {
      throw new Error('Admin password incorrect');
    }

    return;
  }

  throw new Error('Basic auth password was not in an acceptable format');
}

app.use((req, res, next) => {
  const user = basicAuth(req);

  if (!user) {
    res.status(400).json({ error: 'No Basic Auth provided, or Authorization header was invalid' });
    return;
  }

  try {
    validateAuth(user.name, user.pass);
    req.huntTeamId = user.name;
  } catch (err) {
    res.status(400).json({ error: 'Basic auth credentials were invalid', details: err.message });
    return;
  }

  next();
});

// Team blacklist
let blacklist;
if (process.env.HUNT_TEAM_BLACKLIST) {
  blacklist = new Set(process.env.HUNT_TEAM_BLACKLIST.split(',').map(s => s.trim()));
}

app.use((req, res, next) => {
  if (blacklist && blacklist.has(req.huntTeamId)) {
    res.status(400).json({ error: 'Your team has been blacklisted from this puzzle. Please contact HQ.' });
    return;
  }

  next();
});


// Wraps a maybe-asynchronous function to always return a promise
function returnPromise(fn) {
  let result;
  try {
    result = fn();
  } catch (e) {
    result = Promise.reject(e);
  }

  if (result instanceof Promise) {
    return result;
  }
  return Promise.resolve(result);
}

// Calls a GET/POST handler defined by the app
async function callHandler(handler, data, req, res, rateLimiters) {
  let response;

  try {
    await Promise.all(rateLimiters.map(limiter => limiter(req)));

    response = await returnPromise(() => handler({
      data,
      session: sessionData.sessionAPI(req, mysqlPool),
      team: teamData.teamAPI(req, mysqlPool, pubsub),
    }));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);

    const statusCode = err.statusCode || 500;
    const message = err.userMessage || 'Server Error';

    res.status(statusCode).json({ error: message });
    return;
  }

  res.json(response);
}

// Define a healthz endpoint for GCP and Kubernetes health-checking
app.get('/healthz', (req, res) => res.status(200).json({ healthy: true }));

// Redirect HTTP -> HTTPS
if (process.env.HUNT_REDIRECT_HTTP) {
  app.use((req, res, next) => {
    if (req.secure || (req.headers['x-forwarded-proto'] === 'https') || (req.originalUrl === '/healthz')) {
      next();
    } else {
      res.redirect(`https://${req.hostname}${req.originalUrl}`);
    }
  });
}

function makeRateLimiters(options) {
  const rateLimiters = [];

  if (options && options.rateLimitPerMinute) {
    rateLimiters.push(teamData.makeRateLimiter(
      options.rateLimitPerMinute,
      60,
    ));
  }

  if (options && options.sessionRateLimit) {
    rateLimiters.push(sessionData.makeRateLimiter(
      options.sessionRateLimit.limit,
      options.sessionRateLimit.window,
    ));
  }

  return rateLimiters;
}

// Add websocket handling
const channelSubscribers = {};
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws, req) => {
  const location = url.parse(req.url, true);
  // You might use location.query.access_token to authenticate or share sessions
  // or req.headers.cookie (see http://stackoverflow.com/a/16395220/151312)

  if (location.pathname !== '/huntjs_subscribe') {
    console.warn('Got WS connection for invalid path', location.pathname);
    ws.close();
    return;
  }

  const channel = location.query.channel;
  if (!channel || !/^[a-zA-Z0-9_]+$/.test(channel)) {
    console.warn('Got WS connection for invalid channel', channel);
    ws.close();
    return;
  }

  if ((!location.query.username) || (!location.query.password)) {
    console.log('Got a WS connection missing username or password', location.query);
  }

  try {
    validateAuth(location.query.username, location.query.password);
  } catch (e) {
    console.warn('Got a WS connection with invalid username/password', location.query);
    ws.close();
    return;
  }

  const teamId = location.query.username;
  req.huntTeamId = teamId;

  console.log(`Got new client for teamId ${teamId} and channel ${channel}`);

  const unsub = pubsub.subscribe(`${teamId}:${channel}`, (msg) => {
    ws.send(msg);
  });

  ws.on('close', () => {
    unsub();
    console.log(`Client left channel: ${channel}`);
  });

  ws.on('message', (message) => {
    console.warn('websocket received', message);
  });

  if (channelSubscribers[channel]) {
    channelSubscribers[channel].forEach((sub) => {
      returnPromise(() => sub({
        team: teamData.teamAPI(req, mysqlPool, pubsub),
      })).catch(e => console.error('Error in onSubscribe handler', e));
    });
  }
});

// Define API for adding endpoints
module.exports = {
  get(route, handler, options) {
    const rateLimiters = makeRateLimiters(options);

    app.get(route, (req, res) => {
      let data;
      if (req.query.data) {
        try {
          data = JSON.parse(req.query.data);
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error(e, 'Error parsing JSON');
          res.status(422).json({ error: 'Invalid JSON' });
          return;
        }
      }

      callHandler(handler, data, req, res, rateLimiters);
    });
  },

  post(route, handler, options) {
    const rateLimiters = makeRateLimiters(options);

    app.post(route, (req, res) => {
      callHandler(handler, req.body, req, res, rateLimiters);
    });
  },

  onSubscribe(channel, handler) {
    if (!channelSubscribers[channel]) {
      channelSubscribers[channel] = [];
    }

    channelSubscribers[channel].push(handler);
  },

  serve() {
    const port = Number(process.env.HUNT_PORT);
    server.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`App listening on port ${port}`);
    });
  },

  // Helper that constructs an error with statusCode and userMessage properties
  Error(statusCode, userMessage) {
    const err = new Error(userMessage);
    err.statusCode = statusCode;
    err.userMessage = userMessage;

    return err;
  },

  _mysql: mysqlPool,
  _redis: redis,
};
