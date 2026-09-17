'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('lead_engagements', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      // Points at the frozen audience row, not (campaign_id, lead_id)
      // separately. This makes it structurally impossible to record an
      // engagement for a lead who was never part of this campaign's
      // approved audience — the guarantee is enforced by the FK rather
      // than by application discipline.
      campaign_lead_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'campaign_leads', key: 'id' },
        onDelete: 'CASCADE'
      },
      tracking_token: { type: Sequelize.STRING(64), allowNull: false, unique: true },
      status: {
        type: Sequelize.ENUM('sent', 'delivered', 'bounced', 'spamreport'),
        allowNull: false,
        defaultValue: 'sent'
      },
      sent_at: { type: Sequelize.DATE, allowNull: true },
      delivered_at: { type: Sequelize.DATE, allowNull: true },
      opened_at: { type: Sequelize.DATE, allowNull: true },
      clicked_at: { type: Sequelize.DATE, allowNull: true },
      converted_at: { type: Sequelize.DATE, allowNull: true },
      unsubscribed_at: { type: Sequelize.DATE, allowNull: true },
      open_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      click_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      bounce_type: { type: Sequelize.ENUM('hard', 'soft'), allowNull: true },
      error_message: { type: Sequelize.TEXT, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('lead_engagements', ['campaign_lead_id'], {
      name: 'lead_engagements_campaign_lead_id_idx'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('lead_engagements');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_lead_engagements_status";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_lead_engagements_bounce_type";');
  }
};
