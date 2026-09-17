'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('lead_list_memberships', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      lead_list_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'lead_lists', key: 'id' },
        onDelete: 'CASCADE'
      },
      lead_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'leads', key: 'id' },
        onDelete: 'CASCADE'
      },
      status: {
        type: Sequelize.ENUM('New', 'Contacted', 'Qualified', 'Converted', 'Dead'),
        allowNull: false,
        defaultValue: 'New'
      },
      added_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addConstraint('lead_list_memberships', {
      fields: ['lead_list_id', 'lead_id'],
      type: 'unique',
      name: 'memberships_list_lead_unique'
    });
    await queryInterface.addIndex('lead_list_memberships', ['lead_id'], { name: 'memberships_lead_id_idx' });
    await queryInterface.addIndex('lead_list_memberships', ['status'], { name: 'memberships_status_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('lead_list_memberships');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_lead_list_memberships_status";');
  }
};
