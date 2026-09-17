'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('lead_lists', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      client_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'clients', key: 'id' },
        onDelete: 'CASCADE'
      },
      name: { type: Sequelize.STRING(255), allowNull: false },
      status: { type: Sequelize.ENUM('active', 'archived'), allowNull: false, defaultValue: 'active' },
      imported_by_user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('lead_lists', ['client_id'], { name: 'lead_lists_client_id_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('lead_lists');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_lead_lists_status";');
  }
};
