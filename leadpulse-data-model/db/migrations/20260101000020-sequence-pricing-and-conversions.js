'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // --- Pricing moves to the sequence -------------------------------------
    // A client contracts for an outreach MOTION, not for individual sends.
    // Standalone campaigns (sequenceId = null) keep their own pricing columns
    // and bill exactly as before; nothing about existing data changes.
    await queryInterface.addColumn('sequences', 'lead_list_id', {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: 'lead_lists', key: 'id' }
    });
    await queryInterface.addColumn('sequences', 'pricing_model', {
      type: Sequelize.ENUM('flat_retainer', 'cost_per_lead'),
      allowNull: true
    });
    await queryInterface.addColumn('sequences', 'retainer_amount', { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    await queryInterface.addColumn('sequences', 'rate_per_lead', { type: Sequelize.DECIMAL(10, 2), allowNull: true });
    await queryInterface.addColumn('sequences', 'description', { type: Sequelize.TEXT, allowNull: true });

    // Same mutual-exclusivity rule the campaigns table already enforces.
    await queryInterface.sequelize.query(`
      ALTER TABLE sequences ADD CONSTRAINT chk_sequences_pricing_fields CHECK (
        (pricing_model = 'flat_retainer' AND retainer_amount IS NOT NULL AND rate_per_lead IS NULL) OR
        (pricing_model = 'cost_per_lead' AND rate_per_lead IS NOT NULL AND retainer_amount IS NULL) OR
        (pricing_model IS NULL AND retainer_amount IS NULL AND rate_per_lead IS NULL)
      );
    `);
    await queryInterface.sequelize.query(`
      ALTER TABLE sequences ADD CONSTRAINT chk_sequences_amounts_nonnegative CHECK (
        (retainer_amount IS NULL OR retainer_amount >= 0)
        AND (rate_per_lead IS NULL OR rate_per_lead >= 0)
      );
    `);

    // --- The conversion ledger ---------------------------------------------
    // One row per (sequence, lead) the moment that lead first converts
    // ANYWHERE in the sequence — call or email, step 1 or step 5. The unique
    // constraint is what makes "billed once per lead per sequence" a
    // structural guarantee rather than a query that must remember to be
    // written with DISTINCT.
    //
    // Why a table rather than counting distinct leads at read time: a later
    // step may legitimately re-contact a converted lead (a thank-you email,
    // for instance) and could produce a second conversion event. Counting
    // events would double-bill; counting rows here cannot, because the
    // second insert is simply rejected.
    await queryInterface.createTable('sequence_conversions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      sequence_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'sequences', key: 'id' },
        onDelete: 'CASCADE'
      },
      lead_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'leads', key: 'id' },
        onDelete: 'CASCADE'
      },
      // Which campaign in the sequence actually produced the conversion —
      // kept for reporting ("converted at step 2"), not for billing.
      campaign_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'campaigns', key: 'id' },
        onDelete: 'CASCADE'
      },
      channel: { type: Sequelize.ENUM('email', 'call'), allowNull: false },
      converted_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addConstraint('sequence_conversions', {
      fields: ['sequence_id', 'lead_id'],
      type: 'unique',
      name: 'sequence_conversions_sequence_lead_unique'
    });
    await queryInterface.addIndex('sequence_conversions', ['sequence_id'], {
      name: 'sequence_conversions_sequence_id_idx'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sequence_conversions');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_sequence_conversions_channel";');
    await queryInterface.sequelize.query('ALTER TABLE sequences DROP CONSTRAINT IF EXISTS chk_sequences_pricing_fields;');
    await queryInterface.sequelize.query('ALTER TABLE sequences DROP CONSTRAINT IF EXISTS chk_sequences_amounts_nonnegative;');
    await queryInterface.removeColumn('sequences', 'description');
    await queryInterface.removeColumn('sequences', 'rate_per_lead');
    await queryInterface.removeColumn('sequences', 'retainer_amount');
    await queryInterface.removeColumn('sequences', 'pricing_model');
    await queryInterface.removeColumn('sequences', 'lead_list_id');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_sequences_pricing_model";');
  }
};
