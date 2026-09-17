'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');

const loadRoutes = require('./configs/route-config.js');
const notFoundHandler = require('./middleware/notFound.middleware.js');
const errorHandler = require('./middleware/error.middleware.js');

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:3000',
    credentials: true
  })
);
app.use(express.json());
// The unsubscribe / conversion confirmation pages POST a plain HTML form.
app.use(express.urlencoded({ extended: false }));
// The local-driver banner upload receives raw image bytes via PUT — scoped
// to just that path so it never interferes with JSON parsing elsewhere.
// (With STORAGE_DRIVER=s3 the browser PUTs straight to S3 and this is unused.)
app.use('/api/v1/uploads/local', express.raw({ type: ['image/jpeg', 'image/png'], limit: '6mb' }));
app.use(cookieParser());

// Unauthenticated by design: deployment health probes must reach this
// without credentials, and it exposes nothing sensitive (SRS 5.6).
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'core-api' });
});

loadRoutes(app);

// Interactive API docs at /api-docs — generated from the real route table
// so it can't drift from the actual endpoints. Mounted after routes so it
// never shadows a real path.
try {
  const swaggerUi = require('swagger-ui-express');
  const { buildOpenApiSpec } = require('./configs/openapi.js');
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(buildOpenApiSpec(), { customSiteTitle: 'LeadPulse API' }));
} catch (err) {
  // swagger-ui-express is a dev convenience; never let it break startup.
  // eslint-disable-next-line no-console
  console.warn('Swagger UI not mounted:', err.message);
}

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
