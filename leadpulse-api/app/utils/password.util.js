'use strict';

const bcrypt = require('bcrypt');

const SALT_ROUNDS = 12;

const hashPassword = (plainPassword) => bcrypt.hash(plainPassword, SALT_ROUNDS);

const comparePassword = (plainPassword, hash) => bcrypt.compare(plainPassword, hash);

module.exports = { hashPassword, comparePassword };
