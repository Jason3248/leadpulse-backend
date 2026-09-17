'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Zod already rejects non-positive amounts at the API boundary; this is
    // the DB-level backstop so a bug in the service layer can't write a
    // negative price that would silently corrupt billing math.
    await queryInterface.sequelize.query(`
      ALTER TABLE campaigns ADD CONSTRAINT chk_campaigns_amounts_nonnegative CHECK (
        (retainer_amount IS NULL OR retainer_amount >= 0)
        AND (rate_per_lead IS NULL OR rate_per_lead >= 0)
      );
    `);

    // Two campaigns claiming to be the same step of one sequence would make
    // the ordering meaningless — which is the only thing the field exists
    // to express.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX campaigns_sequence_step_unique
      ON campaigns (sequence_id, sequence_step_order)
      WHERE sequence_id IS NOT NULL AND sequence_step_order IS NOT NULL;
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS chk_campaigns_amounts_nonnegative;');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS campaigns_sequence_step_unique;');
  }
};
