'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('import_jobs', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      client_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'clients', key: 'id' },
        onDelete: 'CASCADE'
      },
      // Null until the job resolves which list it targets — a job creating a
      // brand-new list doesn't have one yet at upload time.
      lead_list_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'lead_lists', key: 'id' },
        onDelete: 'SET NULL'
      },
      lead_list_name: { type: Sequelize.STRING(255), allowNull: true },
      started_by_user_id: { type: Sequelize.UUID, allowNull: false, references: { model: 'users', key: 'id' } },
      original_filename: { type: Sequelize.STRING(255), allowNull: false },
      // Where the uploaded source file lives while processing. Deleted once
      // the job reaches a terminal state.
      source_file_key: { type: Sequelize.STRING(500), allowNull: true },
      // Generated only when there are rejected rows; retained for a limited
      // download window, then removed.
      error_file_key: { type: Sequelize.STRING(500), allowNull: true },
      status: {
        type: Sequelize.ENUM('uploaded', 'queued', 'processing', 'completed', 'completed_with_errors', 'failed'),
        allowNull: false,
        defaultValue: 'uploaded'
      },
      total_rows: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      processed_rows: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      successful_rows: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      failed_rows: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      // Breakdown of the successful rows, mirroring the synchronous import
      // summary: brand new to the agency vs. already known globally vs.
      // already mapped to this client.
      new_to_agency: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      matched_from_agency_database: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      already_mapped_to_client: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      // User-safe message when status = failed. Never carries a stack trace.
      failure_reason: { type: Sequelize.TEXT, allowNull: true },
      started_at: { type: Sequelize.DATE, allowNull: true },
      finished_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updated_at: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') }
    });

    await queryInterface.addIndex('import_jobs', ['client_id'], { name: 'import_jobs_client_id_idx' });
    await queryInterface.addIndex('import_jobs', ['status'], { name: 'import_jobs_status_idx' });

    // Row counters can never be negative, and the parts can never exceed the
    // whole — a bug in progress reporting shouldn't be able to write an
    // impossible state the UI then renders as >100%.
    await queryInterface.sequelize.query(`
      ALTER TABLE import_jobs ADD CONSTRAINT chk_import_jobs_counts_sane CHECK (
        total_rows >= 0 AND processed_rows >= 0 AND successful_rows >= 0 AND failed_rows >= 0
        AND new_to_agency >= 0 AND matched_from_agency_database >= 0 AND already_mapped_to_client >= 0
        AND processed_rows <= total_rows
        AND successful_rows + failed_rows <= total_rows
      );
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('import_jobs');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_import_jobs_status";');
  }
};
