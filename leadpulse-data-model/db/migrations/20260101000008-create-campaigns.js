'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('campaigns', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      client_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'clients', key: 'id' },
        onDelete: 'CASCADE'
      },
      lead_list_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'lead_lists', key: 'id' } },
      sequence_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'sequences', key: 'id' },
        onDelete: 'SET NULL'
      },
      sequence_step_order: { type: Sequelize.INTEGER, allowNull: true },
      created_by_user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
      name: { type: Sequelize.STRING(255), allowNull: false },
      type: { type: Sequelize.ENUM('email', 'call'), allowNull: false },
      description: { type: Sequelize.TEXT, allowNull: true },
      category_tag: { type: Sequelize.STRING(100), allowNull: true },
      status: {
        type: Sequelize.ENUM('draft', 'active', 'paused', 'completed'),
        allowNull: false,
        defaultValue: 'draft'
      },
      dispatch_status: {
        type: Sequelize.ENUM('not_sent', 'sending', 'sent'),
        allowNull: false,
        defaultValue: 'not_sent'
      },
      segmentation_filters: { type: Sequelize.JSONB, allowNull: true },
      exclude_closed_leads: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      pricing_model: { type: Sequelize.ENUM('flat_retainer', 'cost_per_lead'), allowNull: true },
      retainer_amount: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      rate_per_lead: { type: Sequelize.DECIMAL(10, 2), allowNull: true },
      budget_alert_90_sent: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      budget_alert_100_sent: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      requires_manager_approval: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      approved_by_user_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      approved_at: { type: Sequelize.DATE, allowNull: true },
      subject_line: { type: Sequelize.STRING(255), allowNull: true },
      sender_name: { type: Sequelize.STRING(150), allowNull: true },
      reply_to_email: { type: Sequelize.STRING(255), allowNull: true },
      email_body_html: { type: Sequelize.TEXT, allowNull: true },
      banner_image_url: { type: Sequelize.STRING(500), allowNull: true },
      schedule_type: { type: Sequelize.ENUM('send_now', 'scheduled'), allowNull: true },
      scheduled_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('campaigns', ['client_id'], { name: 'campaigns_client_id_idx' });
    await queryInterface.addIndex('campaigns', ['lead_list_id'], { name: 'campaigns_lead_list_id_idx' });
    await queryInterface.addIndex('campaigns', ['sequence_id'], { name: 'campaigns_sequence_id_idx' });
    await queryInterface.addIndex('campaigns', ['status'], { name: 'campaigns_status_idx' });

    // Business rule: pricing fields must match the chosen model exactly —
    // never both populated, never neither, never the wrong one for the model.
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns ADD CONSTRAINT chk_campaigns_pricing_fields CHECK (
        (pricing_model = 'flat_retainer' AND retainer_amount IS NOT NULL AND rate_per_lead IS NULL) OR
        (pricing_model = 'cost_per_lead' AND rate_per_lead IS NOT NULL AND retainer_amount IS NULL) OR
        (pricing_model IS NULL AND retainer_amount IS NULL AND rate_per_lead IS NULL)
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('campaigns');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_campaigns_type";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_campaigns_status";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_campaigns_dispatch_status";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_campaigns_pricing_model";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_campaigns_schedule_type";');
  }
};
