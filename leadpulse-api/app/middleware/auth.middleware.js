'use strict';

const jwt = require('jsonwebtoken');
const { User } = require('leadpulse-data-model');
const { UnauthorizedError, ForbiddenError } = require('../lib');

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Authentication required');
    }

    const token = header.slice(7);
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    } catch (err) {
      throw new UnauthorizedError('Invalid or expired token');
    }

    const user = await User.findByPk(decoded.userId);
    if (!user) throw new UnauthorizedError('User no longer exists');
    if (!user.isActive) throw new ForbiddenError('This account has been deactivated');

    // The revocation mechanism: bumping tokenVersion on password reset,
    // logout, or deactivation invalidates every access token issued before
    // that point, even ones that haven't naturally expired yet.
    if (user.tokenVersion !== decoded.tokenVersion) {
      throw new UnauthorizedError('Session expired, please log in again');
    }

    req.user = {
      id: user.id,
      role: user.role,
      managerId: user.managerId,
      clientId: user.clientId
    };

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = authenticate;
