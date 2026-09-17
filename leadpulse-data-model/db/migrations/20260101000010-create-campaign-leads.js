'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('campaign_leads', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      campaign_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'campaigns', key: 'id' },
        onDelete: 'CASCADE'
      },
      lead_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'leads', key: 'id' },
        onDelete: 'CASCADE'
      },
      assigned_executive_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      queue_status: {
        type: Sequelize.ENUM('pending', 'in_progress', 'called', 'skipped', 'completed'),
        allowNull: true
      },
      added_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addConstraint('campaign_leads', {
      fields: ['campaign_id', 'lead_id'],
      type: 'unique',
      name: 'campaign_leads_campaign_lead_unique'
    });
    await queryInterface.addIndex('campaign_leads', ['campaign_id'], { name: 'campaign_leads_campaign_id_idx' });
    await queryInterface.addIndex('campaign_leads', ['assigned_executive_id'], {
      name: 'campaign_leads_assigned_exec_idx'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('campaign_leads');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_campaign_leads_queue_status";');
  }
};
