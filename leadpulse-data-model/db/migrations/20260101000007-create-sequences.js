'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sequences', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      client_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'clients', key: 'id' },
        onDelete: 'CASCADE'
      },
      lead_list_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'lead_lists', key: 'id' } },
      name: { type: Sequelize.STRING(255), allowNull: false },
      created_by_user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('sequences', ['client_id'], { name: 'sequences_client_id_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sequences');
  }
};
