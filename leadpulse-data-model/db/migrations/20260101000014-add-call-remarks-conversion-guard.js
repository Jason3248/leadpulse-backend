'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  // The confirmed-conversion guard now lives in migration 012, where it is
  // defined directly against campaign_lead_id (the frozen audience row).
  // This migration is intentionally a no-op, kept so that any database
  // already carrying it in SequelizeMeta stays consistent rather than
  // having history rewritten underneath it.
  async up() {},
  async down() {}
};
