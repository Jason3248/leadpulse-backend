'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('client_leads', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      client_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'clients', key: 'id' },
        onDelete: 'CASCADE'
      },
      lead_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'leads', key: 'id' },
        onDelete: 'CASCADE'
      },
      // Deliberately per-client, not global and not per-list: an unsubscribe
      // or DNC applies to this Client's outreach specifically, never bleeds
      // into an unrelated Client's campaigns for the same real person, but
      // DOES apply across every product/list that same Client runs.
      dnc: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_unsubscribed: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      is_hard_bounced: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    // One relationship per (client, lead) — this is what "first time this
    // client has ever targeted this person" vs. "already known to them"
    // resolves against during import.
    await queryInterface.addConstraint('client_leads', {
      fields: ['client_id', 'lead_id'],
      type: 'unique',
      name: 'client_leads_client_lead_unique'
    });

    await queryInterface.addIndex('client_leads', ['lead_id'], { name: 'client_leads_lead_id_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('client_leads');
  }
};
