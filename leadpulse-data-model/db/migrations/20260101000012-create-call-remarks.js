'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('call_remarks', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      // Points at the frozen audience row rather than (campaign_id, lead_id)
      // separately — a remark can only ever exist for a lead who was
      // genuinely part of this campaign's approved audience.
      campaign_lead_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'campaign_leads', key: 'id' },
        onDelete: 'CASCADE'
      },
      executive_user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
      call_outcome: {
        type: Sequelize.ENUM(
          'Answered',
          'Not Answered',
          'Busy',
          'Wrong Number',
          'Left Voicemail',
          'Callback Requested',
          'Not Interested',
          'Converted'
        ),
        allowNull: false
      },
      call_duration_minutes: { type: Sequelize.INTEGER, allowNull: true },
      notes: { type: Sequelize.TEXT, allowNull: true },
      follow_up_date: { type: Sequelize.DATEONLY, allowNull: true },
      lead_status_update: {
        type: Sequelize.ENUM('New', 'Contacted', 'Qualified', 'Converted', 'Dead'),
        allowNull: true
      },
      is_manual_entry_by_manager: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      // Tri-state: NULL = not yet reviewed, TRUE = confirmed (billable),
      // FALSE = reviewed and rejected (not billable, reason recorded).
      conversion_confirmed: { type: Sequelize.BOOLEAN, allowNull: true },
      conversion_rejection_reason: { type: Sequelize.TEXT, allowNull: true },
      confirmed_by_user_id: { type: Sequelize.UUID, allowNull: true, references: { model: 'users', key: 'id' } },
      confirmed_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('call_remarks', ['campaign_lead_id'], { name: 'call_remarks_campaign_lead_id_idx' });

    // Whoever reviews a claimed conversion can never be the executive who
    // logged it — self-reported claims need a second pair of eyes before
    // they count toward billing.
    await queryInterface.sequelize.query(`
      ALTER TABLE call_remarks ADD CONSTRAINT chk_call_remarks_no_self_confirm
      CHECK (confirmed_by_user_id IS NULL OR confirmed_by_user_id <> executive_user_id);
    `);

    // Review fields are all-or-nothing, and now cover rejection too:
    //  - reviewed (TRUE or FALSE) -> reviewer + timestamp required
    //  - not reviewed (NULL)      -> reviewer, timestamp and reason all empty
    //  - a rejection reason only makes sense on an actual rejection
    await queryInterface.sequelize.query(`
      ALTER TABLE call_remarks ADD CONSTRAINT chk_call_remarks_confirmation_consistency
      CHECK (
        (
          conversion_confirmed IS NOT NULL
          AND confirmed_by_user_id IS NOT NULL
          AND confirmed_at IS NOT NULL
          AND (conversion_confirmed IS TRUE AND conversion_rejection_reason IS NULL
               OR conversion_confirmed IS FALSE)
        )
        OR (
          conversion_confirmed IS NULL
          AND confirmed_by_user_id IS NULL
          AND confirmed_at IS NULL
          AND conversion_rejection_reason IS NULL
        )
      );
    `);

    // Call duration can't be negative.
    await queryInterface.sequelize.query(`
      ALTER TABLE call_remarks ADD CONSTRAINT chk_call_remarks_duration_nonnegative
      CHECK (call_duration_minutes IS NULL OR call_duration_minutes >= 0);
    `);

    // At most ONE confirmed conversion per frozen audience row — prevents an
    // accidental re-call from double-billing the same person in the same
    // campaign. A confirmed conversion for the same lead in a DIFFERENT
    // campaign is still allowed (legitimate re-engagement).
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX call_remarks_one_confirmed_conversion_per_lead
      ON call_remarks (campaign_lead_id)
      WHERE conversion_confirmed = true;
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('call_remarks');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_call_remarks_call_outcome";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_call_remarks_lead_status_update";');
  }
};
