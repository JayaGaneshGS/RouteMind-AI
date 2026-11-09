const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const config = require('./config');
const { createRouter } = require('./routes');
const { notFound, errorHandler } = require('./middleware');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind nginx / a cloud load balancer
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createRouter());
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
