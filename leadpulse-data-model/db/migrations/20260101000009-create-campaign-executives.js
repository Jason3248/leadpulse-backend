'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('campaign_executives', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      campaign_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'campaigns', key: 'id' },
        onDelete: 'CASCADE'
      },
      executive_user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
      is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      unassigned_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('campaign_executives', ['campaign_id'], {
      name: 'campaign_executives_campaign_id_idx'
    });

    // Business rule: an Executive can only be actively assigned to a given
    // campaign once at a time (reassignment soft-closes the old row instead
    // of deleting it, preserving history).
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX campaign_executives_active_unique
      ON campaign_executives (campaign_id, executive_user_id)
      WHERE is_active = true;
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('campaign_executives');
  }
};
