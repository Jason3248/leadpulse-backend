'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Case-insensitive on purpose — "Acme Prospects" and "acme prospects"
    // should still collide. The application layer already checks for an
    // existing list by name before creating one (and reuses it instead of
    // erroring); this index is the backstop for a genuine race between two
    // concurrent requests that both pass that check before either commits.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX lead_lists_client_id_name_unique
      ON lead_lists (client_id, lower(name));
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS lead_lists_client_id_name_unique;');
  }
};
