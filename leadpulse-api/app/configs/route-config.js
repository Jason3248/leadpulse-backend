'use strict';

const path = require('path');
const routes = require('./route.config.json');
const middleware = require('../middleware');
const validateBody = require('../middleware/validate.middleware.js');

module.exports = (app) => {
  const controllers = new Map();
  const validationSchemas = new Map();

  routes.forEach((route) => {
    const controllerPath = path.resolve(__dirname, `../components/${route.controller}/${route.controller}.controller.js`);
    if (!controllers.has(controllerPath)) {
      const Controller = require(controllerPath);
      controllers.set(controllerPath, new Controller());
    }
    const controller = controllers.get(controllerPath);

    const method = route.method.toLowerCase();
    if (typeof app[method] !== 'function') throw new Error(`Unknown method: ${method}`);
    if (typeof controller[route.action] !== 'function') {
      throw new Error(`Unknown action: ${route.controller}.${route.action}`);
    }

    const chain = (route.middlewares || []).map((name) => {
      if (!middleware[name]) throw new Error(`Unknown middleware: ${name}`);
      return middleware[name];
    });

    if (route.validate) {
      const validationPath = path.resolve(__dirname, `../components/${route.controller}/${route.controller}.validation.js`);
      if (!validationSchemas.has(validationPath)) {
        validationSchemas.set(validationPath, require(validationPath));
      }
      const schema = validationSchemas.get(validationPath)[route.validate];
      if (!schema) throw new Error(`Unknown validation schema: ${route.controller}.${route.validate}`);
      chain.push(validateBody(schema));
    }

    app[method](route.path, ...chain, controller[route.action].bind(controller));
  });
};
