'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('email_dispatch_jobs', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      campaign_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'campaigns', key: 'id' },
        onDelete: 'CASCADE'
      },
      started_by_user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
      status: {
        type: Sequelize.ENUM('queued', 'processing', 'completed', 'completed_with_errors', 'failed'),
        allowNull: false,
        defaultValue: 'queued'
      },
      // total_recipients is the frozen audience size. The three outcome
      // counters below must reconcile against it:
      //   processed = sent + failed + suppressed
      // "suppressed" is where leads skipped by the live consent re-check
      // land — without it the numbers would silently fail to add up and a
      // manager couldn't tell a delivery failure from a deliberate skip.
      total_recipients: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      processed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      sent: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      failed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      suppressed: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      failure_reason: { type: Sequelize.TEXT, allowNull: true },
      started_at: { type: Sequelize.DATE, allowNull: true },
      finished_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('email_dispatch_jobs', ['campaign_id'], {
      name: 'email_dispatch_jobs_campaign_id_idx'
    });
    await queryInterface.addIndex('email_dispatch_jobs', ['status'], { name: 'email_dispatch_jobs_status_idx' });

    await queryInterface.sequelize.query(`
      ALTER TABLE email_dispatch_jobs ADD CONSTRAINT chk_email_jobs_counts_sane CHECK (
        total_recipients >= 0 AND processed >= 0 AND sent >= 0 AND failed >= 0 AND suppressed >= 0
        AND processed <= total_recipients
        AND (sent + failed + suppressed) <= total_recipients
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('email_dispatch_jobs');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_email_dispatch_jobs_status";');
  }
};
