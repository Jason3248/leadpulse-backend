'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Global, agency-wide identity table — no client_id here. The agency
    // maintains one shared prospect database; a person's relationship to a
    // specific Client (consent flags, sourcing) lives in client_leads
    // instead. See migration 013 for that table.
    await queryInterface.createTable('leads', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      first_name: { type: Sequelize.STRING(100), allowNull: false },
      last_name: { type: Sequelize.STRING(100), allowNull: true },
      email: { type: Sequelize.STRING(255), allowNull: false, unique: true },
      phone: { type: Sequelize.STRING(30), allowNull: true },
      company: { type: Sequelize.STRING(255), allowNull: true },
      job_title: { type: Sequelize.STRING(150), allowNull: true },
      industry: { type: Sequelize.STRING(150), allowNull: true },
      source: { type: Sequelize.STRING(150), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('leads');
  }
};
