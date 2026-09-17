'use strict';

require('dotenv').config();

const app = require('./app.js');
const { sequelize } = require('leadpulse-data-model');
const logger = require('./configs/logger.js');

const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await sequelize.authenticate();
    logger.info('Database connection established successfully.');

    app.listen(PORT, () => {
      logger.info(`LeadPulse API listening on port ${PORT}`);
    });
  } catch (error) {
    logger.error('Unable to start the server', { message: error.message, stack: error.stack });
    process.exit(1);
  }
})();
